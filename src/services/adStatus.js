//src\services\adStatus.js

import { pool } from '../db.js';
import { hasMomoxStatusColumn, hasBooksColumn } from './bookColumns.js';

// Derive the Momox lifecycle state for a row.
//
// When books.momox_status exists it is the SOLE source of truth: provider
// prices default to 0 (never NULL) so price can no longer signal "not checked".
// A NULL momox_status with the column present means the row was never sent.
// Legacy path (column absent): fall back to the global status field, where a
// NULL momox_price still means "not checked".
export function deriveMomoxState(row, hasStatusColumn) {
    if (hasStatusColumn) {
        // NULL status (column present) OR an explicit 'not_sent' both mean the
        // row was never sent to Momox. Price is NULL in this state.
        if (!row.momox_status || row.momox_status === 'not_sent') return 'not_sent';
        if (row.momox_status === 'momox_pending') return 'pending';
        if (row.momox_status === 'momox_failed') return 'failed';
        return 'done'; // momox_price_found / momox_no_offer
    }

    const status = String(row.status || '');

    if (status === 'momox_pending' || status === 'momox_pending_duplicate') return 'pending';
    if (status === 'momox_error' || status === 'momox_lookup_failed') return 'failed';
    if (row.momox_price === null || row.momox_price === undefined) return 'not_sent';

    return 'done';
}

// Gibert always has gibert_status + gibert_checked_at, so it never depends on
// price. checked_at is set only on a successful lookup.
export function deriveGibertState(row) {
    const status = String(row.gibert_status || '');

    // Explicitly never sent (eligibility held it / no usable ISBN). Price NULL.
    if (status === 'not_sent') return 'not_sent';
    if (status === 'gibert_pending') return 'pending';
    if (status === 'gibert_failed' || status === 'gibert_lookup_failed') return 'failed';
    if (
        status === 'gibert_price_found' ||
        status === 'gibert_non_repris' ||
        status === 'gibert_no_price' ||
        status === 'gibert_missing'
    ) {
        return 'done';
    }
    if (row.gibert_checked_at) return 'done';

    return 'not_sent';
}


function isProviderEligibleRow(row) {
    const status = String(row.status || '');
    const candidateStatus = String(row.candidate_status || '');
    const adminStatus = String(row.admin_status || '');

    if (!row.isbn) return false;

    if (
        status === 'isbn_not_found' ||
        status === 'isbn_invalid' ||
        status === 'isbn_weak' ||
        status === 'bad' ||
        status === 'skipped'
    ) {
        return false;
    }

    if (candidateStatus === 'weak_candidate' || candidateStatus === 'no_isbn') {
        return false;
    }

    return (
        status === 'ready_for_resale_check' ||
        status === 'isbn_alternative_candidate' ||
        status === 'momox_pending' ||
        status === 'momox_pending_duplicate' ||
        status === 'momox_lookup_failed' ||
        status.startsWith('momox_') ||
        status.startsWith('gibert_') ||
        candidateStatus === 'strong_candidate' ||
        candidateStatus === 'selected_edition' ||
        candidateStatus === 'alternative_edition' ||
        adminStatus === 'pending_edition_choice' ||
        // Was actually sent to a provider (explicit status markers). An explicit
        // 'not_sent' marker is the opposite — a row deliberately held back — so
        // it must NOT count as provider-eligible.
        (Boolean(row.momox_status) && row.momox_status !== 'not_sent') ||
        (Boolean(row.gibert_status) && row.gibert_status !== 'not_sent') ||
        Boolean(row.gibert_checked_at)
    );
}

/**
 * Canonical backend status for a row, derived (read-only) from the existing
 * status machine. Gives the book-app/admin UI one clear value to read without
 * renaming the live status/candidate_status/admin_status fields the workflow
 * and updaters depend on. Pass momoxState/gibertState from derive* (or omit to
 * compute the legacy way).
 *
 * Vocabulary: detected_no_isbn, isbnsearch_candidate, isbn_confirmed,
 * provider_price_found, provider_no_offer, provider_not_sent, provider_failed,
 * needs_admin_review, ready_for_admin, rejected.
 *
 * Point-11 rule: provider_no_offer is ONLY valid when a provider was actually
 * called and returned no price. A row that was never sent is provider_not_sent
 * (or needs_admin_review), NEVER provider_no_offer.
 */

const REVIEW_NOT_SENT_REASONS = new Set([
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
]);

function rowNeedsAdminReviewWhenNotSent(row) {
    if (!row?.isbn) return false;

    const status = String(row.status || '');
    const candidateStatus = String(row.candidate_status || '');
    const adminStatus = String(row.admin_status || '');
    const reason = String(row.not_sent_reason || '');

    if (adminStatus === 'rejected' || candidateStatus === 'rejected') return false;
    if (status === 'isbn_not_found' || status === 'isbn_invalid') return false;
    if (candidateStatus === 'no_isbn') return false;

    if (
        candidateStatus === 'strong_candidate' ||
        candidateStatus === 'medium_candidate' ||
        status === 'isbn_strong' ||
        status === 'isbn_medium' ||
        status === 'isbn_medium_promoted'
    ) {
        return true;
    }

    return REVIEW_NOT_SENT_REASONS.has(reason);
}

export function deriveBackendStatus(row, momoxState, gibertState) {
    const adminStatus = String(row.admin_status || '');
    const candidateStatus = String(row.candidate_status || '');
    const matchStatus = String(row.provider_match_status || '');

    if (adminStatus === 'rejected' || candidateStatus === 'rejected') return 'rejected';
    if (adminStatus === 'validated') return 'ready_for_admin';

    if (!row.isbn) return 'detected_no_isbn';

    // Provider image verification (point 6): an image mismatch or uncertain
    // match means the persisted provider result may be the wrong edition.
    if (matchStatus === 'mismatch' || matchStatus === 'uncertain') {
        return 'needs_admin_review';
    }

    // Admin must disambiguate multi-edition rows.
    if (
        adminStatus === 'pending_duplicate' ||
        adminStatus === 'pending_edition_choice' ||
        candidateStatus === 'duplicate_selected' ||
        candidateStatus === 'duplicate_alternative'
    ) {
        return 'needs_admin_review';
    }

    const m = momoxState || 'not_sent';
    const g = gibertState || 'not_sent';

    if (m === 'failed' || g === 'failed') return 'provider_failed';
    if (m === 'pending' || g === 'pending') return 'isbn_confirmed'; // sent, awaiting result

    const momoxPrice = Number(row.momox_price) || 0;
    const gibertPrice = Number(row.gibert_price) || 0;

    if (momoxPrice > 0 || gibertPrice > 0) {
        // A strong provider IMAGE match confirms the edition even if the title
        // match was imperfect/long (the L'Art de l'automobile case).
        if (matchStatus === 'match' || matchStatus === 'likely_match') return 'ready_for_admin';
        return 'provider_price_found';
    }

    // No price anywhere. provider_no_offer ONLY when every provider actually ran.
    if (m === 'done' && g === 'done') return 'provider_no_offer';

    // One provider ran with no price, the other was never sent -> incomplete.
    if (m === 'done' || g === 'done') return 'isbn_confirmed';

    // Neither provider was sent this row. Some held rows are not bad; they are
    // good/medium ISBN candidates that need an admin decision.
    if (rowNeedsAdminReviewWhenNotSent(row)) {
        return 'needs_admin_review';
    }

    return 'provider_not_sent';
}

/**
 * Audit the provider completion state of every ISBN row of an ad.
 *
 * Returns:
 *   rows           - all ISBN rows with derived momoxState/gibertState
 *   incompleteRows - rows with a NULL provider price or pending/failed status
 *   blockingRows   - rows that were SENT but are unresolved (pending/failed);
 *                    these prevent the ad from counting as fully complete
 *   counts         - summary numbers for the audit log
 */
export async function checkProviderCompletionForAd(adsId) {
    const withMomoxStatus = await hasMomoxStatusColumn();
    const withMatchCols = await hasBooksColumn('provider_match_status');
    const withNotSentReason = await hasBooksColumn('not_sent_reason');

    const result = await pool.query(
        `
        SELECT
            id,
            ads_id,
            isbn,
            title,
            momox_price,
            gibert_price,
            momox_image_url,
            gibert_image_url,
            ${withMomoxStatus ? 'momox_status,' : 'NULL::text AS momox_status,'}
            gibert_status,
            gibert_checked_at,
            ${withMatchCols
            ? 'provider_match_status, provider_image_match_score, provider_match_source, provider_visual_similarity_score, provider_match_confidence,'
            : 'NULL::text AS provider_match_status, NULL::numeric AS provider_image_match_score, NULL::text AS provider_match_source, NULL::numeric AS provider_visual_similarity_score, NULL::numeric AS provider_match_confidence,'}
            ${withNotSentReason ? 'not_sent_reason,' : 'NULL::text AS not_sent_reason,'}
            status,
            candidate_status,
            admin_status
        FROM books
        WHERE ads_id = $1
          AND isbn IS NOT NULL
        ORDER BY id ASC
        `,
        [adsId]
    );

    const rows = result.rows.map((row) => ({
        ...row,
        providerEligible: isProviderEligibleRow(row),
        momoxState: deriveMomoxState(row, withMomoxStatus),
        gibertState: deriveGibertState(row),
    }));

    const providerRows = rows.filter((row) => row.providerEligible);

    // A row is incomplete when a provider that should have a result is still
    // pending or failed. Price is no longer a signal (defaults to 0).
    const incompleteRows = providerRows.filter(
        (row) =>
            ['pending', 'failed', 'not_sent'].includes(row.momoxState) ||
            ['pending', 'failed', 'not_sent'].includes(row.gibertState)
    );

    const blockingRows = providerRows.filter(
        (row) =>
            ['pending', 'failed'].includes(row.momoxState) ||
            ['pending', 'failed'].includes(row.gibertState)
    );

    const countBy = (state, key) => providerRows.filter((row) => row[key] === state).length;

    return {
        adsId,
        rows,
        incompleteRows,
        blockingRows,
        counts: {
            isbnRows: rows.length,
            providerEligibleRows: providerRows.length,
            momoxDone: countBy('done', 'momoxState'),
            momoxPending: countBy('pending', 'momoxState'),
            momoxFailed: countBy('failed', 'momoxState'),
            momoxNotSent: countBy('not_sent', 'momoxState'),
            gibertDone: countBy('done', 'gibertState'),
            gibertPending: countBy('pending', 'gibertState'),
            gibertFailed: countBy('failed', 'gibertState'),
            gibertNotSent: countBy('not_sent', 'gibertState'),
        },
    };
}

export async function getNewAdsByIds(adsIds) {
    if (!Array.isArray(adsIds) || adsIds.length === 0) {
        return [];
    }

    const result = await pool.query(
        `
        SELECT
            ads_id AS "adsId",
            url,
            title,
            description,
            first_picture_url AS "firstPictureUrl",
            price_text AS "priceText",
            price_amount AS "priceAmount",
            status,
            COALESCE(process_attempts, 0) AS "processAttempts",
            raw_data AS "rawData"
        FROM ads
        WHERE ads_id = ANY($1::text[])
          AND status = 'new'
        ORDER BY updated_at DESC
        `,
        [adsIds]
    );

    return result.rows;
}

export async function getAllNewAds() {
    const result = await pool.query(
        `
        SELECT
            ads_id AS "adsId",
            url,
            title,
            description,
            first_picture_url AS "firstPictureUrl",
            price_text AS "priceText",
            price_amount AS "priceAmount",
            status,
            COALESCE(process_attempts, 0) AS "processAttempts",
            raw_data AS "rawData"
        FROM ads
        WHERE status = 'new'
        ORDER BY updated_at DESC
        `
    );

    return result.rows;
}

export async function incrementAdProcessAttempts(adsId) {
    const result = await pool.query(
        `
        UPDATE ads
        SET
            process_attempts = COALESCE(process_attempts, 0) + 1,
            updated_at = NOW()
        WHERE ads_id = $1
        RETURNING
            ads_id,
            process_attempts
        `,
        [adsId]
    );

    return result.rows[0] || null;
}

export async function markAdProcessed(adsId) {
    const result = await pool.query(
        `
        UPDATE ads
        SET
            status = 'processed',
            updated_at = NOW()
        WHERE ads_id = $1
        RETURNING ads_id, status
        `,
        [adsId]
    );

    return result.rows[0] || null;
}

/**
 * Re-run the provider completion audit for an ad, log it, and sync
 * ads.processing_status ('provider_incomplete' vs 'processed'). Used by the
 * manual provider retry routes so a successful retry clears the incomplete
 * flag without re-running extraction. Never throws.
 */
export async function refreshAdProviderCompletion(adsId) {
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

        const blocked = completion.blockingRows.length > 0;

        await pool.query(
            `
            UPDATE ads
            SET
                processing_status = $2,
                processing_notes = $3,
                updated_at = NOW()
            WHERE ads_id = $1
            `,
            [
                adsId,
                blocked ? 'provider_incomplete' : 'processed',
                blocked
                    ? `Provider lookups incomplete: momoxPending=${counts.momoxPending}, momoxFailed=${counts.momoxFailed}, gibertPending=${counts.gibertPending}, gibertFailed=${counts.gibertFailed}`
                    : null,
            ]
        );

        return completion;
    } catch (error) {
        console.error(
            `[ad ${adsId}] refreshAdProviderCompletion failed:`,
            error?.message || error
        );
        return null;
    }
}

export async function bookAlreadyProcessedForAd({ adsId, isbn }) {
    const result = await pool.query(
        `
        SELECT EXISTS (
            SELECT 1
            FROM books
            WHERE ads_id = $1
              AND isbn = $2
            LIMIT 1
        ) AS exists
        `,
        [adsId, isbn]
    );

    return result.rows[0]?.exists === true;
}
