// src/services/catalog/abebooksCoverByIsbn.js
//
// Cover-by-ISBN catalog source (Phase 4). The AbeBooks image CDN is keyed by
// ISBN, so for any ISBN we ALREADY have (from ISBNSearch / the pipeline) we can
// fetch its cover directly — no keyword search, no Scrapfly credit:
//
//   https://pictures.abebooks.com/isbn/<ISBN13>-fr-300.jpg
//
// This is the PRIMARY candidate source for image verification (keyword search
// becomes a fallback): it avoids the keyword coverage gap that made the seller's
// exact edition disappear from the top-10 (e.g. Le Père Goriot Folio).
//
// Standalone: plain HTTP GET against the public CDN. No Scrapfly, no DB, no
// provider calls. Validates that the URL returns a real image (200 + image/* +
// a reasonable byte size, so AbeBooks "no cover" placeholders are rejected).

import dotenv from 'dotenv';

import { mapWithConcurrency } from '../scrapflyClient.js';

dotenv.config();

const ABEBOOKS_CDN = 'https://pictures.abebooks.com/isbn';

function num(envName, fallback) {
    const v = Number(process.env[envName]);
    return Number.isFinite(v) ? v : fallback;
}

// Real covers observed at 13-90 KB; missing-cover placeholders are tiny. Floor
// rejects placeholders without dropping genuine small thumbnails.
const MIN_BYTES = num('ABEBOOKS_COVER_MIN_BYTES', 1500);
const CONCURRENCY = num('ABEBOOKS_COVER_CONCURRENCY', 4);
const TIMEOUT_MS = num('ABEBOOKS_COVER_TIMEOUT_MS', 15000);

function cleanIsbn13(value) {
    const s = String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    return /^\d{13}$/.test(s) ? s : null;
}

/**
 * Candidate AbeBooks cover URLs for an ISBN13, most-likely first. The fr variant
 * is the verified primary; en/us cover non-French editions (e.g. English
 * editions of Lord of the Flies / Sa Majesté des Mouches).
 */
export function buildAbebooksCoverUrls(isbn13) {
    return [
        `${ABEBOOKS_CDN}/${isbn13}-fr-300.jpg`,
        `${ABEBOOKS_CDN}/${isbn13}-en-300.jpg`,
        `${ABEBOOKS_CDN}/${isbn13}-us-300.jpg`,
    ];
}

async function getImageMeta(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, contentType: res.headers.get('content-type'), bytes: buf.length };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolve the first valid AbeBooks cover for one ISBN. Never throws.
 * @returns {Promise<{isbn13, ok, imageUrl, status, bytes, contentType, source, tried, reason}>}
 */
export async function fetchAbebooksCoverForIsbn(isbn, { minBytes = MIN_BYTES, timeoutMs = TIMEOUT_MS } = {}) {
    const isbn13 = cleanIsbn13(isbn);
    if (!isbn13) {
        return { isbn13: null, ok: false, imageUrl: null, reason: 'invalid isbn13', tried: [] };
    }

    const tried = [];

    for (const url of buildAbebooksCoverUrls(isbn13)) {
        try {
            const meta = await getImageMeta(url, timeoutMs);
            tried.push({ url, status: meta.status, bytes: meta.bytes, contentType: meta.contentType });

            const valid =
                meta.status === 200 &&
                /^image\//i.test(meta.contentType || '') &&
                meta.bytes >= minBytes;

            if (valid) {
                return {
                    isbn13,
                    ok: true,
                    imageUrl: url,
                    status: meta.status,
                    bytes: meta.bytes,
                    contentType: meta.contentType,
                    source: 'abebooks_cdn',
                    tried,
                    reason: null,
                };
            }
        } catch (error) {
            tried.push({ url, error: error.message });
        }
    }

    return { isbn13, ok: false, imageUrl: null, source: 'abebooks_cdn', tried, reason: 'no valid cover' };
}

/**
 * Resolve covers for many ISBNs concurrently (deduped). No Scrapfly.
 * @returns {Promise<Array>} one result per unique ISBN (see fetchAbebooksCoverForIsbn).
 */
export async function fetchAbebooksCoversForIsbns(isbns, options = {}) {
    const unique = [...new Set((isbns || []).map(cleanIsbn13).filter(Boolean))];
    if (!unique.length) return [];

    return mapWithConcurrency(
        unique,
        options.concurrency || CONCURRENCY,
        (isbn) => fetchAbebooksCoverForIsbn(isbn, options)
    );
}
