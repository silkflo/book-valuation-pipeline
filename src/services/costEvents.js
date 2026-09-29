// src/services/costEvents.js
//
// Shared technical cost tracking: one row per paid provider call
// (Scrapfly request, Apify run, OpenAI call, ...).
//
// Saving a cost event must NEVER block or fail the calling workflow,
// so errors are swallowed after a warning.

import { pool } from '../db.js';

let warnedMissingTable = false;
let warnedMissingUsdColumn = false;

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function roundUsd(value) {
    const n = toNumber(value, 0);
    return Number(n.toFixed(6));
}

function scrapflyUsdPerCredit() {
    return toNumber(process.env.SCRAPFLY_USD_PER_CREDIT, 0.00015);
}

/**
 * Divide a batch's Scrapfly cost across the ISBNs/books in the batch, for
 * per-book cost attribution in cost-event metadata. Returns fields ready to
 * spread into a metadata object. Does NOT emit a separate cost row (the batch
 * already records one ad-total event), so per-book division never double-counts.
 */
export function perUnitScrapflyMeta(credits, units) {
    const n = Number(units) || 0;
    // Number(null) === 0, which would mask a missing cost as 0 — guard explicitly.
    const c = credits === null || credits === undefined ? NaN : Number(credits);

    if (!n || !Number.isFinite(c)) {
        return { isbnCount: n || null, perIsbnCredits: null, perIsbnUsd: null };
    }

    return {
        isbnCount: n,
        perIsbnCredits: Number((c / n).toFixed(4)),
        perIsbnUsd: roundUsd((c * scrapflyUsdPerCredit()) / n),
    };
}

function computeAmountUsd({ amount, currency, amountUsd }) {
    if (Number.isFinite(Number(amountUsd))) {
        return roundUsd(amountUsd);
    }

    const numericAmount = toNumber(amount, null);
    if (numericAmount === null) return null;

    if (currency === 'USD') {
        return roundUsd(numericAmount);
    }

    if (currency === 'SCRAPFLY_CREDIT') {
        return roundUsd(numericAmount * scrapflyUsdPerCredit());
    }

    return null;
}

async function addCostToAdTotal(client, adsId, amountUsd) {
    if (!adsId || !Number.isFinite(Number(amountUsd)) || Number(amountUsd) <= 0) {
        return;
    }

    await client.query(
        `
        UPDATE public.ads
           SET technical_cost_usd = COALESCE(technical_cost_usd, 0) + $2,
               updated_at = NOW()
         WHERE ads_id = $1
        `,
        [String(adsId), Number(amountUsd)]
    );
}

export async function saveTechnicalCostEvent({
    adsId = null,
    bookId = null,
    costType,
    provider,
    amount,
    amountUsd = null,
    currency = 'USD',
    unitCount = null,
    unitType = null,
    metadata = {},
}) {
    if (!costType || !provider) {
        return null;
    }

    if (!Number.isFinite(Number(amount))) {
        return null;
    }

    const computedAmountUsd = computeAmountUsd({
        amount,
        currency,
        amountUsd,
    });

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const result = await client.query(
            `
            INSERT INTO public.technical_cost_events (
                ads_id,
                book_id,
                cost_type,
                provider,
                amount,
                amount_usd,
                currency,
                unit_count,
                unit_type,
                metadata,
                created_at
            )
            VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8,
                $9, $10::jsonb,
                NOW()
            )
            RETURNING id
            `,
            [
                adsId || null,
                bookId || null,
                costType,
                provider,
                Number(amount),
                computedAmountUsd,
                currency,
                unitCount ?? null,
                unitType || null,
                JSON.stringify(metadata || {}),
            ]
        );

        await addCostToAdTotal(client, adsId, computedAmountUsd);

        await client.query('COMMIT');

        return result.rows[0] || null;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { });

        const message = error?.message || '';

        const isMissingTable = /relation "technical_cost_events" does not exist/i.test(message);
        const isMissingUsdColumn = /column "amount_usd" does not exist/i.test(message);

        if (isMissingTable && !warnedMissingTable) {
            warnedMissingTable = true;
            console.warn(
                'technical_cost_events table is missing. Apply scripts/sql/technical_cost_events.sql. Cost tracking is disabled until then.'
            );
        } else if (isMissingUsdColumn && !warnedMissingUsdColumn) {
            warnedMissingUsdColumn = true;
            console.warn(
                'technical_cost_events.amount_usd is missing. Apply scripts/sql/002_technical_cost_usd.sql. USD cost tracking is disabled until then.'
            );
        } else if (!isMissingTable && !isMissingUsdColumn) {
            console.warn(
                `Failed to save technical cost event (${provider}/${costType}):`,
                error?.message || error
            );
        }

        return null;
    } finally {
        client.release();
    }
}
