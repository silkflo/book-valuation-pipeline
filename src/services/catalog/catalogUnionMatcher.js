// src/services/catalog/catalogUnionMatcher.js
//
// Union catalog matcher (Phase 5). Combines the two candidate sources so the
// seller's exact edition is in the pool regardless of which source has it:
//   1. Pipeline / ISBNSearch ISBNs already found for the detected book (precise).
//   2. AbeBooks keyword-search ISBNs for title+author (discovers editions the
//      pipeline missed — e.g. the Yvain Hachette edition).
// Dedupe by ISBN13 (tracking sourceFlags), confirm each cover on the AbeBooks
// CDN by ISBN, then run the strict Phase 3 image matcher against the crop.
//
// Standalone: composes the existing catalog services. No provider calls, no DB,
// no eligibility change, no provider images.

import { fetchAbebooksCatalogCandidates } from './abebooksCatalogSource.js';
import { fetchAbebooksCoversForIsbns } from './abebooksCoverByIsbn.js';
import { matchCatalogCandidates } from './catalogImageMatcher.js';

function cleanIsbn13(value) {
    const s = String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    return /^\d{13}$/.test(s) ? s : null;
}

function num(envName, fallback) {
    const v = Number(process.env[envName]);
    return Number.isFinite(v) ? v : fallback;
}

// Safety ceiling on vision compares per book (env-overridable).
const MAX_UNION_COMPARE = Math.max(1, num('CATALOG_UNION_MAX_COMPARE', 30));

// Cover-cluster decision thresholds.
const MIN_SIM = num('CATALOG_MATCH_MIN_SIMILARITY', 0.8); // a "strong match" cover
const MIN_CONF = num('CATALOG_MATCH_MIN_CONFIDENCE', 0.7);
const EXACT_GAP = num('CATALOG_MATCH_MIN_GAP', 0.15);     // lead needed to call a unique winner
const CLUSTER_GAP = num('CATALOG_CLUSTER_GAP', 0.1);      // spread within a "same cover" cluster
const CLUSTER_MAX = Math.max(2, num('CATALOG_CLUSTER_MAX', 3));
const NO_MATCH_SIM = num('CATALOG_MATCH_NO_MATCH_SIM', 0.45);

/**
 * Cover-cluster decision over the ranked candidates (sorted by similarity desc):
 *   selected_exact_isbn           - exactly one confident strong cover match
 *   selected_cover_ambiguous_isbn - 2..CLUSTER_MAX strong matches sharing a
 *                                   near-identical cover (reissues) -> a small
 *                                   ISBN cluster to disambiguate later by price
 *   needs_verification            - too many matches / unclear lead / no strong match
 *   no_match                      - nothing visually resembles the crop
 *
 * Image matching verifies the COVER/edition; it cannot distinguish ISBNs that
 * reuse one cover — that is exactly the ambiguous-cluster case.
 */
export function decideUnion(ranked) {
    const scored = (ranked || []).filter((c) => Number.isFinite(c.similarity));
    const empty = { selectedExactIsbn: null, selectedCandidate: null, ambiguousCluster: null, clusterSize: 0 };

    if (!scored.length) {
        return { decision: 'no_match', reason: 'No candidate cover could be compared.', ...empty };
    }

    const best = scored[0];

    if (best.similarity < NO_MATCH_SIM) {
        return { decision: 'no_match', reason: `No cover resembles the crop (best similarity ${best.similarity} < ${NO_MATCH_SIM}).`, ...empty };
    }

    const strong = scored.filter(
        (c) => c.matchStatus === 'match' && c.similarity >= MIN_SIM && c.confidence >= MIN_CONF
    );

    if (!strong.length) {
        return {
            decision: 'needs_verification',
            reason: `Best cover is plausible (similarity ${best.similarity}) but not a confident strong match (status ${best.matchStatus}, confidence ${best.confidence}).`,
            ...empty,
        };
    }

    if (strong.length === 1) {
        return {
            decision: 'selected_exact_isbn',
            reason: `Exactly one confident strong cover match (similarity ${strong[0].similarity}, confidence ${strong[0].confidence}).`,
            selectedExactIsbn: strong[0].isbn13,
            selectedCandidate: strong[0],
            ambiguousCluster: null,
            clusterSize: 1,
        };
    }

    // 2+ strong matches: a tight near-identical cluster (same cover, different
    // ISBNs) vs a clear single winner vs genuinely conflicting matches.
    const top = strong[0];
    const cluster = strong.filter((c) => top.similarity - c.similarity <= CLUSTER_GAP);

    if (cluster.length === 1) {
        const gap = Number((top.similarity - strong[1].similarity).toFixed(2));
        if (gap >= EXACT_GAP) {
            return {
                decision: 'selected_exact_isbn',
                reason: `Top cover match clearly leads other matches by ${gap}.`,
                selectedExactIsbn: top.isbn13,
                selectedCandidate: top,
                ambiguousCluster: null,
                clusterSize: 1,
            };
        }
        return { decision: 'needs_verification', reason: `Multiple strong matches with an unclear lead (gap ${gap}).`, ...empty };
    }

    if (cluster.length <= CLUSTER_MAX) {
        return {
            decision: 'selected_cover_ambiguous_isbn',
            reason: `Cover verified, but ${cluster.length} ISBNs share a near-identical cover (sim ${cluster.map((c) => c.similarity).join(', ')}) — ambiguous ISBN; disambiguate by provider price.`,
            selectedExactIsbn: null,
            selectedCandidate: null,
            ambiguousCluster: cluster,
            clusterSize: cluster.length,
        };
    }

    return { decision: 'needs_verification', reason: `Too many near-identical matching covers (${cluster.length}) — ambiguous.`, ...empty };
}

// --- Deterministic pre-AI candidate planning (dedupe / filter / rank / cap) ----
function normTitle(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function titleTokens(s) {
    return new Set(normTitle(s).split(' ').filter((t) => t.length > 1));
}
// Jaccard token overlap in [0,1]; 0 when either side is empty.
export function titleSimilarity(a, b) {
    const ta = titleTokens(a);
    const tb = titleTokens(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter += 1;
    return Number((inter / (ta.size + tb.size - inter)).toFixed(3));
}

/**
 * Plan which catalog candidates actually go to AI cover-verify, BEFORE any vision call:
 *   1. keep only candidates with a cover image (others can't be compared),
 *   2. low-floor title prefilter (drops near-zero-overlap NON-pipeline candidates;
 *      never drops pipeline ISBNs; disabled when floor<=0 or no detected title),
 *   3. rank: pipeline ISBNs (the book's own resolved editions) first, then by title
 *      similarity to the detected book,
 *   4. dedupe by cover image URL (reissues sharing one cover -> ONE compare, keeping
 *      the full ISBN group so the ambiguous-cluster decision still sees every ISBN),
 *   5. cap to maxCompare (CATALOG_MATCH_MAX_COMPARE, default 3) AFTER dedupe/filter.
 * Pure + deterministic (no I/O) so it is unit-testable offline.
 */
export function planUnionCompares({ candidates = [], detectedTitle = '', maxCompare, titleFloor } = {}) {
    const cap = Math.max(1, Math.min(
        Number.isFinite(Number(maxCompare)) ? Number(maxCompare) : num('CATALOG_MATCH_MAX_COMPARE', 3),
        MAX_UNION_COMPARE,
    ));
    const floor = Number.isFinite(Number(titleFloor)) ? Number(titleFloor) : num('CATALOG_PREFILTER_TITLE_MIN', 0);
    const det = detectedTitle || '';
    const isPipeline = (c) => Array.isArray(c.sourceFlags) && c.sourceFlags.includes('pipeline');

    const withCover = (candidates || []).filter((c) => c && c.imageUrl);
    const candidateRows = withCover.length;

    let skippedLowScore = 0;
    const kept = withCover.filter((c) => {
        if (isPipeline(c) || !det || floor <= 0) return true;
        if (titleSimilarity(det, c.title) >= floor) return true;
        skippedLowScore += 1;
        return false;
    });

    kept.sort((a, b) => {
        if (isPipeline(a) !== isPipeline(b)) return isPipeline(a) ? -1 : 1;
        return titleSimilarity(det, b.title) - titleSimilarity(det, a.title);
    });

    const byCover = new Map();
    for (const c of kept) {
        if (!byCover.has(c.imageUrl)) byCover.set(c.imageUrl, { rep: c, isbns: [] });
        byCover.get(c.imageUrl).isbns.push(c.isbn13);
    }
    const unique = [...byCover.values()].map(({ rep, isbns }) => ({ ...rep, coverIsbnGroup: isbns }));
    const uniqueCandidates = unique.length;
    const skippedDedupe = kept.length - uniqueCandidates;

    const toCompare = unique.slice(0, cap);

    return {
        toCompare,
        candidateRows,
        uniqueCandidates,
        skippedDedupe,
        skippedLowScore,
        cappedOut: Math.max(0, uniqueCandidates - toCompare.length),
    };
}

/**
 * Build the deduped union of pipeline + AbeBooks-keyword candidates, confirm
 * covers, and image-match against the Leboncoin crop.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.author]
 * @param {Array}  [options.pipelineCandidates] - [{ isbn13|isbn, title?, author?, publisher? }]
 * @param {object} [options.cropSource]  - { sourceImageUrl, bbox, orientation }
 * @param {string} [options.cropImagePath]
 * @param {string} [options.cropImageUrl]
 * @param {number} [options.maxCompare]
 */
export async function unionMatchCatalog({
    title,
    author = null,
    pipelineCandidates = [],
    cropSource,
    cropImagePath,
    cropImageUrl,
    detectedTitle = title,
    maxCompare,
    cache = null, // optional in-run (crop, cover) pair cache shared across the ad
} = {}) {
    // 1. Keyword discovery (the only paid step — ~1 Scrapfly credit).
    const keyword = await fetchAbebooksCatalogCandidates({ title, author, maxResults: 10 });
    const scrapflyCredits = Number(keyword.scrapflyCost) || 0;

    // 2. Union by ISBN13, tracking which source(s) contributed each ISBN.
    const byIsbn = new Map();
    const addOrMerge = (rawIsbn, data, flag) => {
        const isbn13 = cleanIsbn13(rawIsbn);
        if (!isbn13) return;
        const existing = byIsbn.get(isbn13) || { flags: new Set() };
        existing.flags.add(flag);
        existing.title = existing.title || data.title || null;
        existing.author = existing.author || data.author || null;
        existing.publisher = existing.publisher || data.publisher || null;
        existing.year = existing.year || data.year || null;
        existing.listingUrl = existing.listingUrl || data.listingUrl || null;
        byIsbn.set(isbn13, existing);
    };

    const pipelineIsbns = new Set();
    for (const p of pipelineCandidates) {
        const isbn13 = cleanIsbn13(p.isbn13 || p.isbn);
        if (!isbn13) continue;
        pipelineIsbns.add(isbn13);
        addOrMerge(isbn13, { title: p.title, author: p.author, publisher: p.publisher }, 'pipeline');
    }
    for (const c of keyword.candidates || []) {
        addOrMerge(c.isbn13, { title: c.title, author: c.author, publisher: c.publisher, year: c.year, listingUrl: c.listingUrl }, 'abebooks_keyword');
    }

    // 3. Confirm an AbeBooks CDN cover for every union ISBN (free, no Scrapfly).
    const unionIsbns = [...byIsbn.keys()];
    const covers = await fetchAbebooksCoversForIsbns(unionIsbns);
    const coverByIsbn = new Map(covers.filter((c) => c.ok).map((c) => [c.isbn13, c]));

    // 4. Candidates = union ISBNs with a confirmed cover.
    const candidates = [];
    for (const [isbn13, info] of byIsbn) {
        const cover = coverByIsbn.get(isbn13);
        if (!cover) continue;
        candidates.push({
            isbn13,
            title: info.title,
            author: info.author,
            publisher: info.publisher,
            year: info.year,
            imageUrl: cover.imageUrl,
            listingUrl: info.listingUrl,
            sourceFlags: [...info.flags],
        });
    }

    const sourceCounts = {
        pipelineCandidates: pipelineIsbns.size,
        abebooksKeywordCandidates: (keyword.candidates || []).length,
        unionCandidates: byIsbn.size,
        coversFound: candidates.length,
    };

    if (!candidates.length) {
        return {
            sourceCounts,
            candidates: [],
            decision: 'no_match',
            selectedExactIsbn: null,
            selectedCandidate: null,
            ambiguousCluster: null,
            clusterSize: 0,
            reason: keyword.ok ? 'No union candidate had a confirmable cover.' : `Keyword search failed (${keyword.reason}); no covers.`,
            scrapflyCost: scrapflyCredits,
            estimatedCost: { scrapflyCredits, visionUsd: 0 },
            ok: false,
        };
    }

    // 5. Plan the compares BEFORE any vision call: rank (pipeline first, then title
    //    similarity), dedupe by cover image URL (reissues -> 1 compare), and cap to
    //    CATALOG_MATCH_MAX_COMPARE (default 3) AFTER dedupe. This is where the per-book
    //    fan-out is actually bounded (previously the cap was effectively candidates.length).
    const plan = planUnionCompares({ candidates, detectedTitle, maxCompare });

    const match = await matchCatalogCandidates({
        cropSource,
        cropImagePath,
        cropImageUrl,
        detectedTitle,
        candidates: plan.toCompare,
        maxCompare: Math.max(1, plan.toCompare.length),
        cache,
    });

    // 6. Expand each COMPARED cover's result back to every ISBN that shares that cover
    //    (so the cover-cluster decision still sees the full reissue cluster), re-attaching
    //    sourceFlags + metadata, then re-sort by similarity desc.
    const repByIsbn = new Map(plan.toCompare.map((c) => [c.isbn13, c]));
    const metaByIsbn = new Map(candidates.map((c) => [c.isbn13, c]));
    const ranked = [];
    for (const r of match.candidates) {
        const rep = repByIsbn.get(r.isbn13);
        const group = rep && Array.isArray(rep.coverIsbnGroup) && rep.coverIsbnGroup.length ? rep.coverIsbnGroup : [r.isbn13];
        for (const isbn of group) {
            const meta = metaByIsbn.get(isbn) || {};
            ranked.push({
                ...r,
                isbn13: isbn,
                title: meta.title ?? r.title,
                author: meta.author ?? r.author,
                publisher: meta.publisher ?? r.publisher,
                year: meta.year ?? r.year,
                listingUrl: meta.listingUrl ?? r.listingUrl,
                sourceFlags: Array.isArray(meta.sourceFlags) ? meta.sourceFlags : [],
            });
        }
    }
    ranked.sort((a, b) => ((b.similarity ?? -1) - (a.similarity ?? -1)) || ((b.confidence || 0) - (a.confidence || 0)));

    // 7. Cover-cluster decision (Phase 5b) over the ranked candidates.
    const verdict = decideUnion(ranked);

    const aiBudget = {
        candidateRows: plan.candidateRows,
        uniqueCandidates: plan.uniqueCandidates,
        aiCallsPlanned: match.apiCalls ?? match.comparedCount ?? plan.toCompare.length,
        comparedCount: match.comparedCount ?? plan.toCompare.length,
        cacheHits: match.cacheHits || 0,
        skippedDedupe: plan.skippedDedupe,
        skippedLowScore: plan.skippedLowScore,
        cappedOut: plan.cappedOut,
    };

    return {
        sourceCounts,
        candidates: ranked,
        decision: verdict.decision,
        selectedExactIsbn: verdict.selectedExactIsbn,
        selectedCandidate: verdict.selectedCandidate,
        ambiguousCluster: verdict.ambiguousCluster,
        clusterSize: verdict.clusterSize,
        reason: verdict.reason,
        scrapflyCost: scrapflyCredits,
        estimatedCost: { scrapflyCredits, visionUsd: Number(match.costUsd) || 0 },
        aiBudget,
        ok: match.ok,
    };
}
