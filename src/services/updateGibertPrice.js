//src\services\updateGibertPrice.js
// src/services/updateGibertPrice.js

import { pool } from '../db.js';
import { lookupGibertPriceByIsbn } from './gibertScrapflyService.js';
import { saveTechnicalCostEvent } from './costEvents.js';

function parsePrice(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function pickBestResalePlatform({ momoxPrice, gibertPrice }) {
    const momox = parsePrice(momoxPrice);
    const gibert = parsePrice(gibertPrice);

    if (momox <= 0 && gibert <= 0) return null;
    if (gibert > momox) return 'gibert';

    return 'momox';
}

export async function updateGibertPriceForBookRow(book) {
    if (!book?.id) {
        throw new Error('updateGibertPriceForBookRow missing book.id');
    }

    if (!book?.ads_id) {
        throw new Error('updateGibertPriceForBookRow missing book.ads_id');
    }

    if (!book?.isbn) {
        throw new Error('updateGibertPriceForBookRow missing book.isbn');
    }

    const lookup = await lookupGibertPriceByIsbn({
        isbn: book.isbn,
        adsId: book.ads_id,
        bookId: book.id,
    });

    if (lookup.scrapflyCost !== null && lookup.scrapflyCost !== undefined) {
        await saveTechnicalCostEvent({
            adsId: book.ads_id,
            bookId: book.id,
            costType: 'gibert_lookup',
            provider: 'scrapfly',
            amount: Number(lookup.scrapflyCost),
            currency: 'SCRAPFLY_CREDIT',
            unitCount: 1,
            unitType: 'isbn',
            metadata: {
                isbn: book.isbn,
                ok: lookup.ok,
                requestId: lookup.requestId || null,
                logUrl: lookup.logUrl || null,
                statusCode: lookup.statusCode || null,
                reason: lookup.reason || null,
            },
        });
    }

    // Failure keeps gibert_price NULL (retryable); success writes a numeric
    // price (0 = checked, no offer) plus explicit status and checked_at.
    const gibertPrice = lookup.ok ? Number(lookup.gibertPrice) : null;

    const gibertStatus = !lookup.ok
        ? 'gibert_failed'
        : gibertPrice > 0
            ? 'gibert_price_found'
            : 'gibert_non_repris';

    const momoxPrice = parsePrice(book.momox_price);
    const bestPlatform = pickBestResalePlatform({
        momoxPrice,
        gibertPrice: gibertPrice ?? 0,
    });

    const bestPrice =
        bestPlatform === 'gibert'
            ? gibertPrice
            : bestPlatform === 'momox'
                ? momoxPrice
                : 0;

    const cost = book.cost === null || book.cost === undefined ? null : Number(book.cost);
    const profitGibert =
        gibertPrice !== null && Number.isFinite(cost)
            ? Number((gibertPrice - cost).toFixed(2))
            : null;

    const result = await pool.query(
        `
        UPDATE books
        SET
            gibert_price = COALESCE($1::numeric, gibert_price),
            gibert_status = $6,
            gibert_checked_at = CASE WHEN $1::numeric IS NULL THEN gibert_checked_at ELSE NOW() END,
            profit_gibert = CASE WHEN $1::numeric IS NULL THEN profit_gibert ELSE $2 END,
            best_resale_price = CASE WHEN $1::numeric IS NULL THEN best_resale_price ELSE $3 END,
            best_resale_platform = CASE WHEN $1::numeric IS NULL THEN best_resale_platform ELSE $4 END,
            status = CASE
                WHEN $1::numeric > 0 THEN 'gibert_price_found'
                ELSE status
            END,
            candidate_status = CASE
                WHEN $1::numeric > 0 THEN 'resale_price_found'
                ELSE candidate_status
            END,
            admin_status = CASE
                WHEN $1::numeric > 0 AND admin_status NOT IN ('validated', 'rejected')
                    THEN 'new'
                ELSE admin_status
            END,
            updated_at = NOW()
        WHERE id = $5
        RETURNING
            id,
            ads_id,
            isbn,
            title,
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
            updated_at
        `,
        [
            gibertPrice,
            profitGibert,
            bestPrice,
            bestPlatform,
            book.id,
            gibertStatus,
        ]
    );

    return {
        lookup,
        row: result.rows[0],
    };
}

export async function updateGibertPriceForAd({ adsId, limit = 10 }) {
    if (!adsId) {
        throw new Error('updateGibertPriceForAd missing adsId');
    }

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
            profit_momox,
            profit_gibert,
            best_resale_price,
            best_resale_platform,
            status,
            candidate_status,
            admin_status
        FROM books
        WHERE ads_id = $1
          AND isbn IS NOT NULL
          AND COALESCE(gibert_price, 0) = 0
        ORDER BY id ASC
        LIMIT $2
        `,
        [adsId, limit]
    );

    const rows = [];

    for (const book of booksResult.rows) {
        const result = await updateGibertPriceForBookRow(book);
        rows.push(result);
    }

    return {
        adsId,
        attempted: booksResult.rows.length,
        rows,
    };
}
