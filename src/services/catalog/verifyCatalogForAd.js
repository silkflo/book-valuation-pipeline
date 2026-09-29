// src/services/catalog/verifyCatalogForAd.js
//
// Catalog verification orchestrator (Phase 7 — DRY-RUN FIRST).
//
// Reads an ad's already-saved book rows, groups them into detected physical
// books by crop region (bbox), and for each book runs the catalog union matcher
// to decide whether its cover is verified. Produces the send list that WOULD go
// to providers (hybrid gate: catalog-verified ISBNs UNION visible-ISBN rows).
//
// SAFETY (this phase):
//   - dryRun:true (default)  -> NO DB writes; report shows what WOULD be written.
//   - persist:true (opt-in)  -> writes ONLY catalog_* columns; never provider
//                               columns (momox_status/gibert_status/prices).
//   - NEVER calls Momox/Gibert and does NOT change provider eligibility. The
//     "would send" list is computed and reported, not acted upon.
//
// Crop-quality gate (#5, 2026-06-16 — the cover match IS the content check for
// unreliable crops; pixel/entropy stats can't tell a table-heavy crop from a cover,
// see cropQuality.js):
//   visible cover ISBN         -> send (direct evidence; exempt from the guard).
//   good  (large, area>=LARGE) -> lenient: trust strong/medium confidence; a strong
//                                 ISBN sends even if catalog can't confirm it.
//   risky (borderline) / poor (tiny, area<TINY) -> STRICT: send ONLY when the catalog
//                                 cover match is a strong positive (selected_exact_isbn).
//                                 Confidence/title alone never sends; medium/weak send
//                                 only via a strong cover match. Else hold.

import { pool } from '../../db.js';
import { hasBooksColumn } from '../bookColumns.js';
import { unionMatchCatalog } from './catalogUnionMatcher.js';
import { levelFromCropClass } from '../cropQuality.js';
import { MATCH_STATUSES } from '../verifyProviderImage.js';

// same_book=TRUE verdicts (the matcher sets these only when it believes it is the
// same edition/cover); 'mismatch' is a confident DIFFERENT edition, 'uncertain' is
// always low-confidence (<0.6) — neither may satisfy the guarded path B below.
const SAME_BOOK_STATUSES = new Set([MATCH_STATUSES.MATCH, MATCH_STATUSES.LIKELY]);

function num(envName, fallback) {
    const v = Number(process.env[envName]);
    return Number.isFinite(v) ? v : fallback;
}

const TINY_AREA = num('CATALOG_CROP_TINY_AREA', 0.05);
const LARGE_AREA = num('CATALOG_CROP_LARGE_AREA', 0.30);
const MAX_KEYWORD_SEARCHES = num('CATALOG_MAX_KEYWORD_SEARCHES_PER_AD', 15);

const round2 = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(2)) : null);

// Cover-verify "strong positive match" thresholds — SAME values decideUnion uses for
// a strong cover, so the guarded path B below can never be looser than the matcher.
const COVER_VISION_MIN = num('CATALOG_MATCH_MIN_CONFIDENCE', 0.7); // vision same_book confidence
const COVER_SIM_MIN = num('CATALOG_MATCH_MIN_SIMILARITY', 0.8);    // vision visual similarity

const TITLE_STOPWORDS = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'd', 'l', 'et', 'au', 'aux', 'en', 'dans', 'sur', 'the', 'of', 'to', 'and', 'a', 'an']);
function titleTokens(s) {
    const COMBINING_MARKS = /[̀-ͯ]/g; // strip accents after NFD normalize
    return new Set(
        String(s || '').normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
            .filter((t) => t && !TITLE_STOPWORDS.has(t))
    );
}
// Mutually-exclusive topic words: if the full-image title and the candidate's catalog
// title each contain a DIFFERENT member of one group, they describe different books
// even when they share a series prefix (e.g. "Mon grand livre des chiffres" vs
// "...des couleurs" / "...des nombres"). Extend as new contradictions are found.
const EXCLUSIVE_TOPIC_GROUPS = [
    ['chiffres', 'nombres', 'couleurs', 'formes', 'lettres', 'alphabet', 'animaux', 'mots', 'contraires', 'saisons', 'jours', 'heure', 'metiers', 'fruits', 'legumes'],
    ['diy', 'bricolage', 'pratique', 'theorie', 'theorique'],
];
/** True when two titles contain conflicting members of a mutually-exclusive topic group. */
export function hasSemanticContradiction(detected, candidate) {
    const a = titleTokens(detected);
    const b = titleTokens(candidate);
    if (!a.size || !b.size) return false;
    for (const group of EXCLUSIVE_TOPIC_GROUPS) {
        const inA = group.filter((g) => a.has(g));
        const inB = group.filter((g) => b.has(g));
        if (inA.length && inB.length && !inA.some((g) => inB.includes(g))) return true;
    }
    return false;
}
/** True when two titles share at least half of the shorter title's significant tokens. */
export function titlesCompatible(detected, candidate) {
    const a = titleTokens(detected);
    const b = titleTokens(candidate);
    if (!a.size || !b.size) return false;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared += 1;
    return shared / Math.min(a.size, b.size) >= 0.5;
}

function normalizeAuthorText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sameAuthorEnough(detectedAuthor, lookupAuthors) {
    const detected = normalizeAuthorText(detectedAuthor);
    const lookup = normalizeAuthorText(lookupAuthors);

    if (!detected || !lookup) return false;
    if (detected === lookup) return true;
    if (lookup.includes(detected)) return true;
    if (detected.includes(lookup)) return true;

    const detectedParts = detected.split(' ').filter((part) => part.length >= 3);
    const lookupParts = lookup.split(' ').filter((part) => part.length >= 3);

    if (detectedParts.length < 2 || lookupParts.length < 2) return false;

    const detectedSet = new Set(detectedParts);
    const overlap = lookupParts.filter((part) => detectedSet.has(part)).length;

    return overlap >= 2;
}

function normalizeTitleText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/œ/g, 'oe')
        .replace(/æ/g, 'ae')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/['’`´]/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function mainTitlePart(value) {
    return String(value || '').split(/[:;(\[]/)[0];
}

function safeMainTitlePrefixMatch(detectedTitle, lookupTitle) {
    const detected = normalizeTitleText(mainTitlePart(detectedTitle));
    const lookup = normalizeTitleText(mainTitlePart(lookupTitle));

    if (!detected || !lookup) return false;
    if (Math.min(detected.length, lookup.length) < 12) return false;

    if (detected === lookup) return true;
    if (lookup.startsWith(`${detected} `)) return true;
    if (detected.startsWith(`${lookup} `)) return true;

    return false;
}

function detectedTitleForProof(book) {
    return book?.possible_corrected_title || book?.title || book?.raw_visible_text || null;
}

function lookupTitleForProof(book) {
    return book?.lookup_title || book?.title || book?.possible_corrected_title || null;
}

function titleProofOk(book) {
    const detectedTitle = detectedTitleForProof(book);
    const lookupTitle = lookupTitleForProof(book);

    if (!detectedTitle || !lookupTitle) return false;

    if (hasSemanticContradiction(detectedTitle, lookupTitle)) return false;

    return (
        titlesCompatible(detectedTitle, lookupTitle) ||
        safeMainTitlePrefixMatch(detectedTitle, lookupTitle)
    );
}

function authorProofOkOrNoConflict(book) {
    const detectedAuthor = book?.author || null;
    const lookupAuthors = book?.lookup_authors || null;

    // No author is not proof, but it is also not a conflict.
    if (!detectedAuthor || !lookupAuthors) return true;

    return sameAuthorEnough(detectedAuthor, lookupAuthors);
}

function authorProofStrong(book) {
    return sameAuthorEnough(book?.author, book?.lookup_authors);
}

function hasStrongTextProviderProof(book, { conf, isbnValid, strongMin }) {
    return (
        isbnValid !== false &&
        Number(conf) >= Number(strongMin) &&
        titleProofOk(book) &&
        authorProofOkOrNoConflict(book)
    );
}

function hasMediumPromotedProviderProof(book, { conf, isbnValid, mediumMin }) {
    return (
        isbnValid !== false &&
        Number(conf) >= Number(mediumMin) &&
        safeMainTitlePrefixMatch(detectedTitleForProof(book), lookupTitleForProof(book)) &&
        authorProofStrong(book)
    );
}

function hasConfidentOwnCoverMismatch(res, ownIsbn) {
    if (!ownIsbn) return false;

    const ownCandidate = (res?.candidates || []).find((candidate) => candidate.isbn13 === ownIsbn);
    if (!ownCandidate) return false;

    const status = String(ownCandidate.matchStatus || '');
    const confidence = Number(ownCandidate.confidence) || 0;

    return status === 'mismatch' && confidence >= COVER_VISION_MIN;
}

/**
 * Canonical, DISPLAY-ONLY outcome label for logs/reports. Both a true unique-cover
 * match and the guarded path B carry decision='selected_exact_isbn' (so each sends
 * exactly one ISBN), which makes them look identical in a raw decision column. This
 * label keeps them distinct:
 *   - 'selected_exact_isbn'             : eligible via a genuine exact/visible/strong/medium selection
 *   - 'cover_verified_edition_ambiguous': eligible via the guarded path B (own ISBN, edition ambiguous)
 *   - else (held)                       : the hold reason, e.g. 'poor_crop_needs_cover_match'
 * It never changes eligibility, decision, or the send list.
 */
export function gateOutcomeLabel({ eligible, decision, reason } = {}) {
    if (!eligible) return reason || decision || 'held';
    if (reason === 'cover_verified_edition_ambiguous') return 'cover_verified_edition_ambiguous';
    return decision || reason;
}

/**
 * Eligibility of a `selected_exact_isbn` cover match ON A RISKY/POOR CROP. A unique
 * cover match alone is NOT enough on an unreliable crop: the cover only confirms the
 * artwork, so the base ISBN candidate must ALSO carry enough metadata confidence
 * (>= mediumMin) and be title-compatible with the full-image (Pass-1) title with no
 * semantic contradiction. A weak candidate (e.g. conf 0.32) that merely cover-matched
 * is held. Pure + exported so the regression can be tested offline (no matcher needed).
 */
export function exactMatchEligibilityOnRiskyCrop({ selConf, selValid = true, imageTitle, catalogTitle, mediumMin } = {}) {
    const strongEnough = selValid !== false && Number(selConf) >= Number(mediumMin);
    const titleOk = !imageTitle || !catalogTitle
        || (titlesCompatible(imageTitle, catalogTitle) && !hasSemanticContradiction(imageTitle, catalogTitle));
    if (strongEnough && titleOk) return { eligible: true, reason: 'poor_crop_cover_verified' };
    return {
        eligible: false,
        reason: !strongEnough ? 'poor_crop_selected_exact_low_confidence' : 'poor_crop_selected_exact_title_conflict',
    };
}

/** Classify a crop by its normalized bbox [x1,y1,x2,y2] area. */
export function classifyCrop(bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) {
        return { cropClass: 'borderline', area: null }; // unknown geometry -> treat cautiously
    }
    const [x1, y1, x2, y2] = bbox.map(Number);
    const area = Math.max(0, Math.min(1, (x2 - x1) * (y2 - y1)));
    if (area < TINY_AREA) return { cropClass: 'tiny', area: round2(area) };
    if (area >= LARGE_AREA) return { cropClass: 'large', area: round2(area) };
    return { cropClass: 'borderline', area: round2(area) };
}

function abebooksCoverImageUrlForIsbn(isbn) {
    const clean = String(isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();

    if (!/^\d{13}$/.test(clean)) {
        return null;
    }

    return `https://pictures.abebooks.com/isbn/${clean}-fr-300.jpg`;
}

function buildCoverByIsbnPersistPayload({
    isbn,
    status,
    confidence = null,
    book = null,
} = {}) {
    if (!isbn) return null;

    return {
        isbn,
        status,
        similarity: null,
        confidence,
        imageUrl: abebooksCoverImageUrlForIsbn(isbn),
        listingUrl: null,
        title: book?.lookup_title || book?.possible_corrected_title || book?.title || null,
        author: book?.lookup_authors || book?.author || null,
        publisher: book?.lookup_publisher || null,
        year: null,
        source: 'abebooks_cover_by_isbn',
    };
}

function groupByBbox(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = JSON.stringify(row.bbox);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return [...groups.values()];
}

/**
 * Dry-run catalog verification for an ad.
 * @param {object} options
 * @param {string} options.adsId
 * @param {boolean} [options.dryRun=true]
 * @param {boolean} [options.persist=false] - if true, write ONLY catalog_* columns
 * @param {number} [options.maxKeywordSearches]
 */
export async function verifyCatalogForAd({
    adsId,
    dryRun = true,
    persist = false,
    maxKeywordSearches = MAX_KEYWORD_SEARCHES,
} = {}) {
    if (!adsId) throw new Error('verifyCatalogForAd missing adsId');

    const { rows } = await pool.query(
        `SELECT id, isbn, isbn_source, isbn_confidence, isbn_is_valid,
                lookup_score, best_title_similarity, catalog_match_status, catalog_match_similarity,
                title, lookup_title, lookup_authors, lookup_publisher,
                source_image_url, bbox, orientation
         FROM books
         WHERE ads_id = $1 AND bbox IS NOT NULL
         ORDER BY id ASC`,
        [adsId]
    );

    const canPersist = persist && (await hasBooksColumn('catalog_match_status'));
    const books = [];
    let keywordSearchesUsed = 0;
    let visionUsd = 0;

    for (const group of groupByBbox(rows)) {
        const rep = group.find((r) => r.source_image_url) || group[0];
        const title = rep.lookup_title || rep.title || null;
        const author = rep.lookup_authors || null;
        const candidateRows = group.filter((r) => r.isbn);
        const visibleIsbnCount = new Set(
            candidateRows.filter((r) => r.isbn_source === 'visible_isbn').map((r) => r.isbn)
        ).size;
        const existingRowIsbns = new Set(candidateRows.map((r) => r.isbn));

        // Delegate to the SAME per-book gate the live workflow uses, so dry-run
        // and live behavior cannot drift.
        const cat = await catalogEligibilityForBook({
            book: rep,
            groupCandidates: candidateRows,
            sourceImageUrl: rep.source_image_url,
            existingRowIsbns,
            skipMatch: keywordSearchesUsed >= maxKeywordSearches,
        });
        if (cat.consumedKeyword) keywordSearchesUsed += 1;
        visionUsd += Number(cat.visionUsd) || 0;

        let wrote = 0;
        if (canPersist && cat.persist?.length) {
            wrote = await persistCatalogRows(adsId, cat.persist);
        }

        const wouldSend = cat.sendIsbns.map((isbn) => ({ isbn, via: cat.reason }));
        const heldIsbns = [...existingRowIsbns].filter((isbn) => !cat.sendIsbns.includes(isbn));

        books.push({
            bbox: rep.bbox,
            title,
            cropClass: cat.cropClass,
            area: cat.area,
            unionCandidateCount: cat.unionCount,
            pipelineCandidateCount: candidateRows.length,
            visibleIsbnCount,
            decision: cat.decision,
            bestSimilarity: cat.best?.similarity ?? null,
            bestConfidence: cat.best?.confidence ?? null,
            selectedExactIsbn: cat.selectedExactIsbn ?? null,
            ambiguousCluster: cat.ambiguousCluster ?? null,
            clusterSize: cat.ambiguousCluster?.length ?? 0,
            wouldSend,
            heldIsbns,
            notSentReason: cat.eligible ? null : cat.reason,
            providerSendsAvoided: Math.max(0, cat.unionCount - cat.sendIsbns.length),
            rowsWritten: wrote,
        });
    }

    // Totals.
    const totals = {
        detectedBooks: books.length,
        selected_exact_isbn: books.filter((b) => b.decision === 'selected_exact_isbn').length,
        selected_cover_ambiguous_isbn: books.filter((b) => b.decision === 'selected_cover_ambiguous_isbn').length,
        needs_verification: books.filter((b) => b.decision === 'needs_verification').length,
        no_match: books.filter((b) => b.decision === 'no_match').length,
        booksWithSends: books.filter((b) => b.wouldSend.length > 0).length,
        totalWouldSend: books.reduce((n, b) => n + b.wouldSend.length, 0),
        totalCandidates: books.reduce((n, b) => n + b.unionCandidateCount, 0),
        providerSendsAvoided: books.reduce((n, b) => n + b.providerSendsAvoided, 0),
        keywordSearchesUsed,
        estVisionUsd: round2(visionUsd),
        estScrapflyCredits: keywordSearchesUsed,
    };

    return { adsId, dryRun, persist: canPersist, books, totals };
}

function dedupeIntersect(isbns, allowedSet) {
    const uniq = [...new Set((isbns || []).filter(Boolean))];
    return allowedSet ? uniq.filter((i) => allowedSet.has(i)) : uniq;
}

/**
 * In-memory per-book catalog gate for the LIVE workflow integration.
 * Decides whether (and which ISBNs) to send to providers for ONE detected book.
 *
 * Precedence (no provider fan-out — only the book's own/selected ISBN(s)):
 *   1. visible_isbn               -> eligible (legible cover ISBN = strong evidence)
 *   2. tiny crop + conf >= STRONG -> eligible (strong_isbn_tiny_crop_allowed;
 *      bookCropper upscales to 1024px but tiny bboxes still match unreliably, so
 *      we trust a high-confidence ISBN rather than image-match a poor crop)
 *   3. tiny crop + weak/medium    -> HELD (crop_too_small)
 *   4. borderline/large           -> catalog image match; a high-confidence ISBN
 *      that catalog can't confirm is STILL sent (strong_isbn_catalog_unconfirmed).
 * Sendable ISBNs are restricted to existingRowIsbns so the updaters find a row.
 * NEVER calls Momox/Gibert.
 *
 * @returns {Promise<{eligible, reason, decision, cropClass, area, sendIsbns,
 *   consumedKeyword, best, unionCount, visionUsd, selectedExactIsbn,
 *   ambiguousCluster, persist}>}
 */
export async function catalogEligibilityForBook({ book, groupCandidates = null, sourceImageUrl, existingRowIsbns = null, skipMatch = false, cache = null, adsId = null } = {}) {
    const bbox = Array.isArray(book?.bbox) ? book.bbox : null;
    const { cropClass, area } = classifyCrop(bbox);
    // Pass-2 crop disagreed with the Pass-1 title for this book (set in extraction):
    // the visual identity is unreliable, so text/confidence proof alone must NOT send.
    const cropRetryMismatch = Boolean(book?.crop_retry_mismatch);
    const ownIsbn = book?.isbn || null;
    const isbnSource = book?.isbn_source || book?.isbnSource || null;
    const isVisible = isbnSource === 'visible_isbn';
    const isbnValid = (book?.isbn_is_valid ?? book?.isbnIsValid) !== false;
    const confRaw = Number(book?.isbn_confidence ?? book?.isbnConfidence);
    const conf = Number.isFinite(confRaw) ? confRaw : 0;
    const STRONG_MIN = num('CATALOG_STRONG_ISBN_MIN_CONFIDENCE', 0.9);
    const trustedByConfidence = Boolean(ownIsbn) && isbnValid && conf >= STRONG_MIN;
    // Visible cover ISBN is honored in the catalog-match send gate too (case 4).
    const visibleIsbns = isVisible && ownIsbn && isbnValid ? [ownIsbn] : [];

    const restrict = (isbns) => dedupeIntersect(isbns, existingRowIsbns);

    // Single observability line per book + default fields the callers expect.
    // outcome= is the canonical, distinct label (keeps a true exact match separate
    // from the guarded path B); decision=/reason= remain for full detail.
    // Captures the AI-budget stats of the last cover verify (if any) so every
    // finalize() return surfaces them for the per-ad [catalog-ai-budget] summary.
    let lastAiBudget = null;

    const finalize = (out) => {
        console.log(
            `[catalog-gate] outcome=${gateOutcomeLabel(out)} eligible=${out.eligible ? 'yes' : 'no'} ` +
            `crop=${cropClass} area=${area} isbn=${ownIsbn || '-'} conf=${conf} src=${isbnSource || '-'} ` +
            `decision=${out.decision} reason=${out.reason} send=${JSON.stringify(out.sendIsbns)} persist=${out.persist?.length || 0}`
        );
        // identity vs provider confidence: a book can be kept/identified (row + ISBN
        // candidates) yet NOT be safe to send to providers. This line surfaces the final
        // provider-confidence decision per book.
        console.log(
            `[quality-gate] ${out.eligible ? 'allow' : 'hold'} ads_id=${adsId || '-'} ` +
            `book="${String(book?.title || book?.lookup_title || '').slice(0, 40)}" reason=${out.reason} ` +
            `isbn=${(Array.isArray(out.sendIsbns) && out.sendIsbns[0]) || ownIsbn || '-'} ` +
            `crop=${cropClass} area=${area}${cropRetryMismatch ? ' crop_retry_mismatch=yes' : ''}`
        );
        return {
            cropClass, area, consumedKeyword: false, best: null, unionCount: 0, visionUsd: 0,
            selectedExactIsbn: null, ambiguousCluster: null, aiBudget: lastAiBudget, ...out,
        };
    };

    // Physical-book candidate pool for the MEDIUM fallback (1 ISBN per book max).
    // Source: groupCandidates (the bbox group's rows, from the orchestrator) or
    // the resolved book's own ISBN + its lookup_candidates siblings (workflow).
    // Deduped by ISBN13.
    // Medium fallback is used only when no strong/visible ISBN exists.
    // Keep it low enough to catch acceptable title/author matches, but still send
    // max 1 ISBN per physical book through bestSendableMedium().
    const MEDIUM_MIN = num('CATALOG_MEDIUM_ISBN_MIN_CONFIDENCE', 0.50);
    const rawCandidates = (Array.isArray(groupCandidates) && groupCandidates.length)
        ? groupCandidates
        : [
            ...(ownIsbn ? [{ isbn: ownIsbn, isbn_confidence: conf, isbn_source: isbnSource, isbn_is_valid: isbnValid }] : []),
            ...(Array.isArray(book?.lookup_candidates) ? book.lookup_candidates : []),
        ];
    const candPool = [];
    const candSeen = new Set();
    for (const c of rawCandidates) {
        const isbn13 = c.isbn13 || c.isbn || null;
        if (!isbn13 || candSeen.has(isbn13)) continue;
        const cConf = Number(c.isbn_confidence ?? c.confidence ?? c.score);
        candSeen.add(isbn13);
        candPool.push({
            isbn13,
            confidence: Number.isFinite(cConf) ? cConf : 0,
            source: c.isbn_source || c.isbnSource || c.source || null,
            valid: (c.isbn_is_valid ?? c.isbnIsValid) !== false,
            lookupScore: Number(c.lookup_score ?? c.score) || 0,
            titleSim: Number(c.best_title_similarity ?? c.title_similarity) || 0,
            catalogSim: Number(c.catalog_match_similarity) || 0,
            id: Number.isFinite(Number(c.id)) ? Number(c.id) : Infinity,
        });
    }
    const isStrongCand = (c) => c.valid && (c.source === 'visible_isbn' || c.confidence >= STRONG_MIN);
    // Best medium first: confidence, then lookup score, title sim, catalog sim, lowest id.
    const mediumCandidates = candPool
        .filter((c) => c.valid && !isStrongCand(c) && c.confidence >= MEDIUM_MIN)
        .sort((a, b) => (b.confidence - a.confidence) || (b.lookupScore - a.lookupScore)
            || (b.titleSim - a.titleSim) || (b.catalogSim - a.catalogSim) || (a.id - b.id));

    // Send the SINGLE best medium ISBN with a sendable row (no sibling fan-out).
    const bestSendableMedium = () => mediumCandidates.find((c) => restrict([c.isbn13]).length) || null;
    const logMediumChoice = (chosen) => console.log(
        `[catalog-gate] medium fallback bbox=${bbox ? JSON.stringify(bbox) : '-'} ` +
        `chosen=${chosen.isbn13} conf=${chosen.confidence} ` +
        `skippedDup=${JSON.stringify(candPool.map((x) => x.isbn13).filter((i) => i !== chosen.isbn13))}`
    );
    const mediumFallbackResult = () => {
        const med = bestSendableMedium();
        if (!med) return null;
        logMediumChoice(med);
        return finalize({
            eligible: true, reason: 'medium_fallback', decision: 'selected_exact_isbn',
            sendIsbns: [med.isbn13], selectedExactIsbn: med.isbn13,
            persist: [buildCoverByIsbnPersistPayload({ isbn: med.isbn13, status: 'medium_fallback', confidence: med.confidence, book })].filter(Boolean),
        });
    };

    const TEXT_AUTO_MEDIUM_MIN = num('CATALOG_TEXT_AUTO_MEDIUM_MIN_CONFIDENCE', 0.60);

    const textProofResult = ({ strongReason, mediumReason }) => {
        const send = restrict([ownIsbn]);
        if (!send.length) return null;

        if (hasStrongTextProviderProof(book, { conf, isbnValid, strongMin: STRONG_MIN })) {
            return finalize({
                eligible: true,
                reason: strongReason,
                decision: 'selected_exact_isbn',
                sendIsbns: send,
                selectedExactIsbn: ownIsbn,
                persist: [buildCoverByIsbnPersistPayload({
                    isbn: ownIsbn,
                    status: strongReason,
                    confidence: conf,
                    book,
                })].filter(Boolean),
            });
        }

        if (hasMediumPromotedProviderProof(book, {
            conf,
            isbnValid,
            mediumMin: TEXT_AUTO_MEDIUM_MIN,
        })) {
            return finalize({
                eligible: true,
                reason: mediumReason,
                decision: 'selected_exact_isbn',
                sendIsbns: send,
                selectedExactIsbn: ownIsbn,
                persist: [buildCoverByIsbnPersistPayload({
                    isbn: ownIsbn,
                    status: mediumReason,
                    confidence: conf,
                    book,
                })].filter(Boolean),
            });
        }

        return null;
    };

    // Crop-quality level (area-based): large -> good, borderline -> risky, tiny -> poor.
    // The catalog cover-image match is the CONTENT check the guard relies on for
    // risky/poor crops (a clipped/table-heavy crop will not strongly match the real
    // cover; a clean small cover will). See cropQuality.js for why pixel stats aren't used.
    const cropLevel = levelFromCropClass(cropClass);
    // A crop-retry mismatch (without a visible cover ISBN) forces the STRICT cover-only
    // branch even on a large crop: only a verified cover (or visible ISBN) may send;
    // title/confidence proof is held for admin review.
    const effectiveCropLevel = (cropRetryMismatch && !isVisible) ? 'poor' : cropLevel;

    // 1) Visible cover ISBN: read directly off the cover -> direct evidence. Exempt
    //    from the crop-quality guard; send the ONE main ISBN.
    if (isVisible && ownIsbn && isbnValid) {
        const send = restrict([ownIsbn]);
        if (send.length) {
            return finalize({
                eligible: true, reason: 'visible_isbn', decision: 'selected_exact_isbn',
                sendIsbns: send, selectedExactIsbn: ownIsbn,
                persist: [buildCoverByIsbnPersistPayload({ isbn: ownIsbn, status: 'selected_exact_isbn', confidence: 1, book })].filter(Boolean),
            });
        }
    }

    // Anything sendable at all? (a strong main ISBN with a row, or a medium candidate)
    const hasSendableStrong = trustedByConfidence && restrict([ownIsbn]).length > 0;
    const hasSendableMedium = Boolean(bestSendableMedium());

    // 2) Nothing strong/medium -> hold (no keyword/vision cost).
    if (!hasSendableStrong && !hasSendableMedium) {
        return finalize({
            eligible: false,
            reason: cropLevel === 'poor' ? 'crop_too_small' : 'needs_verification',
            decision: 'needs_verification',
            sendIsbns: [],
            persist: ownIsbn
                ? [buildCoverByIsbnPersistPayload({ isbn: ownIsbn, status: 'needs_verification', confidence: conf || null, book })].filter(Boolean)
                : [],
        });
    }

    // Catalog cover verification (used by GOOD lenient + RISKY/POOR strict). Verifies
    // against ALL of this physical book's ISBN candidates so the cover match can pick
    // the right sibling, falling back to the main ISBN. Builds the catalog_* persist rows.
    const runCoverVerify = async () => {
        const title = book.lookup_title || book.possible_corrected_title || book.title || null;
        const author = book.lookup_authors || book.author || null;
        const poolIsbns = candPool.length ? candPool.map((c) => c.isbn13) : (ownIsbn ? [ownIsbn] : []);
        const pipelineCandidates = poolIsbns.map((isbn13) => ({ isbn13, title, author, publisher: book.lookup_publisher }));
        const res = await unionMatchCatalog({
            title, author, pipelineCandidates,
            cropSource: { sourceImageUrl, bbox, orientation: book.orientation },
            detectedTitle: title,
            cache,
        });
        lastAiBudget = res.aiBudget || null;
        const catalogSelected = res.decision === 'selected_exact_isbn' ? [res.selectedExactIsbn]
            : res.decision === 'selected_cover_ambiguous_isbn' ? (res.ambiguousCluster || []).map((c) => c.isbn13) : [];
        const persist = [];
        const seen = new Set();
        for (const c of res.candidates) {
            const status = c.isbn13 === res.selectedExactIsbn ? 'selected_exact_isbn'
                : catalogSelected.includes(c.isbn13) ? 'selected_cover_ambiguous_isbn'
                    : catalogSelected.length ? 'no_match' : res.decision;
            persist.push({
                isbn: c.isbn13, status, similarity: c.similarity, confidence: c.confidence,
                imageUrl: c.imageUrl, title: c.title, author: c.author, publisher: c.publisher, year: c.year, listingUrl: c.listingUrl,
            });
            seen.add(c.isbn13);
        }
        if (ownIsbn && !seen.has(ownIsbn)) {
            const fp = buildCoverByIsbnPersistPayload({ isbn: ownIsbn, status: res.decision, confidence: conf || null, book });
            if (fp) persist.push(fp);
        }
        return { res, catalogSelected, persist };
    };

    // 3) GOOD crop (large): lenient — pipeline confidence is trustworthy here.
    //    (effectiveCropLevel forces poor when a crop-retry mismatch demands cover proof.)
    if (effectiveCropLevel === 'good') {
        if (skipMatch) {
            if (hasSendableStrong) {
                return finalize({
                    eligible: true, reason: 'strong_isbn_budget', decision: 'selected_exact_isbn',
                    sendIsbns: restrict([ownIsbn]), selectedExactIsbn: ownIsbn,
                    persist: [buildCoverByIsbnPersistPayload({ isbn: ownIsbn, status: 'selected_exact_isbn', confidence: conf, book })].filter(Boolean),
                });
            }
            const med = mediumFallbackResult();
            if (med) return med;
            return finalize({
                eligible: false, reason: 'ad_match_budget_reached', decision: 'needs_verification', sendIsbns: [],
                persist: ownIsbn ? [buildCoverByIsbnPersistPayload({ isbn: ownIsbn, status: 'needs_verification', confidence: conf || null, book })].filter(Boolean) : [],
            });
        }

        const { res, catalogSelected, persist } = await runCoverVerify();
        let sendIsbns = restrict([...catalogSelected, ...visibleIsbns]);
        let reason = sendIsbns.length ? res.decision
            : res.decision === 'no_match' ? 'catalog_no_match' : 'catalog_needs_verification';

        // Large crop + strong ISBN catalog couldn't confirm: still send the ONE main ISBN.
        if (!sendIsbns.length && hasSendableStrong) {
            sendIsbns = restrict([ownIsbn]);
            reason = 'strong_isbn_catalog_unconfirmed';
        }
        // Else fall back to the single best medium candidate (1/book).
        if (!sendIsbns.length) {
            const med = bestSendableMedium();
            if (med) {
                sendIsbns = [med.isbn13];
                reason = 'medium_fallback';
                const ex = persist.find((p) => p.isbn === med.isbn13);
                if (ex) ex.status = 'medium_fallback';
                else { const mp = buildCoverByIsbnPersistPayload({ isbn: med.isbn13, status: 'medium_fallback', confidence: med.confidence, book }); if (mp) persist.push(mp); }
                logMediumChoice(med);
            }
        }

        return finalize({
            eligible: sendIsbns.length > 0, reason,
            decision: sendIsbns.length ? 'selected_exact_isbn' : 'needs_verification',
            sendIsbns, consumedKeyword: true, best: res.candidates[0] || null,
            unionCount: res.sourceCounts.unionCandidates, visionUsd: Number(res.estimatedCost?.visionUsd) || 0,
            selectedExactIsbn: sendIsbns.length ? (res.selectedExactIsbn || sendIsbns[0] || null) : null,
            ambiguousCluster: res.decision === 'selected_cover_ambiguous_isbn' && catalogSelected.length ? catalogSelected : null,
            persist,
        });
    }

    // 4) RISKY / POOR crop (borderline / tiny): the guard. Confidence/title alone is
    //    NOT enough — send ONLY when the catalog cover match is a strong positive
    //    (selected_exact_isbn). Medium/weak send only via that strong cover match.
    if (skipMatch) {
        // Cover verification was SKIPPED (ad-level catalog budget exhausted). On a
        // risky/poor (or mismatch-forced) crop we have NO visual proof, so text/confidence
        // alone must NOT send (quality gate). Keep the book + ISBN candidate for admin
        // review. (visible_isbn was already handled above.)
        return finalize({
            eligible: false,
            reason: cropRetryMismatch ? 'crop_retry_mismatch' : 'catalog_budget_no_cover_proof',
            decision: 'needs_verification',
            sendIsbns: [],
            persist: ownIsbn
                ? [buildCoverByIsbnPersistPayload({
                    isbn: ownIsbn,
                    status: 'needs_verification',
                    confidence: conf || null,
                    book,
                })].filter(Boolean)
                : [],
        });
    }

    const { res, persist } = await runCoverVerify();

    const ownCoverMismatch = hasConfidentOwnCoverMismatch(res, ownIsbn);

    // Path 2: a unique exact cover match. On a risky/poor crop a cover match alone is
    // NOT enough — the cover only confirms the artwork, so the base candidate must also
    // carry metadata confidence >= MEDIUM_MIN and be title-compatible with the full-image
    // (Pass-1) title with no semantic contradiction. A weak candidate (e.g. conf 0.32)
    // that merely cover-matched on a borderline crop is HELD, not sent.
    if (res.decision === 'selected_exact_isbn' && res.selectedExactIsbn) {
        const selIsbn = res.selectedExactIsbn;
        const send = restrict([selIsbn]);
        if (send.length) {
            const poolMatch = candPool.find((c) => c.isbn13 === selIsbn);
            const selConf = poolMatch ? poolMatch.confidence : (selIsbn === ownIsbn ? conf : 0);
            const selValid = poolMatch ? poolMatch.valid : (selIsbn === ownIsbn ? isbnValid : true);
            const selCand = (res.candidates || []).find((c) => c.isbn13 === selIsbn);
            const imageTitle = book.title || book.possible_corrected_title || null;
            const catalogTitle = (selIsbn === ownIsbn ? book.lookup_title : null) || selCand?.title || null;
            const verdict = exactMatchEligibilityOnRiskyCrop({ selConf, selValid, imageTitle, catalogTitle, mediumMin: MEDIUM_MIN });
            console.log(
                `[catalog-gate] path-2 exact check: isbn=${selIsbn} selConf=${selConf} MEDIUM_MIN=${MEDIUM_MIN} ` +
                `valid=${selValid} -> ${verdict.eligible ? 'send' : 'HOLD'} (${verdict.reason}) ` +
                `imageTitle="${imageTitle || '-'}" catalogTitle="${catalogTitle || '-'}"`
            );
            return finalize({
                eligible: verdict.eligible,
                reason: verdict.reason,
                decision: verdict.eligible ? 'selected_exact_isbn' : 'needs_verification',
                sendIsbns: verdict.eligible ? send : [],
                selectedExactIsbn: verdict.eligible ? selIsbn : null,
                consumedKeyword: true, best: res.candidates[0] || null,
                unionCount: res.sourceCounts.unionCandidates,
                visionUsd: Number(res.estimatedCost?.visionUsd) || 0, persist,
            });
        }
    }

    // Path B (GUARDED — option B): the book's OWN PRIMARY strong ISBN whose own cover
    // verified strongly, even when the exact EDITION cluster is ambiguous (many
    // editions reuse one cover). This is a STRICT gate, not a loose fallback:
    //   - own primary ISBN only (never a medium/alternative candidate),
    //   - isbn_confidence >= 0.90 and valid,
    //   - that ISBN's OWN cover is a strong positive match (vision conf >= MIN_CONF,
    //     visual similarity >= MIN_SIM, matchStatus 'match' — same bar as decideUnion),
    //   - the full-image (Pass-1) title is compatible with the ISBN's catalog title AND
    //     carries NO semantic contradiction (chiffres vs couleurs/nombres, DIY vs pratique).
    if (ownIsbn && isbnValid && conf >= 0.90) {
        const ownCand = (res.candidates || []).find((c) => c.isbn13 === ownIsbn);
        // same_book verdict (match/likely_match) with vision confidence >= 0.70 and
        // visual similarity >= 0.80. Excludes 'mismatch' (confident different edition)
        // and 'uncertain' (always < 0.6 confidence).
        const coverStrong = !!ownCand
            && SAME_BOOK_STATUSES.has(ownCand.matchStatus)
            && Number(ownCand.confidence) >= COVER_VISION_MIN
            && Number(ownCand.similarity) >= COVER_SIM_MIN;
        const imageTitle = book.title || book.possible_corrected_title || null; // Pass-1 full-image read
        const catalogTitle = book.lookup_title || null;                         // what this ISBN actually is
        const titleOk = !imageTitle || !catalogTitle
            || (titlesCompatible(imageTitle, catalogTitle) && !hasSemanticContradiction(imageTitle, catalogTitle));
        console.log(
            `[catalog-gate] path-B eval: isbn=${ownIsbn} found=${!!ownCand} status=${ownCand?.matchStatus || '-'} ` +
            `conf=${ownCand?.confidence ?? '-'} sim=${ownCand?.similarity ?? '-'} coverStrong=${coverStrong} titleOk=${titleOk}`
        );
        if (coverStrong && titleOk) {
            const send = restrict([ownIsbn]);
            if (send.length) {
                console.log(
                    `[catalog-gate] path-B own-ISBN cover-verified (edition ambiguous): isbn=${ownIsbn} ` +
                    `conf=${ownCand.confidence} sim=${ownCand.similarity} status=${ownCand.matchStatus} ` +
                    `imageTitle="${imageTitle || '-'}" catalogTitle="${catalogTitle || '-'}"`
                );
                return finalize({
                    eligible: true, reason: 'cover_verified_edition_ambiguous', decision: 'selected_exact_isbn',
                    sendIsbns: send, selectedExactIsbn: ownIsbn, consumedKeyword: true,
                    best: res.candidates[0] || null, unionCount: res.sourceCounts.unionCandidates,
                    visionUsd: Number(res.estimatedCost?.visionUsd) || 0, persist,
                });
            }
        }
    }

    // Else: cover did NOT verify strongly on a risky/poor crop. Per the quality gate,
    // an unconfirmed cover is not proof — text/confidence alone must NOT send (this was
    // the strong_text_proof_cover_unconfirmed leak). Keep the book + ISBN candidate for
    // admin review with a specific reason.
    const holdReason = ownCoverMismatch
        ? 'cover_mismatch_needs_review'
        : cropRetryMismatch
            ? 'crop_retry_mismatch'
            : cropLevel === 'poor'
                ? 'tiny_crop_cover_unconfirmed'
                : 'poor_crop_needs_cover_match';

    return finalize({
        eligible: false,
        reason: holdReason,
        decision: 'needs_verification',
        sendIsbns: [],
        consumedKeyword: true,
        best: res.candidates[0] || null,
        unionCount: res.sourceCounts.unionCandidates,
        visionUsd: Number(res.estimatedCost?.visionUsd) || 0,
        persist,
    });
}

/** Write ONLY catalog_* fields for {isbn,...} payloads (never provider columns). */
export async function persistCatalogRows(adsId, payloads) {
    if (!adsId || !payloads?.length) return 0;
    if (!(await hasBooksColumn('catalog_match_status'))) return 0;

    let wrote = 0;

    for (const p of payloads) {
        if (!p?.isbn) continue;

        const catalogYear =
            p.year != null && Number.isFinite(Number(p.year))
                ? Number(p.year)
                : null;

        const r = await pool.query(
            `UPDATE books SET
                catalog_match_status = $3,
                catalog_match_similarity = $4,
                catalog_match_confidence = $5,
                catalog_image_url = COALESCE($6, catalog_image_url),
                catalog_listing_url = COALESCE($7, catalog_listing_url),
                catalog_title = COALESCE($8, catalog_title),
                catalog_author = COALESCE($9, catalog_author),
                catalog_publisher = COALESCE($10, catalog_publisher),
                catalog_year = COALESCE($11, catalog_year),
                catalog_source = COALESCE($12, catalog_source),
                catalog_verified_at = NOW(),
                updated_at = NOW()
             WHERE ads_id = $1 AND isbn = $2`,
            [
                adsId,
                p.isbn,
                p.status ?? null,
                p.similarity ?? null,
                p.confidence ?? null,
                p.imageUrl ?? null,
                p.listingUrl ?? null,
                p.title ?? null,
                p.author ?? null,
                p.publisher ?? null,
                catalogYear,
                p.source ?? null,
            ]
        );

        wrote += r.rowCount || 0;
    }

    return wrote;
}
