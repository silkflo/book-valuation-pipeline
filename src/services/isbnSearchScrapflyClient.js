// src/services/isbnSearchScrapflyClient.js
//
// ISBNSearch.org lookups through Scrapfly (primary provider).
//
// Two transport modes:
//   - BATCH (default for 2+ lookups): ONE rendered Scrapfly call opens
//     https://isbnsearch.org/ and a js_scenario execute script fetches every
//     /search?s={query} and /isbn/{isbn} page in-browser, returning only the
//     #searchresults / #book HTML fragments. ~30 credits per batch of up to
//     ~10-20 lookups, versus ~25 credits per page with one call each.
//   - SINGLE (1 lookup): plain non-rendered scrape of the page (~25 credits).
//
// Search is page 1 ONLY in both modes - never paginate.
//
// The return shape is identical to runIsbnSearchApifyLookup so the ISBN
// resolution pipeline in extractBooksWithOpenAI.js works with either provider:
//   { candidatesByQuery: Map, candidatesByIsbn: Map, rawItems, blocked, runs }
// plus Scrapfly extras: { costEvents, attemptedCalls, failedCalls, totalScrapflyCost }.

import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import {
    scrapflyScrape,
    isScrapflyEnabled,
    toUrlSafeBase64,
} from './scrapflyClient.js';

dotenv.config();

const ISBNSEARCH_BASE_URL = 'https://isbnsearch.org';

// Process-lifetime caches: the same title/ISBN often repeats across books of
// one ad (and across retries), and every Scrapfly call costs credits.
const searchCacheByQuery = new Map();
const isbnPageCache = new Map();

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Defensive UTF-8 hygiene: collapse whitespace and force NFC so accented
// characters compare/store consistently (see "Chรขteaux" mojibake incident -
// that was a console artifact, but normalizing costs nothing).
function cleanText(value) {
    return String(value || '')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanIsbn(value) {
    const cleaned = String(value || '')
        .replace(/[^0-9Xx]/g, '')
        .toUpperCase();

    return cleaned || null;
}

function uniqueCleanValues(values, normalizer) {
    const seen = new Set();
    const result = [];

    for (const value of values) {
        const clean = cleanText(value);
        const key = normalizer(clean);

        if (!clean || !key || seen.has(key)) continue;

        seen.add(key);
        result.push(clean);
    }

    return result;
}

function absoluteIsbnSearchUrl(value) {
    if (!value) return null;

    const text = String(value).trim();

    if (text.startsWith('http://') || text.startsWith('https://')) {
        return text;
    }

    if (text.startsWith('/')) {
        return `${ISBNSEARCH_BASE_URL}${text}`;
    }

    return `${ISBNSEARCH_BASE_URL}/${text}`;
}

function looksBlocked({ statusCode, html }) {
    if (statusCode === 403 || statusCode === 429 || statusCode === 503) {
        return true;
    }

    const sample = String(html || '').slice(0, 4000);

    return (
        /please verify to continue/i.test(sample) ||
        /just a moment/i.test(sample) ||
        /cf-challenge|challenge-platform|cloudflare/i.test(sample) && /challenge/i.test(sample)
    );
}

/**
 * The book title in a search result row is the text BEFORE the
 * Author/ISBN-13/ISBN-10 markers. Used when the /isbn/ link has no text
 * (observed in batch js_scenario results).
 */
export function extractTitleFromRawText(rawText) {
    return String(rawText || '')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .split(/\bAuthors?:|\bISBN-?13:|\bISBN-?10:/i)[0]
        .trim();
}

/**
 * Parse ISBNSearch search results (page 1). Accepts a full page or just the
 * #searchresults <ul> fragment (what the batch scenario returns). Returns raw
 * candidates: { isbn13, isbn10, isbn, title, authors, imageUrl, resultUrl, source }.
 */
export function parseIsbnSearchSearchPage(html) {
    const $ = cheerio.load(html || '');
    const candidates = [];
    const seen = new Set();

    let rows = $('#searchresults li, ul#searchresults li');

    // Fragment fallback: when given just the <ul> children markup.
    if (!rows.length) {
        rows = $('li');
    }

    rows.each((_, element) => {
        const container = $(element);
        const text = container.text() || '';

        if (!/ISBN-?13:/i.test(text) && !/ISBN-?10:/i.test(text)) {
            return;
        }

        const titleLink = container.find('.bookinfo h2 a[href*="/isbn/"]').first();
        const href =
            titleLink.attr('href') ||
            container.find('a[href*="/isbn/"]').first().attr('href') ||
            '';

        const isbnFromHref = cleanIsbn(href.match(/\/isbn\/([0-9Xx-]+)/)?.[1]);
        const isbn13 = cleanIsbn(text.match(/ISBN-?13:\s*([0-9Xx-]+)/i)?.[1]);
        const isbn10 = cleanIsbn(text.match(/ISBN-?10:\s*([0-9Xx-]+)/i)?.[1]);

        const dedupeKey = isbn13 || isbnFromHref || isbn10;

        if (!dedupeKey || seen.has(dedupeKey)) {
            return;
        }

        seen.add(dedupeKey);

        // Title fallback chain: link text -> raw text before Author/ISBN
        // markers -> image alt. The link text can be empty in fragments
        // returned by the batch js_scenario.
        const title =
            cleanText(titleLink.text()) ||
            extractTitleFromRawText(text) ||
            cleanText(container.find('.image img').first().attr('alt')) ||
            null;

        const authors =
            cleanText(text.match(/Authors?:\s*([^\n\r]+?)(?:ISBN-?1[03]:|View This Book|$)/i)?.[1]) ||
            cleanText(text.match(/Authors?:\s*([^\n\r]+)/i)?.[1]) ||
            null;

        candidates.push({
            isbn: isbn13 || isbnFromHref || isbn10,
            isbn13: isbn13 || isbnFromHref || null,
            isbn10: isbn10 || null,
            title,
            authors,
            imageUrl: absoluteIsbnSearchUrl(container.find('.image img').first().attr('src')),
            resultUrl: absoluteIsbnSearchUrl(href),
            source: 'isbnsearch_scrapfly',
        });
    });

    return candidates;
}

/**
 * Parse an ISBNSearch /isbn/{isbn} book page (full page or #book fragment)
 * into one raw candidate (plus publisher/publishedDate).
 */
export function parseIsbnSearchIsbnPage(html, requestedIsbn) {
    const $ = cheerio.load(html || '');

    const bookInfo = $('#book .bookinfo, .bookinfo').first();
    const pageText = (bookInfo.length ? bookInfo.text() : $('body').text() || $.root().text()) || '';

    const isbn13 = cleanIsbn(pageText.match(/ISBN-?13:\s*([0-9Xx-]+)/i)?.[1]);
    const isbn10 = cleanIsbn(pageText.match(/ISBN-?10:\s*([0-9Xx-]+)/i)?.[1]);

    const title =
        cleanText($('#book .bookinfo h1').first().text()) ||
        cleanText($('.bookinfo h1').first().text()) ||
        cleanText($('h1').first().text()) ||
        null;

    if (!title && !isbn13 && !isbn10) {
        return null;
    }

    const authors =
        cleanText(pageText.match(/Authors?:\s*([^\n\r]+?)(?:Binding:|Publisher:|Published:|$)/i)?.[1]) ||
        cleanText(pageText.match(/Authors?:\s*([^\n\r]+)/i)?.[1]) ||
        null;

    const publisher =
        cleanText(pageText.match(/Publisher:\s*([^\n\r]+?)(?:Published:|$)/i)?.[1]) ||
        cleanText(pageText.match(/Publisher:\s*([^\n\r]+)/i)?.[1]) ||
        null;

    const publishedDate =
        cleanText(pageText.match(/Published:\s*([^\n\r]+)/i)?.[1]) || null;

    const imageUrl = absoluteIsbnSearchUrl(
        $('#book .image img').first().attr('src') ||
        $('.image img').first().attr('src') ||
        null
    );

    const bestIsbn = isbn13 || cleanIsbn(requestedIsbn) || isbn10;

    return {
        isbn: bestIsbn,
        isbn13: isbn13 || null,
        isbn10: isbn10 || null,
        title,
        authors,
        publisher,
        publishedDate,
        imageUrl,
        resultUrl: bestIsbn ? `${ISBNSEARCH_BASE_URL}/isbn/${bestIsbn}` : null,
        source: 'isbnsearch_scrapfly_isbn',
    };
}

function buildScrapflyParams() {
    const params = {
        asp: 'true',
        country: process.env.SCRAPFLY_ISBNSEARCH_COUNTRY || 'us',
        render_js: 'false',
        tags: 'books,isbnsearch,project:books-sell',
    };

    if (process.env.SCRAPFLY_ISBNSEARCH_RESIDENTIAL !== 'false') {
        params.proxy_pool = 'public_residential_pool';
    }

    return params;
}

export function isIsbnSearchScrapflyEnabled() {
    return isScrapflyEnabled() && process.env.ISBNSEARCH_SCRAPFLY_ENABLED !== 'false';
}

/* ------------------------------ batch transport ------------------------------ */

function getBatchSize() {
    // Capped at 12: the js_scenario execute timeout is <=24s (Scrapfly's 30s
    // total budget) and each in-browser fetch takes ~1.5-2s.
    return Math.min(
        Math.max(Number(process.env.ISBNSEARCH_SCRAPFLY_BATCH_SIZE || 10), 2),
        12
    );
}

/**
 * In-browser script: fetch each path (same-origin), extract only the relevant
 * fragment (#searchresults for searches, #book for isbn pages) to keep the
 * scenario return payload small, and report per-path block/failure state.
 */
function buildIsbnSearchBatchScript(items) {
    return `
const items = ${JSON.stringify(items.map((item) => ({ key: item.key, type: item.type, path: item.path })))};

const results = [];

for (const item of items) {
  try {
    const response = await fetch(item.path, {
      method: "GET",
      headers: { "Accept": "text/html,application/xhtml+xml" },
      credentials: "include"
    });

    const text = await response.text();

    let html = null;
    try {
      const doc = new DOMParser().parseFromString(text, "text/html");
      const node = item.type === "isbn"
        ? doc.querySelector("#book")
        : doc.querySelector("#searchresults");
      html = node ? node.outerHTML : null;
    } catch (e) {
      html = null;
    }

    results.push({
      key: item.key,
      type: item.type,
      ok: response.ok,
      status: response.status,
      html,
      blocked: /please verify to continue|just a moment/i.test(text.slice(0, 4000)),
      sample: html ? null : text.replace(/\\s+/g, " ").slice(0, 200)
    });
  } catch (error) {
    results.push({
      key: item.key,
      type: item.type,
      ok: false,
      error: String(error)
    });
  }
}

return { ok: true, results };
`.trim();
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

    return null;
}

/**
 * Run one batched Scrapfly call fetching up to batchSize ISBNSearch pages
 * in-browser. Returns { ok, entries, scrapflyCost, requestId, logUrl, reason }.
 */
async function runIsbnSearchBatchCall(items) {
    // Scrapfly's total js_scenario budget is 30s: wait + execute must stay
    // under it or the whole call is rejected. 1s settle + <=24s execute = 25s.
    const executeTimeout = Math.min(24000, 6000 + items.length * 1800);

    const scenario = JSON.stringify([
        { wait: 1000 },
        {
            execute: {
                script: buildIsbnSearchBatchScript(items),
                timeout: executeTimeout,
            },
        },
    ]);

    const params = {
        asp: 'true',
        country: process.env.SCRAPFLY_ISBNSEARCH_COUNTRY || 'us',
        render_js: 'true',
        rendering_wait: '1000',
        tags: 'books,isbnsearch,batch,project:books-sell',
        js_scenario: toUrlSafeBase64(scenario),
    };

    if (process.env.SCRAPFLY_ISBNSEARCH_RESIDENTIAL !== 'false') {
        params.proxy_pool = 'public_residential_pool';
    }

    const response = await scrapflyScrape({
        url: `${ISBNSEARCH_BASE_URL}/`,
        params,
        timeoutMs: 240000,
    });

    if (!response.ok) {
        return {
            ok: false,
            entries: [],
            scrapflyCost: response.scrapflyCost,
            requestId: response.requestId,
            logUrl: response.logUrl,
            statusCode: response.statusCode,
            reason: response.reason,
        };
    }

    const scenarioResult = extractScenarioReturnValue(response.data);
    const entries = Array.isArray(scenarioResult?.results) ? scenarioResult.results : [];

    if (!entries.length) {
        return {
            ok: false,
            entries: [],
            scrapflyCost: response.scrapflyCost,
            requestId: response.requestId,
            logUrl: response.logUrl,
            statusCode: response.statusCode,
            reason: 'ISBNSearch js_scenario returned no results',
        };
    }

    return {
        ok: true,
        entries,
        scrapflyCost: response.scrapflyCost,
        requestId: response.requestId,
        logUrl: response.logUrl,
        statusCode: response.statusCode,
        reason: null,
    };
}

/* --------------------------------- lookup --------------------------------- */

/**
 * Run ISBNSearch lookups via Scrapfly.
 *
 * @param {object} options
 * @param {string[]} [options.queries] - title queries (page 1 of search results only)
 * @param {string[]} [options.isbns] - ISBNs to fetch /isbn/{isbn} pages for
 * @param {number} [options.maxCandidatesPerQuery]
 */
export async function runIsbnSearchScrapflyLookup({
    queries = [],
    isbns = [],
    maxCandidatesPerQuery = 5,
} = {}) {
    const candidatesByQuery = new Map();
    const candidatesByIsbn = new Map();
    const rawItems = [];
    const runs = [];
    const costEvents = [];

    let blocked = false;
    let attemptedCalls = 0;
    let failedCalls = 0;
    let totalScrapflyCost = 0;

    const result = () => ({
        candidatesByQuery,
        candidatesByIsbn,
        rawItems,
        blocked,
        runs,
        costEvents,
        attemptedCalls,
        failedCalls,
        totalScrapflyCost,
    });

    if (!isIsbnSearchScrapflyEnabled()) {
        console.warn('ISBNSearch Scrapfly lookup skipped: Scrapfly disabled or SCRAPFLY_KEY missing.');
        return result();
    }

    const maxCalls = Math.min(
        Math.max(Number(process.env.ISBNSEARCH_SCRAPFLY_MAX_CALLS || 20), 1),
        60
    );

    const registerCandidatesByIsbn = (candidates) => {
        for (const candidate of candidates) {
            const key = cleanIsbn(candidate.isbn || candidate.isbn13 || candidate.isbn10);

            if (!key) continue;

            if (!candidatesByIsbn.has(key)) {
                candidatesByIsbn.set(key, []);
            }

            candidatesByIsbn.get(key).push(candidate);
        }
    };

    const applySearchCandidates = (queryKey, candidates) => {
        const limited = candidates.slice(0, maxCandidatesPerQuery);
        candidatesByQuery.set(queryKey, limited);
        registerCandidatesByIsbn(limited);
    };

    const applyIsbnCandidate = (isbnKey, candidate) => {
        if (!candidate) return;

        if (!candidatesByIsbn.has(isbnKey)) {
            candidatesByIsbn.set(isbnKey, []);
        }

        candidatesByIsbn.get(isbnKey).push(candidate);
    };

    const cleanQueries = uniqueCleanValues(queries, normalizeText);
    const cleanIsbns = uniqueCleanValues(isbns.map(cleanIsbn).filter(Boolean), (v) => v);

    if (!cleanQueries.length && !cleanIsbns.length) {
        return result();
    }

    // Serve cache hits first; only uncached lookups become paid work.
    const pendingItems = [];

    for (const query of cleanQueries) {
        const queryKey = normalizeText(query);

        if (searchCacheByQuery.has(queryKey)) {
            applySearchCandidates(queryKey, searchCacheByQuery.get(queryKey));
            continue;
        }

        pendingItems.push({
            type: 'search',
            key: query,
            cacheKey: queryKey,
            path: `/search?s=${encodeURIComponent(query)}`,
        });
    }

    for (const isbn of cleanIsbns) {
        const isbnKey = cleanIsbn(isbn);

        if (!isbnKey) continue;

        if (isbnPageCache.has(isbnKey)) {
            applyIsbnCandidate(isbnKey, isbnPageCache.get(isbnKey));
            continue;
        }

        pendingItems.push({
            type: 'isbn',
            key: isbnKey,
            cacheKey: isbnKey,
            path: `/isbn/${isbnKey}`,
        });
    }

    if (!pendingItems.length) {
        console.log('ISBNSearch Scrapfly lookup served fully from cache.');
        return result();
    }

    const processEntry = (entry, item) => {
        const isSearch = item.type === 'search';

        if (entry?.blocked) {
            blocked = true;
        }

        if (!entry || entry.ok === false || (!entry.html && entry.blocked)) {
            console.warn(
                `ISBNSearch batch item failed type=${item.type} key="${item.key}": ${entry?.error || entry?.sample || `HTTP ${entry?.status}`}`
            );
            return { ok: false, candidates: [] };
        }

        if (isSearch) {
            const candidates = entry.html ? parseIsbnSearchSearchPage(entry.html) : [];

            searchCacheByQuery.set(item.cacheKey, candidates);
            applySearchCandidates(item.cacheKey, candidates);

            rawItems.push({
                type: 'search',
                query: item.key,
                candidates,
            });

            return { ok: true, candidates };
        }

        const candidate = entry.html ? parseIsbnSearchIsbnPage(entry.html, item.key) : null;

        // 404 = unknown ISBN: a real negative, cacheable.
        if (candidate || entry.status === 404) {
            isbnPageCache.set(item.cacheKey, candidate);
        }

        applyIsbnCandidate(item.cacheKey, candidate);

        if (candidate) {
            rawItems.push({
                type: 'isbn',
                requestedIsbn: item.key,
                candidates: [candidate],
            });
        }

        return { ok: true, candidates: candidate ? [candidate] : [] };
    };

    // ---------------- SINGLE mode: one lookup -> cheap non-rendered call ----------------
    if (pendingItems.length === 1) {
        const item = pendingItems[0];

        attemptedCalls += 1;

        const response = await scrapflyScrape({
            url: `${ISBNSEARCH_BASE_URL}${item.path}`,
            params: buildScrapflyParams(),
        });

        if (Number.isFinite(Number(response.scrapflyCost))) {
            totalScrapflyCost += Number(response.scrapflyCost);
        }

        runs.push({
            type: item.type,
            key: item.key,
            mode: 'single',
            ok: response.ok,
            statusCode: response.statusCode,
            requestId: response.requestId,
            scrapflyCost: response.scrapflyCost,
        });

        costEvents.push({
            costType: item.type === 'search' ? 'isbnsearch_search' : 'isbnsearch_isbn',
            provider: 'scrapfly',
            amount: response.scrapflyCost,
            unitCount: 1,
            unitType: item.type === 'search' ? 'query' : 'isbn',
            metadata: {
                [item.type === 'search' ? 'query' : 'isbn']: item.key,
                ok: response.ok,
                reason: response.reason || null,
                statusCode: response.statusCode,
                requestId: response.requestId,
                logUrl: response.logUrl,
            },
        });

        if (!response.ok || looksBlocked(response)) {
            failedCalls += 1;

            if (looksBlocked(response)) {
                blocked = true;
            }

            if (item.type === 'isbn' && response.statusCode === 404) {
                isbnPageCache.set(item.cacheKey, null);
            }

            console.warn(
                `ISBNSearch Scrapfly single ${item.type} failed key="${item.key}": ${response.reason || response.statusCode}`
            );
        } else {
            processEntry(
                { key: item.key, type: item.type, ok: true, status: response.statusCode, html: response.html, blocked: false },
                item
            );
        }

        console.log(
            `ISBNSearch Scrapfly lookup finished (single): queryKeys=${candidatesByQuery.size}, isbnKeys=${candidatesByIsbn.size}, blocked=${blocked}, totalCost=${totalScrapflyCost}`
        );

        return result();
    }

    // ---------------- BATCH mode: 2+ lookups -> rendered js_scenario calls ----------------
    const batchSize = getBatchSize();
    const chunks = [];

    for (let index = 0; index < pendingItems.length; index += batchSize) {
        chunks.push(pendingItems.slice(index, index + batchSize));
    }

    console.log(
        `ISBNSearch Scrapfly BATCH lookup planned: queries=${cleanQueries.length}, isbns=${cleanIsbns.length}, pending=${pendingItems.length}, batches=${chunks.length}, batchSize=${batchSize}`
    );

    for (const [chunkIndex, chunk] of chunks.entries()) {
        if (blocked) {
            console.warn(
                `ISBNSearch batch stopped before chunk ${chunkIndex + 1}/${chunks.length}: blocked.`
            );
            break;
        }

        if (attemptedCalls >= maxCalls) {
            console.warn('ISBNSearch batch stopped: maxCalls budget reached.');
            break;
        }

        // The rendered page is occasionally flaky: retry one extra time per chunk.
        let batch = null;

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            attemptedCalls += 1;

            batch = await runIsbnSearchBatchCall(chunk);

            if (Number.isFinite(Number(batch.scrapflyCost))) {
                totalScrapflyCost += Number(batch.scrapflyCost);
            }

            runs.push({
                type: 'batch',
                mode: 'batch',
                attempt,
                items: chunk.map((item) => ({ type: item.type, key: item.key })),
                ok: batch.ok,
                statusCode: batch.statusCode,
                requestId: batch.requestId,
                scrapflyCost: batch.scrapflyCost,
            });

            costEvents.push({
                costType: 'isbnsearch_batch_lookup',
                provider: 'scrapfly',
                amount: batch.scrapflyCost,
                unitCount: chunk.length,
                unitType: 'page',
                metadata: {
                    ok: batch.ok,
                    attempt,
                    queries: chunk.filter((item) => item.type === 'search').map((item) => item.key),
                    isbns: chunk.filter((item) => item.type === 'isbn').map((item) => item.key),
                    reason: batch.reason || null,
                    statusCode: batch.statusCode ?? null,
                    requestId: batch.requestId || null,
                    logUrl: batch.logUrl || null,
                },
            });

            if (batch.ok) break;

            failedCalls += 1;

            console.warn(
                `ISBNSearch batch chunk ${chunkIndex + 1}/${chunks.length} attempt ${attempt} failed: ${batch.reason}`
            );
        }

        if (!batch?.ok) {
            continue;
        }

        const entriesByKey = new Map(
            batch.entries.map((entry) => [`${entry.type}:${entry.key}`, entry])
        );

        let chunkParsed = 0;
        let chunkFailedItems = 0;

        for (const item of chunk) {
            const entry = entriesByKey.get(`${item.type}:${item.key}`);
            const outcome = processEntry(entry, item);

            if (outcome.ok) {
                chunkParsed += 1;
            } else {
                chunkFailedItems += 1;
            }
        }

        console.log(
            `ISBNSearch batch chunk ${chunkIndex + 1}/${chunks.length} done: items=${chunk.length}, parsed=${chunkParsed}, failedItems=${chunkFailedItems}, cost=${batch.scrapflyCost}, blocked=${blocked}`
        );
    }

    console.log(
        `ISBNSearch Scrapfly lookup finished (batch): calls=${attemptedCalls}, failedCalls=${failedCalls}, queryKeys=${candidatesByQuery.size}, isbnKeys=${candidatesByIsbn.size}, blocked=${blocked}, totalCost=${totalScrapflyCost}`
    );

    return result();
}

/**
 * Fetch and parse a single /isbn/{isbn} page (used to verify the final
 * accepted ISBN of a book). Returns { candidate, costEvent, ok, reason }.
 */
export async function fetchIsbnSearchIsbnPage(isbn) {
    const isbnKey = cleanIsbn(isbn);

    if (!isbnKey) {
        return { ok: false, candidate: null, costEvent: null, reason: 'invalid isbn' };
    }

    if (!isIsbnSearchScrapflyEnabled()) {
        return { ok: false, candidate: null, costEvent: null, reason: 'scrapfly disabled' };
    }

    if (isbnPageCache.has(isbnKey)) {
        return {
            ok: true,
            cached: true,
            candidate: isbnPageCache.get(isbnKey),
            costEvent: null,
            reason: null,
        };
    }

    const url = `${ISBNSEARCH_BASE_URL}/isbn/${isbnKey}`;
    const response = await scrapflyScrape({ url, params: buildScrapflyParams() });

    const costEvent = {
        costType: 'isbnsearch_isbn_verify',
        provider: 'scrapfly',
        amount: response.scrapflyCost,
        unitCount: 1,
        unitType: 'isbn',
        metadata: {
            isbn: isbnKey,
            ok: response.ok,
            reason: response.reason || null,
            statusCode: response.statusCode,
            requestId: response.requestId,
            logUrl: response.logUrl,
        },
    };

    if (!response.ok) {
        if (response.statusCode === 404) {
            isbnPageCache.set(isbnKey, null);
        }

        return { ok: false, candidate: null, costEvent, reason: response.reason };
    }

    const candidate = parseIsbnSearchIsbnPage(response.html, isbnKey);

    isbnPageCache.set(isbnKey, candidate);

    return { ok: true, candidate, costEvent, reason: null };
}
