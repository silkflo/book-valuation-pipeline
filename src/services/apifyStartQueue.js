// src/services/apifyStartQueue.js

import crypto from 'crypto';
import os from 'os';
import { pool } from '../db.js';
import { recordJobEvent } from './jobEvents.js';
import { isDirectLeboncoinAdUrl } from './leboncoinUrl.js';

const WORKER_ID = `${os.hostname()}-${process.pid}`;

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function minuteBucket() {
    return Math.floor(Date.now() / 60_000);
}

function actorIdForJobType(type) {
    if (type === 'apify_start_manual_ad') {
        return String(process.env.APIFY_MANUAL_AD_ACTOR_ID || '').trim();
    }

    if (type === 'apify_start_search_page') {
        return String(process.env.APIFY_SEARCH_PAGE_ACTOR_ID || '').trim();
    }

    return '';
}

function apifyToken() {
    return String(process.env.APIFY_TOKEN || '').trim();
}

function publicWebhookUrl() {
    const base = String(process.env.PUBLIC_WEBHOOK_BASE_URL || '').replace(/\/+$/, '');
    const secret = String(process.env.WEBHOOK_SECRET || '').trim();

    if (!base) {
        throw new Error('PUBLIC_WEBHOOK_BASE_URL is missing.');
    }

    if (!secret) {
        throw new Error('WEBHOOK_SECRET is missing.');
    }

    return `${base}/webhooks/apify?secret=${encodeURIComponent(secret)}`;
}

function proxyConfiguration() {
    const groups = String(process.env.APIFY_PROXY_GROUPS || 'RESIDENTIAL')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

    return {
        useApifyProxy: true,
        apifyProxyGroups: groups,
        apifyProxyCountry: String(process.env.APIFY_PROXY_COUNTRY || 'FR'),
    };
}

function normalizeActorId(actorId) {
    return String(actorId || '').trim().replace(/\//g, '~');
}

export function buildActorInput(job) {
    const input = job.input || {};
    const webhookUrl = publicWebhookUrl();

    const common = {
        webhookUrl,
        country: String(process.env.APIFY_ACTOR_COUNTRY || 'FR'),
        language: String(process.env.APIFY_ACTOR_LANGUAGE || 'fr'),
        proxyConfiguration: proxyConfiguration(),
    };

    if (job.type === 'apify_start_manual_ad') {
        const adUrl = String(input.adUrl || '').trim();

        return {
            ...common,
            mode: 'manual_ad',
            adUrl,
            startUrl: adUrl,
            startUrls: [{ url: adUrl }],
        };
    }

    if (job.type === 'apify_start_search_page') {
        const searchUrl = String(input.searchUrl || '').trim();

        // Last-resort guard: a search-page run on a direct ad URL emits per-item
        // webhooks (mode=search_page_item) the backend cannot process, so the job
        // would hang at apify_running/40% and block the whole sequential queue.
        if (isDirectLeboncoinAdUrl(searchUrl)) {
            throw new Error(
                `Direct Leboncoin ad URL must run as apify_start_manual_ad, not apify_start_search_page: ${searchUrl}`
            );
        }

        const page = Number(input.page || input.fromPage || 1);

        return {
            ...common,
            mode: 'page_range',
            searchUrl,
            url: searchUrl,
            fromPage: page,
            toPage: page,
            page,
        };
    }

    throw new Error(`Unsupported Apify start job type: ${job.type}`);
}

export async function enqueueManualAdScrapeJob({ adUrl, priority = 0 } = {}) {
    const cleanUrl = String(adUrl || '').trim();

    if (!cleanUrl) {
        throw new Error('adUrl is required.');
    }

    if (!/^https?:\/\//i.test(cleanUrl)) {
        throw new Error('adUrl must be a valid URL.');
    }

    // Prevent accidental double-click duplicates, but allow a new manual retry later.
    const idempotencyKey = `apify-start-manual-ad:${sha256(cleanUrl)}:${minuteBucket()}`;

    const input = {
        adUrl: cleanUrl,
        requestedAt: new Date().toISOString(),
    };

    const result = await pool.query(
        `
        INSERT INTO public.processing_jobs (
            type,
            status,
            stage,
            progress,
            idempotency_key,
            leboncoin_url,
            input,
            priority,
            next_run_at,
            updated_at
        )
        VALUES (
            'apify_start_manual_ad',
            'queued',
            'queued',
            0,
            $1,
            $2,
            $3::jsonb,
            $4,
            NOW(),
            NOW()
        )
        ON CONFLICT (idempotency_key)
        DO UPDATE SET
            updated_at = NOW()
        RETURNING
            id,
            type,
            status,
            stage,
            progress,
            idempotency_key,
            leboncoin_url,
            created_at,
            updated_at
        `,
        [
            idempotencyKey,
            cleanUrl,
            JSON.stringify(input),
            Number(priority || 0),
        ]
    );

    const job = result.rows[0];
    await recordJobEvent(job.id, {
        eventType: 'job_queued',
        stage: 'queued',
        status: 'queued',
        progress: 0,
        message: 'Manual ad scrape queued',
        metadata: { jobType: 'apify_start_manual_ad', url: cleanUrl },
    });

    return job;
}

export async function enqueuePageRangeScrapeJobs({ searchUrl, fromPage = 1, toPage = 1, priority = 0 } = {}) {
    const cleanUrl = String(searchUrl || '').trim();

    if (!cleanUrl) {
        throw new Error('searchUrl is required.');
    }

    if (!/^https?:\/\//i.test(cleanUrl)) {
        throw new Error('searchUrl must be a valid URL.');
    }

    // A DIRECT ad URL on the page-range path would start the search-page actor, whose
    // per-item webhooks (mode=search_page_item) the backend cannot process — the job
    // would hang at apify_running/40% and block the queue. Queue it as a manual ad
    // scrape instead (the correct actor + supported webhooks).
    if (isDirectLeboncoinAdUrl(cleanUrl)) {
        console.warn(
            `[apify-start-queue] direct Leboncoin ad URL received on the page-range path; queued as apify_start_manual_ad instead: ${cleanUrl}`
        );

        const job = await enqueueManualAdScrapeJob({ adUrl: cleanUrl, priority });

        await recordJobEvent(job.id, {
            eventType: 'job_rerouted_direct_ad_url',
            stage: 'queued',
            status: 'queued',
            progress: 0,
            message: 'Direct ad URL sent to the search-page endpoint; queued as manual ad scrape instead',
            metadata: { jobType: 'apify_start_manual_ad', url: cleanUrl, requestedRange: { fromPage, toPage } },
        });

        return {
            fromPage: 1,
            toPage: 1,
            jobs: [job],
            reroutedAsManualAd: true,
        };
    }

    const from = Math.max(1, Math.floor(Number(fromPage || 1)));
    const to = Math.max(from, Math.floor(Number(toPage || from)));
    const maxPages = Math.max(1, Math.min(Number(process.env.APIFY_START_MAX_PAGES_PER_REQUEST || 20), 100));

    if ((to - from + 1) > maxPages) {
        throw new Error(`Too many pages requested. Max allowed is ${maxPages}.`);
    }

    const jobs = [];

    for (let page = from; page <= to; page += 1) {
        const idempotencyKey = `apify-start-search-page:${sha256(`${cleanUrl}|${page}`)}:${minuteBucket()}`;

        const input = {
            searchUrl: cleanUrl,
            fromPage: page,
            toPage: page,
            page,
            requestedRange: { fromPage: from, toPage: to },
            requestedAt: new Date().toISOString(),
        };

        const result = await pool.query(
            `
            INSERT INTO public.processing_jobs (
                type,
                status,
                stage,
                progress,
                idempotency_key,
                leboncoin_url,
                input,
                priority,
                next_run_at,
                updated_at
            )
            VALUES (
                'apify_start_search_page',
                'queued',
                'queued',
                0,
                $1,
                $2,
                $3::jsonb,
                $4,
                NOW(),
                NOW()
            )
            ON CONFLICT (idempotency_key)
            DO UPDATE SET
                updated_at = NOW()
            RETURNING
                id,
                type,
                status,
                stage,
                progress,
                idempotency_key,
                leboncoin_url,
                created_at,
                updated_at
            `,
            [
                idempotencyKey,
                cleanUrl,
                JSON.stringify(input),
                Number(priority || 0),
            ]
        );

        const job = result.rows[0];
        await recordJobEvent(job.id, {
            eventType: 'job_queued',
            stage: 'queued',
            status: 'queued',
            progress: 0,
            message: `Search page ${page} scrape queued`,
            metadata: { jobType: 'apify_start_search_page', url: cleanUrl, page, requestedRange: { fromPage: from, toPage: to } },
        });
        jobs.push(job);
    }

    return {
        fromPage: from,
        toPage: to,
        jobs,
    };
}

/**
 * Self-heal for legacy rows queued before the enqueue-time reroute existed: an
 * apify_start_search_page job whose URL is a DIRECT ad URL is retyped in place to
 * apify_start_manual_ad (correct actor + supported webhooks). Called by the worker at
 * claim time and by the cleanup script. No-op (returns null) if the job was already
 * retyped or is no longer a search-page job.
 */
export async function retypeSearchPageJobToManualAd(job) {
    const adUrl = String(job?.leboncoin_url || job?.input?.searchUrl || '').trim();

    if (!adUrl) return null;

    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET type = 'apify_start_manual_ad',
               input = COALESCE(input, '{}'::jsonb) || $2::jsonb,
               updated_at = NOW()
         WHERE id = $1::bigint
           AND type = 'apify_start_search_page'
        RETURNING *
        `,
        [
            job.id,
            JSON.stringify({
                adUrl,
                retypedFrom: 'apify_start_search_page',
                retypedAt: new Date().toISOString(),
            }),
        ]
    );

    const updated = result.rows[0] || null;
    if (updated) {
        await recordJobEvent(updated.id, {
            eventType: 'job_retyped_direct_ad_url',
            stage: updated.stage,
            status: updated.status,
            message: 'Direct ad URL found in a search-page job; retyped to apify_start_manual_ad',
            metadata: { url: adUrl, from: 'apify_start_search_page', to: 'apify_start_manual_ad' },
        });
    }

    return updated;
}

export async function claimNextApifyStartJob() {
    const maxAttempts = Number(process.env.APIFY_START_MAX_ATTEMPTS || 3);

    const result = await pool.query(
        `
        WITH next_job AS (
            SELECT id
              FROM public.processing_jobs
             WHERE type IN ('apify_start_manual_ad', 'apify_start_search_page')
               AND status = 'queued'
               AND next_run_at <= NOW()
               AND attempts < $2
               -- Apify-active lock: do NOT start a new Apify run while any previous
               -- apify_start_% run is still active (started or running, webhook not yet
               -- received). Released when the webhook completes that job (-> processed)
               -- or when it goes stale. (Robust at APIFY_START_MAX_CONCURRENCY=1.)
               AND NOT EXISTS (
                   SELECT 1
                     FROM public.processing_jobs active
                    WHERE active.type IN ('apify_start_manual_ad', 'apify_start_search_page')
                      AND active.status = 'processing'
                      AND active.stage IN ('starting_apify', 'apify_running')
               )
             ORDER BY priority DESC, created_at ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
        )
        UPDATE public.processing_jobs j
           SET status = 'processing',
               stage = 'starting_apify',
               progress = 10,
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
            eventType: 'apify_start_claimed',
            stage: 'starting_apify',
            status: 'processing',
            progress: 10,
            message: 'Apify-start worker claimed the job',
            metadata: { jobType: job.type, attempts: job.attempts },
        });
    }

    return job;
}

export async function startApifyRunForJob(job) {
    const token = apifyToken();

    if (!token) {
        throw new Error('APIFY_TOKEN is missing.');
    }

    const actorId = actorIdForJobType(job.type);

    if (!actorId) {
        throw new Error(`Missing actor id for job type ${job.type}.`);
    }

    const actorInput = buildActorInput(job);
    const safeActorId = normalizeActorId(actorId);

    const url = `https://api.apify.com/v2/acts/${encodeURIComponent(safeActorId)}/runs?token=${encodeURIComponent(token)}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(actorInput),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(
            data?.error?.message ||
            data?.message ||
            `Apify run start failed (${response.status})`
        );
    }

    const run = data.data || data;

    return {
        actorId,
        actorInput,
        run,
    };
}

export async function markApifyStartJobStarted(jobId, { actorId, actorInput, run }) {
    // The run was ACCEPTED by Apify but is NOT finished yet. Keep the job ACTIVE
    // (processing / apify_running) so the Apify-active lock blocks the next start job
    // until the webhook for THIS run arrives. Do NOT mark processed or set finished_at
    // here — that happens in completeApifyStartJobForWebhook when the webhook lands.
    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'processing',
               stage = 'apify_running',
               progress = 40,
               result = $2::jsonb,
               apify_actor_id = $3,
               apify_run_id = $4,
               apify_dataset_id = $5,
               apify_status = $6,
               locked_by = NULL,
               locked_at = NULL,
               updated_at = NOW()
         WHERE id = $1
        RETURNING id, status, stage, progress, apify_run_id
        `,
        [
            jobId,
            JSON.stringify({
                actorId,
                actorInput,
                run,
                startedAt: new Date().toISOString(),
            }),
            actorId || null,
            run?.id || null,
            run?.defaultDatasetId || null,
            run?.status || 'RUNNING',
        ]
    );

    const row = result.rows[0] || null;
    if (row) {
        await recordJobEvent(jobId, {
            eventType: 'apify_run_started',
            stage: 'apify_running',
            status: 'processing',
            progress: 40,
            message: 'Apify accepted the run; awaiting webhook',
            // NOTE: never include actorInput (it carries the secret webhookUrl + proxy config).
            metadata: { actorId, runId: run?.id || null, datasetId: run?.defaultDatasetId || null, apifyStatus: run?.status || 'RUNNING' },
        });
    }

    return row;
}

/**
 * Complete the active apify_start_% job when its webhook arrives — this RELEASES the
 * Apify-active lock so the next start job can run. Matches by Apify run id; if the
 * webhook payload carries no run id (or it doesn't match), falls back to the SINGLE
 * active run (safe under the sequential invariant — only one Apify run is ever active).
 * Returns { job, matchedBy }.
 */
export async function completeApifyStartJobForWebhook(runId) {
    const cleanRunId = String(runId || '').trim();

    const completeSql = (whereClause, params) => pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'processed',
               stage = 'apify_finished_webhook_received',
               progress = 100,
               apify_status = COALESCE(apify_status, 'WEBHOOK_RECEIVED'),
               webhook_received_at = COALESCE(webhook_received_at, NOW()),
               -- Clear any stale error from an earlier requeue/stale guard: the start job
               -- completed (webhook received), so it must not look failed to the UI.
               error_code = NULL,
               error_message = NULL,
               locked_by = NULL,
               locked_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE ${whereClause}
        RETURNING id, type, apify_run_id, status, stage
        `,
        params
    );

    // 1) Precise match by Apify run id (only an active start job).
    if (cleanRunId) {
        const byId = await completeSql(
            `apify_run_id = $1
               AND type IN ('apify_start_manual_ad', 'apify_start_search_page')
               AND status = 'processing'
               AND stage IN ('starting_apify', 'apify_running')`,
            [cleanRunId]
        );
        if (byId.rows[0]) {
            await recordApifyStartCompletion(byId.rows[0], 'run_id');
            return { job: byId.rows[0], matchedBy: 'run_id' };
        }

        // The job for this run exists but is already TERMINAL (processed earlier, or
        // failed by the stale guard / unsupported-webhook-mode guard / actor-failure
        // webhook). A late or duplicate webhook for that run must NOT fall through to
        // the single-active fallback below — it would complete an UNRELATED newer run.
        const known = await pool.query(
            `
            SELECT id, status, stage
              FROM public.processing_jobs
             WHERE apify_run_id = $1
               AND type IN ('apify_start_manual_ad', 'apify_start_search_page')
             LIMIT 1
            `,
            [cleanRunId]
        );
        if (known.rows[0]) {
            return { job: null, matchedBy: 'run_already_terminal' };
        }
    }

    // 2) Fallback: exactly ONE active start job (sequential invariant => it is this run).
    const active = await pool.query(
        `
        SELECT id
          FROM public.processing_jobs
         WHERE type IN ('apify_start_manual_ad', 'apify_start_search_page')
           AND status = 'processing'
           AND stage IN ('starting_apify', 'apify_running')
         LIMIT 2
        `
    );

    if (active.rowCount === 1) {
        const done = await completeSql(`id = $1`, [active.rows[0].id]);
        if (done.rows[0]) await recordApifyStartCompletion(done.rows[0], 'single_active');
        return { job: done.rows[0] || null, matchedBy: 'single_active' };
    }

    return { job: null, matchedBy: active.rowCount > 1 ? 'ambiguous_multiple_active' : 'no_active' };
}

// Two timeline events when a webhook completes a start job: the webhook landed, and the
// Apify queue is now released for the next run.
async function recordApifyStartCompletion(job, matchedBy) {
    await recordJobEvent(job.id, {
        eventType: 'apify_webhook_received',
        stage: 'apify_finished_webhook_received',
        status: 'processed',
        progress: 100,
        message: 'Apify run webhook received',
        metadata: { runId: job.apify_run_id || null, matchedBy },
    });
    await recordJobEvent(job.id, {
        eventType: 'apify_queue_released',
        stage: 'apify_finished_webhook_received',
        status: 'processed',
        progress: 100,
        message: 'Apify-active lock released; next run may start',
        metadata: { runId: job.apify_run_id || null },
    });
}

/**
 * Stale protection: an apify_start_% job stuck in processing/apify_running past
 * APIFY_RUN_STALE_MS without a webhook is marked FAILED (never silently processed),
 * which releases the Apify-active lock for the next job.
 */
export async function failStaleApifyStartJobs() {
    const staleMs = Number(process.env.APIFY_RUN_STALE_MS || 7_200_000);

    const result = await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'failed',
               stage = 'failed',
               error_code = 'apify_run_stale_no_webhook',
               error_message = 'Apify run did not deliver a webhook before APIFY_RUN_STALE_MS; releasing the Apify queue.',
               locked_by = NULL,
               locked_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE type IN ('apify_start_manual_ad', 'apify_start_search_page')
           AND status = 'processing'
           AND stage IN ('starting_apify', 'apify_running')
           AND started_at < NOW() - ($1::text || ' milliseconds')::interval
        RETURNING id
        `,
        [String(staleMs)]
    );

    for (const row of result.rows) {
        await recordJobEvent(row.id, {
            eventType: 'apify_run_stale_no_webhook',
            stage: 'failed',
            status: 'failed',
            severity: 'error',
            message: 'Apify run did not deliver a webhook before the stale timeout; queue released.',
            errorCode: 'apify_run_stale_no_webhook',
            errorMessage: `No webhook within ${staleMs}ms`,
            metadata: { staleMs },
        });
    }

    return result.rowCount;
}

const APIFY_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

// Throttle for the reconciler's Apify API calls: runId -> epoch ms of the last check.
const reconcileLastCheckAt = new Map();

/**
 * Fast stale recovery (much earlier than APIFY_RUN_STALE_MS): for the active
 * apify_start_% job, ask the Apify API what the run is ACTUALLY doing.
 *  - Keeps processing_jobs.apify_status in sync (no more frozen 'READY' at 40%).
 *  - If the run ended (SUCCEEDED/FAILED/ABORTED/TIMED-OUT) and no supported webhook
 *    completed the job within a grace window, the job is failed terminally — this
 *    releases the Apify-active lock so the queue advances in minutes, not hours.
 * Called from the worker loop; API calls are throttled per run. Returns the number
 * of jobs released.
 */
export async function reconcileActiveApifyRunStatus() {
    const token = apifyToken();
    if (!token) return 0;

    const checkAfterMs = Number(process.env.APIFY_RUN_RECONCILE_AFTER_MS || 180_000);
    const checkIntervalMs = Number(process.env.APIFY_RUN_RECONCILE_INTERVAL_MS || 60_000);
    const webhookGraceMs = Number(process.env.APIFY_RUN_WEBHOOK_GRACE_MS || 120_000);

    const active = await pool.query(
        `
        SELECT id, type, apify_run_id, apify_status, leboncoin_url
          FROM public.processing_jobs
         WHERE type IN ('apify_start_manual_ad', 'apify_start_search_page')
           AND status = 'processing'
           AND stage = 'apify_running'
           AND apify_run_id IS NOT NULL
           AND started_at < NOW() - ($1::text || ' milliseconds')::interval
         LIMIT 5
        `,
        [String(checkAfterMs)]
    );

    // Drop throttle entries for runs that are no longer active (bounded memory).
    const activeRunIds = new Set(active.rows.map((row) => row.apify_run_id));
    for (const runId of reconcileLastCheckAt.keys()) {
        if (!activeRunIds.has(runId)) reconcileLastCheckAt.delete(runId);
    }

    let released = 0;

    for (const job of active.rows) {
        const runId = job.apify_run_id;
        const lastCheck = reconcileLastCheckAt.get(runId) || 0;
        if (Date.now() - lastCheck < checkIntervalMs) continue;
        reconcileLastCheckAt.set(runId, Date.now());

        let run = null;
        try {
            const response = await fetch(
                `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`,
                { headers: { Accept: 'application/json' } }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                console.warn(`[apify-reconcile] run=${runId} status fetch failed (${response.status}); will retry`);
                continue;
            }
            run = data.data || data;
        } catch (fetchError) {
            console.warn(`[apify-reconcile] run=${runId} status fetch error: ${fetchError?.message || fetchError}`);
            continue;
        }

        const runStatus = String(run?.status || '').trim().toUpperCase();
        if (!runStatus) continue;

        // Observability: reflect the real Apify run status on the job row.
        if (runStatus !== job.apify_status) {
            await pool.query(
                `
                UPDATE public.processing_jobs
                   SET apify_status = $2,
                       updated_at = NOW()
                 WHERE id = $1::bigint
                   AND status = 'processing'
                   AND stage = 'apify_running'
                `,
                [job.id, runStatus]
            );
        }

        if (!APIFY_TERMINAL_STATUSES.has(runStatus)) continue;

        // Grace window: the run just ended — its webhook may still be in flight.
        const finishedAtMs = run?.finishedAt ? Date.parse(run.finishedAt) : null;
        if (finishedAtMs && Date.now() - finishedAtMs < webhookGraceMs) continue;

        const errorMessage = `Apify run ${runId} ended with status ${runStatus} but no supported webhook completed the job; failed to release the Apify queue.`;

        const upd = await pool.query(
            `
            UPDATE public.processing_jobs
               SET status = 'failed',
                   stage = 'failed',
                   apify_status = $2::text,
                   error_code = 'apify_run_terminal_no_webhook',
                   error_message = $3::text,
                   locked_by = NULL,
                   locked_at = NULL,
                   finished_at = NOW(),
                   updated_at = NOW()
             WHERE id = $1::bigint
               AND status = 'processing'
               AND stage = 'apify_running'
            RETURNING id
            `,
            [job.id, runStatus, errorMessage]
        );

        if (!upd.rows[0]) continue; // raced with the webhook — job completed normally

        released += 1;
        console.warn(`[apify-reconcile] run=${runId} ended ${runStatus} without a supported webhook; failing job=${job.id} to release the queue`);

        await recordJobEvent(job.id, {
            eventType: 'apify_run_terminal_no_webhook',
            stage: 'failed',
            status: 'failed',
            severity: 'error',
            message: `Apify run ended (${runStatus}) but no supported webhook arrived; queue released.`,
            errorCode: 'apify_run_terminal_no_webhook',
            errorMessage,
            metadata: { runId, apifyStatus: runStatus, finishedAt: run?.finishedAt || null, jobType: job.type, url: job.leboncoin_url || null },
        });
    }

    return released;
}

export async function markApifyStartJobFailed(job, error) {
    const maxAttempts = Number(process.env.APIFY_START_MAX_ATTEMPTS || 3);
    const retryDelayMs = Number(process.env.APIFY_START_RETRY_DELAY_MS || 60_000);
    const shouldRetry = Number(job.attempts || 0) < maxAttempts;

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
        RETURNING id, status, stage, attempts, error_message
        `,
        [
            job.id,
            shouldRetry ? 'queued' : 'failed',
            shouldRetry ? 'queued' : 'failed',
            'apify_start_failed',
            String(error?.message || error || 'Unknown Apify start error').slice(0, 2000),
            shouldRetry,
            String(retryDelayMs),
        ]
    );

    const row = result.rows[0] || null;
    await recordJobEvent(job.id, {
        eventType: shouldRetry ? 'apify_start_retried' : 'apify_start_failed',
        stage: shouldRetry ? 'queued' : 'failed',
        status: shouldRetry ? 'queued' : 'failed',
        severity: 'error',
        message: shouldRetry ? 'Apify run start failed; will retry' : 'Apify run start failed permanently',
        errorCode: 'apify_start_failed',
        errorMessage: String(error?.message || error || 'Unknown Apify start error'),
        metadata: { jobType: job.type, attempts: Number(job.attempts || 0) + 1, willRetry: shouldRetry },
    });

    return row;
}

/** True when an Apify webhook payload reports an actor failure (not a normal result). */
export function isApifyFailureWebhook(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const mode = String(payload.mode || '');
    return payload.failed === true
        || payload.status === 'failed'
        || mode === 'manual_ad_failed'
        || mode === 'search_page_failed';
}

/**
 * A webhook arrived in a mode the backend cannot process (e.g. per-record
 * mode=search_page_item): that run will NEVER deliver a processable payload, so the
 * matching apify_start_% job must be failed TERMINALLY — otherwise it sits at
 * apify_running/40% holding the Apify-active lock and blocks the whole queue.
 *
 * Matching is deliberately conservative (never guess across runs):
 *   1. run id, when the payload carries one — the only fully trusted match;
 *      if that run's job is already terminal, report it and DO NOT touch other jobs
 *      (late duplicate per-item webhooks must not kill the next active run);
 *   2. leboncoin_url among ACTIVE start jobs;
 *   3. the single active start job, ONLY when the payload carries no identifiers at all
 *      (a foreign/manual actor run with identifiers that match nothing is left alone).
 * Returns { handled, job, matchedBy, ... }. Never throws SQL params mismatches; idempotent.
 */
export async function failApifyStartJobForUnsupportedWebhookMode(payload) {
    const mode = String(payload?.mode || '').trim() || 'unknown';
    const runId = String(payload?.apifyRunId || payload?.actorRunId || '').trim();
    const urls = [payload?.adUrl, payload?.searchUrl, payload?.url]
        .map((u) => String(u || '').trim())
        .filter(Boolean);

    const activeFilter = `
        type IN ('apify_start_manual_ad', 'apify_start_search_page')
        AND status = 'processing'
        AND stage IN ('starting_apify', 'apify_running')`;

    // 1) Find the target start job without ever guessing across runs.
    let target = null;
    let matchedBy = null;

    if (runId) {
        const byRun = await pool.query(
            `
            SELECT id, type, status, stage, apify_run_id, leboncoin_url
              FROM public.processing_jobs
             WHERE apify_run_id = $1::text
               AND type IN ('apify_start_manual_ad', 'apify_start_search_page')
             ORDER BY id DESC
             LIMIT 1
            `,
            [runId]
        );
        const row = byRun.rows[0] || null;

        if (row && row.status === 'processing' && (row.stage === 'starting_apify' || row.stage === 'apify_running')) {
            target = row;
            matchedBy = 'run_id';
        } else if (row) {
            // Already terminal (processed / failed): a repeated per-item webhook for the
            // same run must not fall through and fail an unrelated newer run.
            return { handled: true, alreadyTerminal: true, job: row, matchedBy: 'run_already_terminal' };
        }
    }

    if (!target && urls.length) {
        const byUrl = await pool.query(
            `
            SELECT id, type, status, stage, apify_run_id, leboncoin_url
              FROM public.processing_jobs
             WHERE ${activeFilter}
               AND leboncoin_url = ANY($1::text[])
             ORDER BY id DESC
             LIMIT 1
            `,
            [urls]
        );
        if (byUrl.rows[0]) {
            target = byUrl.rows[0];
            matchedBy = 'url';
        }
    }

    if (!target && !runId && urls.length === 0) {
        const single = await pool.query(
            `
            SELECT id, type, status, stage, apify_run_id, leboncoin_url
              FROM public.processing_jobs
             WHERE ${activeFilter}
             LIMIT 2
            `
        );
        if (single.rowCount === 1) {
            target = single.rows[0];
            matchedBy = 'single_active';
        }
    }

    if (!target) {
        console.warn(`[apify-start-queue] unsupported webhook mode=${mode}: no matching active start job (runId=${runId || '-'} urls=${urls.join('|') || '-'})`);
        return { handled: false, unmatched: true, job: null, matchedBy: 'none' };
    }

    // 2) Fail it terminally (guarded: never overwrites a job the webhook completed).
    const errorMessage = `Apify sent webhook mode=${mode}, which the backend does not support; the run will never deliver a processable payload, so the job was failed terminally to release the Apify queue. Direct ad URLs must be queued as apify_start_manual_ad.`.slice(0, 2000);

    const upd = await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'failed',
               stage = 'failed',
               error_code = $2::text,
               error_message = $3::text,
               locked_by = NULL,
               locked_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE id = $1::bigint
           AND status = 'processing'
           AND stage IN ('starting_apify', 'apify_running')
        RETURNING id, type, status, stage, apify_run_id, leboncoin_url
        `,
        [target.id, 'unsupported_webhook_mode', errorMessage]
    );

    const job = upd.rows[0] || null;
    if (!job) {
        // Raced with a completing webhook or the stale guard between SELECT and UPDATE.
        return { handled: true, alreadyTerminal: true, job: target, matchedBy };
    }

    console.warn(`[apify-start-queue] job=${job.id} failed terminally (unsupported webhook mode=${mode}, matchedBy=${matchedBy}); Apify queue released`);

    await recordJobEvent(job.id, {
        eventType: 'apify_webhook_unsupported_mode',
        stage: 'failed',
        status: 'failed',
        severity: 'error',
        message: `Unsupported Apify webhook mode=${mode}; job failed terminally to release the Apify queue`,
        errorCode: 'unsupported_webhook_mode',
        errorMessage,
        metadata: { mode, runId: runId || null, url: urls[0] || job.leboncoin_url || null, matchedBy },
    });

    return { handled: true, job, matchedBy };
}

/**
 * Mark the matching apify_start_% job FAILED from an actor failure webhook + record a
 * timeline event. No child apify_payload_processing job is created. Idempotent + never
 * overwrites an already-processed job. Releases the Apify-active lock (status becomes
 * 'failed', so the next queued start job is claimable). Returns a thin outcome object.
 */
export async function markApifyStartJobFailedFromWebhook(payload) {
    const runId = String(payload?.apifyRunId || payload?.actorRunId || '').trim();
    const mode = String(payload?.mode || '').trim();
    const urls = [payload?.adUrl, payload?.searchUrl, payload?.url]
        .map((u) => String(u || '').trim())
        .filter(Boolean);
    const adsId = payload?.adsId ? String(payload.adsId) : null;
    const errorCode = String(
        payload?.error?.code
        || (mode === 'manual_ad_failed' ? 'manual_ad_failed' : mode === 'search_page_failed' ? 'search_page_failed' : 'apify_run_failed')
    ).slice(0, 200);
    const errorMessage = payload?.error?.message ? String(payload.error.message).slice(0, 2000) : null;

    // 1) Find the matching start job: run id first (precise), then leboncoin_url fallback.
    let job = null;
    if (runId) {
        const r = await pool.query(
            `SELECT id, status, stage, progress, ads_id
               FROM public.processing_jobs
              WHERE apify_run_id = $1 AND type LIKE 'apify_start_%'
              ORDER BY id DESC
              LIMIT 1`,
            [runId]
        );
        job = r.rows[0] || null;
    }
    if (!job && urls.length) {
        const r = await pool.query(
            `SELECT id, status, stage, progress, ads_id
               FROM public.processing_jobs
              WHERE type LIKE 'apify_start_%'
                AND leboncoin_url = ANY($1::text[])
              ORDER BY (CASE WHEN status = 'processing' THEN 0 ELSE 1 END), id DESC
              LIMIT 1`,
            [urls]
        );
        job = r.rows[0] || null;
    }

    if (!job) {
        console.warn(`[apify-fail] no matching apify_start job (runId=${runId || '-'} urls=${urls.join('|') || '-'} mode=${mode || '-'})`);
        return { handled: false, unmatched: true, job: null };
    }
    if (job.status === 'processed') return { handled: true, alreadyProcessed: true, job };
    if (job.status === 'failed') return { handled: true, alreadyHandled: true, job };

    // 2) Mark failed (compact safe failure summary in result; never overwrite processed).
    const summary = payload?.summary && typeof payload.summary === 'object'
        ? {
            totalCandidates: payload.summary.totalCandidates ?? null,
            validLivre: payload.summary.validLivre ?? null,
            enqueued: payload.summary.enqueued ?? null,
            webhookRecordsCount: payload.summary.webhookRecordsCount ?? null,
            failedRequestsCount: payload.summary.failedRequestsCount ?? null,
        }
        : null;

    const resultPatch = JSON.stringify({
        failure: { mode: mode || null, runId: runId || null, actorId: payload?.apifyActorId || null, adsId, errorCode, failedAt: payload?.failedAt || null, summary },
    });

    const upd = await pool.query(
        `
        UPDATE public.processing_jobs
           SET status = 'failed',
               stage = 'apify_run_failed',
               progress = COALESCE(progress, 40),
               apify_status = 'FAILED',
               ads_id = COALESCE(ads_id, $2::text),
               apify_run_id = COALESCE(apify_run_id, $3::text),
               error_code = $4::text,
               error_message = $5::text,
               result = COALESCE(result, '{}'::jsonb) || $6::jsonb,
               locked_by = NULL,
               locked_at = NULL,
               finished_at = NOW(),
               updated_at = NOW()
         WHERE id = $1::bigint AND status <> 'processed'
        RETURNING id, status, stage, progress, error_code, error_message
        `,
        // Explicit casts so Postgres infers types even when adsId / runId / errorMessage
        // are NULL. (The previous array had an unused null at $2 the SQL never referenced,
        // which is what triggered "could not determine data type of parameter $2".)
        [job.id, adsId, runId || null, errorCode, errorMessage, resultPatch]
    );

    const updated = upd.rows[0] || null;
    if (!updated) {
        // Raced to 'processed' between the SELECT and UPDATE.
        return { handled: true, alreadyProcessed: true, job };
    }

    // 3) Timeline event (non-throwing). No secrets / no raw HTML / no full logs.
    await recordJobEvent(updated.id, {
        eventType: 'apify_run_failed',
        stage: 'apify_run_failed',
        status: 'failed',
        progress: updated.progress ?? 40,
        severity: 'error',
        message: 'Apify actor failed before webhook processing',
        errorCode,
        errorMessage,
        metadata: { mode: mode || null, runId: runId || null, actorId: payload?.apifyActorId || null, adsId, url: urls[0] || null, summary },
    });

    return { handled: true, job: updated };
}
