// src/services/apifyStartWorkers.js

import {
    claimNextApifyStartJob,
    failStaleApifyStartJobs,
    markApifyStartJobFailed,
    markApifyStartJobStarted,
    reconcileActiveApifyRunStatus,
    retypeSearchPageJobToManualAd,
    startApifyRunForJob,
} from './apifyStartQueue.js';
import { isDirectLeboncoinAdUrl } from './leboncoinUrl.js';

let started = false;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function enabled() {
    return String(process.env.APIFY_START_WORKER_ENABLED || 'true') !== 'false';
}

function concurrency() {
    return Math.max(1, Math.min(Number(process.env.APIFY_START_MAX_CONCURRENCY || 1), 5));
}

function pollMs() {
    return Math.max(500, Number(process.env.APIFY_START_WORKER_POLL_INTERVAL_MS || 1500));
}

function pageDelayMs() {
    return Math.max(0, Number(process.env.APIFY_START_PAGE_DELAY_MS || 5000));
}

async function runJob(job) {
    try {
        // Self-heal legacy rows queued before the enqueue-time reroute: a search-page
        // job on a DIRECT ad URL would start the wrong actor and hang at 40% on
        // unsupported per-item webhooks (mode=search_page_item), blocking the queue.
        if (job.type === 'apify_start_search_page' && isDirectLeboncoinAdUrl(job.leboncoin_url || job.input?.searchUrl)) {
            const retyped = await retypeSearchPageJobToManualAd(job);
            if (retyped) {
                console.warn(
                    `[apify-start-worker] job=${job.id} retyped apify_start_search_page -> apify_start_manual_ad (direct ad URL: ${retyped.leboncoin_url})`
                );
                job = retyped;
            }
        }

        const result = await startApifyRunForJob(job);

        const saved = await markApifyStartJobStarted(job.id, result);

        console.log(
            `[apify-start-worker] started job=${job.id} type=${job.type} actor=${result.actorId} run=${result.run?.id || 'unknown'}`
        );

        return saved;
    } catch (error) {
        console.error(`[apify-start-worker] failed job=${job.id} type=${job.type}:`, error.message);

        await markApifyStartJobFailed(job, error);

        return null;
    }
}

async function loop(workerName) {
    console.log(`[apify-start-worker] ${workerName} running`);

    while (true) {
        try {
            // Release any Apify run stuck without a webhook so the queue can advance.
            const released = await failStaleApifyStartJobs();
            if (released) {
                console.log(`[apify-start-worker] released ${released} stale apify_running job(s) (no webhook within APIFY_RUN_STALE_MS)`);
            }

            // Fast recovery: ask the Apify API what the active run is really doing —
            // a run that ended without a supported webhook is failed within minutes
            // (instead of blocking the queue until APIFY_RUN_STALE_MS). Isolated so an
            // Apify API hiccup never blocks claiming.
            try {
                const reconciled = await reconcileActiveApifyRunStatus();
                if (reconciled) {
                    console.log(`[apify-start-worker] reconciler released ${reconciled} job(s) whose Apify run ended without a supported webhook`);
                }
            } catch (reconcileError) {
                console.warn(`[apify-start-worker] apify run status reconcile failed: ${reconcileError?.message || reconcileError}`);
            }

            const job = await claimNextApifyStartJob();

            if (!job) {
                // Either nothing queued, or an Apify run is still active (lock held) —
                // wait and re-poll; the webhook will release the lock.
                await sleep(pollMs());
                continue;
            }

            await runJob(job);

            // Extra delay avoids launching search-page actors too aggressively.
            if (job.type === 'apify_start_search_page') {
                await sleep(pageDelayMs());
            }
        } catch (error) {
            console.error(`[apify-start-worker] ${workerName} loop error:`, error.message);
            await sleep(pollMs());
        }
    }
}

export function startApifyStartWorkers() {
    if (started) return;
    started = true;

    if (!enabled()) {
        console.log('[apify-start-worker] disabled by APIFY_START_WORKER_ENABLED=false');
        return;
    }

    const n = concurrency();

    console.log(`[apify-start-worker] enabled concurrency=${n} pollMs=${pollMs()} pageDelayMs=${pageDelayMs()}`);

    for (let i = 0; i < n; i += 1) {
        loop(`worker-${i + 1}`).catch((error) => {
            console.error(`[apify-start-worker] worker-${i + 1} crashed:`, error);
        });
    }
}
