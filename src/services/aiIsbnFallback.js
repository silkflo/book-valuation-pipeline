// src/services/aiIsbnFallback.js
//
// AI ISBN FALLBACK PHASE (gated, runs BEFORE the provider phase).
//
// When the normal ISBN search + catalog gate sends too few physical books to
// providers, ask OpenAI for up to N ISBN candidates per UNRESOLVED physical book,
// then VERIFY each suggestion through the full safety chain before it may merge
// into the single provider batch:
//   1. ISBN checksum (+ normalize ISBN-10 -> ISBN-13)
//   2. exact ISBN lookup on ISBNSearch (AbeBooks as backup / cover source)
//   3. title/author compatibility with the DETECTED (Pass-1/full-image) title
//   4. cover retrieval
//   5. cover comparison vs the crop  ── via the SAME catalog/crop-quality gate
//   6. same catalog gate as normal candidates                ──┘
//
// AI suggestions are NEVER trusted directly. An AI-origin ISBN is pinned to
// MEDIUM_MIN confidence (never higher) and only merges when the catalog gate
// returns a COVER-VERIFIED outcome — the cover/catalog match is the proof, not the
// AI's self-reported confidence and not title similarity.
//
// This module performs NO DB writes and triggers NO provider calls. The workflow
// merges `recovered` ISBNs into the existing single Momox/Gibert batch.

import { openai, OPENAI_MODEL } from './openaiClient.js';
import { trackedOpenAiCall } from './aiUsage.js';
import { fetchIsbnSearchIsbnPage } from './isbnSearchScrapflyClient.js';
import { fetchAbebooksCoversForIsbns } from './catalog/abebooksCoverByIsbn.js';
import {
    catalogEligibilityForBook,
    titlesCompatible,
    hasSemanticContradiction,
} from './catalog/verifyCatalogForAd.js';
import { fetchAbebooksCatalogCandidates } from './catalog/abebooksCatalogSource.js';
import { downloadImageToBuffer } from './tempImages.js';
import { cropBookFromImage } from './bookCropper.js';

function num(name, fallback) {
    const v = Number(process.env[name]);
    return Number.isFinite(v) ? v : fallback;
}

// AI-origin ISBNs are pinned to MEDIUM_MIN (same value the gate uses) — never higher.
const MEDIUM_MIN = num('AI_FB_MIN_DERIVED_CONFIDENCE', num('CATALOG_MEDIUM_ISBN_MIN_CONFIDENCE', 0.5));

// A fallback candidate may merge ONLY when the gate eligibility came from a real
// cover match (not a confidence-only path like medium_fallback / strong_isbn_*).
// Exported so the Lens fallback applies the IDENTICAL safety filter.
export const COVER_VERIFIED_REASONS = new Set([
    'selected_exact_isbn',
    'selected_cover_ambiguous_isbn',
    'poor_crop_cover_verified',
    'cover_verified_edition_ambiguous',
]);

// ---------------------------------------------------------------------------
// ISBN checksum + normalization (self-contained; no coupling to extraction).
// ---------------------------------------------------------------------------
function cleanIsbn(raw) {
    return String(raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}
export function isValidIsbn10(raw) {
    const s = cleanIsbn(raw);
    if (!/^\d{9}[\dX]$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 10; i += 1) sum += (i + 1) * (s[i] === 'X' ? 10 : Number(s[i]));
    return sum % 11 === 0;
}
export function isValidIsbn13(raw) {
    const s = cleanIsbn(raw);
    if (!/^\d{13}$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 13; i += 1) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0;
}
function isbn10To13(raw) {
    const s = cleanIsbn(raw).slice(0, 9);
    const core = `978${s}`;
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    return core + String((10 - (sum % 10)) % 10);
}
/** Validate + normalize any ISBN-10/13 to a checksum-valid ISBN-13, else null. */
export function normalizeToIsbn13(raw) {
    const s = cleanIsbn(raw);
    if (isValidIsbn13(s)) return s;
    if (isValidIsbn10(s)) return isbn10To13(s);
    return null;
}

/**
 * Repair a 13-digit ISBN that starts with 978/979 but has a BAD check digit: keep the
 * first 12 digits and recompute the correct check digit. Returns the repaired
 * checksum-valid ISBN-13, or null when it is not a 13-digit 978/979 string (wrong
 * length / wrong prefix is NOT repairable -> held_checksum). A repaired ISBN is NEVER
 * trusted directly — it must still pass exact lookup + title compat + the cover gate.
 */
export function repairIsbn13(raw) {
    const s = cleanIsbn(raw);
    if (!/^\d{13}$/.test(s)) return null;
    if (!s.startsWith('978') && !s.startsWith('979')) return null;
    const core = s.slice(0, 12);
    let sum = 0;
    for (let i = 0; i < 12; i += 1) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
    return core + String((10 - (sum % 10)) % 10);
}

/**
 * Resolve a raw AI ISBN string to a usable ISBN-13. Returns { isbn13, repaired } or
 * { isbn13: null } when it cannot be validated or repaired.
 */
export function resolveAiIsbn(raw) {
    const valid = normalizeToIsbn13(raw); // valid-13 or valid-10 -> 13
    if (valid) return { isbn13: valid, repaired: false };
    const repaired = repairIsbn13(raw);   // 13-digit 978/979 with bad checksum -> fixed
    if (repaired) return { isbn13: repaired, repaired: true };
    return { isbn13: null, repaired: false };
}

// ---------------------------------------------------------------------------
// Trigger (pure).
// ---------------------------------------------------------------------------
export function shouldTriggerFallback({
    enabled,
    detectedBooks,
    providerEligibleBooks,
    minDetected = num('AI_FB_TRIGGER_MIN_DETECTED', 5),
    maxEligible = num('AI_FB_TRIGGER_MAX_ELIGIBLE', 1),
} = {}) {
    if (!enabled) return { trigger: false, reason: 'disabled' };
    if (providerEligibleBooks === 0) return { trigger: true, reason: 'zero_eligible' };
    if (detectedBooks >= minDetected && providerEligibleBooks <= maxEligible) {
        return { trigger: true, reason: `sparse(${detectedBooks}/${providerEligibleBooks})` };
    }
    return { trigger: false, reason: `ok(${detectedBooks}/${providerEligibleBooks})` };
}

// ---------------------------------------------------------------------------
// OpenAI prompt + call (vision: full ad image + crop). Observed evidence is kept
// strictly separate from uncertain/catalog evidence.
// ---------------------------------------------------------------------------
function buildEvidenceText(hb) {
    const observed = {
        bookIndex: hb.bookIndex,
        bbox: hb.bbox,
        detectedVisibleTitle: hb.observedTitle || null,
        rawVisibleText: hb.rawVisibleText || null,
        possibleCorrectedTitle: hb.possibleCorrectedTitle || null,
        author: hb.author || null,
        publisherOrCollection: hb.publisher || null,
        languageHint: hb.language || 'unknown',
        cropQuality: hb.cropQuality || null,
        cropMayBePartialOrClipped: Boolean(hb.mayBeClipped),
        neighborContext: hb.neighborContext || null,
    };
    const uncertain = {
        normalIsbnSearchQuery: hb.pipeline?.query || null,
        candidatesFound: hb.pipeline?.candidatesFound || [],
        candidatesRejectedOrHeld: hb.pipeline?.candidatesHeld || [],
        whyHeld: hb.pipeline?.heldReason || null,
        coverVerificationResult: hb.pipeline?.coverResult || null,
    };
    return [
        'OBSERVED EVIDENCE (from the image — treat as the ground truth for what the book IS):',
        JSON.stringify(observed, null, 2),
        '',
        'EXISTING PIPELINE EVIDENCE (NOT truth — these are candidate/rejected/held/uncertain):',
        JSON.stringify(uncertain, null, 2),
        '',
        'These pipeline titles may be WRONG sibling titles (e.g. the observed book is',
        '"Mon grand livre de chiffres" but a held candidate is "...des couleurs"/"...des nombres").',
        'Do NOT anchor on them unless the image clearly supports them.',
    ].join('\n');
}

const FALLBACK_JSON_SCHEMA = {
    type: 'json_schema',
    name: 'ai_isbn_fallback_candidates',
    strict: true,
    schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
            bookIndex: { type: 'integer' },
            observedTitle: { type: 'string' },
            isbnCandidates: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        isbn13: { type: 'string' },
                        title: { type: 'string' },
                        author: { type: 'string' },
                        publisher: { type: 'string' },
                        year: { type: 'string' },
                        confidence: { type: 'number' },
                        why: { type: 'string' },
                        risk: { type: 'string' },
                    },
                    required: ['isbn13', 'title', 'author', 'publisher', 'year', 'confidence', 'why', 'risk'],
                },
            },
            searchQueries: {
                type: 'array',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { query: { type: 'string' }, why: { type: 'string' } },
                    required: ['query', 'why'],
                },
            },
        },
        required: ['bookIndex', 'observedTitle', 'isbnCandidates', 'searchQueries'],
    },
};

/** Build the crop data URL for the held book (best-effort; returns null on failure). */
async function buildCropDataUrl(hb) {
    try {
        const buf = hb.sourceImageBuffer || (hb.sourceImageUrl ? await downloadImageToBuffer(hb.sourceImageUrl) : null);
        if (!buf) return null;
        const crop = await cropBookFromImage({ imageBuffer: buf, bbox: hb.bbox, orientation: hb.orientation });
        return `data:image/jpeg;base64,${crop.toString('base64')}`;
    } catch {
        return null;
    }
}

/** Ask OpenAI for up to 3 ISBN-13 candidates for ONE unresolved physical book. */
export async function askFallbackIsbnCandidates(hb, adsId = null) {
    const cropDataUrl = await buildCropDataUrl(hb);
    const userContent = [{ type: 'input_text', text: buildEvidenceText(hb) }];
    if (hb.sourceImageUrl) userContent.push({ type: 'input_image', image_url: hb.sourceImageUrl });
    if (cropDataUrl) userContent.push({ type: 'input_image', image_url: cropDataUrl });

    const response = await trackedOpenAiCall({
        callSite: 'ai_isbn_fallback_v2',
        adsId,
        inputKind: 'multi_image',
        imageCount: userContent.filter((p) => p.type === 'input_image').length,
        costType: 'openai_ai_isbn_fallback_v2',
        // model resolves per call site (OPENAI_AI_ISBN_FALLBACK_MODEL -> OPENAI_MODEL), injected into create()
        fn: (model) => openai.responses.create({
        model,
        input: [
            {
                role: 'system',
                content: [{
                    type: 'input_text',
                    text: [
                        'You are a bibliographic assistant identifying the EXACT physical book in an image.',
                        'Return up to 3 ISBN-13 candidates for this one physical book AND up to 2 precise search queries.',
                        'Rules:',
                        '- Prefer ISBN-13 (do NOT return ISBN-10).',
                        '- DO NOT invent ISBNs. If you are not sure of the exact digits, return an EMPTY',
                        '  isbnCandidates list and provide better searchQueries instead of guessing.',
                        '- Prefer the EXACT visible edition/cover, not just the same title.',
                        '- Use the exact visible subtitle words, publisher/collection, author, series name, and any',
                        '  edition clues — in both isbnCandidates (title/publisher) and searchQueries (query text).',
                        '- Prefer French editions when the language hint or cover is French.',
                        'Every ISBN and every search result is independently verified (exact lookup + cover match)',
                        'before any use — recall via good queries beats a wrong ISBN. Output JSON only.',
                    ].join(' '),
                }],
            },
            { role: 'user', content: userContent },
        ],
        text: { format: FALLBACK_JSON_SCHEMA },
        }),
    });

    let parsed = { bookIndex: hb.bookIndex, observedTitle: hb.observedTitle || '', isbnCandidates: [], searchQueries: [] };
    try {
        const raw = response.output_text || response.output?.[0]?.content?.[0]?.text;
        if (raw) {
            const p = JSON.parse(raw);
            parsed = {
                bookIndex: p.bookIndex ?? hb.bookIndex,
                observedTitle: p.observedTitle || hb.observedTitle || '',
                isbnCandidates: p.isbnCandidates || p.candidates || [],
                searchQueries: p.searchQueries || [],
            };
        }
    } catch { /* keep empty */ }
    return parsed;
}

// ---------------------------------------------------------------------------
// Orchestrator (dependency-injected so it is fully testable offline).
// ---------------------------------------------------------------------------
export async function runAiIsbnFallback({
    adsId,
    heldBooks = [],
    keywordBudgetRemaining = Infinity,
    maxBooksPerAd = num('AI_FB_MAX_BOOKS_PER_AD', 0), // 0 = unlimited (run on ALL unresolved books)
    maxSuggestionsPerBook = num('AI_FB_MAX_SUGGESTIONS_PER_BOOK', 3),
    maxSearchQueriesPerBook = num('AI_FB_MAX_SEARCH_QUERIES_PER_BOOK', 2),
    maxSearchCandidatesPerQuery = num('AI_FB_MAX_SEARCH_CANDIDATES_PER_QUERY', 3),
    coverCache = null, // shared in-run (crop, cover) pair cache; reuses catalog-loop compares
    deps = {},
} = {}) {
    const {
        askFallback = askFallbackIsbnCandidates,
        exactLookup = fetchIsbnSearchIsbnPage,
        fetchCovers = fetchAbebooksCoversForIsbns,
        searchByQuery = fetchAbebooksCatalogCandidates,
        runGate = catalogEligibilityForBook,
    } = deps;

    const books = (maxBooksPerAd && maxBooksPerAd > 0) ? heldBooks.slice(0, maxBooksPerAd) : heldBooks;
    const recovered = new Map(); // physicalBookKey -> merged candidate (max 1/book)
    const attempted = [];
    const stats = { books: books.length, merged: 0, aiCalls: 0, exactLookups: 0, searchQueries: 0, visionUsd: 0, keywordUsed: 0 };

    const logCand = (hb, rec) => console.log(
        `[ai-fallback] ad=${adsId} book=${hb.bookIndex} via=${rec.via} isbn=${rec.original || rec.isbn13 || '-'} ` +
        `checksum=${rec.checksum}${rec.repaired ? ` repaired=${rec.isbn13}` : ''} ` +
        `lookup=${rec.lookup ? (rec.lookup.source || 'found') : 'none'} ` +
        `titleCompat=${rec.titleCompatible === undefined ? '-' : (rec.titleCompatible ? 'y' : 'n')} ` +
        `gate=${rec.gate?.reason || '-'} coverSim=${rec.gate?.bestSimilarity ?? '-'} -> ${rec.status}`
    );

    // Memoized exact lookup: ISBNSearch primary, AbeBooks cover as backup. Dedupes across
    // both attempts and all books (a repaired or search-discovered ISBN is looked up once).
    const lookupMemo = new Map();
    const lookupOne = async (isbn13) => {
        if (lookupMemo.has(isbn13)) return lookupMemo.get(isbn13);
        let result = null;
        try {
            const r = await exactLookup(isbn13);
            stats.exactLookups += 1;
            if (r?.ok && r.candidate) {
                result = {
                    title: r.candidate.title || null,
                    author: r.candidate.authors || r.candidate.author || null,
                    publisher: r.candidate.publisher || null,
                    coverUrl: r.candidate.imageUrl || null,
                    source: 'isbnsearch',
                };
            }
        } catch { /* fall through to cover backup */ }
        if (!result) {
            try {
                const covers = await fetchCovers([isbn13]);
                const c = (covers || []).find((x) => x.ok);
                if (c) result = { title: null, author: null, publisher: null, coverUrl: c.imageUrl, source: 'abebooks' };
            } catch { /* none */ }
        }
        lookupMemo.set(isbn13, result);
        return result;
    };

    // Verify ONE ISBN-13 through: exact lookup -> title compat -> the SAME cover gate.
    // AI-origin confidence pinned to MEDIUM_MIN; merge only on a cover-verified outcome.
    const evaluateIsbn = async (hb, isbn13, meta) => {
        const rec = {
            physicalBookKey: hb.physicalBookKey, bookIndex: hb.bookIndex, observedTitle: hb.observedTitle,
            via: meta.via, repaired: Boolean(meta.repaired), original: meta.original || isbn13,
            checksum: meta.repaired ? 'bad' : 'ok', isbn13, status: null,
        };
        const lk = await lookupOne(isbn13);
        if (!lk) { rec.status = 'held_no_lookup'; return rec; }
        rec.lookup = lk;

        const catalogTitle = lk.title || null;
        rec.titleCompatible = Boolean(
            catalogTitle && titlesCompatible(hb.observedTitle, catalogTitle) && !hasSemanticContradiction(hb.observedTitle, catalogTitle)
        );
        if (!rec.titleCompatible) { rec.status = 'held_title'; return rec; }

        const syntheticBook = {
            isbn: isbn13, isbn_source: 'ai_fallback_verified', isbn_is_valid: true, isbn_confidence: MEDIUM_MIN,
            title: hb.observedTitle, possible_corrected_title: hb.possibleCorrectedTitle || null,
            lookup_title: lk.title || null, lookup_authors: lk.author || null, lookup_publisher: lk.publisher || null,
            bbox: hb.bbox, orientation: hb.orientation,
        };
        const groupCandidates = [{
            isbn: isbn13, isbn13, isbn_confidence: MEDIUM_MIN,
            isbn_source: 'ai_fallback_verified', isbn_is_valid: true, lookup_title: lk.title || null,
        }];
        let gate;
        try {
            gate = await runGate({
                adsId, book: syntheticBook, groupCandidates, sourceImageUrl: hb.sourceImageUrl,
                existingRowIsbns: new Set([isbn13]), skipMatch: stats.keywordUsed >= keywordBudgetRemaining,
                cache: coverCache,
            });
        } catch (e) { rec.status = 'held_gate'; rec.gateError = e?.message || String(e); return rec; }
        if (gate.consumedKeyword) stats.keywordUsed += 1;
        stats.visionUsd += Number(gate.visionUsd) || 0;
        rec.gate = { eligible: gate.eligible, reason: gate.reason, sendIsbns: gate.sendIsbns, bestSimilarity: gate.best?.similarity ?? null };
        rec.status = (gate.eligible && COVER_VERIFIED_REASONS.has(gate.reason) && (gate.sendIsbns || []).includes(isbn13))
            ? 'merged' : 'held_gate';
        return rec;
    };

    for (const hb of books) {
        let ai;
        try { ai = await askFallback(hb, adsId); stats.aiCalls += 1; }
        catch (e) { console.warn(`[ai-fallback] ad=${adsId} book=${hb.bookIndex} ai-call failed: ${e?.message || e}`); ai = { isbnCandidates: [], searchQueries: [] }; }
        const isbnCands = (ai?.isbnCandidates || []).slice(0, maxSuggestionsPerBook);
        const queries = (ai?.searchQueries || []).slice(0, maxSearchQueriesPerBook);
        console.log(
            `[ai-fallback] ad=${adsId} book=${hb.bookIndex} bbox=${JSON.stringify(hb.bbox)} ` +
            `observed="${hb.observedTitle || '-'}" cropQuality=${hb.cropQuality || '-'} aiIsbns=${isbnCands.length} aiQueries=${queries.length}`
        );

        let merged = null;
        const seenInBook = new Set(); // don't re-evaluate the same ISBN for this physical book

        // ---- Attempt 1: AI ISBN candidates (with checksum REPAIR for 978/979) ----
        for (const s of isbnCands) {
            const raw = s.isbn13 || s.isbn || '';
            const { isbn13, repaired } = resolveAiIsbn(raw);
            if (!isbn13) {
                const rec = { physicalBookKey: hb.physicalBookKey, bookIndex: hb.bookIndex, via: 'ai_isbn', original: raw, checksum: 'bad', repaired: false, isbn13: null, status: 'held_checksum' };
                logCand(hb, rec); attempted.push(rec); continue;
            }
            if (seenInBook.has(isbn13)) continue;
            seenInBook.add(isbn13);
            const rec = await evaluateIsbn(hb, isbn13, { via: 'ai_isbn', repaired, original: raw });
            logCand(hb, rec); attempted.push(rec);
            if (rec.status === 'merged') { merged = rec; break; }
        }

        // ---- Attempt 2: AI search queries (only if no ISBN candidate survived) ----
        if (!merged) {
            for (const q of queries) {
                if (stats.keywordUsed >= keywordBudgetRemaining) break; // keyword budget exhausted
                let discovered = [];
                try {
                    const r = await searchByQuery({ title: q.query, author: hb.author || null, maxResults: 10 });
                    stats.searchQueries += 1;
                    stats.keywordUsed += 1; // a title search consumes ~1 Scrapfly credit
                    discovered = (r?.candidates || []).map((c) => c.isbn13).filter(Boolean);
                } catch (e) { console.warn(`[ai-fallback] ad=${adsId} book=${hb.bookIndex} search "${q.query}" failed: ${e?.message || e}`); }
                console.log(`[ai-fallback] ad=${adsId} book=${hb.bookIndex} via=ai_search query="${String(q.query || '').slice(0, 48)}" discovered=${discovered.length}`);

                for (const disc of [...new Set(discovered)].slice(0, maxSearchCandidatesPerQuery)) {
                    const isbn13 = normalizeToIsbn13(disc); // discovered ISBNs are expected valid
                    if (!isbn13 || seenInBook.has(isbn13)) continue;
                    seenInBook.add(isbn13);
                    const rec = await evaluateIsbn(hb, isbn13, { via: 'ai_search', repaired: false, original: disc });
                    logCand(hb, rec); attempted.push(rec);
                    if (rec.status === 'merged') { merged = rec; break; }
                }
                if (merged) break;
            }
        }

        if (merged) { recovered.set(hb.physicalBookKey, merged); stats.merged += 1; }
    }

    console.log(
        `[ai-fallback] ad=${adsId} summary: books=${stats.books} merged=${stats.merged} ` +
        `held=${attempted.length - stats.merged} aiCalls=${stats.aiCalls} exactLookups=${stats.exactLookups} ` +
        `searchQueries=${stats.searchQueries} visionUsd=${stats.visionUsd.toFixed(4)} keywordUsed=${stats.keywordUsed}`
    );
    return { recovered, attempted, stats };
}
