// src/workflows/processApifyPayload.js

import { pool } from '../db.js';
import { saveAdsFromPayload } from '../services/saveAds.js';
import { extractBooksWithOpenAI } from '../services/extractBooksWithOpenAI.js';
import { triggerMomoxActorForAd } from '../services/triggerMomoxActor.js';
import { updateMomoxPricesForAd, markMomoxLookupFailed } from '../services/updateMomoxBatch.js';
import { updateGibertPricesForAd, markGibertLookupFailed } from '../services/updateGibertBatch.js';
import { runProviderLookup } from '../services/providerLookupLimiter.js';
import { verifyProviderImagesForAd, tryProviderAlternativesForAd } from '../services/providerImageVerifyForAd.js';
import { catalogEligibilityForBook, persistCatalogRows } from '../services/catalog/verifyCatalogForAd.js';
import { runAiIsbnFallback, shouldTriggerFallback } from '../services/aiIsbnFallback.js';
import { setCurrentAd, summarizeAdAiUsage } from '../services/aiUsage.js';
import { runLensFallback, selectLensCandidates, lensPublicBaseUrl } from '../services/lensFallback.js';
import { cropQualityLevel } from '../services/cropQuality.js';
import { isCropDebugEnabled, saveBookCropDebug, ensureLensTempCropUrl, cleanupLensTempCrops } from '../services/cropDebug.js';
import { downloadImageToBuffer } from '../services/tempImages.js';
import { hasMomoxStatusColumn, hasBooksColumn, providerStatusLiteral, safeTextLiteral } from '../services/bookColumns.js';
import { computeSellerBookPrices, parseTitleFallbackPrice } from '../services/bookPriceFromDescription.js';
import { classifyAdBookRelevance, shouldRejectAsNonBook } from '../services/adEarlyFilter.js';
import { saveBookCropVariantsForUi } from '../services/bookCropImages.js';
import {
    getAllNewAds,
    getNewAdsByIds,
    incrementAdProcessAttempts,
    markAdProcessed,
    bookAlreadyProcessedForAd,
    checkProviderCompletionForAd,
    deriveBackendStatus,
} from '../services/adStatus.js';



function normalizeSavedAds(adsResult) {
    if (Array.isArray(adsResult.ads)) {
        return adsResult.ads;
    }

    return [];
}

function isManualAdPayload(payload) {
    return payload?.mode === 'manual_ad' || payload?.source === 'manual_ad';
}

function normalizeExtractionResult(result) {
    if (Array.isArray(result)) {
        return {
            resolvedBooks: result,
            validBooks: result.filter(isBookEligibleForMomox),
        };
    }

    if (result && typeof result === 'object') {
        const resolvedBooks = Array.isArray(result.resolvedBooks)
            ? result.resolvedBooks
            : Array.isArray(result.allBooks)
                ? result.allBooks
                : Array.isArray(result.books)
                    ? result.books
                    : [];

        // IMPORTANT:
        // Do not blindly trust result.validBooks / result.acceptedBooks here.
        // The workflow may apply newer MVP promotion rules than the extraction service.
        const locallyEligibleBooks = resolvedBooks.filter(isBookEligibleForMomox);

        const upstreamValidBooks = [
            ...(Array.isArray(result.validBooks) ? result.validBooks : []),
            ...(Array.isArray(result.acceptedBooks) ? result.acceptedBooks : []),
        ];

        const byKey = new Map();

        for (const book of [...upstreamValidBooks, ...locallyEligibleBooks]) {
            const key = [
                book.isbn || book.isbn13 || '',
                book.title || book.possible_corrected_title || book.raw_visible_text || '',
                book.image_index ?? '',
            ].join('|');

            if (!byKey.has(key)) {
                byKey.set(key, book);
            }
        }

        return {
            resolvedBooks,
            validBooks: [...byKey.values()],
        };
    }

    return {
        resolvedBooks: [],
        validBooks: [],
    };
}

function normalizeNumber(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return null;
    }

    return number;
}
function normalizeMatchText(value) {
    return String(value || '')
        .toLowerCase()
        // Expand ligatures BEFORE diacritic stripping, otherwise "chefs-d'œuvre"
        // becomes "chefs d uvre" and no longer matches "chefs d'oeuvre".
        .replace(/œ/g, 'oe')
        .replace(/æ/g, 'ae')
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/&/g, ' and ')
        .replace(/\+/g, ' plus ')
        .replace(/['’`´]/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getBookField(book, camelName, snakeName) {
    return book?.[camelName] ?? book?.[snakeName] ?? null;
}

function isSafeMainTitlePrefixMatch(detectedTitle, lookupTitle) {
    const detected = normalizeMatchText(detectedTitle);
    const lookup = normalizeMatchText(lookupTitle);

    if (!detected || !lookup) return false;
    if (detected.length < 12) return false;

    if (detected === lookup) return true;

    if (lookup.startsWith(`${detected} `)) return true;

    if (detected.startsWith(`${lookup} `) && lookup.length >= 12) return true;

    return false;
}

// The MAIN title, i.e. everything before the first subtitle/edition delimiter
// (": chefs-d'oeuvre ...", "; [publ. à l'occasion ...]", "(French Edition)").
// This is what stays stable when ISBNSearch's /isbn page returns a very long
// bibliographic title that tanks the token-overlap score.
function mainTitleOf(title) {
    return String(title || '').split(/[:;(\[]/)[0];
}

const WORK_MATCH_STOPWORDS = new Set([
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'd', 'l', 'et', 'a',
    'au', 'aux', 'en', 'the', 'of', 'and', 'edition', 'french', 'tome', 'vol',
]);

function meaningfulTitleTokens(value) {
    return normalizeMatchText(value)
        .split(' ')
        .filter((token) => token.length >= 3 && !WORK_MATCH_STOPWORDS.has(token));
}

// Fraction of the detected title's meaningful tokens that appear in the lookup
// title. ~1.0 when the detected title is fully contained in a long verified
// title (the "L'Art de l'automobile : chefs-d'oeuvre ..." case).
function detectedTokenContainment(detectedTitle, lookupTitle) {
    const detectedTokens = meaningfulTitleTokens(detectedTitle);
    if (detectedTokens.length < 2) return 0;

    const lookupTokens = new Set(meaningfulTitleTokens(lookupTitle));
    if (!lookupTokens.size) return 0;

    const present = detectedTokens.filter((token) => lookupTokens.has(token)).length;
    return present / detectedTokens.length;
}

/**
 * "Strong same-work match" for provider eligibility (Finding 2). A long
 * bibliographic verified title must NOT exclude a book whose main title clearly
 * matches. True when ANY of:
 *   - rawTextSimilarity or bestTitleSimilarity (when preserved) >= 0.85,
 *   - the detected title (full or main-before-colon, or raw spine text) is a
 *     clean prefix of the verified title,
 *   - the detected meaningful tokens are >= 85% contained in the verified title.
 */
function isStrongWorkMatch(book) {
    const detectedTitle =
        getBookField(book, 'possibleCorrectedTitle', 'possible_corrected_title') ||
        getBookField(book, 'title', 'title');
    const rawText = getBookField(book, 'rawVisibleText', 'raw_visible_text');
    const lookupTitle = getBookField(book, 'lookupTitle', 'lookup_title');

    if (!lookupTitle) return false;

    const rawSim = normalizeNumber(getBookField(book, 'rawTextSimilarity', 'raw_text_similarity')) ?? 0;
    const bestSim = normalizeNumber(getBookField(book, 'bestTitleSimilarity', 'best_title_similarity')) ?? 0;

    if (rawSim >= 0.85 || bestSim >= 0.85) return true;

    if (isSafeMainTitlePrefixMatch(detectedTitle, lookupTitle)) return true;
    if (isSafeMainTitlePrefixMatch(rawText, lookupTitle)) return true;

    // Detected MAIN title (before subtitle) prefixing the long verified title.
    if (isSafeMainTitlePrefixMatch(mainTitleOf(detectedTitle), lookupTitle)) return true;

    // Token containment handles OCR noise + long verified titles.
    if (detectedTokenContainment(detectedTitle, lookupTitle) >= 0.85) return true;
    if (detectedTokenContainment(rawText, lookupTitle) >= 0.85) return true;

    return false;
}

function isSameNormalizedAuthor(detectedAuthor, lookupAuthors) {
    const detected = normalizeMatchText(detectedAuthor);
    const lookup = normalizeMatchText(lookupAuthors);

    if (!detected || !lookup) return false;

    if (detected === lookup) return true;
    if (lookup.includes(detected)) return true;
    if (detected.includes(lookup)) return true;

    const detectedParts = detected.split(' ').filter(Boolean);
    const lookupParts = lookup.split(' ').filter(Boolean);

    if (detectedParts.length < 2 || lookupParts.length < 2) {
        return false;
    }

    const detectedSet = new Set(detectedParts);
    const overlap = lookupParts.filter((part) => detectedSet.has(part)).length;

    return overlap >= 2;
}

function shouldPromoteMediumIsbnCandidate(book) {
    const isbn = getBookField(book, 'isbn', 'isbn');
    const isbnIsValid = getBookField(book, 'isbnIsValid', 'isbn_is_valid');

    const isbnConfidence =
        normalizeNumber(getBookField(book, 'isbnConfidence', 'isbn_confidence')) ?? 0;

    if (!isbn) return false;
    if (isbnIsValid === false) return false;

    // Only promote medium candidates, not weak/random matches.
    if (isbnConfidence < 0.5 || isbnConfidence >= 0.85) return false;

    const detectedTitle =
        getBookField(book, 'possibleCorrectedTitle', 'possible_corrected_title') ||
        getBookField(book, 'title', 'title') ||
        getBookField(book, 'rawVisibleText', 'raw_visible_text');

    const lookupTitle =
        getBookField(book, 'lookupTitle', 'lookup_title') ||
        getBookField(book, 'lookup_title', 'lookup_title');

    const detectedAuthor =
        getBookField(book, 'author', 'author');

    const lookupAuthors =
        getBookField(book, 'lookupAuthors', 'lookup_authors') ||
        getBookField(book, 'authors', 'authors');

    const prefixTitleMatch = isSafeMainTitlePrefixMatch(detectedTitle, lookupTitle);
    const authorMatch = isSameNormalizedAuthor(detectedAuthor, lookupAuthors);

    return prefixTitleMatch && authorMatch;
}


function isBookEligibleForMomox(book) {
    const isbn = getBookField(book, 'isbn', 'isbn');
    const isbnIsValid = getBookField(book, 'isbnIsValid', 'isbn_is_valid');

    const isbnConfidence =
        normalizeNumber(getBookField(book, 'isbnConfidence', 'isbn_confidence')) ?? 0;

    if (!isbn) {
        return false;
    }

    if (isbnIsValid === false) {
        return false;
    }

    if (isbnConfidence >= 0.85) {
        return true;
    }

    if (shouldPromoteMediumIsbnCandidate(book)) {
        return true;
    }

    return false;
}

// Phase B provider eligibility (recall-oriented). We send PLAUSIBLE candidates
// to Momox/Gibert, not only strong ones, and let provider IMAGE verification be
// the precision filter. A long bibliographic verified title must NOT block a
// lookup when the detected main title is a clean prefix of it
// (e.g. detected "L'Art de l'automobile" vs verified "L'art de l'automobile,
// chefs d'oeuvre de la collection Ralph Lauren ..."). Returns { eligible, reason }.
// Cost-stop provider eligibility (immediate fan-out reduction): send ONLY the
// one selected/main ISBN per detected book, and only when we are confident in
// the exact edition. A book qualifies when it has a VISIBLE ISBN (exact match)
// or its selected-ISBN confidence is >= PROVIDER_MIN_ISBN_CONFIDENCE (~0.80).
// Low/medium confidence work-matches are held for verification rather than
// fanned out to Momox/Gibert (no AI-invented ISBNs, no alternative editions).
const PROVIDER_MIN_ISBN_CONFIDENCE = Math.min(
    Math.max(Number(process.env.PROVIDER_MIN_ISBN_CONFIDENCE || 0.80), 0),
    1
);

function hasVisibleIsbnMatch(book) {
    const source = getBookField(book, 'isbnSource', 'isbn_source');
    if (source === 'visible_isbn') return true;
    return Boolean(getBookField(book, 'visibleIsbn', 'visible_isbn'));
}

export function getProviderEligibility(book) {
    const isbn = getBookField(book, 'isbn', 'isbn');
    const isbnIsValid = getBookField(book, 'isbnIsValid', 'isbn_is_valid');

    if (!isbn) return { eligible: false, reason: 'no_isbn' };
    if (isbnIsValid === false) return { eligible: false, reason: 'isbn_invalid' };

    const conf = normalizeNumber(getBookField(book, 'isbnConfidence', 'isbn_confidence')) ?? 0;

    // Exception: a visible ISBN read off the book is an exact match -> send.
    if (hasVisibleIsbnMatch(book)) {
        return { eligible: true, reason: 'visible_isbn' };
    }

    // Otherwise require high confidence in the selected ISBN.
    if (conf >= PROVIDER_MIN_ISBN_CONFIDENCE) {
        return { eligible: true, reason: 'strong_isbn' };
    }

    // Below threshold: hold for verification rather than fan out to providers.
    return {
        eligible: false,
        reason: conf >= 0.5 ? 'needs_verification_medium' : 'needs_verification_low',
    };
}

// Map an internal eligibility/skip reason onto the documented not_sent_reason
// vocabulary the admin UI reads. The confidence-held cases collapse to one
// stable value so the UI can show a single "Demander le prix" affordance.
export function normalizeNotSentReason(reason) {
    if (!reason) return 'not_eligible';
    if (reason === 'no_isbn' || reason === 'isbn_invalid') return reason;
    if (String(reason).startsWith('needs_verification')) {
        return 'isbn_confidence_below_threshold';
    }
    return reason;
}

const ADMIN_REVIEW_PROVIDER_REASONS = new Set([
    'poor_crop_needs_cover_match',
    'poor_crop_unverified_budget',
    'poor_crop_selected_exact_low_confidence',
    'poor_crop_selected_exact_title_conflict',
    'cover_mismatch_needs_review',
    'catalog_needs_verification',
    'catalog_no_match',
    'ad_match_budget_reached',
    'not_eligible',
    'isbn_confidence_below_threshold',
    'needs_verification_medium',
    'needs_verification_low',
    // Quality-gate holds (book kept + ISBN candidate, but not provider-eligible):
    'crop_retry_mismatch',
    'catalog_budget_no_cover_proof',
    'tiny_crop_cover_unconfirmed',
]);

function shouldFlagProviderNeedsAdminReview({ book, classification, notSentReason }) {
    if (!book?.isbn) return false;

    const reason = String(notSentReason || '');
    if (reason === 'no_isbn' || reason === 'isbn_invalid') return false;

    const candidateStatus = String(classification?.candidateStatus || '');
    const status = String(classification?.status || '');
    const confidence = normalizeNumber(book.isbn_confidence ?? book.isbnConfidence) ?? 0;

    // Good candidate held by provider/catalog gate: UI should highlight it.
    if (
        candidateStatus === 'strong_candidate' ||
        candidateStatus === 'medium_candidate' ||
        status === 'isbn_strong' ||
        status === 'isbn_medium' ||
        status === 'isbn_medium_promoted' ||
        confidence >= 0.5
    ) {
        return true;
    }

    return ADMIN_REVIEW_PROVIDER_REASONS.has(reason);
}

function classifyBookCandidate(book) {
    const isbn = getBookField(book, 'isbn', 'isbn');
    const isbnIsValid = getBookField(book, 'isbnIsValid', 'isbn_is_valid');

    const isbnConfidence =
        normalizeNumber(getBookField(book, 'isbnConfidence', 'isbn_confidence')) ?? 0;

    if (!isbn) {
        return {
            status: 'isbn_not_found',
            candidateStatus: 'no_isbn',
            reviewStatus: 'manual_review',
            skipReason: 'No valid ISBN found',
        };
    }

    if (isbnIsValid === false) {
        return {
            status: 'isbn_invalid',
            candidateStatus: 'no_isbn',
            reviewStatus: 'manual_review',
            skipReason: 'Invalid ISBN',
        };
    }

    if (isbnConfidence < 0.5) {
        return {
            status: 'isbn_weak',
            candidateStatus: 'weak_candidate',
            reviewStatus: 'manual_review',
            skipReason: 'ISBN confidence below Momox threshold',
        };
    }

    if (isbnConfidence < 0.85) {
        if (shouldPromoteMediumIsbnCandidate(book)) {
            return {
                status: 'isbn_medium_promoted',
                candidateStatus: 'medium_candidate',
                reviewStatus: 'manual_review',
                skipReason: 'Medium ISBN promoted: main title prefix + author match',
            };
        }

        return {
            status: 'isbn_medium',
            candidateStatus: 'medium_candidate',
            reviewStatus: 'manual_review',
            skipReason: null,
        };
    }

    return {
        status: 'isbn_strong',
        candidateStatus: 'strong_candidate',
        reviewStatus: 'pending',
        skipReason: null,
    };
}





function getBookSourceImageUrl(book, ad, imageUrls) {
    const imageIndex = Number(book.image_index);

    if (
        Number.isFinite(imageIndex) &&
        imageIndex > 0 &&
        Array.isArray(imageUrls) &&
        imageUrls[imageIndex - 1]
    ) {
        return imageUrls[imageIndex - 1];
    }

    return ad.firstPictureUrl || null;
}

function buildLookupCandidates(book) {
    if (Array.isArray(book.lookup_candidates)) {
        return book.lookup_candidates;
    }

    if (!book.lookup_title && !book.lookup_score && !book.isbn) {
        return [];
    }

    return [
        {
            isbn: book.isbn || null,
            isbn13: book.isbn13 || null,
            isbn10: book.isbn10 || null,
            title: book.lookup_title || null,
            authors: book.lookup_authors || null,
            publisher: book.lookup_publisher || null,
            publishedDate: book.lookup_published_date || null,
            language: book.lookup_language || null,
            score: book.lookup_score ?? book.isbn_confidence ?? null,
            query: book.lookup_query || null,
            selected: Boolean(book.isbn),
        },
    ];
}

function getCandidateIsbn(candidate) {
    return candidate?.isbn || candidate?.isbn13 || null;
}

function getStrongLookupCandidates(book) {
    const lookupCandidates = buildLookupCandidates(book);
    const seenIsbns = new Set();
    const strongCandidates = [];

    for (const candidate of lookupCandidates) {
        const candidateIsbn = getCandidateIsbn(candidate);
        const score = normalizeNumber(candidate?.score) ?? 0;

        if (!candidateIsbn) continue;
        if (score < 0.5) continue;
        if (seenIsbns.has(candidateIsbn)) continue;

        seenIsbns.add(candidateIsbn);
        strongCandidates.push(candidate);
    }

    return strongCandidates;
}


// Page-1 candidates whose title matches the detected title exactly (or
// article-insensitively) are alternative EDITIONS of the same book. They are
// all priced on Momox/Gibert; the admin validates the correct edition later.
function getExactTitleAlternativeCandidates(book) {
    const primaryIsbn = book.isbn || null;
    const seen = new Set(primaryIsbn ? [primaryIsbn] : []);
    const alternatives = [];

    for (const candidate of getStrongLookupCandidates(book)) {
        if (!candidate.exactTitleMatch && !candidate.articleInsensitiveTitleMatch) continue;

        const candidateIsbn = getCandidateIsbn(candidate);
        const score = normalizeNumber(candidate?.score) ?? 0;

        if (!candidateIsbn || seen.has(candidateIsbn)) continue;
        if (score < 0.5) continue;

        seen.add(candidateIsbn);
        alternatives.push(candidate);
    }

    return alternatives;
}


function getExactTitleAlternativeIsbnSet(book) {
    return new Set(
        getExactTitleAlternativeCandidates(book)
            .map((candidate) => getCandidateIsbn(candidate))
            .filter(Boolean)
    );
}


function isCandidateEligibleForMomox(book) {
    return isBookEligibleForMomox(book);
}


// Rank alternative-edition rows high-value first (exact-title "priceable" alternatives,
// then highest lookup score, then ISBN confidence) and keep at most `max`. Pure/exported
// so the persistence cap is unit-testable. The selected/main row is handled separately.
export function selectPersistedAlternatives(altRows, max) {
    const cap = Math.max(0, Number.isFinite(Number(max)) ? Number(max) : 2);
    return [...(Array.isArray(altRows) ? altRows : [])]
        .sort((a, b) =>
            (Number(Boolean(b._isPriceableAlternativeCandidate)) - Number(Boolean(a._isPriceableAlternativeCandidate)))
            || ((b.lookup_score || 0) - (a.lookup_score || 0))
            || ((b.isbn_confidence || 0) - (a.isbn_confidence || 0)))
        .slice(0, cap);
}

function buildAdminCandidateRows(book) {
    const lookupCandidates = buildLookupCandidates(book);
    const strongCandidates = getStrongLookupCandidates(book);
    const exactAlternativeIsbnSet = getExactTitleAlternativeIsbnSet(book);
    const hasPriceableAlternativeCandidates = exactAlternativeIsbnSet.size > 0;

    const rows = [
        {
            ...book,
            lookup_candidates: lookupCandidates,
            _adminCandidateAlternative: false,
            _isPriceableAlternativeCandidate: false,
            _hasPriceableAlternativeCandidates: hasPriceableAlternativeCandidates,
            _duplicateCandidateCount: hasPriceableAlternativeCandidates
                ? exactAlternativeIsbnSet.size + 1
                : 0,
        },
    ];

    const seenIsbns = new Set();

    if (book.isbn) {
        seenIsbns.add(book.isbn);
    }

    // Cap how many ALTERNATIVE-edition rows we persist per physical book. The selected/
    // main candidate (rows[0]) is always kept; alternatives are noisy (large ads created
    // ~100 rows for ~20 books). Keep only high-value ones — exact-title "priceable"
    // alternatives first, then highest lookup score — up to the cap.
    const MAX_PERSISTED_ALTERNATIVES_PER_BOOK = Math.max(
        0,
        Number.isFinite(Number(process.env.MAX_PERSISTED_ALTERNATIVES_PER_BOOK))
            ? Number(process.env.MAX_PERSISTED_ALTERNATIVES_PER_BOOK)
            : 2
    );
    const altRows = [];

    for (const candidate of strongCandidates) {
        const candidateIsbn = getCandidateIsbn(candidate);

        if (!candidateIsbn) continue;
        if (seenIsbns.has(candidateIsbn)) continue;

        const isPriceableAlternative = exactAlternativeIsbnSet.has(candidateIsbn);

        seenIsbns.add(candidateIsbn);

        altRows.push({
            ...book,

            isbn: candidateIsbn,
            isbn13: candidate.isbn13 || candidateIsbn,
            isbn10: candidate.isbn10 || null,
            isbn13_raw: candidate.isbn13 || candidateIsbn,
            isbn10_raw: candidate.isbn10 || null,
            isbn_is_valid: true,
            isbn_source: candidate.source || book.isbn_source || 'isbnsearch_candidate',

            isbn_confidence: normalizeNumber(candidate.score) ?? 0,

            lookup_title: candidate.title || null,
            lookup_authors: candidate.authors || null,
            lookup_publisher: candidate.publisher || null,
            lookup_published_date: candidate.publishedDate || null,
            lookup_language: candidate.language || null,
            lookup_score: normalizeNumber(candidate.score) ?? 0,
            lookup_query: candidate.query || book.lookup_query || null,

            title_similarity: candidate.titleSimilarity ?? null,
            raw_text_similarity: candidate.rawTextSimilarity ?? null,
            corrected_title_similarity: candidate.correctedTitleSimilarity ?? null,
            best_title_similarity: candidate.bestTitleSimilarity ?? null,
            author_similarity: candidate.authorSimilarity ?? null,

            lookup_candidates: lookupCandidates,

            _adminCandidateAlternative: isPriceableAlternative,
            _isPriceableAlternativeCandidate: isPriceableAlternative,
            _hasPriceableAlternativeCandidates: hasPriceableAlternativeCandidates,
            _duplicateCandidateCount: hasPriceableAlternativeCandidates
                ? exactAlternativeIsbnSet.size + 1
                : 0,
        });
    }

    const keptAlts = selectPersistedAlternatives(altRows, MAX_PERSISTED_ALTERNATIVES_PER_BOOK);

    // Stats for the per-ad [candidate-persist] log (read off the main row by the caller).
    rows[0]._altConsidered = altRows.length;
    rows[0]._altPersisted = keptAlts.length;

    return [...rows, ...keptAlts];
}

async function findExistingBookId({ adsId, isbn, title, imageIndex }) {
    if (isbn) {
        const result = await pool.query(
            `
            SELECT id
            FROM books
            WHERE ads_id = $1
              AND isbn = $2
            ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
            LIMIT 1
            `,
            [adsId, isbn]
        );

        return result.rows[0]?.id || null;
    }

    const result = await pool.query(
        `
        SELECT id
        FROM books
        WHERE ads_id = $1
          AND COALESCE(title, '') = COALESCE($2, '')
          AND COALESCE(image_index, -1) = COALESCE($3::integer, -1)
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
        LIMIT 1
        `,
        [adsId, title || null, Number.isFinite(Number(imageIndex)) ? Number(imageIndex) : null]
    );

    return result.rows[0]?.id || null;
}


async function persistBookCropImageUrl(bookId, bookCropImageUrl) {
    if (!bookId || !bookCropImageUrl) return;

    if (!(await hasBooksColumn('book_crop_image_url'))) {
        return;
    }

    await pool.query(
        `
        UPDATE books
           SET book_crop_image_url = $2,
               updated_at = NOW()
         WHERE id = $1
        `,
        [bookId, bookCropImageUrl]
    );
}


async function upsertBookCandidate({
    adsId,
    ad,
    book,
    sourceImageUrl,
    bookCropImageUrl = null,
    willSendToMomox,
    notSentReason = null,
}) {
    const classification = classifyBookCandidate(book);

    const hasPriceableAlternativeCandidates = Boolean(book._hasPriceableAlternativeCandidates);
    const isPriceableAlternative = Boolean(book._isPriceableAlternativeCandidate);
    const isAlternativeGroupRow = hasPriceableAlternativeCandidates && willSendToMomox;

    const status = isAlternativeGroupRow
        ? 'isbn_alternative_candidate'
        : willSendToMomox
            ? 'ready_for_resale_check'
            : classification.status;

    const candidateStatus = isAlternativeGroupRow
        ? isPriceableAlternative
            ? 'alternative_edition'
            : 'selected_edition'
        : classification.candidateStatus;

    const heldProviderNeedsReview = !willSendToMomox && shouldFlagProviderNeedsAdminReview({
        book,
        classification,
        notSentReason,
    });

    const reviewStatus = isAlternativeGroupRow
        ? 'manual_review'
        : heldProviderNeedsReview
            ? 'manual_review'
            : classification.reviewStatus;

    const skipReason = isAlternativeGroupRow
        ? `Multiple exact-title ISBN editions (${book._duplicateCandidateCount || 0}); admin must choose the correct edition`
        : heldProviderNeedsReview && !classification.skipReason
            ? `Provider needs admin review: ${notSentReason || 'held_by_provider_gate'}`
            : classification.skipReason;

    const hasUsableIsbn = Boolean(book.isbn && book.isbn_is_valid !== false);
    const isbnConfidence = normalizeNumber(book.isbn_confidence) ?? 0;

    const adminStatus = isAlternativeGroupRow
        ? 'pending_edition_choice'
        : willSendToMomox || heldProviderNeedsReview || (hasUsableIsbn && isbnConfidence >= 0.5)
            ? 'pending'
            : 'failed';

    const lookupCandidates = buildLookupCandidates(book);

    // Provider lifecycle at save time:
    //   - rows that WILL be sent -> *_pending  (price stays NULL until a result
    //     lands; the updater then writes 0 = no offer or > 0 = price)
    //   - rows never sent        -> 'not_sent' (price stays NULL), so the admin
    //     can tell "held back" from "called, returned no offer (price 0)".
    const momoxStatusLiteral = providerStatusLiteral(willSendToMomox ? 'momox_pending' : 'not_sent');
    const gibertStatusLiteral = providerStatusLiteral(willSendToMomox ? 'gibert_pending' : 'not_sent');
    const withMomoxStatus = await hasMomoxStatusColumn();
    const withSelectedIsbn = await hasBooksColumn('selected_isbn');
    const withNotSentReason = await hasBooksColumn('not_sent_reason');
    const withBackendStatus = await hasBooksColumn('backend_status');
    const withBookPrice = await hasBooksColumn('book_price');
    const withCropImageUrl = await hasBooksColumn('crop_image_url');
    const withCropImageUrls = await hasBooksColumn('crop_image_urls');
    const notSentReasonLiteral = safeTextLiteral(notSentReason);
    // Stable per-book crop URL (TEXT); safe-quoted literal so it slots in like the other
    // optional columns without renumbering positional params. NULL when no crop was made.
    const cropImageUrlLiteral = safeTextLiteral(book.crop_image_url || null);
    // Crop VARIANTS as a JSONB array literal (primary first). Single-quotes escaped so it
    // slots in like the other optional columns without renumbering positional params; the
    // values are controlled /uploads/... paths. NULL when no crop set was made.
    const cropImageUrlsLiteral = (() => {
        const arr = Array.isArray(book.crop_image_urls)
            ? book.crop_image_urls.filter((u) => typeof u === 'string' && u)
            : [];
        if (!arr.length) return 'NULL';
        return `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;
    })();

    // Seller price parsed from the ad description (NUMERIC(10,2)); safe numeric literal
    // (only digits + dot) so it slots in like the other optional columns without
    // renumbering the positional params. NULL when no confident description match.
    const bookPriceNum = Number(book.book_price);
    const bookPriceLiteral = Number.isFinite(bookPriceNum) && bookPriceNum >= 0 ? bookPriceNum.toFixed(2) : 'NULL';

    // backend_status for rows we are NOT sending (the provider/image path owns
    // it for sent rows): detected_no_isbn when there is no ISBN, otherwise
    // provider_not_sent (held for verification / below the confidence threshold).
    const backendStatusForNotSent = willSendToMomox
        ? null
        : book.isbn
            ? heldProviderNeedsReview
                ? 'needs_admin_review'
                : 'provider_not_sent'
            : 'detected_no_isbn';

    const backendStatusLiteral = safeTextLiteral(backendStatusForNotSent);

    const existingBookId = await findExistingBookId({
        adsId,
        isbn: book.isbn || null,
        title: book.title || null,
        imageIndex: book.image_index,
    });

    const values = [
        adsId,
        book.isbn || null,
        book.momox_price ?? null,
        book.gibert_price ?? null,
        ad.priceAmount ?? book.cost ?? null,
        book.profit_momox ?? null,
        book.profit_gibert ?? null,
        book.best_resale_price ?? null,
        book.best_resale_platform ?? null,
        status,
        book.title || null,
        book.ai_confidence ?? null,
        book.isbn_confidence ?? null,
        book.momox_title || null,

        candidateStatus,
        reviewStatus,
        adminStatus,
        skipReason,

        book.raw_visible_text || null,
        book.possible_corrected_title || null,
        JSON.stringify(book.title_candidates || []),

        book.author || null,
        book.publisher_or_collection || null,
        book.language_hint || null,

        Number.isFinite(Number(book.image_index)) ? Number(book.image_index) : null,
        sourceImageUrl || null,
        book.position || null,
        book.bbox ? JSON.stringify(book.bbox) : null,
        book.orientation || null,
        Boolean(book.is_partial_or_occluded),

        book.visible_isbn || null,
        book.isbn13 || null,
        book.isbn10 || null,
        book.isbn13_raw || null,
        book.isbn10_raw || null,
        Boolean(book.isbn_is_valid),
        book.isbn_source || null,

        book.lookup_title || null,
        book.lookup_authors || null,
        book.lookup_publisher || null,
        book.lookup_published_date || null,
        book.lookup_language || null,
        book.lookup_score ?? null,
        book.lookup_query || null,
        JSON.stringify(lookupCandidates),

        book.title_similarity ?? null,
        book.raw_text_similarity ?? null,
        book.corrected_title_similarity ?? null,
        book.best_title_similarity ?? null,
        book.author_similarity ?? null,

        book.momox_final_url || null,
        book.momox_image_url || null,
        book.momox_title_match_score ?? null,
        book.momox_raw_response ? JSON.stringify(book.momox_raw_response) : null,

        book.gibert_title || null,
        book.gibert_final_url || null,
        book.gibert_image_url || null,
        book.gibert_title_match_score ?? null,
        book.gibert_raw_response ? JSON.stringify(book.gibert_raw_response) : null,

        book.needs_crop_review ?? false,
    ];

    if (existingBookId) {
        await pool.query(
            `
        UPDATE books
        SET
            ads_id = $1,
            isbn = $2,
            momox_price = COALESCE($3, momox_price),
            gibert_price = COALESCE($4, gibert_price),
            cost = $5,
            profit_momox = COALESCE($6, profit_momox),
            profit_gibert = COALESCE($7, profit_gibert),
            best_resale_price = COALESCE($8, best_resale_price),
            best_resale_platform = COALESCE($9, best_resale_platform),
            status = $10,
            title = $11,
            ai_confidence = $12,
            isbn_confidence = $13,
            momox_title = COALESCE($14, momox_title),

            candidate_status = $15,
            review_status = $16,
            admin_status =
                CASE
                    WHEN admin_status IN ('validated', 'rejected')
                        THEN admin_status
                    ELSE $17
                END,
            skip_reason = $18,

            raw_visible_text = $19,
            possible_corrected_title = $20,
            title_candidates = $21::jsonb,

            author = $22,
            publisher_or_collection = $23,
            language_hint = $24,

            image_index = $25,
            source_image_url = $26,
            position = $27,
            bbox = $28::jsonb,
            orientation = $29,
            is_partial_or_occluded = $30,

            visible_isbn = $31,
            isbn13 = $32,
            isbn10 = $33,
            isbn13_raw = $34,
            isbn10_raw = $35,
            isbn_is_valid = $36,
            isbn_source = $37,

            lookup_title = $38,
            lookup_authors = $39,
            lookup_publisher = $40,
            lookup_published_date = $41,
            lookup_language = $42,
            lookup_score = $43,
            lookup_query = $44,
            lookup_candidates = $45::jsonb,

            title_similarity = $46,
            raw_text_similarity = $47,
            corrected_title_similarity = $48,
            best_title_similarity = $49,
            author_similarity = $50,

            momox_final_url = COALESCE($51, momox_final_url),
            momox_image_url = COALESCE($52, momox_image_url),
            momox_title_match_score = COALESCE($53, momox_title_match_score),
            momox_raw_response = COALESCE($54::jsonb, momox_raw_response),

            gibert_title = COALESCE($55, gibert_title),
            gibert_final_url = COALESCE($56, gibert_final_url),
            gibert_image_url = COALESCE($57, gibert_image_url),
            gibert_title_match_score = COALESCE($58, gibert_title_match_score),
            gibert_raw_response = COALESCE($59::jsonb, gibert_raw_response),

            -- (Re-)mark provider lifecycle while NO final result exists: flip
            -- between *_pending and 'not_sent' as eligibility changes, but never
            -- clobber a finished status (price_found / no_offer / failed).
            gibert_status = CASE
                WHEN gibert_checked_at IS NULL
                     AND (gibert_status IS NULL OR gibert_status IN ('gibert_pending', 'not_sent'))
                    THEN ${gibertStatusLiteral}
                ELSE gibert_status
            END,
            ${withMomoxStatus ? `
            momox_status = CASE
                WHEN momox_status IS NULL OR momox_status IN ('momox_pending', 'not_sent')
                    THEN ${momoxStatusLiteral}
                ELSE momox_status
            END,
            ` : ''}
            ${withSelectedIsbn ? `
            selected_isbn = COALESCE($2, selected_isbn),
            selected_isbn_source = COALESCE($37, selected_isbn_source),
            ` : ''}
            ${withNotSentReason ? `not_sent_reason = ${notSentReasonLiteral},` : ''}
            ${withBackendStatus ? `backend_status = CASE WHEN ${backendStatusLiteral} IS NOT NULL THEN ${backendStatusLiteral} ELSE backend_status END,` : ''}
            ${withBookPrice ? `book_price = COALESCE(${bookPriceLiteral}, book_price),` : ''}
            ${withCropImageUrl ? `crop_image_url = COALESCE(${cropImageUrlLiteral}, crop_image_url),` : ''}
            ${withCropImageUrls ? `crop_image_urls = COALESCE(${cropImageUrlsLiteral}, crop_image_urls),` : ''}

            needs_crop_review = $60,
            updated_at = NOW()
        WHERE id = $61
        `,
            [...values, existingBookId]
        );
        await persistBookCropImageUrl(existingBookId, bookCropImageUrl);
        return { id: existingBookId, created: false };
    }

    const result = await pool.query(
        `
    INSERT INTO books (
        ads_id,
        isbn,
        momox_price,
        gibert_price,
        cost,
        profit_momox,
        profit_gibert,
        best_resale_price,
        best_resale_platform,
        status,
        title,
        ai_confidence,
        isbn_confidence,
        momox_title,

        candidate_status,
        review_status,
        admin_status,
        skip_reason,

        raw_visible_text,
        possible_corrected_title,
        title_candidates,

        author,
        publisher_or_collection,
        language_hint,

        image_index,
        source_image_url,
        position,
        bbox,
        orientation,
        is_partial_or_occluded,

        visible_isbn,
        isbn13,
        isbn10,
        isbn13_raw,
        isbn10_raw,
        isbn_is_valid,
        isbn_source,

        lookup_title,
        lookup_authors,
        lookup_publisher,
        lookup_published_date,
        lookup_language,
        lookup_score,
        lookup_query,
        lookup_candidates,

        title_similarity,
        raw_text_similarity,
        corrected_title_similarity,
        best_title_similarity,
        author_similarity,

        momox_final_url,
        momox_image_url,
        momox_title_match_score,
        momox_raw_response,

        gibert_title,
        gibert_final_url,
        gibert_image_url,
        gibert_title_match_score,
        gibert_raw_response,

        gibert_status,
        ${withMomoxStatus ? 'momox_status,' : ''}
        ${withSelectedIsbn ? 'selected_isbn,\n        selected_isbn_source,' : ''}
        ${withNotSentReason ? 'not_sent_reason,' : ''}
        ${withBackendStatus ? 'backend_status,' : ''}
        ${withBookPrice ? 'book_price,' : ''}
        ${withCropImageUrl ? 'crop_image_url,' : ''}
        ${withCropImageUrls ? 'crop_image_urls,' : ''}

        needs_crop_review,
        created_at,
        updated_at
    )
    VALUES (
        -- Provider prices follow the call lifecycle: NULL = not called / not
        -- sent, 0 = called and returned no offer, > 0 = price found. The
        -- updaters fill them; momox_status / gibert_status carry the state.
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14,

        $15, $16, $17, $18,

        $19, $20, $21::jsonb,

        $22, $23, $24,

        $25, $26, $27, $28::jsonb, $29, $30,

        $31, $32, $33, $34, $35, $36, $37,

        $38, $39, $40, $41, $42, $43, $44, $45::jsonb,

        $46, $47, $48, $49, $50,

        $51, $52, $53, $54::jsonb,

        $55, $56, $57, $58, $59::jsonb,

        ${gibertStatusLiteral},
        ${withMomoxStatus ? `${momoxStatusLiteral},` : ''}
        ${withSelectedIsbn ? '$2, $37,' : ''}
        ${withNotSentReason ? `${notSentReasonLiteral},` : ''}
        ${withBackendStatus ? `${backendStatusLiteral},` : ''}
        ${withBookPrice ? `${bookPriceLiteral},` : ''}
        ${withCropImageUrl ? `${cropImageUrlLiteral},` : ''}
        ${withCropImageUrls ? `${cropImageUrlsLiteral},` : ''}

        $60,
        NOW(),
        NOW()
    )
    RETURNING id
    `,
        values
    );

    const insertedId = result.rows[0]?.id || null;
    await persistBookCropImageUrl(insertedId, bookCropImageUrl);

    return { id: insertedId, created: true };
}

async function markBooksMomoxPending({ adsId, isbns }) {
    if (!Array.isArray(isbns) || !isbns.length) return;

    const withMomoxStatus = await hasMomoxStatusColumn();

    await pool.query(
        `
        UPDATE books
        SET
            ${withMomoxStatus ? `momox_status = 'momox_pending',` : ''}
            status =
               CASE
                   WHEN admin_status IN ('pending_duplicate', 'pending_edition_choice')
                       THEN 'momox_pending_duplicate'
                   ELSE 'momox_pending'
               END,
            review_status =
               CASE
                   WHEN admin_status IN ('pending_duplicate', 'pending_edition_choice')
                       THEN 'manual_review'
                   ELSE review_status
               END,
            updated_at = NOW()
        WHERE ads_id = $1
          AND isbn = ANY($2::text[])
          AND momox_price IS NULL
          AND status NOT IN (
              'momox_price_found',
              'momox_price_found_needs_review',
              'momox_title_mismatch',
              'momox_no_price',
              'momox_not_real_offer',
              'momox_error',
              'confirmed',
              'rejected'
          )
        `,
        [adsId, isbns]
    );
}

export async function getProviderIsbnsForAd({ adsId, limit = 30 }) {
    const minConf = Math.min(Math.max(Number(process.env.PROVIDER_MIN_ISBN_CONFIDENCE || 0.80), 0), 1);

    // Cost-stop send policy: only the selected/main ISBN of a detected book,
    // never alternative editions, and only when we are confident in the exact
    // edition (visible ISBN, or selected-ISBN confidence >= threshold).
    const result = await pool.query(
        `
        SELECT DISTINCT isbn
        FROM books
        WHERE ads_id = $1
          AND isbn IS NOT NULL
          AND COALESCE(status, '') NOT IN ('confirmed', 'rejected', 'isbn_not_found', 'isbn_invalid', 'isbn_weak', 'bad', 'skipped')
          AND (
              -- Exception: a visible ISBN read off the cover is an exact match
              -- and is ALWAYS eligible, regardless of candidate_status.
              isbn_source = 'visible_isbn'
              OR (
                  -- Otherwise: only the high-confidence selected/main ISBN.
                  -- NEVER fan out alternative editions or low/medium labels
                  -- (alt rows carry a high score, so the candidate_status
                  -- exclusion is required, not just the confidence check).
                  COALESCE(candidate_status, '') NOT IN (
                      'alternative_edition', 'duplicate_alternative', 'medium_candidate', 'weak_candidate', 'no_isbn'
                  )
                  AND COALESCE(isbn_confidence, 0) >= $2
              )
          )
        ORDER BY isbn ASC
        LIMIT $3
        `,
        [adsId, minConf, limit]
    );

    return result.rows.map((row) => row.isbn).filter(Boolean);
}

async function updateAdProcessingSummary({
    adsId,
    detectedCount,
    acceptedCount,
    rejectedCount,
    needsReviewCount,
    processingStatus,
    processingNotes,
}) {
    await pool.query(
        `
        UPDATE ads
        SET
            books_detected_count = $2,
            books_accepted_count = $3,
            books_rejected_count = $4,
            books_needs_review_count = $5,
            last_processed_at = NOW(),
            processing_status = $6,
            processing_notes = $7,
            updated_at = NOW()
        WHERE ads_id = $1
        `,
        [
            adsId,
            detectedCount,
            acceptedCount,
            rejectedCount,
            needsReviewCount,
            processingStatus,
            processingNotes || null,
        ]
    );
}

export async function processApifyPayload(payload, options = {}) {
    // Optional high-level progress reporter (no-op unless the queue worker passes one).
    // Called at coarse phase boundaries; must never affect processing if it throws.
    const reportProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const onProgress = async (info) => { if (reportProgress) { try { await reportProgress(info); } catch { /* ignore */ } } };

    const manualMode = isManualAdPayload(payload);

    const adsResult = await saveAdsFromPayload(payload, {
        forceStatusNew: manualMode,
    });

    const savedAds = normalizeSavedAds(adsResult);
    const savedAdsIds = savedAds.map((ad) => ad.adsId).filter(Boolean);

    const adsToProcess = manualMode
        ? await getNewAdsByIds(savedAdsIds)
        : await getAllNewAds();

    console.log(
        `Processing mode=${manualMode ? 'manual_ad' : 'page'} | savedAds=${savedAds.length} | adsToProcess=${adsToProcess.length}`
    );

    let openaiProcessed = 0;
    let skippedAlreadyProcessedAds = manualMode
        ? 0
        : Math.max(0, savedAds.length - adsToProcess.length);
    let skippedNoImage = 0;
    let earlyRejectedNonBook = 0;
    let booksDetected = 0;
    let booksAccepted = 0;
    let booksRejected = 0;
    let booksNeedsReview = 0;
    let booksSkippedAlreadyProcessed = 0;
    let booksDuplicateSkipped = 0;
    let momoxTriggered = 0;
    let momoxErrors = 0;
    let momoxFallbackTriggered = 0;
    let gibertTriggered = 0;
    let gibertErrors = 0;
    let adsProcessed = 0;
    let adsKeptNewForRetry = 0;
    const errors = [];

    for (const ad of adsToProcess) {
        const adsId = ad.adsId;
        const isRetry = Number(ad.processAttempts || 0) > 0;
        // Attribute all (incl. deeply-nested) OpenAI calls for this ad to it; ads run
        // sequentially so a single ambient "current ad" is safe. Summarized + reset in
        // the per-ad finally below.
        setCurrentAd(adsId);

        console.log(
            `Processing ad ${adsId} | mode=${manualMode ? 'manual_ad' : 'page'} | title="${ad.title || ''}" | image=${ad.firstPictureUrl ? 'yes' : 'no'}`
        );

        let hadMomoxError = false;
        let hadGibertError = false;
        // Unique id per ad-processing run; scopes the Lens temp crop folder so cleanup
        // (in the finally below) only ever removes THIS run's crops.
        const lensRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        try {
            await incrementAdProcessAttempts(adsId);

            if (!ad.firstPictureUrl) {
                console.log(`Ad ${adsId}: no image URL, marking processed.`);

                await updateAdProcessingSummary({
                    adsId,
                    detectedCount: 0,
                    acceptedCount: 0,
                    rejectedCount: 0,
                    needsReviewCount: 0,
                    processingStatus: 'no_image',
                    processingNotes: 'No image URL found',
                });

                await markAdProcessed(adsId);

                skippedNoImage += 1;
                adsProcessed += 1;
                continue;
            }

            // Early deterministic NON-BOOK filter (no AI): reject clearly non-book ads
            // BEFORE any OpenAI vision / crop / ISBNSearch / catalog verify / Momox / Gibert
            // cost. Conservative — rejects ONLY on a high-confidence non-book signal with NO
            // book signal; ambiguous ads are kept. Manual single-ad submissions bypass it by
            // default (the operator chose that ad). Disable entirely with
            // ENABLE_AD_EARLY_FILTER=false. Rejected ads create NO book rows, so they never
            // reach the admin "À valider" list.
            if (
                process.env.ENABLE_AD_EARLY_FILTER !== 'false'
                && (!manualMode || process.env.EARLY_FILTER_APPLY_TO_MANUAL === 'true')
            ) {
                const verdict = classifyAdBookRelevance({
                    title: ad.title,
                    description: ad.description,
                    rawData: ad.rawData,
                });

                if (shouldRejectAsNonBook(verdict)) {
                    console.log(`[ad ${adsId}] early-filter: rejected_non_book reason="${verdict.reason}" signals=[${verdict.matchedSignals.join(', ')}]`);

                    await updateAdProcessingSummary({
                        adsId,
                        detectedCount: 0,
                        acceptedCount: 0,
                        rejectedCount: 0,
                        needsReviewCount: 0,
                        processingStatus: 'rejected_non_book',
                        processingNotes: `early-filter non-book: ${verdict.reason} | signals=[${verdict.matchedSignals.join(', ')}]`,
                    });

                    await markAdProcessed(adsId);

                    earlyRejectedNonBook += 1;
                    adsProcessed += 1;
                    continue;
                }

                console.log(`[ad ${adsId}] early-filter: keep reason="${verdict.reason}"${verdict.matchedSignals.length ? ` signals=[${verdict.matchedSignals.join(', ')}]` : ''}`);
            }

            const imageUrls = Array.isArray(ad.rawData?.pictureUrls)
                ? ad.rawData.pictureUrls
                : [];

            await onProgress({ eventType: 'ai_extraction_started', stage: 'ai_extraction', progress: 40 });

            const extractionResult = await extractBooksWithOpenAI({
                adsId,
                adTitle: ad.title,
                imageUrl: ad.firstPictureUrl,
                imageUrls,
                maxImages: 8,
            });

            const { resolvedBooks, validBooks } = normalizeExtractionResult(extractionResult);

            // Per-book SELLER price (Leboncoin LISTING price), fully deterministic — no AI:
            //   single-book ad -> ad price; multi-book -> description per-line match;
            //   else -> ad-title fallback (per-unit wording, or safe lot distribution).
            // Only sets book_price; never touches title/ISBN/provider fields. Unmatched/
            // ambiguous stays null (and COALESCE on upsert keeps any existing value).
            if (resolvedBooks.length) {
                const priceResults = computeSellerBookPrices({
                    books: resolvedBooks,
                    adPriceAmount: ad.priceAmount,
                    description: ad.description,
                    adTitle: ad.title,
                });
                let priced = 0;
                const bySource = {};
                for (let i = 0; i < resolvedBooks.length; i += 1) {
                    const { price, source } = priceResults[i];
                    resolvedBooks[i].book_price = price;
                    if (price != null) {
                        priced += 1;
                        bySource[source] = (bySource[source] || 0) + 1;
                    }
                }

                if (resolvedBooks.length === 1 && priceResults[0].source === 'single_ad_price') {
                    console.log(`[ad ${adsId}] book-price: single-book ad price applied title="${String(resolvedBooks[0].title || resolvedBooks[0].lookup_title || '').slice(0, 50)}" price=${priceResults[0].price}`);
                } else if (priced) {
                    const parts = Object.entries(bySource).map(([s, n]) => `${s}=${n}`).join(' ');
                    console.log(`[ad ${adsId}] book-price: matched ${priced}/${resolvedBooks.length} book(s) [${parts}].`);
                } else {
                    console.log(`[ad ${adsId}] book-price: no confident price for ${resolvedBooks.length} book(s).`);
                }
                // Surface an unsafe/ambiguous lot title (e.g. "Lot de 10 livres 20€" with a
                // different detected count) so it is visibly skipped rather than guessed.
                if (resolvedBooks.length > 1) {
                    const fb = parseTitleFallbackPrice(ad.title, resolvedBooks.length);
                    if (fb.mode === 'none' && /^lot_unsafe/.test(fb.reason || '')) {
                        console.log(`[ad ${adsId}] book-price: ambiguous lot price skipped (${fb.reason}) title="${String(ad.title || '').slice(0, 60)}"`);
                    }
                }
            }

            // One stable, public crop set per detected book (for the admin/UI row):
            //   books.crop_image_url  = primary/default crop (unchanged semantics)
            //   books.crop_image_urls = JSON array [primary, wide, xwide] (primary first)
            // Permanent (NOT the debug/lens-temp crops); source_image_url is left untouched.
            // Skips invalid/too-tiny/whole-image bboxes (-> NULL / []) and never fails the ad
            // if a crop errors. Both fields are set on the resolved book so
            // buildAdminCandidateRows (spread) carries the SAME crop set onto every candidate
            // row of the physical book.
            if (process.env.ENABLE_BOOK_CROP_IMAGES !== 'false' && resolvedBooks.length) {
                const cropBufferCache = new Map();
                let croppedCount = 0;
                let variantCount = 0;
                for (const b of resolvedBooks) {
                    b.crop_image_url = null;
                    b.crop_image_urls = null;
                    const bb = Array.isArray(b.bbox) ? b.bbox.map(Number) : null;
                    const w = bb && bb.length === 4 ? Math.abs(bb[2] - bb[0]) : 0;
                    const h = bb && bb.length === 4 ? Math.abs(bb[3] - bb[1]) : 0;
                    const cropworthy = bb && bb.every(Number.isFinite)
                        && w > 0 && h > 0 && (w * h) >= 0.003
                        && !(w >= 0.999 && h >= 0.999); // not whole-image / not degenerate-tiny
                    if (!cropworthy) continue;
                    const cropSourceUrl = getBookSourceImageUrl(b, ad, imageUrls);
                    if (!cropSourceUrl) continue;
                    try {
                        const variants = await saveBookCropVariantsForUi({
                            adsId, book: b, sourceImageUrl: cropSourceUrl, bufferCache: cropBufferCache,
                        });
                        b.crop_image_url = variants.primaryUrl;
                        b.crop_image_urls = variants.urls.length ? variants.urls : null;
                        if (b.crop_image_url) {
                            croppedCount += 1;
                            variantCount += variants.urls.length;
                        }
                    } catch (cropError) {
                        console.warn(`[ad ${adsId}] crop-image failed for "${String(b.title || b.isbn || 'unknown').slice(0, 40)}": ${cropError?.message || cropError}`);
                        b.crop_image_url = null;
                        b.crop_image_urls = null;
                    }
                }
                console.log(`[ad ${adsId}] crop-image: saved ${croppedCount}/${resolvedBooks.length} book crop set(s), ${variantCount} variant file(s) total.`);
            }

            // Extraction resolves ISBNs (ISBNSearch) internally, so both phases are done here.
            await onProgress({ eventType: 'ai_extraction_finished', stage: 'ai_extraction', progress: 55 });
            await onProgress({ eventType: 'isbn_lookup_finished', stage: 'isbn_lookup', progress: 70 });

            openaiProcessed += 1;
            booksDetected += resolvedBooks.length;
            booksAccepted += validBooks.length;
            booksRejected += Math.max(0, resolvedBooks.length - validBooks.length);

            const needsReviewForAd = resolvedBooks.filter((book) => {
                const isbnConfidence = normalizeNumber(book.isbn_confidence) ?? 0;

                return (
                    !book.isbn ||
                    book.isbn_is_valid === false ||
                    isbnConfidence < 0.85 ||
                    book.review_status === 'manual_review' ||
                    book.is_partial_or_occluded === true
                );
            }).length;

            booksNeedsReview += needsReviewForAd;

            if (!resolvedBooks.length) {
                console.log(`Ad ${adsId}: OpenAI found no book candidate, marking processed.`);

                await updateAdProcessingSummary({
                    adsId,
                    detectedCount: 0,
                    acceptedCount: 0,
                    rejectedCount: 0,
                    needsReviewCount: 0,
                    processingStatus: 'no_books_detected',
                    processingNotes: 'OpenAI found no book candidate',
                });

                await markAdProcessed(adsId);
                adsProcessed += 1;
                continue;
            }

            // --- Crop debug/audit layer (DEBUG_CROPS_ENABLED). Persists per-book
            // crops + a bbox overlay for visual inspection of crop-to-book mapping.
            // No DB rows, no provider calls; never breaks the workflow.
            if (isCropDebugEnabled()) {
                const debugBufferCache = new Map();
                let debugBookIndex = 0;
                for (const debugBook of resolvedBooks) {
                    debugBookIndex += 1;
                    const debugUrl = getBookSourceImageUrl(debugBook, ad, imageUrls);
                    if (!debugUrl) {
                        console.warn(`[crop-debug] ad=${adsId} book=${debugBookIndex} skipped (no source image url)`);
                        continue;
                    }
                    try {
                        if (!debugBufferCache.has(debugUrl)) {
                            debugBufferCache.set(debugUrl, await downloadImageToBuffer(debugUrl));
                        }
                        const dbg = await saveBookCropDebug({
                            adsId,
                            bookIndex: debugBookIndex,
                            sourceImageBuffer: debugBufferCache.get(debugUrl),
                            sourceImageUrl: debugUrl,
                            bbox: debugBook.bbox,
                            orientation: debugBook.orientation,
                            // Overlay shows the DETECTED/visible title (Pass-1 full-image,
                            // else Pass-2 crop read) — never the lookup/catalog title.
                            detectedTitle: debugBook.title || debugBook.possible_corrected_title || null,
                            lookupTitle: debugBook.lookup_title || null,
                            isbn: debugBook.isbn,
                            imageIndex: debugBook.image_index,
                        });
                        console.log(
                            `[crop-debug] ad=${adsId} book=${debugBookIndex} ` +
                            `detected="${String(debugBook.title || debugBook.possible_corrected_title || '').slice(0, 40)}" ` +
                            `lookup="${String(debugBook.lookup_title || '').slice(0, 40)}" ` +
                            `bbox=${JSON.stringify(debugBook.bbox)} imageIndex=${debugBook.image_index ?? '-'} ` +
                            `srcUrl=${debugUrl} cropPx=${dbg?.cropDims?.['crop-prod.jpg'] || '-'} files=${dbg?.dir || '-'} ` +
                            `extractionCrop=crop-prod.jpg verificationCrop=crop-prod.jpg`
                        );
                    } catch (error) {
                        console.warn(`[crop-debug] ad=${adsId} book=${debugBookIndex} failed: ${error?.message || error}`);
                    }
                }
            }

            const allAdminCandidateRows = [];

            for (const book of resolvedBooks) {
                allAdminCandidateRows.push(...buildAdminCandidateRows(book));
            }

            // Resale lookups use the final accepted/resolved books PLUS their
            // exact-title-match page-1 candidates (alternative editions of the
            // same book). Loose candidate variants are saved for admin review
            // but never priced.
            // Per-ad cost caps (point 8). Each is enforced at its own layer:
            //   - AI ISBN recovery:   MAX_AI_ISBN_RECOVERY_PER_AD (extractBooksWithOpenAI)
            //   - crop retries:        CROP_RETRY_MAX            (extractBooksWithOpenAI)
            //   - ISBNSearch calls:    ISBNSEARCH_SCRAPFLY_MAX_CALLS (isbnSearchScrapflyClient)
            //   - provider ISBNs/ad:   MAX_RESALE_ISBNS_PER_AD (below) -> <=3 batches of 10
            //   - Gibert chunk retry:  GIBERT_BATCH_RETRIES     (updateGibertBatch)
            const MAX_RESALE_ISBNS_PER_AD = Math.min(
                Math.max(Number(process.env.MAX_RESALE_ISBNS_PER_AD || 30), 10),
                100
            );

            const seenResaleIsbns = new Set();
            const booksForResale = [];
            const resaleSkipped = [];

            // Feature flag (default OFF): when false the provider eligibility/send
            // path below is IDENTICAL to the current getProviderEligibility behavior.
            // When true, catalog image verification gates the send list instead.
            const CATALOG_VERIFY_ENABLED = process.env.ENABLE_CATALOG_VERIFY === 'true';
            const CATALOG_MAX_KEYWORD_SEARCHES = Math.max(1, Number(process.env.CATALOG_MAX_KEYWORD_SEARCHES_PER_AD) || 15);
            const existingRowIsbns = new Set(allAdminCandidateRows.filter((r) => r.isbn).map((r) => r.isbn));
            const catalogPersistPayloads = [];
            // AI ISBN fallback bookkeeping (catalog path): which physical books (bbox
            // groups) produced a send vs. were held/unresolved.
            const eligibleBookKeys = new Set();
            const heldByKey = new Map();
            let catalogKeywordUsed = 0;
            // Shared per-ad (crop, cover) pair cache: a given crop/cover is compared by AI
            // at most once per ad run (across all books AND the AI-ISBN fallback).
            const catalogPairCache = new Map();
            // Aggregated catalog AI-budget counters for the per-ad [catalog-ai-budget] line.
            const catBudget = { candidateRows: 0, uniqueCandidates: 0, aiCallsPlanned: 0, cacheHits: 0, skippedDedupe: 0, skippedLowScore: 0, deterministicAccepts: 0 };
            const pushResaleCandidate = async ({ isbn, isbn13, isbn10, title, aiConfidence, isbnConfidence, isAlternative }) => {
                if (!isbn || seenResaleIsbns.has(isbn)) {
                    if (isbn) {
                        booksDuplicateSkipped += 1;
                        resaleSkipped.push({ isbn, title, reason: 'duplicate_isbn_in_ad' });
                    }
                    return;
                }

                if (booksForResale.length >= MAX_RESALE_ISBNS_PER_AD) {
                    resaleSkipped.push({ isbn, title, reason: `resale_cap_${MAX_RESALE_ISBNS_PER_AD}_reached` });
                    return;
                }

                seenResaleIsbns.add(isbn);

                const alreadyProcessedBook = manualMode
                    ? false
                    : await bookAlreadyProcessedForAd({ adsId, isbn });

                if (alreadyProcessedBook) {
                    booksSkippedAlreadyProcessed += 1;
                    resaleSkipped.push({ isbn, title, reason: 'already_in_books_table' });
                    return;
                }

                booksForResale.push({
                    isbn,
                    isbn13: isbn13 || isbn,
                    isbn10: isbn10 || null,
                    title,
                    aiConfidence: aiConfidence ?? null,
                    isbnConfidence: isbnConfidence ?? null,
                    cost: ad.priceAmount,
                    isAlternative: Boolean(isAlternative),
                });
            };

            if (CATALOG_VERIFY_ENABLED) {
                // NEW (flag ON): catalog-image gate. Verify each detected book's
                // cover against its Leboncoin crop before it can reach a provider.
                // Sendable ISBNs are restricted to rows that will be saved; tiny
                // crops / needs_verification / no_match are HELD (manual override
                // still available). Never calls Momox/Gibert here.
                for (const acceptedBook of resolvedBooks) {
                    const catSourceImageUrl = getBookSourceImageUrl(acceptedBook, ad, imageUrls);
                    const cat = await catalogEligibilityForBook({
                        adsId,
                        book: acceptedBook,
                        sourceImageUrl: catSourceImageUrl,
                        existingRowIsbns,
                        skipMatch: catalogKeywordUsed >= CATALOG_MAX_KEYWORD_SEARCHES,
                        cache: catalogPairCache,
                    });

                    if (cat.consumedKeyword) catalogKeywordUsed += 1;
                    if (cat.aiBudget) {
                        catBudget.candidateRows += cat.aiBudget.candidateRows || 0;
                        catBudget.uniqueCandidates += cat.aiBudget.uniqueCandidates || 0;
                        catBudget.aiCallsPlanned += cat.aiBudget.aiCallsPlanned || 0;
                        catBudget.cacheHits += cat.aiBudget.cacheHits || 0;
                        catBudget.skippedDedupe += cat.aiBudget.skippedDedupe || 0;
                        catBudget.skippedLowScore += cat.aiBudget.skippedLowScore || 0;
                    }
                    if (cat.persist?.length) catalogPersistPayloads.push(...cat.persist);

                    const fbBookKey = JSON.stringify(acceptedBook.bbox || null);
                    if (!cat.eligible) {
                        resaleSkipped.push({
                            isbn: acceptedBook.isbn || null,
                            title: acceptedBook.title || acceptedBook.lookup_title || null,
                            reason: cat.reason,
                        });
                        // Held/unresolved physical book — candidate for the AI ISBN fallback.
                        if (!heldByKey.has(fbBookKey)) {
                            heldByKey.set(fbBookKey, { acceptedBook, sourceImageUrl: catSourceImageUrl, reason: cat.reason });
                        }
                        continue;
                    }
                    eligibleBookKeys.add(fbBookKey);

                    for (const sendIsbn of cat.sendIsbns) {
                        await pushResaleCandidate({
                            isbn: sendIsbn,
                            isbn13: sendIsbn,
                            isbn10: null,
                            title:
                                acceptedBook.lookup_title ||
                                acceptedBook.possible_corrected_title ||
                                acceptedBook.title,
                            aiConfidence: acceptedBook.ai_confidence,
                            isbnConfidence: acceptedBook.isbn_confidence,
                            isAlternative: false,
                        });
                    }
                }
                console.log(
                    `[catalog-ai-budget] ads_id=${adsId} physical_books=${resolvedBooks.length} ` +
                    `candidate_rows=${catBudget.candidateRows} unique_candidates=${catBudget.uniqueCandidates} ` +
                    `deterministic_accepts=${catBudget.deterministicAccepts} ai_calls_planned=${catBudget.aiCallsPlanned} ` +
                    `ai_calls_skipped_dedupe=${catBudget.skippedDedupe + catBudget.cacheHits} ` +
                    `ai_calls_skipped_low_score=${catBudget.skippedLowScore}`
                );
            } else {
                // Phase B: consider ALL resolved books (not only auto-accepted
                // validBooks) so plausible medium/weak + long-title rows reach the
                // providers. getProviderEligibility decides; image verification is
                // the precision filter afterwards.
                for (const acceptedBook of resolvedBooks) {
                    const eligibility = getProviderEligibility(acceptedBook);

                    if (!eligibility.eligible) {
                        resaleSkipped.push({
                            isbn: acceptedBook.isbn || null,
                            title: acceptedBook.title || acceptedBook.lookup_title || null,
                            reason: eligibility.reason,
                        });
                        continue;
                    }

                    // Cost-stop: send ONLY the one selected/main ISBN for this
                    // detected physical book. Exact-title alternative editions are
                    // still saved (admin review) but are NOT fanned out to providers
                    // — that fan-out was the cost explosion on same-title classics.
                    await pushResaleCandidate({
                        isbn: acceptedBook.isbn,
                        isbn13: acceptedBook.isbn13,
                        isbn10: acceptedBook.isbn10,

                        // Compare provider titles against the bibliographic lookup
                        // title, not only the sometimes-wrong visual AI title.
                        title:
                            acceptedBook.lookup_title ||
                            acceptedBook.possible_corrected_title ||
                            acceptedBook.title,

                        aiConfidence: acceptedBook.ai_confidence,
                        isbnConfidence: acceptedBook.isbn_confidence,
                        isAlternative: false,
                    });
                }
            }

            // ---- Visual + AI ISBN fallback phase (gated; BEFORE the provider phase) ----
            // When the catalog gate sent too few physical books, try to recover ISBNs for
            // the held/unresolved books and merge ONLY cover-verified ISBNs into
            // booksForResale (the ONE provider batch below). Order: Google Lens visual
            // discovery first, then the AI ISBN/search fallback ONLY if Lens is disabled or
            // recovered nothing. Both verify via the SAME chain; no second provider call.
            const LENS_ENABLED = process.env.ENABLE_LENS_FALLBACK === 'true';
            const AI_FB_ENABLED = process.env.ENABLE_AI_ISBN_FALLBACK === 'true';
            if (CATALOG_VERIFY_ENABLED && (LENS_ENABLED || AI_FB_ENABLED)) {
                const detectedBooks = new Set(resolvedBooks.map((b) => JSON.stringify(b.bbox || null))).size;
                const providerEligibleBooks = eligibleBookKeys.size;
                const trig = shouldTriggerFallback({ enabled: true, detectedBooks, providerEligibleBooks });
                console.log(`[fallback] ad=${adsId} trigger=${trig.reason} detected=${detectedBooks} eligible=${providerEligibleBooks} held=${heldByKey.size}`);

                // Lens is decided PER PHYSICAL BOOK below (NOT gated by the global sparse/zero
                // trigger); the AI fallback still uses the global trigger.
                if (heldByKey.size) {
                    const FB_CONF = Number(process.env.AI_FB_MIN_DERIVED_CONFIDENCE) || 0.5;

                    // Merge a recovered map into the ONE provider list: ONE verified row per
                    // physical book (no unverified rows / alternatives). Held books' original
                    // rows stay as held.
                    const mergeRecovered = async (recoveredMap, isbnSource, matchSource) => {
                        for (const [, rec] of recoveredMap) {
                            const held = heldByKey.get(rec.physicalBookKey);
                            if (!held) continue;
                            const recoveredBook = {
                                ...held.acceptedBook,
                                isbn: rec.isbn13, isbn13: rec.isbn13, isbn10: null,
                                isbn_is_valid: true, isbn_source: isbnSource, provider_match_source: matchSource,
                                isbn_confidence: Math.max(Number(held.acceptedBook.isbn_confidence) || 0, FB_CONF),
                                lookup_title: rec.lookup?.title || held.acceptedBook.lookup_title || null,
                                lookup_authors: rec.lookup?.author || held.acceptedBook.lookup_authors || null,
                                lookup_publisher: rec.lookup?.publisher || held.acceptedBook.lookup_publisher || null,
                                catalog_image_url: rec.lookup?.coverUrl || null,
                                lookup_candidates: [],
                            };
                            for (const row of buildAdminCandidateRows(recoveredBook)) {
                                allAdminCandidateRows.push(row);
                                if (row.isbn === rec.isbn13) {
                                    await pushResaleCandidate({
                                        isbn: row.isbn, isbn13: row.isbn, isbn10: null,
                                        title: recoveredBook.lookup_title || recoveredBook.title,
                                        aiConfidence: null, isbnConfidence: recoveredBook.isbn_confidence,
                                        isAlternative: false,
                                    });
                                }
                            }
                        }
                    };

                    // 1) Google Lens visual fallback for held crop-visible books.
                    // Crops are written to a TEMPORARY per-ad/run folder (lens-temp), public
                    // only while the actor reads them, then deleted in the finally below.
                    let lensMerged = 0;
                    if (LENS_ENABLED && process.env.LENS_TEMP_CROPS_ENABLED !== 'false') {
                        // Per-book decision (not the global trigger): held + not sent + usable
                        // crop + recoverable reason (crop_too_small only with text + high conf).
                        const lensBooks = [...heldByKey.values()].map((h) => ({
                            reason: h.reason,
                            bbox: h.acceptedBook.bbox,
                            observedTitle: h.acceptedBook.title || h.acceptedBook.possible_corrected_title || null,
                            rawText: h.acceptedBook.raw_visible_text || null,
                            confidence: Number(h.acceptedBook.isbn_confidence) || 0,
                            sent: false,
                            _held: h,
                        }));
                        const decision = selectLensCandidates(lensBooks);
                        if (!decision.run) {
                            console.log(`[lens-fallback] skipped ad=${adsId} reason=no_recoverable_candidates detected=${detectedBooks} sent=${providerEligibleBooks} held=${heldByKey.size}`);
                        } else {
                            console.log(`[lens-fallback] decision ad=${adsId} run=yes candidates=${decision.candidates.length} reason=per_book detected=${detectedBooks} sent=${providerEligibleBooks} held=${heldByKey.size}`);
                            const lensBaseUrl = lensPublicBaseUrl();
                            const lensBufCache = new Map();
                            let lensIdx = 0;
                            const lensHeld = [];
                            for (const { book } of decision.candidates) {
                                const { acceptedBook, sourceImageUrl } = book._held;
                                if (sourceImageUrl && !lensBufCache.has(sourceImageUrl)) {
                                    try { lensBufCache.set(sourceImageUrl, await downloadImageToBuffer(sourceImageUrl)); }
                                    catch { lensBufCache.set(sourceImageUrl, null); }
                                }
                                const { publicUrl, filePath } = await ensureLensTempCropUrl({
                                    adsId, runId: lensRunId, bookIndex: `lens-${lensIdx}`,
                                    sourceImageBuffer: sourceImageUrl ? lensBufCache.get(sourceImageUrl) : null,
                                    bbox: acceptedBook.bbox, orientation: acceptedBook.orientation, baseUrl: lensBaseUrl,
                                });
                                if (publicUrl) {
                                    console.log(`[lens-fallback] tempCropCreated ad=${adsId} book=lens-${lensIdx} url=${publicUrl} file=${filePath}`);
                                }
                                lensHeld.push({
                                    physicalBookKey: JSON.stringify(acceptedBook.bbox || null),
                                    bookIndex: lensIdx, cropUrl: publicUrl,
                                    observedTitle: acceptedBook.title || acceptedBook.possible_corrected_title || null,
                                    possibleCorrectedTitle: acceptedBook.possible_corrected_title || null,
                                    ocrText: acceptedBook.raw_visible_text || null,
                                    author: acceptedBook.author || null,
                                    bbox: acceptedBook.bbox, orientation: acceptedBook.orientation, sourceImageUrl,
                                });
                                lensIdx += 1;
                            }
                            if (lensHeld.length) {
                                const lens = await runLensFallback({
                                    adsId, heldBooks: lensHeld,
                                    keywordBudgetRemaining: Math.max(0, CATALOG_MAX_KEYWORD_SEARCHES - catalogKeywordUsed),
                                });
                                catalogKeywordUsed += lens.stats.keywordUsed;
                                await mergeRecovered(lens.recovered, 'lens_fallback_verified', 'lens_fallback');
                                lensMerged = lens.recovered.size;
                                if (lensMerged) console.log(`[ad ${adsId}] lens-fallback merged ${lensMerged} verified ISBN(s) into the provider list (single batch).`);
                            }
                        }
                    }

                    // 2) AI ISBN/search fallback — global trigger + only if Lens disabled or empty.
                    if (AI_FB_ENABLED && trig.trigger && (!LENS_ENABLED || lensMerged === 0)) {
                        let fbIndex = 0;
                        const heldBooks = [...heldByKey.values()].map(({ acceptedBook, sourceImageUrl, reason }) => {
                            const level = cropQualityLevel(acceptedBook.bbox).level;
                            return {
                                physicalBookKey: JSON.stringify(acceptedBook.bbox || null),
                                bookIndex: fbIndex++,
                                sourceImageUrl,
                                bbox: acceptedBook.bbox,
                                orientation: acceptedBook.orientation,
                                observedTitle: acceptedBook.title || acceptedBook.possible_corrected_title || null,
                                possibleCorrectedTitle: acceptedBook.possible_corrected_title || null,
                                rawVisibleText: acceptedBook.raw_visible_text || null,
                                author: acceptedBook.author || null,
                                publisher: acceptedBook.publisher_or_collection || null,
                                language: acceptedBook.language_hint || null,
                                cropQuality: level,
                                mayBeClipped: level !== 'good',
                                pipeline: {
                                    heldReason: reason,
                                    candidatesHeld: (acceptedBook.lookup_candidates || [])
                                        .map((c) => c.title || c.lookup_title).filter(Boolean).slice(0, 5),
                                },
                            };
                        });
                        const fb = await runAiIsbnFallback({
                            adsId, heldBooks,
                            keywordBudgetRemaining: Math.max(0, CATALOG_MAX_KEYWORD_SEARCHES - catalogKeywordUsed),
                            coverCache: catalogPairCache,
                        });
                        catalogKeywordUsed += fb.stats.keywordUsed;
                        await mergeRecovered(fb.recovered, 'ai_fallback_verified', 'ai_fallback');
                        if (fb.recovered.size) console.log(`[ad ${adsId}] ai-fallback merged ${fb.recovered.size} verified ISBN(s) into the provider list (single batch).`);
                    }
                }
            }

            const resaleIsbnSet = new Set(booksForResale.map((book) => book.isbn));
            const resaleIsbns = [...resaleIsbnSet];

            // Candidate-persistence summary: how many alternative-edition rows we kept vs
            // skipped (capped by MAX_PERSISTED_ALTERNATIVES_PER_BOOK) for this ad.
            {
                const mainRows = allAdminCandidateRows.filter((r) => r._adminCandidateAlternative !== true);
                const altPersisted = mainRows.reduce((s, r) => s + (r._altPersisted || 0), 0);
                const altConsidered = mainRows.reduce((s, r) => s + (r._altConsidered || 0), 0);
                console.log(
                    `[candidate-persist] ads_id=${adsId} physical_books=${mainRows.length} ` +
                    `selected=${mainRows.length} alternatives_persisted=${altPersisted} ` +
                    `alternatives_skipped=${Math.max(0, altConsidered - altPersisted)} ` +
                    `total_rows=${allAdminCandidateRows.length}`
                );
            }

            // Why each non-sent ISBN was skipped (for the not_sent_reason column).
            const notSentReasonByIsbn = new Map();
            for (const skip of resaleSkipped) {
                if (skip.isbn && !notSentReasonByIsbn.has(skip.isbn)) {
                    notSentReasonByIsbn.set(skip.isbn, skip.reason);
                }
            }

            // Save ALL book rows (accepted + review candidates) BEFORE any
            // resale lookup, so provider updates always have rows to land on.
            let saveCreated = 0;
            let saveUpdated = 0;
            let saveSkipped = 0;
            let saveIsbnRows = 0;
            let saveNoIsbnRows = 0;

            for (const candidateBook of allAdminCandidateRows) {
                const sourceImageUrl = getBookSourceImageUrl(candidateBook, ad, imageUrls);

                const willSend = Boolean(
                    candidateBook.isbn && resaleIsbnSet.has(candidateBook.isbn)
                );

                const notSentReason = willSend
                    ? null
                    : !candidateBook.isbn
                        ? 'no_isbn'
                        : normalizeNotSentReason(notSentReasonByIsbn.get(candidateBook.isbn));

                // Do not persist public crop files.
                // The UI uses catalog_image_url / ISBN image first, then the original ad image.
                // Crop retry uses temporary files elsewhere and cleans them after processing.
                const bookCropImageUrl = null;



                const saved = await upsertBookCandidate({
                    adsId,
                    ad,
                    book: candidateBook,
                    sourceImageUrl,
                    bookCropImageUrl,
                    willSendToMomox: willSend,
                    notSentReason,
                });

                if (!saved?.id) {
                    saveSkipped += 1;
                } else if (saved.created) {
                    saveCreated += 1;
                } else {
                    saveUpdated += 1;
                }

                if (candidateBook.isbn) {
                    saveIsbnRows += 1;
                } else {
                    saveNoIsbnRows += 1;
                }
            }

            console.log(
                `[ad ${adsId}] save-books: rowsCreated=${saveCreated}, rowsUpdated=${saveUpdated}, rowsSkipped=${saveSkipped}, isbnRows=${saveIsbnRows}, noIsbnRows=${saveNoIsbnRows}`
            );

            // Catalog verification audit trail (flag ON only): writes ONLY
            // catalog_* columns; never provider price/status fields.
            if (CATALOG_VERIFY_ENABLED && catalogPersistPayloads.length) {
                const catalogRowsWritten = await persistCatalogRows(adsId, catalogPersistPayloads);
                console.log(
                    `[ad ${adsId}] catalog-verify: keywordSearches=${catalogKeywordUsed}, catalog_* rows written=${catalogRowsWritten}`
                );
            }


            let dbProviderIsbns = [];
            let providerIsbns;

            if (CATALOG_VERIFY_ENABLED) {
                // Catalog-gated send list ONLY: resaleIsbns already contains
                // exactly the catalog-verified + visible-ISBN sends (no
                // confidence-gated DB union, which would re-admit unverified ISBNs).
                providerIsbns = resaleIsbns.slice(0, MAX_RESALE_ISBNS_PER_AD);
            } else {
                dbProviderIsbns = await getProviderIsbnsForAd({
                    adsId,
                    limit: MAX_RESALE_ISBNS_PER_AD,
                });

                const dbProviderSet = new Set(dbProviderIsbns);

                // Send list = UNION of the in-memory prepared+eligible set and the DB
                // set. A book that getProviderEligibility approved (and was saved with
                // a pending marker) MUST be sent even if a stale DB filter would have
                // dropped it — this is the L'Art de l'automobile regression.
                providerIsbns = [...new Set([...resaleIsbns, ...dbProviderIsbns])]
                    .slice(0, MAX_RESALE_ISBNS_PER_AD);

                // Diagnostics only (the union above guarantees correctness regardless).
                const preparedNotInDb = resaleIsbns.filter((isbn) => !dbProviderSet.has(isbn));
                const dbNotPrepared = dbProviderIsbns.filter((isbn) => !resaleIsbnSet.has(isbn));

                if (preparedNotInDb.length || dbNotPrepared.length) {
                    console.warn(
                        `[ad ${adsId}] provider-isbn-sync: prepared=${resaleIsbns.length}, dbProvider=${dbProviderIsbns.length}, sent(union)=${providerIsbns.length}, preparedNotInDb=${preparedNotInDb.length}, dbNotPrepared=${dbNotPrepared.length}`
                    );

                    if (preparedNotInDb.length) {
                        console.table(
                            preparedNotInDb.map((isbn) => ({
                                isbn,
                                issue: 'prepared_eligible_but_db_query_missed_it_now_force_sent',
                            }))
                        );
                    }
                }
            }

            const providerIsbnSet = new Set(providerIsbns);

            // Book objects for ISBNs we will send (used by the Apify Momox fallback).
            // Covers union members from the in-memory list; DB-only ISBNs are priced
            // by the Scrapfly updaters via the isbns array regardless.
            const providerBooksForResale = booksForResale.filter((book) => providerIsbnSet.has(book.isbn));

            console.log(
                `[ad ${adsId}] resale-candidates: prepared=${booksForResale.length}, dbProvider=${dbProviderIsbns.length}, sending=${providerIsbns.length}, skipped=${resaleSkipped.length}`
            );




            if (booksForResale.length) {
                console.table(
                    booksForResale.map((book) => ({
                        isbn: book.isbn,
                        title: String(book.title || '').slice(0, 50),
                        isbnConfidence: book.isbnConfidence,
                        isAlternative: book.isAlternative,
                    }))
                );
            }

            if (resaleSkipped.length) {
                console.table(
                    resaleSkipped.map((entry) => ({
                        isbn: entry.isbn,
                        title: String(entry.title || '').slice(0, 50),
                        reason: entry.reason,
                    }))
                );
            }

            if (providerIsbns.length) {
                await onProgress({ eventType: 'provider_pricing_started', stage: 'provider_pricing', progress: 80 });
                const expectedMomoxChunks = Math.ceil(providerIsbns.length / 10);
                const expectedGibertChunks = Math.ceil(providerIsbns.length / 5);

                // ---------------- Momox (isolated: never blocks Gibert) ----------------
                try {
                    await markBooksMomoxPending({ adsId, isbns: providerIsbns });

                    console.log(
                        `[ad ${adsId}] momox: sending=${providerIsbns.length}, chunks=${expectedMomoxChunks}, isbns=${providerIsbns.join(',')}`
                    );

                    const momoxResult = await runProviderLookup(`momox adsId=${adsId}`, () => updateMomoxPricesForAd({
                        adsId,
                        isbns: providerIsbns,
                        limit: MAX_RESALE_ISBNS_PER_AD,
                    }));

                    if (!momoxResult.ok) {
                        throw new Error(momoxResult.reason || 'Momox Scrapfly batch failed');
                    }

                    momoxTriggered += 1;

                    console.log(
                        `[ad ${adsId}] momox: updated=${momoxResult.updated ?? 0}, offers=${momoxResult.offerIsbns?.length ?? 0}, noOffer=${momoxResult.noOfferIsbns?.length ?? 0}, failed=${momoxResult.failedIsbns?.length ?? 0}, pending=0, cost=${momoxResult.scrapflyCost ?? 'n/a'}`
                    );
                } catch (momoxError) {
                    momoxErrors += 1;

                    console.error(`[ad ${adsId}] momox batch failed: ${momoxError?.message || momoxError}`);

                    errors.push({
                        adsId,
                        isbns: providerIsbns,
                        step: 'momox_batch',
                        error: momoxError?.message || String(momoxError),
                    });

                    let fallbackWorked = false;

                    if (process.env.MOMOX_APIFY_FALLBACK_ENABLED === 'true') {
                        try {
                            await triggerMomoxActorForAd({
                                adsId,
                                cost: ad.priceAmount,
                                books: providerBooksForResale,
                                maxBooksPerRun: 10,
                            });

                            fallbackWorked = true;
                            momoxFallbackTriggered += 1;

                            // Rows keep momox_status='momox_pending': the Apify
                            // actor reports back per-book via the /momox webhook.
                            console.log(
                                `[ad ${adsId}] momox: updated=0, offers=0, noOffer=0, failed=0, pending=${providerIsbns.length}, cost=n/a (Apify fallback actor triggered, results arrive via webhook)`
                            );
                        } catch (fallbackError) {
                            console.error(
                                `[ad ${adsId}] momox Apify fallback also failed: ${fallbackError?.message || fallbackError}`
                            );

                            errors.push({
                                adsId,
                                isbns: providerIsbns,
                                step: 'momox_apify_fallback',
                                error: fallbackError?.message || String(fallbackError),
                            });
                        }
                    }

                    if (!fallbackWorked) {
                        hadMomoxError = true;
                        await markMomoxLookupFailed({
                            adsId,
                            isbns: providerIsbns,
                            reason: momoxError?.message || String(momoxError),
                        });

                        console.log(
                            `[ad ${adsId}] momox: updated=0, offers=0, noOffer=0, failed=${providerIsbns.length}, pending=0, cost=n/a (all rows marked momox_failed)`
                        );
                    }
                }

                // ---------------- Gibert (isolated: never blocked by Momox) ----------------
                try {
                    console.log(
                        `[ad ${adsId}] gibert: sending=${providerIsbns.length}, chunks=${expectedGibertChunks}, isbns=${providerIsbns.join(',')}`
                    );

                    const gibertResult = await runProviderLookup(`gibert adsId=${adsId}`, () => updateGibertPricesForAd({
                        adsId,
                        isbns: providerIsbns,
                        limit: MAX_RESALE_ISBNS_PER_AD,
                    }));

                    if (gibertResult.ok) {
                        gibertTriggered += 1;

                        const statusCounts = { priceFound: 0, nonRepris: 0, missing: 0 };

                        for (const row of gibertResult.rows || []) {
                            if (row.gibert_status === 'gibert_price_found') statusCounts.priceFound += 1;
                            else if (row.gibert_status === 'gibert_non_repris') statusCounts.nonRepris += 1;
                            else if (row.gibert_status === 'gibert_missing') statusCounts.missing += 1;
                        }

                        console.log(
                            `[ad ${adsId}] gibert: updated=${gibertResult.updated ?? 0}, priceFound=${statusCounts.priceFound}, nonRepris=${statusCounts.nonRepris}, missing=${statusCounts.missing}, failed=${gibertResult.failedIsbns?.length ?? 0}, pending=0, cost=${gibertResult.scrapflyCost ?? 'n/a'}`
                        );
                    } else if (!gibertResult.skipped) {
                        // Rows were already marked gibert_failed inside the service.
                        hadGibertError = true;
                        gibertErrors += 1;

                        console.log(
                            `[ad ${adsId}] gibert: updated=0, priceFound=0, nonRepris=0, missing=0, failed=${providerIsbns.length}, pending=0, cost=${gibertResult.scrapflyCost ?? 'n/a'} (all chunks failed)`
                        );

                        errors.push({
                            adsId,
                            isbns: providerIsbns,
                            step: 'gibert_batch',
                            error: gibertResult.reason || 'Gibert Scrapfly batch failed',
                        });
                    }
                } catch (gibertError) {
                    hadGibertError = true;
                    gibertErrors += 1;

                    console.error(`[ad ${adsId}] gibert batch failed: ${gibertError?.message || gibertError}`);

                    errors.push({
                        adsId,
                        isbns: providerIsbns,
                        step: 'gibert_batch',
                        error: gibertError?.message || String(gibertError),
                    });

                    await markGibertLookupFailed({
                        adsId,
                        isbns: providerIsbns,
                        reason: gibertError?.message || String(gibertError),
                    });
                }
            } else {
                console.log(`[ad ${adsId}] resale: no provider-eligible books to send after DB sync.`);
            }

            // ---------------- provider image verification (Phase B) ----------------
            // Confirm the persisted provider results are the SAME book/edition as
            // the Leboncoin photo. On mismatch, try untried alternative ISBNs and
            // verify again. Isolated: never blocks the ad.
            try {
                const v1 = await verifyProviderImagesForAd({ adsId });

                if (Number(v1?.byStatus?.mismatch || 0) > 0) {
                    const fallback = await tryProviderAlternativesForAd({ adsId });

                    if (fallback.createdIsbns?.length) {
                        await verifyProviderImagesForAd({ adsId });
                    }
                }
            } catch (verifyError) {
                console.error(
                    `[ad ${adsId}] image-verify failed (ignored):`,
                    verifyError?.message || verifyError
                );
            }

            const failedProviders = [
                ...(hadMomoxError ? ['momox'] : []),
                ...(hadGibertError ? ['gibert'] : []),
            ];

            // ---------------- provider completion audit ----------------
            // Every ISBN row must end with a numeric provider price OR an
            // explicit pending/failed provider status. Rows that were sent but
            // are unresolved keep the ad from counting as fully complete.
            let completionBlocked = false;

            try {
                const completion = await checkProviderCompletionForAd(adsId);
                const counts = completion.counts;

                console.log(
                    `[ad ${adsId}] provider-completion: isbnRows=${counts.isbnRows}, providerEligibleRows=${counts.providerEligibleRows}, momoxDone=${counts.momoxDone}, momoxPending=${counts.momoxPending}, momoxFailed=${counts.momoxFailed}, gibertDone=${counts.gibertDone}, gibertPending=${counts.gibertPending}, gibertFailed=${counts.gibertFailed}`
                );

                if (completion.incompleteRows.length) {
                    console.table(
                        completion.incompleteRows.map((row) => ({
                            id: row.id,
                            isbn: row.isbn,
                            title: String(row.title || '').slice(0, 40),
                            momox_price: row.momox_price,
                            momox_status: row.momox_status || `(global) ${row.status}`,
                            gibert_price: row.gibert_price,
                            gibert_status: row.gibert_status,
                        }))
                    );
                }

                // Per-book final audit line (point 10): everything needed to
                // understand a run from the console alone.
                for (const row of completion.rows) {
                    const backendStatus = deriveBackendStatus(row, row.momoxState, row.gibertState);
                    const eligible = row.momoxState !== 'not_sent' || row.gibertState !== 'not_sent';
                    console.log(
                        `[ad ${adsId}] book id=${row.id} isbn=${row.isbn || '-'}` +
                        ` title="${String(row.title || '').slice(0, 40)}"` +
                        ` candidate=${row.candidate_status || '-'}` +
                        ` eligible=${eligible ? 'yes' : `no(${row.not_sent_reason || '-'})`}` +
                        ` momox=${row.momox_price ?? '-'}/${row.momox_status || row.momoxState}/img=${row.momox_image_url ? 'y' : 'n'}` +
                        ` gibert=${row.gibert_price ?? '-'}/${row.gibert_status || row.gibertState}/img=${row.gibert_image_url ? 'y' : 'n'}` +
                        ` imgverify=${row.provider_match_status || '-'} sim=${row.provider_visual_similarity_score ?? '-'} conf=${row.provider_match_confidence ?? '-'} src=${row.provider_match_source || '-'}` +
                        ` backend_status=${backendStatus}`
                    );
                }

                completionBlocked = completion.blockingRows.length > 0;
            } catch (completionError) {
                console.error(
                    `[ad ${adsId}] provider-completion check failed:`,
                    completionError?.message || completionError
                );
            }





            await updateAdProcessingSummary({
                adsId,
                detectedCount: resolvedBooks.length,
                acceptedCount: validBooks.length,
                rejectedCount: Math.max(0, resolvedBooks.length - validBooks.length),
                needsReviewCount: needsReviewForAd,
                processingStatus: completionBlocked
                    ? 'provider_incomplete'
                    : failedProviders.length
                        ? 'processed_with_provider_errors'
                        : 'processed',
                processingNotes: completionBlocked
                    ? `Provider lookups incomplete${failedProviders.length ? ` (failed: ${failedProviders.join(', ')})` : ' (pending rows remain)'}`
                    : failedProviders.length
                        ? `Resale provider lookup failed: ${failedProviders.join(', ')}`
                        : null,
            });

            // ads.status is still marked processed so the ad is NEVER re-run
            // through paid OpenAI extraction; incomplete provider rows are
            // visible via processing_status='provider_incomplete' and are
            // re-checked through the manual provider routes.
            await onProgress({ eventType: 'provider_pricing_finished', stage: 'provider_pricing', progress: 95 });
            console.log(`[ad ${adsId}] marking processed (processing_status=${completionBlocked ? 'provider_incomplete' : failedProviders.length ? 'processed_with_provider_errors' : 'processed'}).`);
            await markAdProcessed(adsId);
            adsProcessed += 1;
        } catch (error) {
            console.error(`Ad ${adsId}: processing failed:`, error?.stack || error?.message || error);

            errors.push({
                adsId,
                step: 'ad_processing',
                error: error?.message || String(error),
            });

            try {
                await updateAdProcessingSummary({
                    adsId,
                    detectedCount: 0,
                    acceptedCount: 0,
                    rejectedCount: 0,
                    needsReviewCount: 0,
                    processingStatus: 'error',
                    processingNotes: error?.message || String(error),
                });
            } catch (summaryError) {
                console.error(
                    `Ad ${adsId}: failed to update processing summary:`,
                    summaryError?.message || summaryError
                );
            }

            if (isRetry) {
                console.log(`Ad ${adsId}: failed again on retry, marking processed to avoid infinite loop.`);
                await markAdProcessed(adsId);
                adsProcessed += 1;
            } else {
                console.log(`Ad ${adsId}: failed on first try, keeping status=new for retry.`);
                adsKeptNewForRetry += 1;
            }
        } finally {
            // Per-ad AI usage summary ([ai-usage] ...), then clear the ambient ad +
            // this ad's counters. Non-throwing; always runs (success or failure).
            summarizeAdAiUsage(adsId);
            setCurrentAd(null);

            // Always remove THIS ad/run's Lens temp crops, even if the Lens actor,
            // provider lookups, or the workflow threw after the crops were created.
            if (process.env.ENABLE_LENS_FALLBACK === 'true' && process.env.LENS_TEMP_CROPS_CLEANUP !== 'false') {
                const c = await cleanupLensTempCrops({ adsId, runId: lensRunId });
                console.log(`[lens-fallback] cleanup ad=${adsId} folder=${c.folder || '-'} deleted=${c.deleted ? 'yes' : 'no'}`);
            }
        }
    }

    return {
        success: true,
        ads: adsResult,
        workflow: {
            receivedAds: savedAds.length,
            adsToProcess: adsToProcess.length,
            skippedAlreadyProcessedAds,
            skippedNoImage,
            earlyRejectedNonBook,
            openaiProcessed,
            booksDetected,
            booksAccepted,
            booksRejected,
            booksNeedsReview,
            booksSkippedAlreadyProcessed,
            booksDuplicateSkipped,
            momoxTriggered,
            momoxErrors,
            momoxFallbackTriggered,
            gibertTriggered,
            gibertErrors,
            adsProcessed,
            adsKeptNewForRetry,
            errors,
        },
    };
}
