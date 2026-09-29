// src/services/providerImageVerifyForAd.js
//
// Orchestrates provider IMAGE verification for one ad (Phase B, step 5):
//   - selects the rows worth verifying, in priority order, under a per-ad cap
//   - runs verifyProviderImageForRow on each (Momox image first, then Gibert)
//   - persists provider_match_status / provider_image_match_score /
//     provider_match_reason / provider_match_source and recomputes backend_status
//   - records one OpenAI cost event per verification
//
// Feature-detects the Phase B columns: if scripts/sql/003_resale_strategy_fields.sql
// is not applied yet, it logs once and no-ops (never throws).

import { pool } from '../db.js';
import { verifyProviderImageForRow, isProviderImageVerifyEnabled } from './verifyProviderImage.js';
import { updateMomoxPricesForAd } from './updateMomoxBatch.js';
import { updateGibertPricesForAd } from './updateGibertBatch.js';
import { saveTechnicalCostEvent } from './costEvents.js';
import { hasBooksColumn, hasMomoxStatusColumn, providerStatusLiteral, safeTextLiteral } from './bookColumns.js';
import { deriveMomoxState, deriveGibertState, deriveBackendStatus } from './adStatus.js';

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function cleanIsbn(value) {
    const c = String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    return c || null;
}

// Normalize ISBN-10 -> ISBN-13 so alternative-candidate dedupe is consistent.
function toIsbn13(value) {
    const c = cleanIsbn(value);
    if (!c) return null;
    if (c.length === 13) return c;
    if (c.length === 10) {
        const core = '978' + c.slice(0, 9);
        let sum = 0;
        for (let i = 0; i < 12; i += 1) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
        return core + String((10 - (sum % 10)) % 10);
    }
    return c;
}

// Priority order (point 8). Higher = verified first. -1 = skip (no image AND no price).
function verifyPriority(row) {
    const hasImage = Boolean(row.momox_image_url || row.gibert_image_url);
    const hasPrice = num(row.momox_price) > 0 || num(row.gibert_price) > 0;

    if (!hasImage && !hasPrice) return -1;

    if (hasPrice) {
        // Rows where Momox and Gibert disagree a lot are the riskiest (price variance).
        const variance = Math.abs(num(row.momox_price) - num(row.gibert_price));
        return 100 + Math.min(20, Math.round(variance));
    }

    if (['duplicate_alternative', 'alternative_edition'].includes(String(row.candidate_status))) {
        return 80;
    }
    if (['medium_candidate', 'weak_candidate'].includes(String(row.candidate_status))) {
        return 60;
    }
    return 40;
}

function getCap() {
    return Math.min(
        Math.max(Number(process.env.PROVIDER_IMAGE_VERIFY_MAX_PER_AD || 10), 0),
        50
    );
}

export async function verifyProviderImagesForAd({ adsId, limit = null } = {}) {
    if (!adsId) throw new Error('verifyProviderImagesForAd missing adsId');

    if (!isProviderImageVerifyEnabled()) {
        console.log(`[ad ${adsId}] image-verify: disabled (ENABLE_PROVIDER_IMAGE_VERIFY=false or no OPENAI_API_KEY).`);
        return { adsId, ok: true, skipped: true, reason: 'disabled', verified: 0, rows: [] };
    }

    const withMatchCols = await hasBooksColumn('provider_match_status');
    if (!withMatchCols) {
        console.warn(`[ad ${adsId}] image-verify: provider_match_* columns missing (apply 003_resale_strategy_fields.sql). Skipping.`);
        return { adsId, ok: true, skipped: true, reason: 'columns_missing', verified: 0, rows: [] };
    }

    const withMomoxStatus = await hasMomoxStatusColumn();
    const withBackendStatus = await hasBooksColumn('backend_status');
    const withVisualSim = await hasBooksColumn('provider_visual_similarity_score');
    const withConfidence = await hasBooksColumn('provider_match_confidence');

    const rowsResult = await pool.query(
        `
        SELECT
            id, ads_id, isbn, title, lookup_title,
            source_image_url, bbox, orientation,
            momox_price, gibert_price, momox_image_url, gibert_image_url,
            momox_title, gibert_title,
            ${withMomoxStatus ? 'momox_status,' : 'NULL::text AS momox_status,'}
            gibert_status, gibert_checked_at,
            status, candidate_status, admin_status, provider_match_status
        FROM books
        WHERE ads_id = $1
          AND isbn IS NOT NULL
        ORDER BY id ASC
        `,
        [adsId]
    );

    const cap = limit ? Math.min(Number(limit), getCap()) : getCap();

    const candidates = rowsResult.rows
        .map((row) => ({ row, priority: verifyPriority(row) }))
        .filter((entry) => entry.priority >= 0)
        // Don't re-verify rows already resolved to a confident match/mismatch.
        .filter((entry) => !['match', 'mismatch'].includes(String(entry.row.provider_match_status)))
        .sort((a, b) => b.priority - a.priority)
        .slice(0, cap);

    if (!candidates.length) {
        console.log(`[ad ${adsId}] image-verify: no rows to verify (cap=${cap}).`);
        return { adsId, ok: true, verified: 0, rows: [] };
    }

    console.log(
        `[ad ${adsId}] image-verify: verifying ${candidates.length} row(s) (cap=${cap}) in priority order.`
    );

    const bufferCache = new Map(); // dedupe source-image downloads across rows of the ad
    const verifiedRows = [];
    const byStatus = {};

    for (const { row } of candidates) {
        let result;
        try {
            result = await verifyProviderImageForRow(
                {
                    source_image_url: row.source_image_url,
                    bbox: row.bbox,
                    orientation: row.orientation,
                    detectedTitle: row.lookup_title || row.title,
                    momox_image_url: row.momox_image_url,
                    gibert_image_url: row.gibert_image_url,
                    momox_title: row.momox_title,
                    gibert_title: row.gibert_title,
                    momox_price: row.momox_price,
                    gibert_price: row.gibert_price,
                },
                { bufferCache }
            );
        } catch (error) {
            console.warn(`[ad ${adsId}] image-verify row ${row.id} failed: ${error?.message || error}`);
            continue;
        }

        if (result.costEvent) {
            await saveTechnicalCostEvent({ adsId, bookId: row.id, ...result.costEvent });
        }

        // Recompute backend_status with the fresh provider_match_status.
        const enrichedRow = { ...row, provider_match_status: result.provider_match_status };
        const momoxState = deriveMomoxState(enrichedRow, withMomoxStatus);
        const gibertState = deriveGibertState(enrichedRow);
        const backendStatus = deriveBackendStatus(enrichedRow, momoxState, gibertState);

        await pool.query(
            `
            UPDATE books
            SET
                provider_match_status = $2,
                provider_image_match_score = $3,
                provider_match_reason = $4,
                provider_match_source = $5,
                ${withVisualSim ? 'provider_visual_similarity_score = $6,' : ''}
                ${withConfidence ? 'provider_match_confidence = $7,' : ''}
                ${withBackendStatus ? `backend_status = ${safeTextLiteral(backendStatus)},` : ''}
                updated_at = NOW()
            WHERE id = $1
            `,
            [
                row.id,
                result.provider_match_status,
                result.provider_image_match_score,
                result.provider_match_reason,
                result.provider_match_source,
                result.provider_visual_similarity_score ?? null,
                result.provider_match_confidence ?? null,
            ]
        );

        byStatus[result.provider_match_status] = (byStatus[result.provider_match_status] || 0) + 1;

        verifiedRows.push({
            id: row.id,
            isbn: row.isbn,
            provider_match_status: result.provider_match_status,
            provider_visual_similarity_score: result.provider_visual_similarity_score ?? null,
            provider_match_confidence: result.provider_match_confidence ?? null,
            provider_match_source: result.provider_match_source,
            backend_status: backendStatus,
        });

        // Log similarity and confidence SEPARATELY (Finding 3): a mismatch can
        // be low-similarity yet high-confidence.
        console.log(
            `[ad ${adsId}] image-verify book id=${row.id} isbn=${row.isbn} -> ${result.provider_match_status}` +
            ` similarity=${result.provider_visual_similarity_score ?? '-'} confidence=${result.provider_match_confidence ?? '-'}` +
            ` source=${result.provider_match_source} backend=${backendStatus}`
        );
    }

    console.log(
        `[ad ${adsId}] image-verify done: verified=${verifiedRows.length}, byStatus=${JSON.stringify(byStatus)}`
    );

    return { adsId, ok: true, verified: verifiedRows.length, byStatus, rows: verifiedRows };
}

/**
 * Mismatch fallback (Phase B, step 6): when a provider image MISMATCHED, the
 * provider priced the wrong edition. Create rows for untried alternative ISBNs
 * from that book's lookup_candidates, price them on Momox/Gibert, so the next
 * verification pass can confirm a correct edition. Bounded and idempotent.
 *
 * @returns {Promise<{adsId, createdIsbns: string[], pricedMomox: boolean, pricedGibert: boolean}>}
 */
export async function tryProviderAlternativesForAd({ adsId }) {
    if (!adsId) throw new Error('tryProviderAlternativesForAd missing adsId');

    if (process.env.ENABLE_PROVIDER_ALTERNATIVE_FALLBACK === 'false') {
        return { adsId, createdIsbns: [], skipped: true, reason: 'disabled' };
    }

    // Tight, dedicated caps (Finding 4). The old AI_ISBN_CANDIDATES_MAX_PER_BOOK
    // / PROVIDER_ISBNS_MAX_PER_AD are honored as back-compat fallbacks.
    const maxPerBook = Math.min(
        Math.max(Number(process.env.MISMATCH_FALLBACK_MAX_ALTERNATIVES_PER_BOOK ?? process.env.AI_ISBN_CANDIDATES_MAX_PER_BOOK ?? 2), 0),
        5
    );
    const maxPerAd = Math.min(
        Math.max(Number(process.env.MISMATCH_FALLBACK_MAX_TOTAL_PER_AD ?? 4), 0),
        20
    );

    if (maxPerBook === 0 || maxPerAd === 0) {
        return { adsId, createdIsbns: [], skipped: true, reason: 'cap_zero' };
    }

    // Only run the fallback for mismatched rows where a provider PRICE was found
    // (the wrong-edition-priced case): momox_price > 0 OR gibert_price > 0. A
    // mismatch with no offer is not worth pricing more alternatives.
    const mismatchRes = await pool.query(
        `
        SELECT id, isbn, title, lookup_title, lookup_candidates,
               source_image_url, bbox, orientation, image_index, cost,
               momox_price, gibert_price
        FROM books
        WHERE ads_id = $1
          AND provider_match_status = 'mismatch'
          AND (COALESCE(momox_price, 0) > 0 OR COALESCE(gibert_price, 0) > 0)
        ORDER BY id ASC
        `,
        [adsId]
    );

    if (!mismatchRes.rows.length) {
        return { adsId, createdIsbns: [], skipped: true, reason: 'no_priced_mismatches' };
    }

    // ISBNs already present in this ad (normalized) — never duplicate a row.
    const existingRes = await pool.query(
        `SELECT isbn FROM books WHERE ads_id = $1 AND isbn IS NOT NULL`,
        [adsId]
    );
    const existing = new Set(existingRes.rows.map((r) => toIsbn13(r.isbn)).filter(Boolean));

    const withMomoxStatus = await hasMomoxStatusColumn();
    const withSelectedIsbn = await hasBooksColumn('selected_isbn');

    const createdIsbns = [];

    for (const parent of mismatchRes.rows) {
        if (createdIsbns.length >= maxPerAd) break;

        // Only EXACT-title alternative editions — never expand to loose
        // work matches ("365 Jours Solar - Voitures Extraordinaires", ...).
        const candidates = (Array.isArray(parent.lookup_candidates) ? parent.lookup_candidates : [])
            .filter((c) => c?.exactTitleMatch || c?.articleInsensitiveTitleMatch);
        let perBook = 0;

        for (const candidate of candidates) {
            if (perBook >= maxPerBook || createdIsbns.length >= maxPerAd) break;

            const isbn13 = toIsbn13(candidate?.isbn13 || candidate?.isbn || candidate?.isbn10);
            if (!isbn13 || existing.has(isbn13)) continue;

            existing.add(isbn13);
            perBook += 1;

            // Minimal alternative row: enough for providers (isbn) + image
            // verification (image/bbox/orientation/title), inherited from parent.
            await pool.query(
                `
                INSERT INTO books (
                    ads_id, isbn, title, lookup_title,
                    momox_price, gibert_price, best_resale_price,
                    cost, source_image_url, bbox, orientation, image_index,
                    status, candidate_status, review_status, admin_status,
                    isbn_is_valid, isbn_source,
                    gibert_status${withMomoxStatus ? ', momox_status' : ''}${withSelectedIsbn ? ', selected_isbn, selected_isbn_source' : ''},
                    created_at, updated_at
                )
                VALUES (
                    $1, $2, $3, $4,
                    0, 0, 0,
                    $5, $6, $7::jsonb, $8, $9,
                    'isbn_alternative_candidate', 'alternative_edition', 'manual_review', 'pending_edition_choice',
                    true, 'image_mismatch_alternative',
                    'gibert_pending'${withMomoxStatus ? `, 'momox_pending'` : ''}${withSelectedIsbn ? `, $2, 'image_mismatch_alternative'` : ''},
                    NOW(), NOW()
                )
                ON CONFLICT (ads_id, isbn) DO NOTHING
                `,
                [
                    adsId,
                    isbn13,
                    candidate?.title || parent.lookup_title || parent.title || null,
                    candidate?.title || parent.lookup_title || null,
                    parent.cost ?? null,
                    parent.source_image_url || null,
                    parent.bbox ? JSON.stringify(parent.bbox) : null,
                    parent.orientation || null,
                    parent.image_index ?? null,
                ]
            );

            createdIsbns.push(isbn13);
        }
    }

    if (!createdIsbns.length) {
        console.log(`[ad ${adsId}] mismatch-fallback: no untried alternatives to create.`);
        return { adsId, createdIsbns: [], pricedMomox: false, pricedGibert: false };
    }

    console.log(
        `[ad ${adsId}] mismatch-fallback: created ${createdIsbns.length} alternative row(s): ${createdIsbns.join(', ')}. Pricing on providers...`
    );

    let pricedMomox = false;
    let pricedGibert = false;

    try {
        await updateMomoxPricesForAd({ adsId, isbns: createdIsbns, limit: createdIsbns.length });
        pricedMomox = true;
    } catch (error) {
        console.error(`[ad ${adsId}] mismatch-fallback Momox failed:`, error?.message || error);
    }

    try {
        await updateGibertPricesForAd({ adsId, isbns: createdIsbns, limit: createdIsbns.length });
        pricedGibert = true;
    } catch (error) {
        console.error(`[ad ${adsId}] mismatch-fallback Gibert failed:`, error?.message || error);
    }

    return { adsId, createdIsbns, pricedMomox, pricedGibert };
}
