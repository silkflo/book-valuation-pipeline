// src/services/catalog/abebooksCatalogSource.js
//
// AbeBooks.fr as a standalone CATALOG candidate source (Phase 1).
//
// Purpose (new edition-verification strategy): catalog sources — AbeBooks now,
// ISBNSearch / ISBNdb later — provide candidate ISBNs AND cover images that we
// compare against the Leboncoin crop to confirm the exact edition BEFORE any
// provider (Momox/Gibert) is asked for a price. Momox/Gibert become price-only.
//
// SCOPE (Phase 1): this module ONLY searches AbeBooks and returns candidates.
// It does NOT touch the provider flow, write to the DB, or send anything to
// Momox/Gibert. It reuses the shared Scrapfly client (SCRAPFLY_KEY) so it gets
// the same UTF-8, error and cost handling as the other Scrapfly sources.
//
// Verified manually 2026-06-15: AbeBooks.fr via Scrapfly with render_js=false,
// asp=true, country=fr returns HTTP 200 at cost ~1 and exposes cover image URLs
// like https://pictures.abebooks.com/isbn/9782253004271-fr-300.jpg — the ISBN13
// is embedded directly in the image URL.

import dotenv from 'dotenv';
import * as cheerio from 'cheerio';

import { scrapflyScrape, isScrapflyEnabled } from '../scrapflyClient.js';

dotenv.config();

const ABEBOOKS_SEARCH_URL = 'https://www.abebooks.fr/servlet/SearchResults';
const ABEBOOKS_BASE_URL = 'https://www.abebooks.fr';

// Cover images live on this CDN; the ISBN is the path segment after /isbn/.
const ABEBOOKS_IMAGE_RE = /pictures\.abebooks\.com\/isbn\/([0-9Xx]{10,13})-[a-z]{2}-\d+\.(jpe?g|webp|avif|png)/gi;

/* --------------------------------- helpers -------------------------------- */

function cleanText(value) {
    return String(value || '')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim();
}

// ISBN-10 -> ISBN-13 (978 prefix + recomputed check digit), so a candidate is
// always keyed by a 13-digit ISBN regardless of which form the image URL used.
function toIsbn13(raw) {
    const value = String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();

    if (/^\d{13}$/.test(value)) {
        return value;
    }

    if (/^\d{9}[\dX]$/.test(value)) {
        const core = `978${value.slice(0, 9)}`;
        let sum = 0;
        for (let i = 0; i < 12; i += 1) {
            sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
        }
        const check = (10 - (sum % 10)) % 10;
        return `${core}${check}`;
    }

    return null;
}

function absoluteAbebooksUrl(value) {
    if (!value) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.startsWith('http://') || text.startsWith('https://')) return text;
    if (text.startsWith('//')) return `https:${text}`;
    if (text.startsWith('/')) return `${ABEBOOKS_BASE_URL}${text}`;
    return `${ABEBOOKS_BASE_URL}/${text}`;
}

// Collect every URL referenced by an <img> (src + lazy-load + srcset variants),
// keep only AbeBooks ISBN cover URLs, and PREFER .jpg over .webp/.avif/.png.
function pickAbebooksImageUrl($img) {
    const raw = [
        $img.attr('src'),
        $img.attr('data-src'),
        $img.attr('data-original'),
        $img.attr('data-lazy'),
        $img.attr('srcset'),
        $img.attr('data-srcset'),
    ]
        .filter(Boolean)
        .flatMap((attr) => String(attr).split(',').map((part) => part.trim().split(/\s+/)[0]))
        .filter(Boolean);

    const covers = raw.filter((url) => /pictures\.abebooks\.com\/isbn\//i.test(url));
    if (!covers.length) return null;

    const jpg = covers.find((url) => /\.jpe?g(\?|$)/i.test(url));
    return jpg || covers[0];
}

function extractIsbn13FromUrl(url) {
    const match = String(url || '').match(/\/isbn\/([0-9Xx]{10,13})-/i);
    return match ? toIsbn13(match[1]) : null;
}

// First non-empty text among a list of selectors, scoped to a container.
function firstText($, container, selectors) {
    for (const selector of selectors) {
        const node = container.find(selector).first();
        if (!node.length) continue;
        const text = cleanText(node.attr('content') || node.text());
        if (text) return text;
    }
    return null;
}

function extractYear(text) {
    const match = String(text || '').match(/\b(1[5-9]\d{2}|20\d{2})\b/);
    return match ? Number(match[0]) : null;
}

/* --------------------------------- parser --------------------------------- */

/**
 * Parse an AbeBooks.fr SearchResults page into catalog candidates.
 *
 * Strategy: anchor on the cover image (the ISBN lives in its URL — the most
 * reliable signal), then enrich title/author/publisher/year/language from the
 * enclosing listing container via Cheerio when present. A raw image-URL scan is
 * a SUPPLEMENT (not the sole parser) so ISBNs that only appear in srcset/JSON
 * blobs still yield an isbn13 + imageUrl candidate.
 *
 * Returns candidates with BOTH isbn13 and imageUrl, deduped by isbn13.
 */
export function parseAbebooksSearchPage(html) {
    const $ = cheerio.load(html || '');
    const byIsbn = new Map();

    // 1) Structured pass: every <img>, walk up to its listing container.
    $('img').each((_, element) => {
        const $img = $(element);
        const imageUrl = pickAbebooksImageUrl($img);
        if (!imageUrl) return;

        const isbn13 = extractIsbn13FromUrl(imageUrl);
        if (!isbn13 || byIsbn.has(isbn13)) return;

        const container = $img.closest(
            '[data-cy="listing-item"], li.cf, li.result, li[data-cy], li, article, div.result, tr'
        );
        const scope = container.length ? container : $img.parent();

        const title = firstText($, scope, [
            '[data-cy="listing-title"]',
            'h2[itemprop="name"]',
            'span[itemprop="name"]',
            'meta[itemprop="name"]',
            'a.title',
            '.result-title',
            'h2 a',
        ]) || cleanText($img.attr('alt')) || null;

        const author = firstText($, scope, [
            '[data-cy="listing-author"]',
            'span[itemprop="author"]',
            '.author',
            '.result-author',
        ]);

        const publisherRaw = firstText($, scope, [
            '[data-cy="listing-publisher"]',
            'span[itemprop="publisher"]',
            '.publisher',
            '.result-publisher',
        ]);

        const language = firstText($, scope, [
            '[data-cy="listing-language"]',
            'span[itemprop="inLanguage"]',
            '.language',
        ]);

        const listingHref =
            scope.find('a[href*="/servlet/"], a[itemprop="url"], h2 a, a.title').first().attr('href') || null;

        byIsbn.set(isbn13, {
            isbn13,
            title: title || null,
            author: author || null,
            publisher: publisherRaw || null,
            year: extractYear(publisherRaw) || extractYear(scope.text()),
            language: language || null,
            imageUrl,
            listingUrl: absoluteAbebooksUrl(listingHref),
            source: 'abebooks',
        });
    });

    // 2) Supplement: raw image-URL scan catches covers not in an <img src>
    //    (srcset-only, JSON state, etc.). Minimal candidate (isbn13 + imageUrl).
    let match;
    ABEBOOKS_IMAGE_RE.lastIndex = 0;
    while ((match = ABEBOOKS_IMAGE_RE.exec(html || '')) !== null) {
        const isbn13 = toIsbn13(match[1]);
        const imageUrl = `https://${match[0]}`;
        if (!isbn13 || byIsbn.has(isbn13)) continue;
        if (!/\.jpe?g$/i.test(imageUrl)) continue; // prefer .jpg for the bare fallback
        byIsbn.set(isbn13, {
            isbn13,
            title: null,
            author: null,
            publisher: null,
            year: null,
            language: null,
            imageUrl,
            listingUrl: null,
            source: 'abebooks',
        });
    }

    // Keep only candidates with BOTH isbn13 and imageUrl (Phase 1 contract).
    return [...byIsbn.values()].filter((c) => c.isbn13 && c.imageUrl);
}

/* --------------------------------- fetch ---------------------------------- */

export function isAbebooksCatalogEnabled() {
    return isScrapflyEnabled() && process.env.ABEBOOKS_SCRAPFLY_ENABLED !== 'false';
}

export function buildAbebooksSearchUrl({ title, author }) {
    const keywords = [title, author].map((v) => cleanText(v)).filter(Boolean).join(' ');
    // sortby=17 = AbeBooks "relevance" ranking (matches the verified manual test).
    return `${ABEBOOKS_SEARCH_URL}?kn=${encodeURIComponent(keywords)}&sortby=17`;
}

/**
 * Search AbeBooks.fr for catalog candidates (ISBN13 + cover image) for a book.
 *
 * @param {object} options
 * @param {string} options.title       - required
 * @param {string} [options.author]    - optional, appended to the keyword search
 * @param {number} [options.maxResults] - default 10
 * @param {string} [options.country]   - Scrapfly proxy country (default fr / env)
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{query,source,scrapflyCost,candidates,count,ok,reason,statusCode,requestId,logUrl}>}
 *   Never throws on network/Scrapfly errors — inspect `ok`.
 */
export async function fetchAbebooksCatalogCandidates({
    title,
    author = null,
    maxResults = 10,
    country = process.env.SCRAPFLY_ABEBOOKS_COUNTRY || 'fr',
    timeoutMs = 120000,
} = {}) {
    const cleanTitle = cleanText(title);
    const query = buildAbebooksSearchUrl({ title: cleanTitle, author });

    const base = {
        query,
        source: 'abebooks',
        scrapflyCost: null,
        candidates: [],
        count: 0,
        ok: false,
        reason: null,
        statusCode: null,
        requestId: null,
        logUrl: null,
    };

    if (!cleanTitle) {
        return { ...base, reason: 'missing title' };
    }

    if (!isAbebooksCatalogEnabled()) {
        return { ...base, reason: 'AbeBooks catalog disabled or SCRAPFLY_KEY missing' };
    }

    // Matches the verified manual test: asp + fr + NO JS render (cost ~1) + retry.
    const params = {
        asp: 'true',
        country,
        render_js: 'false',
        retry: 'true',
        tags: 'books,abebooks,catalog,project:books-sell',
    };

    if (process.env.SCRAPFLY_ABEBOOKS_RESIDENTIAL === 'true') {
        params.proxy_pool = 'public_residential_pool';
    }

    const response = await scrapflyScrape({ url: query, params, timeoutMs });

    if (!response.ok) {
        return {
            ...base,
            scrapflyCost: response.scrapflyCost,
            statusCode: response.statusCode,
            requestId: response.requestId,
            logUrl: response.logUrl,
            reason: response.reason || `HTTP ${response.statusCode}`,
        };
    }

    const allCandidates = parseAbebooksSearchPage(response.html);
    const candidates = allCandidates.slice(0, Math.max(1, Number(maxResults) || 10));

    return {
        ...base,
        ok: true,
        scrapflyCost: response.scrapflyCost,
        statusCode: response.statusCode,
        requestId: response.requestId,
        logUrl: response.logUrl,
        candidates,
        count: candidates.length,
    };
}
