// src/services/providerPriceJobs.js
//
// Persistent queue data layer for ASYNC manual provider price lookups. The admin endpoint
// enqueues a row (returns 202 immediately); providerPriceWorker claims + processes them
// FIFO, one at a time, through the existing Momox/Gibert updaters + providerLookupLimiter.
// The `provider_price_jobs` table (migration 010) is feature-detected so the endpoint
// degrades gracefully (falls back to synchronous) until the migration is applied.

import os from 'node:os';
import { pool } from '../db.js';

export const PROVIDER_PRICE_WORKER_ID = `${os.hostname()}-${process.pid}`;

function maxAttempts() {
    return Math.max(1, Number(process.env.PROVIDER_PRICE_MAX_ATTEMPTS || 2));
}

let tablePresent = null; // cached
export async function hasProviderPriceJobsTable() {
    if (tablePresent !== null) return tablePresent;
    try {
        const { rows } = await pool.query(
            `SELECT to_regclass('public.provider_price_jobs') IS NOT NULL AS present`
        );
        tablePresent = Boolean(rows[0]?.present);
    } catch {
        tablePresent = false;
    }
    return tablePresent;
}

/**
 * Enqueue a provider-price job for a book. The partial unique index guarantees at most one
 * ACTIVE (queued|running) job per book, so a duplicate click reuses the active job instead
 * of creating another. Returns { job, alreadyQueued }.
 */
export async function enqueueProviderPriceJob({ bookId, adsId = null, isbn = null, providers = null, requestedByName = null, requestedByUserId = null } = {}) {
    const prov = Array.isArray(providers) && providers.length ? providers : ['momox', 'gibert'];

    const inserted = await pool.query(
        `
        INSERT INTO public.provider_price_jobs
            (book_id, ads_id, isbn, requested_providers, status, max_attempts, requested_by_name, requested_by_user_id)
        VALUES ($1, $2, $3, $4::text[], 'queued', $5, $6, $7)
        ON CONFLICT (book_id) WHERE status IN ('queued', 'running')
        DO NOTHING
        RETURNING *
        `,
        [bookId, adsId, isbn, prov, maxAttempts(), requestedByName, requestedByUserId]
    );

    if (inserted.rows[0]) {
        return { job: inserted.rows[0], alreadyQueued: false };
    }

    // Conflict: an active job already exists for this book — return it.
    const active = await getActiveProviderPriceJob(bookId);
    return { job: active, alreadyQueued: true };
}

export async function getActiveProviderPriceJob(bookId) {
    const { rows } = await pool.query(
        `SELECT * FROM public.provider_price_jobs
          WHERE book_id = $1 AND status IN ('queued', 'running')
          ORDER BY id DESC LIMIT 1`,
        [bookId]
    );
    return rows[0] || null;
}

// Atomically claim the oldest queued job (FIFO). FOR UPDATE SKIP LOCKED so concurrent
// workers never grab the same row. Returns the claimed job row or null.
export async function claimNextProviderPriceJob() {
    const { rows } = await pool.query(
        `
        WITH next_job AS (
            SELECT id
              FROM public.provider_price_jobs
             WHERE status = 'queued'
               AND attempts < max_attempts
             ORDER BY created_at ASC, id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
        )
        UPDATE public.provider_price_jobs j
           SET status = 'running',
               stage = 'running',
               attempts = attempts + 1,
               locked_by = $1,
               locked_at = NOW(),
               started_at = COALESCE(started_at, NOW()),
               updated_at = NOW()
          FROM next_job
         WHERE j.id = next_job.id
        RETURNING j.*
        `,
        [PROVIDER_PRICE_WORKER_ID]
    );
    return rows[0] || null;
}

export async function markProviderPriceJobProcessed(jobId, result = null) {
    const { rows } = await pool.query(
        `
        UPDATE public.provider_price_jobs
           SET status = 'processed',
               stage = 'processed',
               error_code = NULL,
               error_message = NULL,
               result = $2::jsonb,
               locked_by = NULL,
               locked_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE id = $1
        RETURNING id, status
        `,
        [jobId, result ? JSON.stringify(result) : null]
    );
    return rows[0] || null;
}

// retry=true -> back to 'queued' (no finished_at); retry=false -> terminal 'failed'.
export async function markProviderPriceJobOutcome(jobId, { retry, errorCode = null, errorMessage = null } = {}) {
    const { rows } = await pool.query(
        `
        UPDATE public.provider_price_jobs
           SET status = $2::text,
               stage = $3::text,
               error_code = $4::text,
               error_message = $5::text,
               locked_by = NULL,
               locked_at = NULL,
               finished_at = CASE WHEN $2 = 'failed' THEN NOW() ELSE finished_at END,
               updated_at = NOW()
         WHERE id = $1
        RETURNING id, status
        `,
        [
            jobId,
            retry ? 'queued' : 'failed',
            retry ? 'retry_scheduled' : 'failed',
            errorCode ? String(errorCode).slice(0, 200) : null,
            errorMessage ? String(errorMessage).slice(0, 2000) : null,
        ]
    );
    return rows[0] || null;
}

// Requeue (or fail) jobs whose worker lock went stale (process restart / crash).
export async function resetStaleProviderPriceJobs(staleMs) {
    const ms = Math.max(60_000, Number(staleMs) || 900_000);
    const { rowCount } = await pool.query(
        `
        UPDATE public.provider_price_jobs
           SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
               stage = 'stale_reset',
               locked_by = NULL,
               locked_at = NULL,
               error_code = COALESCE(error_code, 'provider_price_stale_lock'),
               error_message = COALESCE(error_message, 'Worker lock was stale; requeued or failed.'),
               finished_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE finished_at END,
               updated_at = NOW()
         WHERE status = 'running'
           AND locked_at IS NOT NULL
           AND locked_at < NOW() - ($1::text || ' milliseconds')::interval
        RETURNING id
        `,
        [String(ms)]
    );
    return rowCount;
}

// Latest job per requested book id (for the status endpoint). Returns a Map<bookId, row>.
export async function getProviderPriceJobsForBooks(bookIds) {
    const ids = (Array.isArray(bookIds) ? bookIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return new Map();
    const { rows } = await pool.query(
        `
        SELECT DISTINCT ON (book_id)
               book_id, id, status, stage, error_code, error_message, updated_at
          FROM public.provider_price_jobs
         WHERE book_id = ANY($1::bigint[])
         ORDER BY book_id, id DESC
        `,
        [ids]
    );
    return new Map(rows.map((r) => [Number(r.book_id), r]));
}
