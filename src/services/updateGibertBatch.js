// src/services/updateGibertBatch.js
//
// Orchestrates one Gibert Scrapfly batch lookup for the saved book rows of an
// ad, then updates each row with price/title/image/status + profit and best
// resale recomputation.
//
// Only FINAL resolved ISBNs should reach this service: the workflow passes the
// explicit `isbns` list taken from accepted, saved book rows - never raw
// ISBNSearch candidate variants.

import { pool } from '../db.js';
import { lookupGibertPricesBatch, isRetriableScenarioFailure } from './gibertScrapflyBatchService.js';
import { saveTechnicalCostEvent, perUnitScrapflyMeta } from './costEvents.js';

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

// Failed momox states are NOT final: the row is retryable and its momox_price
// is still NULL, so "no_resale_offer" cannot be concluded from them.
function isFinalMomoxState(status) {
    return [
        'momox_price_found',
        'momox_price_found_needs_review',
        'momox_title_mismatch',
        'momox_no_price',
        'momox_not_real_offer',
    ].includes(String(status || ''));
}

async function updateBookWithGibertResult({ book, gibertRow, batchResult }) {
    const gibertPrice = parsePrice(gibertRow.gibertPrice);
    const momoxPrice = parsePrice(book.momox_price);

    const best = computeBestResale({ momoxPrice, gibertPrice });

    const cost = book.cost === null || book.cost === undefined ? null : Number(book.cost);

    const profitGibert =
        Number.isFinite(cost)
            ? Number((gibertPrice - cost).toFixed(2))
            : null;

    // Gibert runs after Momox in the workflow, so this is the moment we can
    // conclude "no resale offer anywhere" for the book.
    const candidateStatus =
        gibertPrice > 0
            ? 'resale_price_found'
            : best.platform === null && isFinalMomoxState(book.status)
                ? 'no_resale_offer'
                : null; // keep current candidate_status

    const result = await pool.query(
        `
        UPDATE books
        SET
            gibert_price = $1::numeric,
            gibert_title = COALESCE($2, gibert_title),
            gibert_image_url = COALESCE($3, gibert_image_url),
            gibert_status = $4,
            gibert_checked_at = NOW(),
            gibert_raw_response = $5::jsonb,

            profit_gibert = $6,
            best_resale_price = $7,
            best_resale_platform = $8,

            -- Multi-edition (duplicate) groups keep their group markers so the
            -- admin still sees "these rows are ISBN alternatives" after pricing.
            candidate_status = CASE
                    WHEN candidate_status IN (
                        'duplicate_selected',
                        'duplicate_alternative',
                        'selected_edition',
                        'alternative_edition'
                    )
                        THEN candidate_status
                    ELSE COALESCE($9, candidate_status)
                END,

            admin_status = CASE
                WHEN $1::numeric > 0
                     AND admin_status NOT IN (
                        'validated',
                        'rejected',
                        'pending_duplicate',
                        'pending_edition_choice'
                     )
                    THEN 'new'
                ELSE admin_status
            END,

            updated_at = NOW()
        WHERE id = $10
        RETURNING
            id,
            ads_id,
            isbn,
            title,
            cost,
            momox_price,
            gibert_price,
            gibert_title,
            gibert_status,
            profit_momox,
            profit_gibert,
            best_resale_price,
            best_resale_platform,
            candidate_status,
            review_status,
            admin_status,
            gibert_checked_at,
            updated_at
        `,
        [
            gibertPrice,
            gibertRow.title || null,
            gibertRow.imageUrl || null,
            gibertRow.status,
            JSON.stringify({
                provider: 'scrapfly_gibert_batch',
                row: gibertRow,
                batch: {
                    requestedIsbns: batchResult.requestedIsbns,
                    totalAmount: batchResult.totalAmount,
                    totalAmountText: batchResult.totalAmountText,
                    sumRows: batchResult.sumRows,
                    totalMatchesRows: batchResult.totalMatchesRows,
                    requestId: batchResult.requestId || null,
                    logUrl: batchResult.logUrl || null,
                },
            }),
            profitGibert,
            best.price,
            best.platform,
            candidateStatus,
            book.id,
        ]
    );

    return result.rows[0];
}

/**
 * Mark book rows as failed for Gibert (batch-level failure). Rows keep
 * gibert_checked_at = NULL so a later run can retry them; the failure is
 * carried by gibert_status='gibert_failed' and gibert_price is kept
 * display-safe at 0 (never NULL). Never throws.
 */
export async function markGibertLookupFailed({ adsId, isbns, reason }) {
    if (!adsId || !Array.isArray(isbns) || !isbns.length) return;

    try {
        await pool.query(
            `
            UPDATE books
            SET
                gibert_status = 'gibert_failed',
                gibert_price = COALESCE(gibert_price, 0),
                gibert_raw_response = $3::jsonb,
                updated_at = NOW()
            WHERE ads_id = $1
              AND isbn = ANY($2::text[])
              AND gibert_checked_at IS NULL
            `,
            [
                adsId,
                isbns,
                JSON.stringify({
                    provider: 'scrapfly_gibert_batch',
                    error: String(reason || 'Gibert lookup failed').slice(0, 500),
                    failedAt: new Date().toISOString(),
                }),
            ]
        );
    } catch (error) {
        console.error(
            `markGibertLookupFailed failed for adsId=${adsId}:`,
            error?.message || error
        );
    }
}

const GIBERT_CHUNK_SIZE = Number(process.env.GIBERT_CHUNK_SIZE || 5);

// Max Scrapfly batch calls per chunk (1 + retries). Default 2. The improved
// scenario succeeds on the first call in the normal case, so retries are a thin
// safety net for transient proxy/network blips, NOT for a broken form.
const GIBERT_MAX_BATCH_ATTEMPTS = Math.min(
    Math.max(Number(process.env.GIBERT_MAX_BATCH_ATTEMPTS ?? (Number(process.env.GIBERT_BATCH_RETRIES ?? 1) + 1)), 1),
    3
);

// Single-ISBN fallback is OFF by default: it is full-price per ISBN and, when a
// chunk fails because the FORM did not load, every single call hits the same
// broken page. New env name GIBERT_ENABLE_SINGLE_FALLBACK (old
// GIBERT_SINGLE_FALLBACK_ENABLED still honored for back-compat).
const GIBERT_SINGLE_FALLBACK_ENABLED =
    (process.env.GIBERT_ENABLE_SINGLE_FALLBACK ?? process.env.GIBERT_SINGLE_FALLBACK_ENABLED ?? 'false') === 'true';

const GIBERT_SINGLE_FALLBACK_MAX_PER_AD = Math.max(
    0,
    Number(process.env.GIBERT_SINGLE_FALLBACK_MAX_PER_AD || 1)
);

// A form/scenario failure (input never appeared, no product rows, did not
// submit) means the page is broken right now — single fallbacks would just
// re-pay for the same failure. Skip them and mark rows gibert_failed (retryable).
export function isScenarioFormFailure(batchResult) {
    if (['scenario_form_failure', 'consent_modal_blocked'].includes(batchResult?.failureKind)) return true;
    // Defensive fallback for results lacking failureKind (kept in sync with the
    // service's classifyFailureKind).
    const reason = String(batchResult?.reason || '');
    return /no product rows|not present|did not submit|#add_sao|input\[name|input.*missing|form likely|consent|cookie/i.test(reason);
}

function chunkArray(items, size) {
    const chunks = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

async function lookupGibertSingleFallback({
    adsId,
    chunkIndex,
    totalChunks,
    failedChunk,
    failedChunkBooks,
    firstFailureReason,
}) {
    const resultByIsbn = new Map();
    const failedIsbns = [];
    const missingIsbns = [];
    const requestIds = [];

    let okSingles = 0;
    let totalScrapflyCost = 0;
    let fallbackFailureReason = firstFailureReason || null;

    console.warn(
        `[ad ${adsId}] gibert single fallback started: chunk=${chunkIndex + 1}/${totalChunks}, isbns=${failedChunk.join(',')}`
    );

    for (const isbn of failedChunk) {
        const singleBooks = failedChunkBooks.filter((book) => book.isbn === isbn);
        let singleResult;

        try {
            singleResult = await lookupGibertPricesBatch({
                adsId,
                books: singleBooks,
            });
        } catch (error) {
            singleResult = {
                ok: false,
                reason: error?.message || String(error),
                requestedIsbns: [isbn],
                rows: [],
                missingIsbns: [isbn],
            };
        }

        if (Number.isFinite(Number(singleResult.scrapflyCost))) {
            totalScrapflyCost += Number(singleResult.scrapflyCost);
        }

        await saveTechnicalCostEvent({
            adsId,
            costType: 'gibert_single_fallback_lookup',
            provider: 'scrapfly',
            amount: singleResult.scrapflyCost,
            currency: 'SCRAPFLY_CREDIT',
            unitCount: 1,
            unitType: 'isbn',
            metadata: {
                ok: singleResult.ok,
                chunk: `${chunkIndex + 1}/${totalChunks}`,
                requestedIsbns: singleResult.requestedIsbns || [isbn],
                foundIsbns: singleResult.rows?.map((row) => row.isbn) || [],
                missingIsbns: singleResult.missingIsbns || [],
                totalAmount: singleResult.totalAmount ?? null,
                sumRows: singleResult.sumRows ?? null,
                totalMatchesRows: singleResult.totalMatchesRows ?? null,
                ...perUnitScrapflyMeta(singleResult.scrapflyCost, 1),
                requestId: singleResult.requestId || null,
                logUrl: singleResult.logUrl || null,
                reason: singleResult.reason || null,
                fallbackFrom: 'failed_gibert_chunk',
            },
        });

        if (!singleResult.ok) {
            failedIsbns.push(isbn);
            fallbackFailureReason = fallbackFailureReason || singleResult.reason;

            console.warn(
                `[ad ${adsId}] gibert single fallback failed: isbn=${isbn}, error=${singleResult.reason}`
            );

            await markGibertLookupFailed({
                adsId,
                isbns: [isbn],
                reason: singleResult.reason || firstFailureReason,
            });

            continue;
        }

        okSingles += 1;

        if (singleResult.requestId) {
            requestIds.push(singleResult.requestId);
        }

        missingIsbns.push(...(singleResult.missingIsbns || []));

        for (const row of singleResult.rows || []) {
            resultByIsbn.set(row.isbn, { row, batchResult: singleResult });
        }

        if (!resultByIsbn.has(isbn)) {
            resultByIsbn.set(isbn, {
                row: {
                    isbn,
                    title: null,
                    imageUrl: null,
                    gibertPrice: 0,
                    status: 'gibert_missing',
                    priceText: null,
                    nonReprisText: null,
                },
                batchResult: singleResult,
            });
        }
    }

    console.log(
        `[ad ${adsId}] gibert single fallback finished: chunk=${chunkIndex + 1}/${totalChunks}, okSingles=${okSingles}, failedSingles=${failedIsbns.length}, cost=${totalScrapflyCost}`
    );

    return {
        okSingles,
        resultByIsbn,
        failedIsbns,
        missingIsbns,
        requestIds,
        scrapflyCost: totalScrapflyCost,
        reason: fallbackFailureReason,
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run Gibert Scrapfly batches for an ad and persist results per book row.
  * ISBN lists are split into chunks of GIBERT_CHUNK_SIZE. If a chunk still fails
 * after retries, it falls back to single-ISBN Scrapfly calls.
 *
 * @param {object} options
 * @param {string} options.adsId
 * @param {string[]} [options.isbns] - explicit final ISBN list (preferred).
 *   When omitted (manual/admin trigger), all unchecked rows with an ISBN are used.
 * @param {number} [options.limit]
 */
export async function updateGibertPricesForAd({ adsId, isbns = null, limit = 30 }) {
    if (!adsId) {
        throw new Error('updateGibertPricesForAd missing adsId');
    }

    const hasExplicitIsbns = Array.isArray(isbns) && isbns.length > 0;

    const booksResult = await pool.query(
        `
        SELECT
            id,
            ads_id,
            isbn,
            title,
            cost,
            momox_price,
            gibert_price,
            gibert_status,
            profit_momox,
            profit_gibert,
            best_resale_price,
            best_resale_platform,
            status,
            candidate_status,
            review_status,
            admin_status
        FROM books
        WHERE ads_id = $1
          AND isbn IS NOT NULL
          AND gibert_checked_at IS NULL
          AND ($2::text[] IS NULL OR isbn = ANY($2::text[]))
          -- Without an explicit ISBN list (manual retry), skip weak candidates
          -- that were deliberately never sent to providers.
          AND (
            $2::text[] IS NOT NULL
            OR (
                COALESCE(candidate_status, '') <> 'weak_candidate'
                AND COALESCE(status, '') NOT IN (
                    'isbn_not_found',
                    'isbn_invalid',
                    'isbn_weak',
                    'bad',
                    'skipped'
                )
            )
        )
        ORDER BY id ASC
        LIMIT $3
        `,
        [adsId, hasExplicitIsbns ? isbns : null, limit]
    );

    const books = booksResult.rows;

    if (!books.length) {
        return {
            adsId,
            ok: true,
            attempted: 0,
            updated: 0,
            skipped: true,
            reason: 'No unchecked books with ISBN for this ad',
            rows: [],
        };
    }

    const uniqueIsbns = [...new Set(books.map((book) => book.isbn))];
    const isbnChunks = chunkArray(uniqueIsbns, GIBERT_CHUNK_SIZE);

    if (isbnChunks.length > 1) {
        console.log(
            `Gibert: ${uniqueIsbns.length} ISBNs for adsId=${adsId} split into ${isbnChunks.length} batches of <= ${GIBERT_CHUNK_SIZE}.`
        );
    }

    // Bounded batch attempts per chunk (the improved scenario should succeed on
    // the first call; retries only cover transient proxy/network blips).
    const maxAttempts = GIBERT_MAX_BATCH_ATTEMPTS;

    const resultByIsbn = new Map(); // isbn -> { row, batchResult }
    const failedChunkIsbns = [];
    const requestIds = [];
    const missingIsbns = [];

    let okChunks = 0;
    let totalScrapflyCost = 0;
    let firstFailureReason = null;
    let singleFallbackUsed = 0;

    for (const [chunkIndex, chunk] of isbnChunks.entries()) {
        const chunkSet = new Set(chunk);
        const chunkBooks = books.filter((book) => chunkSet.has(book.isbn));

        let batchResult;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                batchResult = await lookupGibertPricesBatch({
                    adsId,
                    books: chunkBooks,
                });
            } catch (error) {
                batchResult = {
                    ok: false,
                    reason: error?.message || String(error),
                    requestedIsbns: chunk,
                    rows: [],
                    missingIsbns: chunk,
                };
            }

            if (Number.isFinite(Number(batchResult.scrapflyCost))) {
                totalScrapflyCost += Number(batchResult.scrapflyCost);
            }

            // One technical cost event per provider CALL (retries included).
            await saveTechnicalCostEvent({
                adsId,
                costType: 'gibert_batch_lookup',
                provider: 'scrapfly',
                amount: batchResult.scrapflyCost,
                currency: 'SCRAPFLY_CREDIT',
                unitCount: chunk.length,
                unitType: 'isbn',
                metadata: {
                    ok: batchResult.ok,
                    chunk: `${chunkIndex + 1}/${isbnChunks.length}`,
                    attempt,
                    requestedIsbns: batchResult.requestedIsbns || chunk,
                    foundIsbns: batchResult.rows?.map((row) => row.isbn) || [],
                    missingIsbns: batchResult.missingIsbns || [],
                    totalAmount: batchResult.totalAmount ?? null,
                    sumRows: batchResult.sumRows ?? null,
                    totalMatchesRows: batchResult.totalMatchesRows ?? null,
                    ...perUnitScrapflyMeta(batchResult.scrapflyCost, chunk.length),
                    requestId: batchResult.requestId || null,
                    logUrl: batchResult.logUrl || null,
                    reason: batchResult.reason || null,
                    failureKind: batchResult.failureKind || null,
                    diagStage: batchResult.diagnostics?.stage || null,
                    diagResultState: batchResult.diagnostics?.resultState || null,
                },
            });

            if (batchResult.ok || batchResult.skipped) {
                break;
            }

            // Diagnostics for the failed attempt (point 3).
            if (batchResult.diagnostics || batchResult.screenshotUrl) {
                const d = batchResult.diagnostics || {};
                const c = d.consent || {};
                console.warn(
                    `[ad ${adsId}] gibert failure diagnostics: failureKind=${batchResult.failureKind || '-'} stage=${d.stage || '-'} fillStage=${d.fillStage || '-'}` +
                    ` inputPresent=${d.inputPresent ?? '-'} hasProductList=${d.hasProductList ?? '-'} rowCount=${d.rowCount ?? '-'}` +
                    ` cookieVisible=${d.cookieVisible ?? '-'} consent{bar=${c.bar ?? '-'},overlay=${c.overlay ?? '-'},hasAllow=${c.hasAllow ?? '-'},hasDecline=${c.hasDecline ?? '-'},hasClose=${c.hasClose ?? '-'},bodyHasModal=${c.bodyHasModal ?? '-'}}` +
                    ` hasArtAuto=${d.hasArtAuto ?? '-'} has13=${d.has13 ?? '-'}` +
                    ` cookies="${String(batchResult.cookiesSeen || '-').slice(0, 200)}"` +
                    ` logUrl=${batchResult.logUrl || '-'}` +
                    (batchResult.screenshotUrl ? ` screenshot=${batchResult.screenshotUrl}` : '')
                );
            }

            // A genuinely broken page (input never appeared) is not worth
            // retrying. An INTERMITTENT failure (filled+submitted but no rows —
            // the consent modal racing the click) gets one bounded retry.
            if (isScenarioFormFailure(batchResult) && !isRetriableScenarioFailure(batchResult)) {
                console.warn(
                    `[ad ${adsId}] gibert chunk broken-form failure (not retrying): chunk=${chunkIndex + 1}/${isbnChunks.length}, stage=${batchResult.diagnostics?.stage || '-'}, error=${batchResult.reason}`
                );
                break;
            }

            if (attempt < maxAttempts) {
                const delayMs = Number(process.env.GIBERT_RETRY_DELAY_MS || 4000);

                console.warn(
                    `[ad ${adsId}] gibert chunk attempt failed (retrying after ${delayMs}ms): chunk=${chunkIndex + 1}/${isbnChunks.length}, attempt=${attempt}/${maxAttempts}, error=${batchResult.reason}`
                );

                await sleep(delayMs);
            }
        }

        if (!batchResult.ok) {
            firstFailureReason = firstFailureReason || batchResult.reason;

            const remainingSingleFallbackBudget = Math.max(
                0,
                GIBERT_SINGLE_FALLBACK_MAX_PER_AD - singleFallbackUsed
            );

            // Never run single fallbacks for a form/scenario failure: the page is
            // broken right now, so every single call re-pays for the same failure.
            const formFailure = isScenarioFormFailure(batchResult);

            if (formFailure || !GIBERT_SINGLE_FALLBACK_ENABLED || remainingSingleFallbackBudget <= 0) {
                failedChunkIsbns.push(...chunk);

                console.warn(
                    `[ad ${adsId}] gibert chunk failed; single fallback skipped: chunk=${chunkIndex + 1}/${isbnChunks.length}, isbns=${chunk.join(',')}, error=${batchResult.reason}, reasonKind=${formFailure ? 'scenario_form_failure' : (batchResult.failureKind || 'other')}, fallbackEnabled=${GIBERT_SINGLE_FALLBACK_ENABLED}, remainingBudget=${remainingSingleFallbackBudget}`
                );

                await markGibertLookupFailed({
                    adsId,
                    isbns: chunk,
                    reason: batchResult.reason,
                });

                continue;
            }

            const fallbackChunk = chunk.slice(0, remainingSingleFallbackBudget);
            const skippedFallbackIsbns = chunk.slice(remainingSingleFallbackBudget);
            const fallbackChunkSet = new Set(fallbackChunk);
            const fallbackChunkBooks = chunkBooks.filter((book) => fallbackChunkSet.has(book.isbn));

            console.warn(
                `[ad ${adsId}] gibert chunk failed after retries; trying capped single fallback: chunk=${chunkIndex + 1}/${isbnChunks.length}, fallbackIsbns=${fallbackChunk.join(',')}, skippedIsbns=${skippedFallbackIsbns.join(',')}, error=${batchResult.reason}`
            );

            const fallbackResult = await lookupGibertSingleFallback({
                adsId,
                chunkIndex,
                totalChunks: isbnChunks.length,
                failedChunk: fallbackChunk,
                failedChunkBooks: fallbackChunkBooks,
                firstFailureReason: batchResult.reason,
            });

            singleFallbackUsed += fallbackChunk.length;
            totalScrapflyCost += fallbackResult.scrapflyCost || 0;

            failedChunkIsbns.push(...fallbackResult.failedIsbns);
            missingIsbns.push(...fallbackResult.missingIsbns);
            requestIds.push(...fallbackResult.requestIds);

            for (const [isbn, entry] of fallbackResult.resultByIsbn.entries()) {
                resultByIsbn.set(isbn, entry);
            }

            if (fallbackResult.okSingles > 0) {
                okChunks += 1;
            }

            if (skippedFallbackIsbns.length) {
                failedChunkIsbns.push(...skippedFallbackIsbns);

                await markGibertLookupFailed({
                    adsId,
                    isbns: skippedFallbackIsbns,
                    reason: `Gibert chunk failed and single fallback budget exhausted. Original error: ${batchResult.reason}`,
                });
            }

            if (fallbackResult.failedIsbns.length) {
                firstFailureReason = firstFailureReason || fallbackResult.reason;
            }

            continue;
        }

        okChunks += 1;

        if (batchResult.requestId) {
            requestIds.push(batchResult.requestId);
        }

        missingIsbns.push(...(batchResult.missingIsbns || []));

        for (const row of batchResult.rows) {
            resultByIsbn.set(row.isbn, { row, batchResult });
        }

        // ISBN not in Gibert's response: Gibert does not know/list it.
        for (const isbn of chunk) {
            if (!resultByIsbn.has(isbn)) {
                resultByIsbn.set(isbn, {
                    row: {
                        isbn,
                        title: null,
                        imageUrl: null,
                        gibertPrice: 0,
                        status: 'gibert_missing',
                        priceText: null,
                        nonReprisText: null,
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
            reason: firstFailureReason || 'All Gibert batches failed',
            scrapflyCost: totalScrapflyCost,
            requestIds,
            rows: [],
        };
    }

    const updatedRows = [];
    let failedRowUpdates = 0;

    for (const book of books) {
        const entry = resultByIsbn.get(book.isbn);

        if (!entry) continue; // failed chunk, already marked gibert_lookup_failed

        try {
            const updated = await updateBookWithGibertResult({
                book,
                gibertRow: entry.row,
                batchResult: entry.batchResult,
            });

            updatedRows.push(updated);
        } catch (error) {
            failedRowUpdates += 1;
            console.error(
                `Gibert row update failed adsId=${adsId} bookId=${book.id} isbn=${book.isbn}:`,
                error?.message || error
            );
        }
    }

    console.log(
        `[ad ${adsId}] gibert persisted: isbns=${uniqueIsbns.length}, batches=${isbnChunks.length} (okOrRecovered=${okChunks}), missing=${missingIsbns.length}, failedIsbns=${failedChunkIsbns.length}, singleFallbackUsed=${singleFallbackUsed}, rowsUpdated=${updatedRows.length}, rowUpdateErrors=${failedRowUpdates}`
    );

    return {
        adsId,
        ok: true,
        attempted: books.length,
        updated: updatedRows.length,
        missingIsbns,
        failedIsbns: failedChunkIsbns,
        scrapflyCost: totalScrapflyCost,
        requestIds,
        rows: updatedRows,
    };
}
