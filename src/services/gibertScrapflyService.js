//src\services\gibertScrapflyService.js

// src/services/gibertScrapflyService.js

import dotenv from 'dotenv';
import * as cheerio from 'cheerio';

dotenv.config();

const SCRAPFLY_API_URL = 'https://api.scrapfly.io/scrape';
const GIBERT_SAO_URL = 'https://www.gibert.com/sao';

function cleanIsbn(value) {
    if (!value) return null;

    const cleaned = String(value)
        .replace(/[^0-9Xx]/g, '')
        .toUpperCase();

    return cleaned || null;
}

function parseFrenchPrice(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const cleaned = String(value)
        .replace(/\u00a0/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace('€', '')
        .replace(',', '.')
        .replace(/[^\d.]/g, '')
        .trim();

    const number = Number(cleaned);

    return Number.isFinite(number) ? number : null;
}

function buildGibertScenario(isbn) {
    return JSON.stringify([
        { wait: 3000 },
        {
            execute: {
                script: `
const cookieButton = document.querySelector('[data-amgdprcookie-js="decline"]')
    || [...document.querySelectorAll('button,a,div,span')]
        .find(e => /continuer sans accepter|accepter les cookies/i.test((e.innerText || e.textContent || '').trim()));

if (cookieButton) {
    cookieButton.click();
}
                `.trim(),
            },
        },
        { wait: 1000 },
        {
            fill: {
                selector: "input[name='codes']",
                value: isbn,
            },
        },
        { wait: 1000 },
        {
            click: {
                selector: '#add_sao',
            },
        },
        { wait: 8000 },
    ]);
}

function extractGibertPriceFromHtml(html) {
    const $ = cheerio.load(html || '');

    const cashPriceText = $('#total_amount .price').first().text().trim();
    const tirelirePriceText = $('#totalTirelire .price').first().text().trim();
    const remainingText = $('.remaining-amount').first().text().replace(/\s+/g, ' ').trim();

    const gibertPrice = parseFrenchPrice(cashPriceText);
    const tirelirePrice = parseFrenchPrice(tirelirePriceText);

    return {
        gibertPrice,
        cashPriceText: cashPriceText || null,
        tirelirePrice,
        tirelirePriceText: tirelirePriceText || null,
        remainingText: remainingText || null,
    };
}

function getScrapflyCost(data) {
    return (
        data?.context?.cost ??
        data?.result?.cost ??
        data?.cost ??
        null
    );
}

function getScrapflyRequestId(data) {
    return (
        data?.context?.request_id ||
        data?.result?.request_id ||
        data?.result?.log_url?.split('/').pop() ||
        null
    );
}

export async function lookupGibertPriceByIsbn({
    isbn,
    adsId = null,
    bookId = null,
}) {
    const clean = cleanIsbn(isbn);

    if (!clean) {
        throw new Error('lookupGibertPriceByIsbn missing valid isbn');
    }

    if (!process.env.SCRAPFLY_KEY) {
        throw new Error('Missing SCRAPFLY_KEY in .env');
    }

    if (process.env.SCRAPFLY_ENABLED === 'false') {
        return {
            ok: false,
            skipped: true,
            reason: 'SCRAPFLY_ENABLED=false',
            isbn: clean,
            gibertPrice: null,
        };
    }

    const scenario = buildGibertScenario(clean);
    const encodedScenario = Buffer.from(scenario, 'utf8').toString('base64');

    const params = new URLSearchParams();

    params.set('key', process.env.SCRAPFLY_KEY);
    params.set('url', GIBERT_SAO_URL);
    params.set('tags', 'books,gibert,project:books-sell');
    params.set('country', 'fr');
    params.set('asp', 'true');
    params.set('render_js', 'true');
    params.set('rendering_wait', '8000');
    params.set('js_scenario', encodedScenario);

    if (process.env.SCRAPFLY_GIBERT_RESIDENTIAL !== 'false') {
        params.set('proxy_pool', 'public_residential_pool');
    }

    console.log(`Gibert Scrapfly lookup started isbn=${clean} adsId=${adsId || ''} bookId=${bookId || ''}`);

    const response = await fetch(`${SCRAPFLY_API_URL}?${params.toString()}`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
    });

    const text = await response.text();

    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new Error(`Scrapfly JSON parse failed: ${text.slice(0, 500)}`);
    }

    const result = data.result || {};
    const html = result.content || '';
    const extracted = extractGibertPriceFromHtml(html);

    const scrapflyCost = getScrapflyCost(data);
    const requestId = getScrapflyRequestId(data);

    if (!response.ok || result.success === false) {
        return {
            ok: false,
            isbn: clean,
            adsId,
            bookId,
            statusCode: result.status_code || response.status,
            reason: result.error?.message || result.reason || 'Scrapfly request failed',
            gibertPrice: null,
            scrapflyCost,
            requestId,
            raw: {
                error: result.error || null,
                logUrl: result.log_url || null,
            },
        };
    }

    if (!Number.isFinite(extracted.gibertPrice) || extracted.gibertPrice < 0) {
        return {
            ok: false,
            isbn: clean,
            adsId,
            bookId,
            statusCode: result.status_code || response.status,
            reason: 'Gibert price not found in rendered HTML',
            gibertPrice: null,
            scrapflyCost,
            requestId,
            raw: {
                cashPriceText: extracted.cashPriceText,
                tirelirePriceText: extracted.tirelirePriceText,
                remainingText: extracted.remainingText,
                logUrl: result.log_url || null,
            },
        };
    }

    return {
        ok: true,
        isbn: clean,
        adsId,
        bookId,
        statusCode: result.status_code || response.status,
        gibertPrice: extracted.gibertPrice,
        rawCashPriceText: extracted.cashPriceText,
        ignoredTirelirePrice: extracted.tirelirePrice,
        rawTirelirePriceText: extracted.tirelirePriceText,
        remainingText: extracted.remainingText,
        scrapflyCost,
        requestId,
        logUrl: result.log_url || null,
    };
}
