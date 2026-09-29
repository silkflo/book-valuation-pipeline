// src/services/jobWorkers.js

import { pool } from '../db.js';
import { processApifyPayload } from '../workflows/processApifyPayload.js';
import { queueApifyRunCostCapture } from './apifyCost.js';
import {
    claimNextApifyPayloadProcessingJob,
    markJobProcessed,
    resetStaleProcessingJobs,
    updateJobProgress,
} from './processingJobs.js';
import { recordJobEvent } from './jobEvents.js';

let started = false;
let running = 0;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function maxConcurrency() {
    return Math.max(1, Number(process.env.AD_PROCESSING_MAX_CONCURRENCY || 1));
}

function pollIntervalMs() {
    return Math.max(500, Number(process.env.JOB_WORKER_POLL_INTERVAL_MS || 1500));
}

// Map a payload-processing error to a stable error_code (best-effort classification).
export function normalizePayloadJobError(error) {
    const message = error?.message || String(error || 'Unknown error');
    let code = 'apify_payload_processing_failed';
    if (/timestamp|invalid input syntax for type timestamp/i.test(message)) code = 'invalid_payload_timestamp';
    else if (/unsupported.*mode|unknown.*mode/i.test(message)) code = 'unsupported_webhook_mode';
    else if (/duplicate key|unique constraint/i.test(message)) code = 'duplicate_payload';
    else if (/timeout/i.test(message)) code = 'payload_processing_timeout';
    return { code, message: message.slice(0, 2000) };
}

// Isolated, NON-THROWING failure handler: a single bad job must never escape the worker
// loop, never stay 'processing', never keep its lock, and never set progress NULL (the
// column is NOT NULL -> COALESCE(progress, 30)). Retries while attempts remain, else fails.
async function failPayloadJobSafely(job, error) {
    const { code, message } = normalizePayloadJobError(error);
    const attempts = Number(job.attempts || 0); // already incremented at claim time
    const maxAttempts = Number(process.env.PROCESSING_JOB_MAX_ATTEMPTS || 3);
    const retry = attempts < maxAttempts;
    const retryDelayMs = Math.min(10 * 60_000, 30_000 * Math.max(1, attempts));

    try {
        if (retry) {
            await pool.query(
                `
                UPDATE public.processing_jobs
                   SET status = 'queued',
                       stage = 'queued',
                       progress = COALESCE(progress, 30),
                       error_code = $2::text,
                       error_message = $3::text,
                       locked_by = NULL,
                       locked_at = NULL,
                       next_run_at = NOW() + ($4::text || ' milliseconds')::interval,
                       updated_at = NOW()
                 WHERE id = $1::bigint
                   AND status IN ('queued', 'processing')
                `,
                [job.id, code, message, String(retryDelayMs)]
            );
        } else {
            await pool.query(
                `
                UPDATE public.processing_jobs
                   SET status = 'failed',
                       stage = 'failed',
                       progress = COALESCE(progress, 30),
                       error_code = $2::text,
                       error_message = $3::text,
                       locked_by = NULL,
                       locked_at = NULL,
                       finished_at = NOW(),
                       updated_at = NOW()
                 WHERE id = $1::bigint
                   AND status IN ('queued', 'processing')
                `,
                [job.id, code, message]
            );
        }
    } catch (updateError) {
        console.error(`[payload-worker] failPayloadJobSafely UPDATE failed job=${job.id}:`, updateError?.message || updateError);
        // Last resort: never leave the job 'processing' + locked, even if the rich update failed.
        try {
            await pool.query(
                `UPDATE public.processing_jobs
                    SET status = 'failed', stage = 'failed', progress = COALESCE(progress, 30),
                        locked_by = NULL, locked_at = NULL, finished_at = NOW(), updated_at = NOW()
                  WHERE id = $1::bigint AND status = 'processing'`,
                [job.id]
            );
        } catch (releaseError) {
            console.error(`[payload-worker] bare lock release failed job=${job.id}:`, releaseError?.message || releaseError);
        }
    }

    // Timeline event (recordJobEvent is itself non-throwing / self-disables if the table is absent).
    try {
        await recordJobEvent(job.id, {
            eventType: 'payload_processing_failed_isolated',
            stage: 'failed',
            status: retry ? 'queued' : 'failed',
            severity: 'error',
            progress: Number(job.progress) || 30,
            errorCode: code,
            errorMessage: message,
            metadata: {
                isolatedFailure: true,
                willRetry: retry,
                jobType: job.type || null,
                apifyRunId: job.apify_run_id || null,
            },
        });
    } catch (eventError) {
        console.error(`[payload-worker] isolated-failure event failed job=${job.id}:`, eventError?.message || eventError);
    }
}

async function runJob(job) {
    running += 1;

    try {
        const payload = job.input?.payload || job.input;

        console.log(
            `[job-worker] processing job=${job.id} type=${job.type} attempt=${job.attempts} apifyRun=${job.apify_run_id || '-'}`
        );

        // Started: move the main job row to 30 / stage=processing (the loading bar).
        await updateJobProgress(job.id, {
            status: 'processing',
            stage: 'processing',
            progress: 30,
        });

        await recordJobEvent(job.id, {
            eventType: 'payload_processing_started',
            stage: 'processing',
            status: 'processing',
            progress: 30,
            message: 'Backend payload processing started',
            metadata: { runId: job.apify_run_id || null, attempt: job.attempts },
        });

        // High-level phase hooks. processApifyPayload calls onProgress at coarse phase
        // boundaries (per ad). We keep the ROW progress MONOTONIC (no regression across a
        // multi-ad payload) and emit each phase EVENT at most once (no per-ad/per-loop spam).
        let maxProgress = 30;
        const seenPhases = new Set();
        const onProgress = async ({ eventType, stage, progress } = {}) => {
            try {
                const p = Number(progress);
                if (Number.isInteger(p) && p > maxProgress) {
                    maxProgress = p;
                    await updateJobProgress(job.id, { stage: stage || null, progress: p, status: 'processing' });
                }
                if (eventType && !seenPhases.has(eventType)) {
                    seenPhases.add(eventType);
                    await recordJobEvent(job.id, {
                        eventType, stage: stage || null, status: 'processing',
                        progress: Number.isInteger(p) ? p : null,
                        parentJobId: job.parent_job_id || null,
                    });
                }
            } catch { /* progress reporting must never break processing */ }
        };

        const result = await processApifyPayload(payload, { onProgress });

        const apifyCostCapture = queueApifyRunCostCapture({
            payload,
            result,
        });

        await markJobProcessed(job.id, {
            processResult: result,
            apifyCostCapture,
        });

        console.log(
            `[job-worker] processed job=${job.id} adsProcessed=${result?.adsProcessed ?? '-'} apifyCostQueued=${apifyCostCapture?.queued ?? false}`
        );
    } catch (error) {
        // Job-level isolation: log + safely fail/retry this ONE job; never rethrow, so the
        // worker loop keeps processing the rest of the queue.
        console.error(`[payload-worker] job ${job.id} failed but worker will continue:`, error);
        await failPayloadJobSafely(job, error);
    } finally {
        running -= 1;
    }
}

async function tick() {
    // Stale-lock recovery is isolated: if it ever throws, we MUST still proceed to claim
    // (a throwing stale-reset previously aborted the whole tick -> the entire queue stalled).
    try {
        await resetStaleProcessingJobs();
    } catch (error) {
        console.error('[job-worker] stale-lock reset failed (continuing to claim):', error);
    }

    try {
        while (running < maxConcurrency()) {
            const job = await claimNextApifyPayloadProcessingJob();
            if (!job) break;

            runJob(job).catch((error) => {
                console.error('[job-worker] unhandled job error:', error);
            });

            // Tiny spacing so one tick does not claim too aggressively.
            await sleep(50);
        }
    } catch (error) {
        console.error('[job-worker] claim loop failed:', error);
    }
}

export function startJobWorkers() {
    if (started) return;
    if (process.env.JOB_WORKER_ENABLED === 'false') {
        console.log('[job-worker] disabled by JOB_WORKER_ENABLED=false');
        return;
    }

    started = true;

    console.log(
        `[job-worker] enabled adProcessingConcurrency=${maxConcurrency()} pollMs=${pollIntervalMs()}`
    );

    setInterval(() => {
        tick().catch((error) => console.error('[job-worker] interval error:', error));
    }, pollIntervalMs());

    // Start quickly after boot.
    setTimeout(() => {
        tick().catch((error) => console.error('[job-worker] boot tick error:', error));
    }, 500);
}
