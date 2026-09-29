// src/services/scrapflyClient.js
//
// Shared low-level Scrapfly HTTP client used by all Scrapfly provider services
// (ISBNSearch, Momox, Gibert). Keeps provider modules focused on URL building
// and response parsing.

import dotenv from 'dotenv';

dotenv.config();

const SCRAPFLY_API_URL = 'https://api.scrapfly.io/scrape';

export function isScrapflyEnabled() {
    return Boolean(process.env.SCRAPFLY_KEY) && process.env.SCRAPFLY_ENABLED !== 'false';
}

export function toUrlSafeBase64(value) {
    return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

export function extractScrapflyCost(data) {
    return (
        data?.context?.cost?.total ??
        data?.context?.cost ??
        data?.result?.cost ??
        data?.cost ??
        null
    );
}

export function extractScrapflyRequestId(data) {
    return (
        data?.config?.request_id ||
        data?.context?.request_id ||
        data?.result?.request_id ||
        data?.result?.log_url?.split('/').pop() ||
        null
    );
}

/**
 * Run one Scrapfly scrape call.
 *
 * @param {object} options
 * @param {string} options.url - target URL to scrape
 * @param {object} [options.params] - extra Scrapfly query params (asp, country, render_js, js_scenario, ...)
 * @param {number} [options.timeoutMs] - abort the HTTP call after this long
 * @returns {Promise<object>} normalized result:
 *   { ok, statusCode, html, data, result, scrapflyCost, requestId, logUrl, reason }
 *   Never throws for HTTP/Scrapfly-level errors; throws only on programmer errors
 *   (missing url/key) so callers can rely on `ok` + try/catch around network use.
 */
export async function scrapflyScrape({ url, params = {}, timeoutMs = 180000 }) {
    if (!url) {
        throw new Error('scrapflyScrape missing url');
    }

    if (!process.env.SCRAPFLY_KEY) {
        throw new Error('Missing SCRAPFLY_KEY in .env');
    }

    const query = new URLSearchParams();

    query.set('key', process.env.SCRAPFLY_KEY);
    query.set('url', url);

    for (const [name, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        query.set(name, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    let responseText;

    try {
        response = await fetch(`${SCRAPFLY_API_URL}?${query.toString()}`, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
            },
            signal: controller.signal,
        });

        // Decode explicitly as UTF-8: accented titles (é, â, ...) must survive
        // regardless of charset hints. The Scrapfly API always returns UTF-8 JSON.
        const rawBody = await response.arrayBuffer();
        responseText = Buffer.from(rawBody).toString('utf8');
    } catch (error) {
        return {
            ok: false,
            statusCode: null,
            html: '',
            data: null,
            result: null,
            scrapflyCost: null,
            requestId: null,
            logUrl: null,
            reason: `Scrapfly HTTP call failed: ${error?.message || error}`,
        };
    } finally {
        clearTimeout(timer);
    }

    let data;

    try {
        data = JSON.parse(responseText);
    } catch (error) {
        return {
            ok: false,
            statusCode: response.status,
            html: '',
            data: null,
            result: null,
            scrapflyCost: null,
            requestId: null,
            logUrl: null,
            reason: `Scrapfly JSON parse failed (HTTP ${response.status}): ${responseText.slice(0, 300)}`,
        };
    }

    const result = data.result || {};
    const scrapflyCost = extractScrapflyCost(data);
    const requestId = extractScrapflyRequestId(data);
    const logUrl = result.log_url || null;

    if (!response.ok || result.success === false) {
        return {
            ok: false,
            statusCode: result.status_code || response.status,
            html: result.content || '',
            data,
            result,
            scrapflyCost,
            requestId,
            logUrl,
            reason:
                result.error?.message ||
                result.reason ||
                data.message ||
                `Scrapfly request failed (HTTP ${response.status})`,
        };
    }

    return {
        ok: true,
        statusCode: result.status_code || response.status,
        html: result.content || '',
        data,
        result,
        scrapflyCost,
        requestId,
        logUrl,
        reason: null,
    };
}

/**
 * Map over items with limited concurrency. Each callback error is captured
 * in-place (never thrown) so one failed item cannot abort its siblings.
 */
export async function mapWithConcurrency(items, concurrency, callback) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;

            try {
                results[index] = await callback(items[index], index);
            } catch (error) {
                results[index] = { ok: false, error };
            }
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, items.length));

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}
