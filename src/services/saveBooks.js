// src/services/saveBooks.js

import { pool } from '../db.js';
import { hasMomoxStatusColumn, providerStatusLiteral } from './bookColumns.js';

// Explicit provider lifecycle value for books.momox_status.
function getProviderMomoxStatusFromGlobal(status) {
    if (status === 'momox_price_found' || status === 'momox_price_found_needs_review') {
        return 'momox_price_found';
    }

    if (status === 'momox_error') {
        return 'momox_failed';
    }

    // momox_no_price / momox_not_real_offer / momox_title_mismatch
    return 'momox_no_offer';
}

export function getCandidateStatusFromMomoxStatus(status) {
    if (status === 'momox_no_price') {
        return 'resale_no_price';
    }

    if (status === 'momox_not_real_offer') {
        return 'resale_not_real_offer';
    }

    if (status === 'momox_error') {
        return 'resale_error';
    }

    if (status === 'momox_title_mismatch') {
        return 'resale_title_mismatch';
    }

    return 'resale_price_found';
}



export function getAdminStatusFromMomoxResult({ status, momoxPrice }) {
    const price = Number(momoxPrice);

    if (Number.isFinite(price) && price > 0) {
        return 'new';
    }

    if (
        status === 'momox_no_price' ||
        status === 'momox_not_real_offer' ||
        status === 'momox_error' ||
        status === 'momox_title_mismatch'
    ) {
        return 'failed';
    }

    return 'pending';
}



export function getReviewStatusFromMomoxStatus({ status, momoxTitleMatchScore }) {
    if (status === 'momox_price_found' && Number(momoxTitleMatchScore) >= 0.85) {
        return 'pending';
    }

    return 'manual_review';
}

export async function saveBookFromMomoxResult({
    adsId,
    isbn,
    aiTitle,
    momoxTitle,
    status = 'momox_price_found',
    aiConfidence,
    isbnConfidence,
    cost,
    momoxPrice,
    momoxFinalUrl = null,
    momoxImageUrl = null,
    momoxDescription = null,
    momoxTitleMatchScore = null,
    momoxRawResponse = null,
}) {
    if (!adsId) {
        throw new Error('saveBookFromMomoxResult missing adsId');
    }

    if (!isbn) {
        throw new Error('saveBookFromMomoxResult missing isbn');
    }

    const safeMomoxPrice =
        momoxPrice === null || momoxPrice === undefined
            ? 0
            : Number(momoxPrice);

    if (!Number.isFinite(safeMomoxPrice)) {
        throw new Error(`saveBookFromMomoxResult invalid momoxPrice: ${momoxPrice}`);
    }

    const candidateStatus = getCandidateStatusFromMomoxStatus(status);

    const reviewStatus = getReviewStatusFromMomoxStatus({
        status,
        momoxTitleMatchScore,
    });

    const adminStatus = getAdminStatusFromMomoxResult({
        status,
        momoxPrice: safeMomoxPrice,
    });

    const withMomoxStatus = await hasMomoxStatusColumn();
    const momoxStatusLiteral = providerStatusLiteral(getProviderMomoxStatusFromGlobal(status));

    const result = await pool.query(
        `
        INSERT INTO books (
            ads_id,
            isbn,
            title,
            momox_title,
            ai_confidence,
            isbn_confidence,
            cost,
            momox_price,
            gibert_price,
            best_resale_price,
            status,
            candidate_status,
            review_status,
            admin_status,
            momox_final_url,
            momox_image_url,
            momox_description,
            momox_title_match_score,
            momox_raw_response,
            ${withMomoxStatus ? 'momox_status,' : ''}
            updated_at
        )
               VALUES (
            $1, $2, $3, $4,
            $5, $6, $7, $8,
            -- gibert_price / best_resale_price are NULL on a fresh insert: this
            -- is a Momox-only result, Gibert was NOT called here (NULL = not
            -- sent, distinct from 0 = called/no offer). ON CONFLICT leaves any
            -- existing Gibert values untouched.
            NULL, NULL,
            $9, $10, $11, $12,
            $13, $14, $15, $16, $17::jsonb,
            ${withMomoxStatus ? `${momoxStatusLiteral},` : ''}
            NOW()
        )
        ON CONFLICT (ads_id, isbn)
        DO UPDATE SET
            ${withMomoxStatus ? `momox_status = ${momoxStatusLiteral},` : ''}
            title = COALESCE(books.title, EXCLUDED.title),
            momox_title = EXCLUDED.momox_title,
            ai_confidence = COALESCE(books.ai_confidence, EXCLUDED.ai_confidence),
            isbn_confidence = COALESCE(books.isbn_confidence, EXCLUDED.isbn_confidence),
            cost = COALESCE(books.cost, EXCLUDED.cost),
            momox_price = EXCLUDED.momox_price,
            status = EXCLUDED.status,
            candidate_status = EXCLUDED.candidate_status,
            review_status = EXCLUDED.review_status,
            admin_status =
            CASE
                WHEN books.admin_status IN ('validated', 'rejected')
                    THEN books.admin_status
                ELSE EXCLUDED.admin_status
            END,
            momox_final_url = EXCLUDED.momox_final_url,
            momox_image_url = EXCLUDED.momox_image_url,
            momox_description = EXCLUDED.momox_description,
            momox_title_match_score = EXCLUDED.momox_title_match_score,
            momox_raw_response = EXCLUDED.momox_raw_response,
            profit_momox = CASE
                WHEN COALESCE(books.cost, EXCLUDED.cost) IS NOT NULL
                    THEN ROUND(COALESCE(EXCLUDED.momox_price, 0) - COALESCE(books.cost, EXCLUDED.cost), 2)
                ELSE books.profit_momox
            END,
            best_resale_price = GREATEST(COALESCE(EXCLUDED.momox_price, 0), COALESCE(books.gibert_price, 0)),
            best_resale_platform = CASE
                WHEN COALESCE(EXCLUDED.momox_price, 0) <= 0 AND COALESCE(books.gibert_price, 0) <= 0
                    THEN NULL
                WHEN COALESCE(books.gibert_price, 0) > COALESCE(EXCLUDED.momox_price, 0)
                    THEN 'gibert'
                ELSE 'momox'
            END,
            updated_at = NOW()
        RETURNING
            id,
            ads_id,
            isbn,
            title,
            momox_title,
            ai_confidence,
            isbn_confidence,
            cost,
            momox_price,
            gibert_price,
            profit_momox,
            profit_gibert,
            best_resale_price,
            best_resale_platform,
            status,
            candidate_status,
            review_status,
            admin_status,
            momox_final_url,
            momox_image_url,
            momox_description,
            momox_title_match_score,
            created_at,
            updated_at
        `,
        [
            adsId,
            isbn,
            aiTitle || null,
            momoxTitle || null,
            aiConfidence ?? null,
            isbnConfidence ?? null,
            cost ?? null,
            safeMomoxPrice,
            status,
            candidateStatus,
            reviewStatus,
            adminStatus,
            momoxFinalUrl || null,
            momoxImageUrl || null,
            momoxDescription || momoxRawResponse?.momoxDescription || null,
            momoxTitleMatchScore ?? null,
            JSON.stringify(momoxRawResponse || {}),
        ]
    );

    return result.rows[0];
}
