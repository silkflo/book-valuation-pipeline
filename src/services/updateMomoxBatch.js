// src/services/updateMomoxBatch.js
//
// Orchestrates one Momox Scrapfly batch lookup for the saved book rows of an
// ad, then updates each row with price/title/image/status + profit and best
// resale recomputation. Mirrors updateGibertBatch.js.
//
// Only FINAL resolved ISBNs should reach this service: the workflow passes the
// explicit `isbns` list taken from accepted, saved book rows - never raw
// ISBNSearch candidate variants.

import { pool } from '../db.js';
import { lookupMomoxPricesBatch } from './momoxScrapflyBatchService.js';
import { titleSimilarity, getMomoxStatus } from './updateMomoxPrice.js';
import {
    getCandidateStatusFromMomoxStatus,
    getAdminStatusFromMomoxResult,
    getReviewStatusFromMomoxStatus,
} from './saveBooks.js';
import { saveTechnicalCostEvent, perUnitScrapflyMeta } from './costEvents.js';
import { hasMomoxStatusColumn, providerStatusLiteral } from './bookColumns.js';

// Explicit per-row provider lifecycle (books.momox_status):
//   failed  -> 'momox_failed'   (price stays NULL, row retryable)
//   no row  -> 'momox_no_offer' (price 0.00, checked)
//   offer   -> 'momox_price_found' (price > 0) unless the title mismatches,
//              which discards the price -> 'momox_no_offer' with price 0.00.
function getProviderMomoxStatus({ rowStatus, globalStatus }) {
    if (rowStatus === 'failed') return 'momox_failed';
    if (rowStatus === 'no_offer') return 'momox_no_offer';

    return globalStatus === 'momox_title_mismatch' ? 'momox_no_offer' : 'momox_price_found';
}

function parsePrice(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function computeBestResale({ momoxPrice, gibertPrice }) {
    const momox = parsePrice(momoxPrice);
    const gibert = parsePrice(gibertPrice);

    if (momox <= 0 && gibert <= 0) {
        return { platform: null, price: 0 };
    }

    if (gibert > momox) {
        return { platform: 'gibert', price: gibert };
    }

    return { platform: 'momox', price: momox };
}

function bookComparisonTitle(book) {
    return (
        book.lookup_title ||
        book.possible_corrected_title ||
        book.title ||
        null
    );
}

async function updateBookWithMomoxRow({ book, momoxRow, batchResult }) {
    const momoxPrice = momoxRow.status === 'offer' ? parsePrice(momoxRow.price) : 0;
    const isFailed = momoxRow.status === 'failed';

    let status;
    let matchScore = null;

    if (isFailed) {
        status = 'momox_error';
    } else if (momoxRow.status === 'no_offer') {
        status = 'momox_no_price';
    } else {
        const similarity = titleSimilarity(bookComparisonTitle(book), momoxRow.title);
        matchScore = Number(similarity.toFixed(2));
        status = getMomoxStatus(similarity);
    }

    // Price semantics:
    //   offer            -> numeric price
    //   no offer / title mismatch -> 0.00 (checked, nothing usable)
    //   failed           -> pass NULL so COALESCE(NULL, momox_price) keeps any
    //                       previously found price and otherwise resolves to the
    //                       column's 0 default (display-safe, never erased).
    //                       Retryability is carried by momox_status='momox_failed'.
    const usablePrice = isFailed
        ? null
        : status === 'momox_title_mismatch'
            ? 0
            : momoxPrice;

    const gibertPrice = parsePrice(book.gibert_price);
    const gibertChecked = Boolean(book.gibert_checked_at);

    const best = computeBestResale({ momoxPrice: usablePrice ?? 0, gibertPrice });

    const cost = book.cost === null || book.cost === undefined ? null : Number(book.cost);
    const profitMomox =
        usablePrice !== null && Number.isFinite(cost)
            ? Number((usablePrice - cost).toFixed(2))
            : null;

    const candidateStatus = isFailed
        ? getCandidateStatusFromMomoxStatus(status)
        : best.platform === null && gibertChecked
            ? 'no_resale_offer'
            : getCandidateStatusFromMomoxStatus(status);

    const reviewStatus = getReviewStatusFromMomoxStatus({
        status,
        momoxTitleMatchScore: matchScore,
    });

    const adminStatus = getAdminStatusFromMomoxResult({
        status,
        momoxPrice: usablePrice ?? 0,
    });

    const momoxProviderStatus = getProviderMomoxStatus({
        rowStatus: momoxRow.status,
        globalStatus: status,
    });

    const withMomoxStatus = await hasMomoxStatusColumn();

    const result = await pool.query(
        `
        UPDATE books
        SET
            -- NULL price (= failed) never erases a previously found price,
            -- and profit/best-resale are not recomputed on failure.
            momox_price = COALESCE($1::numeric, momox_price),
            momox_title = COALESCE($2, momox_title),
            momox_image_url = COALESCE($3, momox_image_url),
            momox_title_match_score = COALESCE($4, momox_title_match_score),
            momox_final_url = COALESCE($5, momox_final_url),
            momox_raw_response = $6::jsonb,
            ${withMomoxStatus ? `momox_status = ${providerStatusLiteral(momoxProviderStatus)},` : ''}

            status = $7,
            -- Multi-edition (duplicate) groups keep their group markers so the
            -- admin still sees "these rows are ISBN alternatives" after pricing.
            candidate_status =
                CASE
                    WHEN candidate_status IN (
                        'duplicate_selected',
                        'duplicate_alternative',
                        'selected_edition',
                        'alternative_edition'
                    )
                        THEN candidate_status
                    ELSE $8
                END,
            review_status =
                CASE
                    WHEN admin_status = 'pending_duplicate'
                        THEN review_status
                    ELSE $9
                END,
            admin_status =
                CASE
                   WHEN admin_status IN (
                    'validated',
                    'rejected',
                    'pending_duplicate',
                    'pending_edition_choice'
                )
                    THEN admin_status
                                    ELSE $10
                END,

            profit_momox = CASE WHEN $1::numeric IS NULL THEN profit_momox ELSE $11 END,
            best_resale_price = CASE WHEN $1::numeric IS NULL THEN best_resale_price ELSE $12 END,
            best_resale_platform = CASE WHEN $1::numeric IS NULL THEN best_resale_platform ELSE $13 END,

            updated_at = NOW()
        WHERE id = $14
        RETURNING
            id,
            ads_id,
            isbn,
            title,
            cost,
            momox_price,
            momox_title,
            ${withMomoxStatus ? 'momox_status,' : ''}
            gibert_price,
            profit_momox,
            profit_gibert,
            best_resale_price,
            best_resale_platform,
            status,
            candidate_status,
            review_status,
            admin_status,
            updated_at
        `,
        [
            usablePrice,
            momoxRow.title || null,
            momoxRow.imageUrl || null,
            matchScore,
            `https://www.momox.fr/api/v4/media/offer/?ean=${momoxRow.isbn}`,
            JSON.stringify({
                provider: 'scrapfly_momox_batch',
                row: momoxRow.raw ?? momoxRow,
                momoxStatus: momoxRow.momoxStatus,
                batch: {
                    requestedIsbns: batchResult.requestedIsbns,
                    requestId: batchResult.requestId || null,
                    logUrl: batchResult.logUrl || null,
                },
            }),
            status,
            candidateStatus,
            reviewStatus,
            adminStatus,
            profitMomox,
            best.price,
            best.platform,
            book.id,
        ]
    );

    return result.rows[0];
}

/**
 * Mark book rows as failed for Momox (used when the Scrapfly batch AND any
 * fallback failed). Never throws.
 */
export async function markMomoxLookupFailed({ adsId, isbns, reason }) {
    if (!adsId || !Array.isArray(isbns) || !isbns.length) return;

    try {
        const withMomoxStatus = await hasMomoxStatusColumn();

        // Target unresolved rows. With momox_status present, price defaults to 0
        // so we can no longer filter on momox_price IS NULL; key off the status
        // instead and keep momox_price display-safe (COALESCE to 0, never erase
        // a previously found price). Legacy path keeps the price-NULL filter.
        const unresolvedFilter = withMomoxStatus
            ? `(momox_status IS NULL OR momox_status IN ('momox_pending', 'momox_failed'))`
            : `momox_price IS NULL`;

        await pool.query(
            `
            UPDATE books
            SET
                ${withMomoxStatus ? `momox_status = 'momox_failed', momox_price = COALESCE(momox_price, 0),` : ''}
                status = 'momox_lookup_failed',
                candidate_status = 'resale_error',
                review_status = 'manual_review',
                skip_reason = COALESCE($3, skip_reason),
                updated_at = NOW()
            WHERE ads_id = $1
              AND isbn = ANY($2::text[])
              AND ${unresolvedFilter}
              AND admin_status NOT IN ('validated', 'rejected')
            `,
            [adsId, isbns, reason ? `Momox lookup failed: ${String(reason).slice(0, 300)}` : null]
        );
    } catch (error) {
        console.error(
            `markMomoxLookupFailed failed for adsId=${adsId}:`,
            error?.message || error
        );
    }
}

const MOMOX_CHUNK_SIZE = 10;

function chunkArray(items, size) {
    const chunks = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

/**
 * Run Momox Scrapfly batches for an ad and persist results per book row.
 * ISBN lists longer than 10 (multiple exact-title editions per detected book)
 * are split into several Scrapfly calls of 10.
 *
 * @param {object} options
 * @param {string} options.adsId
 * @param {string[]} [options.isbns] - explicit final ISBN list (preferred).
 *   When omitted (manual/admin trigger), all rows of the ad without a final
 *   Momox result are used.
 * @param {number} [options.limit]
 */
export async function updateMomoxPricesForAd({ adsId, isbns = null, limit = 30 }) {
    if (!adsId) {
        throw new Error('updateMomoxPricesForAd missing adsId');
    }

    const hasExplicitIsbns = Array.isArray(isbns) && isbns.length > 0;

    // Manual "retry everything unresolved" path: with momox_status present,
    // price defaults to 0, so target rows by status rather than momox_price IS NULL.
    const withMomoxStatus = await hasMomoxStatusColumn();
    const unresolvedFilter = withMomoxStatus
        ? `(momox_status IS NULL OR momox_status IN ('momox_pending', 'momox_failed'))`
        : `momox_price IS NULL`;

    const booksResult = await pool.query(
        hasExplicitIsbns
            ? `
            SELECT
                id, ads_id, isbn, title, possible_corrected_title, lookup_title,
                cost, momox_price, gibert_price, gibert_checked_at,
                status, candidate_status, review_status, admin_status
            FROM books
            WHERE ads_id = $1
              AND isbn = ANY($2::text[])
            ORDER BY id ASC
            LIMIT $3
            `
            : `
            SELECT
                id, ads_id, isbn, title, possible_corrected_title, lookup_title,
                cost, momox_price, gibert_price, gibert_checked_at,
                status, candidate_status, review_status, admin_status
            FROM books
            WHERE ads_id = $1
              AND isbn IS NOT NULL
              AND ${unresolvedFilter}
              AND status NOT IN (
                  'momox_price_found',
                  'momox_price_found_needs_review',
                  'momox_title_mismatch',
                  'momox_no_price',
                  'momox_not_real_offer',
                  'confirmed',
                  'rejected'
              )
              -- Manual retry targets rows that were (or should be) SENT;
              -- weak candidates were deliberately never sent to providers.
              AND COALESCE(candidate_status, '') <> 'weak_candidate'
              AND COALESCE(status, '') NOT IN (
                'isbn_not_found',
                'isbn_invalid',
                'isbn_weak',
                'bad',
                'skipped'
            )
            ORDER BY id ASC
            LIMIT $2
            `,
        hasExplicitIsbns ? [adsId, isbns, limit] : [adsId, limit]
    );

    const books = booksResult.rows;

    if (!books.length) {
        return {
            adsId,
            ok: true,
            attempted: 0,
            updated: 0,
            skipped: true,
            reason: 'No book rows to price on Momox for this ad',
            rows: [],
        };
    }

    const uniqueIsbns = [...new Set(books.map((book) => book.isbn))];
    const isbnChunks = chunkArray(uniqueIsbns, MOMOX_CHUNK_SIZE);

    if (isbnChunks.length > 1) {
        console.log(
            `Momox: ${uniqueIsbns.length} ISBNs for adsId=${adsId} split into ${isbnChunks.length} batches of <= ${MOMOX_CHUNK_SIZE}.`
        );
    }

    // One js_scenario Scrapfly call per chunk; chunk failures are isolated.
    const resultByIsbn = new Map(); // isbn -> { row, batchResult }
    const failedChunkIsbns = [];
    const requestIds = [];
    const offerIsbns = [];
    const noOfferIsbns = [];
    const failedIsbns = [];

    let okChunks = 0;
    let totalScrapflyCost = 0;
    let firstFailureReason = null;

    for (const [chunkIndex, chunk] of isbnChunks.entries()) {
        const chunkSet = new Set(chunk);
        const chunkBooks = books.filter((book) => chunkSet.has(book.isbn));

        let batchResult;

        try {
            batchResult = await lookupMomoxPricesBatch({ adsId, books: chunkBooks });
        } catch (error) {
            batchResult = {
                ok: false,
                reason: error?.message || String(error),
                requestedIsbns: chunk,
                rows: [],
                offerIsbns: [],
                noOfferIsbns: [],
                failedIsbns: chunk,
            };
        }

        if (Number.isFinite(Number(batchResult.scrapflyCost))) {
            totalScrapflyCost += Number(batchResult.scrapflyCost);
        }

        if (batchResult.requestId) {
            requestIds.push(batchResult.requestId);
        }

        // One technical cost event per provider CALL.
        await saveTechnicalCostEvent({
            adsId,
            costType: 'momox_batch_lookup',
            provider: 'scrapfly',
            amount: batchResult.scrapflyCost,
            currency: 'SCRAPFLY_CREDIT',
            unitCount: batchResult.requestedIsbns?.length || chunk.length,
            unitType: 'isbn',
            metadata: {
                ok: batchResult.ok,
                chunk: `${chunkIndex + 1}/${isbnChunks.length}`,
                requestedIsbns: batchResult.requestedIsbns || chunk,
                offerIsbns: batchResult.offerIsbns || [],
                noOfferIsbns: batchResult.noOfferIsbns || [],
                failedIsbns: batchResult.failedIsbns || [],
                scrapflyCost: batchResult.scrapflyCost ?? null,
                ...perUnitScrapflyMeta(batchResult.scrapflyCost, batchResult.requestedIsbns?.length || chunk.length),
                requestId: batchResult.requestId || null,
                logUrl: batchResult.logUrl || null,
                reason: batchResult.reason || null,
            },
        });

        if (!batchResult.ok) {
            failedChunkIsbns.push(...chunk);
            firstFailureReason = firstFailureReason || batchResult.reason;

            console.warn(
                `[ad ${adsId}] momox chunk failed: chunk=${chunkIndex + 1}/${isbnChunks.length}, isbns=${chunk.join(',')}, error=${batchResult.reason}`
            );

            continue;
        }

        okChunks += 1;
        offerIsbns.push(...(batchResult.offerIsbns || []));
        noOfferIsbns.push(...(batchResult.noOfferIsbns || []));
        failedIsbns.push(...(batchResult.failedIsbns || []));

        for (const row of batchResult.rows) {
            resultByIsbn.set(row.isbn, { row, batchResult });
        }

        // ISBNs the chunk requested but Momox did not return at all.
        for (const isbn of chunk) {
            if (!resultByIsbn.has(isbn)) {
                resultByIsbn.set(isbn, {
                    row: {
                        isbn,
                        status: 'failed',
                        momoxStatus: null,
                        price: null,
                        title: null,
                        imageUrl: null,
                        error: 'ISBN missing from Momox batch response',
                        raw: null,
                    },
                    batchResult,
                });
            }
        }
    }

    if (!okChunks) {
        return {
            adsId,
            ok: false,
            attempted: books.length,
            updated: 0,
            reason: firstFailureReason || 'All Momox batches failed',
            scrapflyCost: totalScrapflyCost,
            requestIds,
            rows: [],
        };
    }

    // Partial failure: mark rows from failed chunks, keep going with the rest.
    if (failedChunkIsbns.length) {
        await markMomoxLookupFailed({
            adsId,
            isbns: failedChunkIsbns,
            reason: firstFailureReason || 'Momox chunk failed',
        });
    }

    const updatedRows = [];
    let failedRowUpdates = 0;

    for (const book of books) {
        const entry = resultByIsbn.get(book.isbn);

        if (!entry) continue; // failed chunk, already marked

        try {
            const updated = await updateBookWithMomoxRow({
                book,
                momoxRow: entry.row,
                batchResult: entry.batchResult,
            });

            updatedRows.push(updated);
        } catch (error) {
            failedRowUpdates += 1;
            console.error(
                `Momox row update failed adsId=${adsId} bookId=${book.id} isbn=${book.isbn}:`,
                error?.message || error
            );
        }
    }

    console.log(
        `[ad ${adsId}] momox persisted: isbns=${uniqueIsbns.length}, batches=${isbnChunks.length} (ok=${okChunks}), offers=${offerIsbns.length}, noOffer=${noOfferIsbns.length}, failed=${failedIsbns.length + failedChunkIsbns.length}, rowsUpdated=${updatedRows.length}, rowUpdateErrors=${failedRowUpdates}`
    );

    return {
        adsId,
        ok: true,
        attempted: books.length,
        updated: updatedRows.length,
        offerIsbns,
        noOfferIsbns,
        failedIsbns: [...failedIsbns, ...failedChunkIsbns],
        scrapflyCost: totalScrapflyCost,
        requestIds,
        rows: updatedRows,
    };
}
