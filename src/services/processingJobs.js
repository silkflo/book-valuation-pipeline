// src/services/processingJobs.js

import crypto from 'crypto';
import os from 'os';
import { pool } from '../db.js';
import { recordJobEvent } from './jobEvents.js';

const WORKER_ID = `${os.hostname()}-${process.pid}`;

function normalizePayloadItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.items)) return payload.items;
    if (payload && Array.isArray(payload.data)) return payload.data;
    return [];
}

function stableJson(value) {
    return JSON.stringify(value, Object.keys(value || {}).sort());
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function extractApifyRunInfoFromPayload(payload) {
    const items = normalizePayloadItems(payload);
    const firstItem = items[0] || {};

    return {
        runId:
            payload?.apifyRunId ||
            payload?.actorRunId ||
            firstItem.apifyRunId ||
            firstItem.actorRunId ||
            null,

        actorId:
            payload?.apifyActorId ||
            payload?.actorId ||
            firstItem.apifyActorId ||
            firstItem.actorId ||
            null,

        datasetId:
            payload?.apifyDatasetId ||
            payload?.defaultDatasetId ||
            firstItem.apifyDatasetId ||
            firstItem.defaultDatasetId ||
            null,
    };
}

export function extractAdsIdsFromPayload(payload) {
    const ids = new Set();

    for (const item of normalizePayloadItems(payload)) {
        const id = item?.adsId || item?.ads_id || item?.id;
        if (id) ids.add(String(id));
    }

    return Array.from(ids);
}

export function buildWebhookIdempotencyKey(payload) {
    const runInfo = extractApifyRunInfoFromPayload(payload);

    if (runInfo.runId) {
        return `apify-webhook-run:${runInfo.runId}`;
    }

    // Fallback for legacy actors that do not include run id.
    // Prevents duplicate HTTP retries from processing the exact same payload twice.
    return `apify-webhook-body:${sha256(stableJson(payload))}`;
}

export async function enqueueApifyPayloadProcessingJob(payload, options = {}) {
    const runInfo = extractApifyRunInfoFromPayload(payload);
    const adsIds = extractAdsIdsFromPayload(payload);
    const idempotencyKey = options.idempotencyKey || buildWebhookIdempotencyKey(payload);

    const input = {
        payload,
        source: options.source || 'webhook_apify',
        receivedAt: new Date().toISOString(),
    };

    const result = await pool.query(
        `
        INSERT INTO public.processing_jobs (
            type,
            status,
            stage,
            progress,
            idempotency_key,
            ads_id,
            input,
            apify_actor_id,
            apify_run_id,
            apify_dataset_id,
            apify_status,
            webhook_received_at,
            priority,
            updated_at
        )
        VALUES (
            'apify_payload_processing',
            'queued',
            'webhook_received',
            25,
            $1,
            $2,
            $3::jsonb,
            $4,
            $5,
            $6,
            $7,
            NOW(),
            $8,
            NOW()
        )
        ON CONFLICT (idempotency_key)
        DO UPDATE SET
            webhook_received_at = COALESCE(public.processing_jobs.webhook_received_at, NOW()),
            updated_at = NOW()
        RETURNING
            id,
            type,
            status,
            stage,
            progress,
            idempotency_key,
            ads_id,
            apify_run_id,
            created_at,
            updated_at
        `,
        [
            idempotencyKey,
            adsIds[0] || null,
            JSON.stringify(input),
            runInfo.actorId,
            runInfo.runId,
            runInfo.datasetId,
            runInfo.runId ? 'WEBHOOK_RECEIVED' : null,
            Number(options.priority || 0),
        ]
    );

    const job = result.rows[0];
    await recordJobEvent(job.id, {
        eventType: 'payload_job_queued',
        stage: 'webhook_received',
        status: job.status || 'queued',
        progress: 25,
        message: 'Apify payload processing job queued from webhook',
        metadata: { source: input.source, runId: runInfo.runId || null, adsCount: adsIds.length },
    });

    return {
        job,
        adsIds,
        runInfo,
    };
}

/**
 * Link a payload job to its originating apify_start_% job (parent). Only sets the link
 * when not already set, so webhook retries are idempotent. No-op if either id is missing.
 */
export async function attachParentJob(childJobId, parentJobId) {
    if (!childJobId || !parentJobId) return null;

    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET parent_job_id = COALESCE(parent_job_id, $2),
               updated_at = NOW()
         WHERE id = $1
        RETURNING id, parent_job_id
        `,
        [childJobId, parentJobId]
    );

    return result.rows[0] || null;
}

export async function resetStaleProcessingJobs() {
    const staleMs = Number(process.env.PROCESSING_JOB_STALE_LOCK_MS || 90 * 60 * 1000);

    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'queued',
               locked_by = NULL,
               locked_at = NULL,
               error_code = 'stale_lock_requeued',
               error_message = 'Processing job lock was stale and has been requeued.',
               next_run_at = NOW(),
               updated_at = NOW()
         WHERE type = 'apify_payload_processing'
           AND status = 'processing'
           AND locked_at IS NOT NULL
           AND locked_at < NOW() - ($1::text || ' milliseconds')::interval
           AND attempts < 3
        RETURNING id
        `,
        [String(staleMs)]
    );

    // A stale job that has ALSO exhausted its attempts is NOT requeued by the clause above
    // (attempts < 3) and would otherwise stay 'processing' + locked forever (never claimed,
    // never reset). Fail it and release the lock so it can never wedge a worker slot.
    await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'failed',
               stage = 'failed',
               progress = COALESCE(progress, 30),
               error_code = COALESCE(error_code, 'attempts_exhausted_stale_lock'),
               error_message = COALESCE(error_message, 'Stale lock with max attempts reached; failed and released.'),
               locked_by = NULL,
               locked_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE type = 'apify_payload_processing'
           AND status = 'processing'
           AND locked_at IS NOT NULL
           AND locked_at < NOW() - ($1::text || ' milliseconds')::interval
           AND attempts >= 3
        `,
        [String(staleMs)]
    );

    return result.rowCount;
}

export async function claimNextApifyPayloadProcessingJob() {
    const maxAttempts = Number(process.env.PROCESSING_JOB_MAX_ATTEMPTS || 3);

    const result = await pool.query(
        `
        WITH next_job AS (
            SELECT id
              FROM public.processing_jobs
             WHERE type = 'apify_payload_processing'
               AND status = 'queued'
               AND next_run_at <= NOW()
               AND attempts < $2
             ORDER BY priority DESC, created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
        )
        UPDATE public.processing_jobs j
           SET status = 'processing',
               stage = 'webhook_received',
               progress = GREATEST(progress, 30),
               attempts = attempts + 1,
               locked_by = $1,
               locked_at = NOW(),
               started_at = COALESCE(started_at, NOW()),
               updated_at = NOW()
          FROM next_job
         WHERE j.id = next_job.id
        RETURNING j.*
        `,
        [WORKER_ID, maxAttempts]
    );

    const job = result.rows[0] || null;
    if (job) {
        await recordJobEvent(job.id, {
            eventType: 'payload_processing_claimed',
            stage: 'webhook_received',
            status: 'processing',
            progress: 30,
            message: 'Backend worker claimed the payload job',
            metadata: { attempts: job.attempts, runId: job.apify_run_id || null },
        });
    }

    return job;
}

export async function markJobProcessed(jobId, resultPayload) {
    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'processed',
               stage = 'processed',
               progress = 100,
               result = $2::jsonb,
               -- Clear any stale error from an earlier requeue (e.g. stale_lock_requeued):
               -- the job actually completed, so it must not look failed to the UI.
               error_code = NULL,
               error_message = NULL,
               locked_by = NULL,
               locked_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE id = $1
        RETURNING id, status, stage, progress
        `,
        [jobId, JSON.stringify(resultPayload || {})]
    );

    const wf = resultPayload?.processResult?.workflow || {};
    await recordJobEvent(jobId, {
        eventType: 'payload_processing_completed',
        stage: 'processed',
        status: 'processed',
        progress: 100,
        message: 'Payload processing completed',
        // Compact result summary (no per-ad spam, no raw payload).
        metadata: {
            adsProcessed: wf.adsProcessed ?? resultPayload?.processResult?.adsProcessed ?? null,
            booksDetected: wf.booksDetected ?? null,
            booksAccepted: wf.booksAccepted ?? null,
            momoxTriggered: wf.momoxTriggered ?? null,
            gibertTriggered: wf.gibertTriggered ?? null,
        },
    });

    return result.rows[0] || null;
}

export async function markJobFailed(jobId, error, options = {}) {
    const retry = options.retry === true;
    const retryDelayMs = Number(options.retryDelayMs || 60_000);

    const status = retry ? 'queued' : 'failed';
    const stage = retry ? 'queued' : 'failed';

    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = $2,
               stage = $3,
               error_code = $4,
               error_message = $5,
               locked_by = NULL,
               locked_at = NULL,
               next_run_at = CASE
                   WHEN $6::boolean THEN NOW() + ($7::text || ' milliseconds')::interval
                   ELSE next_run_at
               END,
               finished_at = CASE
                   WHEN $6::boolean THEN finished_at
                   ELSE NOW()
               END,
               updated_at = NOW()
         WHERE id = $1
        RETURNING id, status, stage, progress, error_message
        `,
        [
            jobId,
            status,
            stage,
            options.errorCode || 'processing_failed',
            String(error?.message || error || 'Unknown processing error').slice(0, 2000),
            retry,
            String(retryDelayMs),
        ]
    );

    await recordJobEvent(jobId, {
        eventType: retry ? 'payload_processing_retried' : 'payload_processing_failed',
        stage,
        status,
        severity: 'error',
        message: retry ? 'Payload processing failed; will retry' : 'Payload processing failed permanently',
        errorCode: options.errorCode || 'processing_failed',
        errorMessage: String(error?.message || error || 'Unknown processing error'),
        metadata: { willRetry: retry },
    });

    return result.rows[0] || null;
}

export async function updateJobProgress(jobId, { stage, progress, status = null, resultPatch = null }) {
    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET stage = COALESCE($2, stage),
               progress = COALESCE($3, progress),
               status = COALESCE($4, status),
               result = CASE
                   WHEN $5::jsonb IS NULL THEN result
                   ELSE result || $5::jsonb
               END,
               updated_at = NOW()
         WHERE id = $1
        RETURNING id, status, stage, progress
        `,
        [
            jobId,
            stage || null,
            Number.isInteger(progress) ? progress : null,
            status || null,
            resultPatch ? JSON.stringify(resultPatch) : null,
        ]
    );

    return result.rows[0] || null;
}

export async function getJobsStatus({ limit = 50 } = {}) {
    const countsResult = await pool.query(
        `
        SELECT status, COUNT(*)::int AS count
          FROM public.processing_jobs
         GROUP BY status
         ORDER BY status
        `
    );

    const jobsResult = await pool.query(
        `
        SELECT
            id,
            parent_job_id,
            type,
            status,
            stage,
            progress,
            ads_id,
            leboncoin_url,
            apify_actor_id,
            apify_run_id,
            apify_dataset_id,
            apify_status,
            error_code,
            error_message,
            attempts,
            created_at,
            updated_at,
            started_at,
            finished_at,
            webhook_received_at
        FROM public.processing_jobs
        ORDER BY updated_at DESC
        LIMIT $1
        `,
        [Math.max(1, Math.min(Number(limit) || 50, 200))]
    );

    return {
        counts: countsResult.rows.reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
        }, {}),
        jobs: jobsResult.rows,
    };
}
