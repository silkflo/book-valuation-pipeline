// src/services/lensFallback.js
//
// GOOGLE LENS VISUAL FALLBACK (gated, runs AFTER the catalog gate, BEFORE the provider
// batch). For held/unresolved physical books that still have a visible crop, send the
// crop image to the Gio Google Lens Apify actor, extract ISBN candidates from the
// visual/exact/ai matches + AI summary, then VERIFY each through the SAME chain as the
// AI fallback before it may merge into the single provider batch:
//   checksum -> exact ISBN lookup (real metadata) -> title compatibility (no semantic
//   contradiction) -> the SAME catalogEligibilityForBook cover gate -> merge (<=1/book).
//
// Lens is candidate DISCOVERY ONLY. A Lens ISBN is NEVER sent to a provider directly:
// it is pinned to MEDIUM_MIN confidence and merges only on a cover-verified gate result.
//
// IMPORTANT: this actor uses APIFY_TOKEN2 (a second token), never APIFY_TOKEN.
// No DB writes; no provider calls.

import { ApifyClient } from 'apify-client';
import { fetchIsbnSearchIsbnPage } from './isbnSearchScrapflyClient.js';
import {
    catalogEligibilityForBook,
    titlesCompatible,
    hasSemanticContradiction,
} from './catalog/verifyCatalogForAd.js';
import { normalizeToIsbn13, isValidIsbn13, COVER_VERIFIED_REASONS } from './aiIsbnFallback.js';

function num(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
}
function bool(name, fallback) {
    const v = process.env[name];
    if (v === undefined) return fallback;
    return v === 'true';
}

// Lens-origin ISBNs are pinned to MEDIUM_MIN (same value the gate uses) — never higher.
const MEDIUM_MIN = num('AI_FB_MIN_DERIVED_CONFIDENCE', num('CATALOG_MEDIUM_ISBN_MIN_CONFIDENCE', 0.5));

// Held gate reasons that warrant a Lens visual retry (book has a crop but no safe ISBN).
const LENS_TRIGGER_REASONS = new Set([
    'poor_crop_needs_cover_match',
    'poor_crop_selected_exact_low_confidence',
    'poor_crop_selected_exact_title_conflict',
    'poor_crop_unverified_budget',
    'needs_verification',
    'crop_too_small',
    'catalog_no_match',
    'catalog_needs_verification',
    'not_found',
    'not_eligible',
]);
export function isLensTriggerReason(reason) {
    return LENS_TRIGGER_REASONS.has(reason);
}

// Recoverable hold reasons for a PER-BOOK Lens retry (decoupled from the global trigger).
const LENS_RECOVERABLE_REASONS = new Set([
    'poor_crop_needs_cover_match',
    'poor_crop_selected_exact_low_confidence',
    'needs_verification',
    'not_found',
    // other held states that still have a usable (risky/borderline/good) crop:
    'poor_crop_unverified_budget',
    'poor_crop_selected_exact_title_conflict',
    'catalog_no_match',
    'catalog_needs_verification',
]);

/**
 * PER-PHYSICAL-BOOK decision: should Google Lens run for this held book? Independent of the
 * global sparse/zero trigger. Qualifies when the book was held (not sent), has a usable crop
 * (valid bbox), and the hold reason is recoverable. `crop_too_small` is included ONLY with
 * useful evidence — a detected/visible title or raw visible text AND high confidence —
 * so totally unusable crops are never sent. Returns { ok, reason }.
 */
export function shouldRunLensForBook(book = {}, opts = {}) {
    const {
        includeCropTooSmall = process.env.LENS_INCLUDE_CROP_TOO_SMALL !== 'false',
        cropTooSmallMinConf = num('LENS_CROP_TOO_SMALL_MIN_CONF', 0.8),
        recoverableReasons = LENS_RECOVERABLE_REASONS,
    } = opts;
    if (book.sent) return { ok: false, reason: 'already_sent' };
    if (!Array.isArray(book.bbox) || book.bbox.length !== 4) return { ok: false, reason: 'no_bbox' };
    const reason = book.reason || null;
    if (recoverableReasons.has(reason)) return { ok: true, reason };
    if (reason === 'crop_too_small') {
        if (!includeCropTooSmall) return { ok: false, reason: 'crop_too_small_excluded' };
        const hasText = Boolean(String(book.observedTitle || '').trim() || String(book.rawText || '').trim());
        const conf = Number(book.confidence) || 0;
        if (hasText && conf >= cropTooSmallMinConf) return { ok: true, reason: 'crop_too_small_with_evidence' };
        return { ok: false, reason: 'crop_too_small_no_evidence' };
    }
    return { ok: false, reason: `non_recoverable:${reason || 'unknown'}` };
}

/** Select the held books Lens should run on (per-book), keeping per-book skip reasons. */
export function selectLensCandidates(books = [], opts = {}) {
    const candidates = [];
    const skipped = [];
    for (const b of books) {
        const d = shouldRunLensForBook(b, opts);
        if (d.ok) candidates.push({ book: b, reason: d.reason });
        else skipped.push({ book: b, reason: d.reason });
    }
    return { run: candidates.length > 0, candidates, skipped };
}

/** Best-effort input-URL field on a Lens dataset item (varies by actor version). */
function lensItemImageUrl(item) {
    return item?.imageUrl || item?.url || item?.searchImageUrl || item?.inputImageUrl || item?.input || item?.image || null;
}

/**
 * Map batched actor dataset items back to the input imageUrls. Tries an imageUrl-like field
 * first (every item must carry one and at least one must match an input), then falls back to
 * positional/index mapping when counts line up. Returns an array aligned to imageUrls (each
 * entry = the item(s) for that URL), or null when mapping is unreliable (caller does per-image).
 */
export function mapItemsToInputs(items, imageUrls) {
    const list = Array.isArray(items) ? items : [];
    const byUrl = new Map();
    let withUrl = 0;
    for (const it of list) {
        const u = lensItemImageUrl(it);
        if (u) { withUrl += 1; if (!byUrl.has(u)) byUrl.set(u, []); byUrl.get(u).push(it); }
    }
    if (list.length > 0 && withUrl === list.length && imageUrls.some((u) => byUrl.has(u))) {
        return imageUrls.map((u) => byUrl.get(u) || []);
    }
    if (list.length === imageUrls.length) return imageUrls.map((_, i) => [list[i]]);
    return null;
}

// ---------------------------------------------------------------------------
// Apify token + runner. MUST use APIFY_TOKEN2 (never APIFY_TOKEN).
// ---------------------------------------------------------------------------
export function lensApifyToken() {
    const token = process.env.APIFY_TOKEN2;
    if (!token) throw new Error('Missing APIFY_TOKEN2 — Google Lens fallback must not use APIFY_TOKEN');
    return token;
}

/**
 * Public base for the crop image URL sent to the Lens actor. LENS_PUBLIC_BASE_URL first,
 * then PUBLIC_WEBHOOK_BASE_URL. On the VPS set LENS_PUBLIC_BASE_URL to the real public
 * backend/domain (not ngrok / not a Cloudflare quick tunnel). Empty string if unset.
 */
export function lensPublicBaseUrl() {
    const lens = (process.env.LENS_PUBLIC_BASE_URL || '').trim();
    const hook = (process.env.PUBLIC_WEBHOOK_BASE_URL || '').trim();
    return lens || hook || '';
}

export async function runLensActor({ imageUrls = [], country, language, includeAiMode, useApifyProxy, maxImages, waitSecs = 120 } = {}) {
    const client = new ApifyClient({ token: lensApifyToken() });
    const actorId = process.env.GOOGLE_LENS_ACTOR_ID;
    if (!actorId) throw new Error('Missing GOOGLE_LENS_ACTOR_ID');
    const input = {
        imageUrls,
        country: country || process.env.LENS_FALLBACK_COUNTRY || 'FR',
        language: language || process.env.LENS_FALLBACK_LANGUAGE || 'fr',
        includeAiMode: includeAiMode ?? bool('LENS_FALLBACK_INCLUDE_AI', true),
        useApifyProxy: useApifyProxy ?? bool('LENS_FALLBACK_USE_PROXY', false),
        maxImages: maxImages ?? num('LENS_FALLBACK_MAX_IMAGES', 20),
    };
    const run = await client.actor(actorId).call(input, { waitSecs });
    if (!run?.defaultDatasetId) return { items: [], run };
    const ds = await client.dataset(run.defaultDatasetId).listItems({ limit: 100, clean: true });
    return { items: Array.isArray(ds?.items) ? ds.items : [], run };
}

// ---------------------------------------------------------------------------
// Lens output normalization + ISBN extraction.
// ---------------------------------------------------------------------------
/** Flatten dataset items into a match list + concatenated AI summary. */
export function normalizeLensItems(items) {
    const matches = [];
    let aiSummary = '';
    for (const it of (Array.isArray(items) ? items : [])) {
        for (const vm of it.visualMatches || []) matches.push({ link: vm.link || vm.url || null, title: vm.title || null, source: vm.source || null, matchType: 'visual' });
        for (const em of it.exactMatches || []) matches.push({ link: em.link || em.url || null, title: em.title || null, source: em.source || null, matchType: 'exact' });
        for (const am of it.aiMatches || []) matches.push({ link: am.link || am.url || null, title: am.title || null, source: am.source || null, matchType: 'ai' });
        if (it.aiSummary) aiSummary += ` ${it.aiSummary}`;
    }
    return { matches, aiSummary: aiSummary.trim() };
}

/** Google homepage / doodle / static asset links carry no real ISBN — skip them. */
export function isGoogleNoise(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return true;
    if (u.includes('gstatic.com') || u.includes('googlelogo') || u.includes('/doodle')) return true;
    if (/\/\/(www\.)?google\.[a-z.]+\/?($|[?#])/.test(u)) return true;               // google homepage
    if (/\/\/(www\.)?google\.[a-z.]+\/(search|imgres|url|preferences|setprefs)\b/.test(u)) return true;
    return false;
}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

/** Find checksum-valid ISBNs in a single text/URL string (ISBN-13 + Amazon/dp ISBN-10 + generic ISBN-10). */
export function findIsbnsInText(text) {
    const s = String(text || '');
    const out = [];
    // ISBN-13: 978/979 followed by 10 more digits (single hyphen/space separators tolerated).
    for (const m of s.matchAll(/(?:97[89])(?:[\s-]?\d){10}/g)) {
        const d = m[0].replace(/\D/g, '');
        if (d.length === 13 && isValidIsbn13(d)) out.push({ isbn13: d, via: 'isbn13' });
    }
    // Amazon /dp/<10> (and /gp/product/<10>).
    for (const m of s.matchAll(/\/(?:dp|gp\/product)\/([0-9]{9}[0-9xX])/g)) {
        const i13 = normalizeToIsbn13(m[1]);
        if (i13) out.push({ isbn13: i13, via: 'amazon_dp' });
    }
    // Generic ISBN-10 tokens (validated by checksum so random 10-digit ids are dropped).
    for (const m of s.matchAll(/(?<![0-9A-Za-z])([0-9]{9}[0-9xX])(?![0-9A-Za-z])/g)) {
        const i13 = normalizeToIsbn13(m[1]);
        if (i13) out.push({ isbn13: i13, via: 'isbn10' });
    }
    return out;
}

/**
 * Extract deduped ISBN candidates (with provenance) from normalized Lens output.
 * Skips Google-noise links and empty matches. AI-summary text is scanned too.
 */
export function extractIsbnCandidates({ matches = [], aiSummary = '' } = {}) {
    const byIsbn = new Map();
    const add = (isbn13, prov) => { if (isbn13 && !byIsbn.has(isbn13)) byIsbn.set(isbn13, { isbn13, ...prov }); };

    for (const mt of matches) {
        const link = mt.link || '';
        const title = mt.title || '';
        if (isGoogleNoise(link)) continue;        // ignore google homepage/doodle
        if (!link && !title) continue;            // ignore empty matches
        const source = hostOf(link) || mt.source || null;
        for (const f of findIsbnsInText(link)) add(f.isbn13, { via: f.via === 'amazon_dp' ? 'amazon_dp' : 'lens_url', source, sourceUrl: link, sourceTitle: title || null, matchType: mt.matchType });
        for (const f of findIsbnsInText(title)) add(f.isbn13, { via: 'lens_title', source, sourceUrl: link || null, sourceTitle: title, matchType: mt.matchType });
    }
    for (const f of findIsbnsInText(aiSummary)) add(f.isbn13, { via: 'lens_ai_summary', source: 'ai_summary', sourceUrl: null, sourceTitle: null, matchType: 'ai_summary' });

    return [...byIsbn.values()];
}

// ---------------------------------------------------------------------------
// Orchestrator (dependency-injected so it is fully testable offline).
// ---------------------------------------------------------------------------
export async function runLensFallback({
    adsId,
    heldBooks = [],
    keywordBudgetRemaining = Infinity,
    maxBooksPerAd = num('LENS_FALLBACK_MAX_BOOKS_PER_AD', 0), // 0 = unlimited
    maxCandidatesPerBook = num('LENS_MAX_CANDIDATES_PER_BOOK', 5),
    deps = {},
} = {}) {
    const {
        runActor = runLensActor,
        exactLookup = fetchIsbnSearchIsbnPage,
        runGate = catalogEligibilityForBook,
    } = deps;

    const books = (maxBooksPerAd && maxBooksPerAd > 0) ? heldBooks.slice(0, maxBooksPerAd) : heldBooks;
    const recovered = new Map(); // physicalBookKey -> merged candidate (max 1/book)
    const attempted = [];
    const stats = { books: books.length, actorCalls: 0, extracted: 0, merged: 0, exactLookups: 0, visionUsd: 0, keywordUsed: 0 };

    const logCand = (rec) => console.log(
        `[lens-fallback] isbn=${rec.isbn13} source=${rec.source || '-'} lookup=${rec.lookup ? 'found' : 'none'} ` +
        `titleCompat=${rec.titleCompatible === undefined || rec.titleCompatible === null ? '-' : (rec.titleCompatible ? 'y' : 'n')} ` +
        `gate=${rec.gate?.reason || '-'} coverSim=${rec.gate?.bestSimilarity ?? '-'} -> ${rec.status}`
    );

    // Exact lookup (ISBNSearch) — requires REAL metadata (a title). Memoized.
    const lookupMemo = new Map();
    const lookupOne = async (isbn13) => {
        if (lookupMemo.has(isbn13)) return lookupMemo.get(isbn13);
        let result = null;
        try {
            const r = await exactLookup(isbn13);
            stats.exactLookups += 1;
            if (r?.ok && r.candidate?.title) {
                result = {
                    title: r.candidate.title,
                    author: r.candidate.authors || r.candidate.author || null,
                    publisher: r.candidate.publisher || null,
                    coverUrl: r.candidate.imageUrl || null,
                    source: 'isbnsearch',
                };
            }
        } catch { /* none */ }
        lookupMemo.set(isbn13, result);
        return result;
    };

    // Verify ONE Lens-discovered ISBN: exact lookup -> title compat -> the SAME cover gate.
    const evaluate = async (hb, cand) => {
        const rec = {
            physicalBookKey: hb.physicalBookKey, bookIndex: hb.bookIndex, isbn13: cand.isbn13,
            source: cand.source, via: cand.via, sourceUrl: cand.sourceUrl || null, lensTitle: cand.sourceTitle || null,
            aiSummary: cand.via === 'lens_ai_summary' ? true : undefined, status: null,
        };
        const lk = await lookupOne(cand.isbn13);
        if (!lk) { rec.status = 'held_no_lookup'; return rec; } // exact lookup must confirm real metadata
        rec.lookup = lk;

        const observed = hb.observedTitle || hb.ocrText || null;
        const catalogTitle = lk.title || null;
        if (observed && catalogTitle) {
            rec.titleCompatible = titlesCompatible(observed, catalogTitle) && !hasSemanticContradiction(observed, catalogTitle);
            if (!rec.titleCompatible) { rec.status = 'held_title'; return rec; } // wrong title -> block
        } else {
            rec.titleCompatible = null; // no observed title available -> rely on the cover gate
        }

        const syntheticBook = {
            isbn: cand.isbn13, isbn_source: 'lens_fallback_verified', isbn_is_valid: true, isbn_confidence: MEDIUM_MIN,
            title: observed, possible_corrected_title: hb.possibleCorrectedTitle || null,
            lookup_title: lk.title || null, lookup_authors: lk.author || null, lookup_publisher: lk.publisher || null,
            bbox: hb.bbox, orientation: hb.orientation,
        };
        const groupCandidates = [{
            isbn: cand.isbn13, isbn13: cand.isbn13, isbn_confidence: MEDIUM_MIN,
            isbn_source: 'lens_fallback_verified', isbn_is_valid: true, lookup_title: lk.title || null,
        }];
        let gate;
        try {
            gate = await runGate({
                book: syntheticBook, groupCandidates, sourceImageUrl: hb.sourceImageUrl,
                existingRowIsbns: new Set([cand.isbn13]), skipMatch: stats.keywordUsed >= keywordBudgetRemaining,
            });
        } catch (e) { rec.status = 'held_gate'; rec.gateError = e?.message || String(e); return rec; }
        if (gate.consumedKeyword) stats.keywordUsed += 1;
        stats.visionUsd += Number(gate.visionUsd) || 0;
        rec.gate = { eligible: gate.eligible, reason: gate.reason, sendIsbns: gate.sendIsbns, bestSimilarity: gate.best?.similarity ?? null };
        rec.status = (gate.eligible && COVER_VERIFIED_REASONS.has(gate.reason) && (gate.sendIsbns || []).includes(cand.isbn13))
            ? 'merged' : 'held_gate';
        return rec;
    };

    // ---- BATCH: one actor run for all crop URLs; map dataset items back per input. ----
    const withCrop = books.filter((b) => b.cropUrl);
    for (const hb of books.filter((b) => !b.cropUrl)) {
        console.log(`[lens-fallback] ad=${adsId} book=${hb.bookIndex} no cropUrl -> skip`);
    }

    let perInputItems = []; // aligned to withCrop: the dataset item(s) for each book
    if (withCrop.length) {
        const imageUrls = withCrop.map((b) => b.cropUrl);
        let mapped = null;
        try {
            const out = await runActor({ imageUrls });
            stats.actorCalls += 1;
            mapped = mapItemsToInputs(out?.items || out || [], imageUrls);
        } catch (e) {
            console.warn(`[lens-fallback] ad=${adsId} batch actor failed: ${e?.message || e}`);
            mapped = null;
        }
        if (mapped) {
            perInputItems = mapped;
        } else {
            // Safe fallback: per-image actor calls when the batch output can't be mapped.
            console.log(`[lens-fallback] ad=${adsId} batch mapping unavailable -> per-image fallback`);
            perInputItems = [];
            for (const url of imageUrls) {
                try { const out = await runActor({ imageUrls: [url] }); stats.actorCalls += 1; perInputItems.push(out?.items || out || []); }
                catch (e) { console.warn(`[lens-fallback] ad=${adsId} per-image actor failed url=${url}: ${e?.message || e}`); perInputItems.push([]); }
            }
        }
        console.log(`[lens-fallback] batch ad=${adsId} imageUrls=${imageUrls.length} actorCalls=${stats.actorCalls}`);
    }

    for (let i = 0; i < withCrop.length; i += 1) {
        const hb = withCrop[i];
        const { matches, aiSummary } = normalizeLensItems(perInputItems[i] || []);
        const candidates = extractIsbnCandidates({ matches, aiSummary }).slice(0, maxCandidatesPerBook);
        stats.extracted += candidates.length;
        console.log(`[lens-fallback] ad=${adsId} book=${hb.bookIndex} cropUrl=${hb.cropUrl} matches=${matches.length} extractedIsbns=${candidates.length}`);

        let merged = null;
        const seen = new Set();
        for (const cand of candidates) {
            if (seen.has(cand.isbn13)) continue;
            seen.add(cand.isbn13);
            const rec = await evaluate(hb, cand);
            attempted.push(rec);
            logCand(rec);
            if (rec.status === 'merged') { merged = rec; break; } // 1 ISBN per physical book
        }
        if (merged) { recovered.set(hb.physicalBookKey, merged); stats.merged += 1; }
    }

    console.log(`[lens-fallback] summary ad=${adsId} books=${stats.books} actorCalls=${stats.actorCalls} extracted=${stats.extracted} merged=${stats.merged}`);
    return { recovered, attempted, stats };
}
