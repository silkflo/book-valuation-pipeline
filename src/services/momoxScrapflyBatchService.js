// src/services/momoxScrapflyBatchService.js
//
// Momox resale offers through Scrapfly (primary provider).
//
// Method (validated manually, see scrapfly-tests/momox-batch-fetch-3-fixed.json):
// one rendered Scrapfly call opens https://www.momox.fr/vendre-livres/ and a
// js_scenario "execute" script performs in-browser fetches against
// /api/v4/media/offer/?ean={isbn} with headers derived from window.MX_WEBAPP.
// One browser session prices a whole batch (~45 credits total), versus ~40
// credits per ISBN with direct API calls - so batching is the primary path.

import dotenv from 'dotenv';
import { scrapflyScrape, isScrapflyEnabled } from './scrapflyClient.js';

dotenv.config();

const MOMOX_SELL_URL = 'https://www.momox.fr/vendre-livres/';
const MAX_ISBNS_PER_MOMOX_BATCH = 10;

// Last-known-good fallbacks when window.MX_WEBAPP is unavailable in the page.
const FALLBACK_CLIENT_KEY = '2231443b8fb511c7b6a0eb25a62577320bac69b6';
const FALLBACK_CLIENT_VERSION = '1.0.0-r280-7b8c75145';
const FALLBACK_MARKETPLACE_ID = 'momox_fr';

function cleanIsbn(value) {
    if (!value) return null;

    const cleaned = String(value)
        .replace(/[^0-9Xx]/g, '')
        .toUpperCase();

    return cleaned || null;
}

function parseMomoxPrice(rawPrice) {
    if (rawPrice === null || rawPrice === undefined) {
        return null;
    }

    if (typeof rawPrice === 'number') {
        return Number.isFinite(rawPrice) ? rawPrice : null;
    }

    const cleaned = String(rawPrice)
        .replace(',', '.')
        .replace(/[^\d.]/g, '');

    const number = Number(cleaned);

    return Number.isFinite(number) ? number : null;
}

function getMomoxImageUrl(data) {
    return (
        data?.product?.full_size_image_url ||
        data?.product?.image_url ||
        data?.product?.thumbnail_image_url ||
        null
    );
}

function buildMomoxBatchScript(codes) {
    const fallbackKey = process.env.MOMOX_FALLBACK_CLIENT_KEY || FALLBACK_CLIENT_KEY;
    const fallbackVersion = process.env.MOMOX_FALLBACK_CLIENT_VERSION || FALLBACK_CLIENT_VERSION;
    const fallbackMarketplace = process.env.MOMOX_FALLBACK_MARKETPLACE_ID || FALLBACK_MARKETPLACE_ID;

    // Mirrors the manually validated script 1:1 (X-CLIENT-VERSION drops the
    // "1.0.0-" prefix). Keep changes minimal: Momox tolerates this shape today.
    return `
const codes = ${JSON.stringify(codes)};

const apiToken = window.MX_WEBAPP?.clientKey || ${JSON.stringify(fallbackKey)};
const clientVersion = (window.MX_WEBAPP?.version || ${JSON.stringify(fallbackVersion)}).replace(/^1\\.0\\.0-/, "");
const marketplaceId = window.MX_WEBAPP?.marketplaceId || ${JSON.stringify(fallbackMarketplace)};

const results = [];

for (const code of codes) {
  try {
    const url = "/api/v4/media/offer/?ean=" + encodeURIComponent(code);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "X-API-TOKEN": apiToken,
        "X-CLIENT-VERSION": clientVersion,
        "X-MARKETPLACE-ID": marketplaceId
      },
      credentials: "include"
    });

    const text = await response.text();

    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }

    results.push({
      code,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      data,
      textStart: text.slice(0, 500)
    });
  } catch (error) {
    results.push({
      code,
      ok: false,
      error: String(error)
    });
  }
}

return {
  ok: true,
  apiToken,
  clientVersion,
  marketplaceId,
  results
};
`.trim();
}

function buildMomoxScenario(codes) {
    // Scrapfly's total js_scenario budget is 30s: wait + execute must stay
    // under it or the whole call is rejected. 1s settle + <=24s execute = 25s.
    const executeTimeout = Math.min(24000, 6000 + codes.length * 1800);

    return JSON.stringify([
        { wait: 1000 },
        {
            execute: {
                script: buildMomoxBatchScript(codes),
                timeout: executeTimeout,
            },
        },
    ]);
}

function extractScenarioReturnValue(data) {
    const steps = data?.result?.browser_data?.js_scenario?.steps;

    if (Array.isArray(steps)) {
        for (const step of steps) {
            if (step?.action === 'execute' && step?.result && typeof step.result === 'object') {
                return step.result;
            }
        }
    }

    // Some Scrapfly responses expose the last evaluation result directly.
    const evaluation = data?.result?.browser_data?.javascript_evaluation_result;

    if (evaluation && typeof evaluation === 'object') {
        return evaluation;
    }

    return null;
}

function normalizeMomoxEntry(entry) {
    const isbn = cleanIsbn(entry?.code);

    if (!isbn) return null;

    const data = entry?.data && typeof entry.data === 'object' ? entry.data : null;

    if (!entry.ok || !data) {
        return {
            isbn,
            status: 'failed',
            momoxStatus: null,
            price: null,
            title: null,
            imageUrl: null,
            httpStatus: entry?.status ?? null,
            error: entry?.error || `Momox API returned HTTP ${entry?.status}`,
            raw: entry,
        };
    }

    const price = parseMomoxPrice(data.price);
    const hasOffer = data.status === 'offer' && Number.isFinite(price) && price > 0;

    return {
        isbn,
        status: hasOffer ? 'offer' : 'no_offer',
        momoxStatus: data.status || null,
        price: hasOffer ? price : 0,
        // Even with no offer, keep title/image when Momox knows the product.
        title: data.product?.title || null,
        imageUrl: getMomoxImageUrl(data),
        demandRating: data.demand_rating ?? null,
        httpStatus: entry?.status ?? null,
        error: null,
        raw: entry,
    };
}

export function isMomoxScrapflyEnabled() {
    return isScrapflyEnabled() && process.env.MOMOX_SCRAPFLY_ENABLED !== 'false';
}

/**
 * Look up Momox offers for up to 10 ISBNs in ONE Scrapfly browser session.
 *
 * @returns {Promise<object>} {
 *   ok, adsId, requestedIsbns, rows, missingIsbns,
 *   offerIsbns, noOfferIsbns, failedIsbns,
 *   scrapflyCost, requestId, logUrl, reason?
 * }
 * Never throws for provider-level failures; check `ok`.
 */
export async function lookupMomoxPricesBatch({ books, adsId = null }) {
    if (!Array.isArray(books) || !books.length) {
        throw new Error('lookupMomoxPricesBatch missing books array');
    }

    if (!isMomoxScrapflyEnabled()) {
        return {
            ok: false,
            skipped: true,
            reason: 'Momox Scrapfly disabled (SCRAPFLY_KEY missing or MOMOX_SCRAPFLY_ENABLED=false)',
            adsId,
            requestedIsbns: [],
            rows: [],
            missingIsbns: [],
            offerIsbns: [],
            noOfferIsbns: [],
            failedIsbns: [],
            scrapflyCost: null,
            requestId: null,
            logUrl: null,
        };
    }

    const seen = new Set();
    const requestedIsbns = [];

    for (const book of books) {
        const isbn = cleanIsbn(book?.isbn || book?.isbn13);

        if (!isbn || seen.has(isbn)) continue;

        seen.add(isbn);
        requestedIsbns.push(isbn);

        if (requestedIsbns.length >= MAX_ISBNS_PER_MOMOX_BATCH) break;
    }

    if (!requestedIsbns.length) {
        throw new Error('lookupMomoxPricesBatch has no valid ISBN');
    }

    const params = {
        tags: 'books,momox,batch,project:books-sell',
        country: process.env.SCRAPFLY_MOMOX_COUNTRY || 'fr',
        asp: 'true',
        render_js: 'true',
        // Scrapfly minimum is 1000ms; this is page-load wait, separate from
        // the 30s js_scenario budget (1s wait + <=24s execute).
        rendering_wait: '1000',
        js_scenario: Buffer.from(buildMomoxScenario(requestedIsbns), 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, ''),
    };

    if (process.env.SCRAPFLY_MOMOX_RESIDENTIAL !== 'false') {
        params.proxy_pool = 'public_residential_pool';
    }

    console.log(
        `Momox Scrapfly batch started adsId=${adsId || ''}, isbns=${requestedIsbns.length}: ${requestedIsbns.join(', ')}`
    );

    const response = await scrapflyScrape({
        url: MOMOX_SELL_URL,
        params,
        timeoutMs: 240000,
    });

    if (!response.ok) {
        return {
            ok: false,
            adsId,
            requestedIsbns,
            rows: [],
            missingIsbns: requestedIsbns,
            offerIsbns: [],
            noOfferIsbns: [],
            failedIsbns: requestedIsbns,
            statusCode: response.statusCode,
            reason: response.reason,
            scrapflyCost: response.scrapflyCost,
            requestId: response.requestId,
            logUrl: response.logUrl,
        };
    }

    const scenarioResult = extractScenarioReturnValue(response.data);
    const entries = Array.isArray(scenarioResult?.results) ? scenarioResult.results : [];

    if (!entries.length) {
        return {
            ok: false,
            adsId,
            requestedIsbns,
            rows: [],
            missingIsbns: requestedIsbns,
            offerIsbns: [],
            noOfferIsbns: [],
            failedIsbns: requestedIsbns,
            statusCode: response.statusCode,
            reason: 'Momox js_scenario returned no results (page layout or MX_WEBAPP changed?)',
            scrapflyCost: response.scrapflyCost,
            requestId: response.requestId,
            logUrl: response.logUrl,
        };
    }

    const rowsByIsbn = new Map();

    for (const entry of entries) {
        const row = normalizeMomoxEntry(entry);

        if (row && !rowsByIsbn.has(row.isbn)) {
            rowsByIsbn.set(row.isbn, row);
        }
    }

    const rows = requestedIsbns
        .map((isbn) => rowsByIsbn.get(isbn))
        .filter(Boolean);

    const missingIsbns = requestedIsbns.filter((isbn) => !rowsByIsbn.has(isbn));
    const offerIsbns = rows.filter((row) => row.status === 'offer').map((row) => row.isbn);
    const noOfferIsbns = rows.filter((row) => row.status === 'no_offer').map((row) => row.isbn);
    const failedIsbns = [
        ...rows.filter((row) => row.status === 'failed').map((row) => row.isbn),
        ...missingIsbns,
    ];

    console.log(
        `Momox Scrapfly batch done adsId=${adsId || ''}: requested=${requestedIsbns.length}, offers=${offerIsbns.length}, noOffer=${noOfferIsbns.length}, failed=${failedIsbns.length}, cost=${response.scrapflyCost}`
    );

    return {
        ok: true,
        adsId,
        requestedIsbns,
        rows,
        missingIsbns,
        offerIsbns,
        noOfferIsbns,
        failedIsbns,
        statusCode: response.statusCode,
        scrapflyCost: response.scrapflyCost,
        requestId: response.requestId,
        logUrl: response.logUrl,
        clientInfo: {
            apiTokenUsed: scenarioResult?.apiToken ? 'present' : 'missing',
            clientVersion: scenarioResult?.clientVersion || null,
            marketplaceId: scenarioResult?.marketplaceId || null,
        },
    };
}
