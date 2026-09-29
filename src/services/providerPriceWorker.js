// src/services/providerPriceWorker.js
//
// Background worker for the async manual provider-price queue (provider_price_jobs).
// Claims queued jobs FIFO (one at a time by default), runs Momox/Gibert through the SAME
// updaters + providerLookupLimiter the old synchronous route used, persists results into
// `books`, recomputes backend_status, and refreshes the ad completion summary — then marks
// the job processed. Transient failures (provider calls throwing) retry up to max_attempts;
// a final failure marks the job failed. Stale 'running' locks are requeued on restart.

import { pool } from '../db.js';
import { updateMomoxPricesForAd } from './updateMomoxBatch.js';
import { updateGibertPricesForAd } from './updateGibertBatch.js';
import { runProviderLookup } from './providerLookupLimiter.js';
import { hasMomoxStatusColumn, hasBooksColumn } from './bookColumns.js';
import { refreshAdProviderCompletion, deriveMomoxState, deriveGibertState, deriveBackendStatus } from './adStatus.js';
import {
    hasProviderPriceJobsTable,
    claimNextProviderPriceJob,
    markProviderPriceJobProcessed,
    markProviderPriceJobOutcome,
    resetStaleProviderPriceJobs,
} from './providerPriceJobs.js';

let started = false;
let running = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const maxConcurrency = () => Math.max(1, Number(process.env.PROVIDER_PRICE_MAX_CONCURRENCY || 1));
const pollIntervalMs = () => Math.max(500, Number(process.env.PROVIDER_PRICE_WORKER_POLL_INTERVAL_MS || 1500));
const staleMs = () => Math.max(60_000, Number(process.env.PROVIDER_PRICE_STALE_MS || 900_000));

// Recompute + persist backend_status for one book from its fresh provider result, then
// refresh the ad-level completion summary — exactly what the old synchronous route did.
async function reconcileBookAfterProviders({ bookId, adsId }) {
    const withMomoxStatus = await hasMomoxStatusColumn();
    const withBackendStatus = await hasBooksColumn('backend_status');
    if (withBackendStatus) {
        const cols = [
            'id', 'isbn', 'momox_price', 'gibert_price', 'best_resale_price', 'best_resale_platform',
            'gibert_status', 'gibert_checked_at', 'provider_match_status', 'status',
        ];
        if (withMomoxStatus) cols.push('momox_status');
        const { rows } = await pool.query(`SELECT ${cols.join(', ')} FROM books WHERE id = $1`, [bookId]);
        const fresh = rows[0];
        if (fresh) {
            const backendStatus = deriveBackendStatus(
                fresh,
                deriveMomoxState(fresh, withMomoxStatus),
                deriveGibertState(fresh)
            );
            await pool.query(`UPDATE books SET backend_status = $2, updated_at = NOW() WHERE id = $1`, [bookId, backendStatus]);
        }
    }
    if (adsId) {
        try { await refreshAdProviderCompletion(adsId); }
        catch (error) { console.warn(`[provider-price-worker] completion refresh failed adsId=${adsId}: ${error?.message || error}`); }
    }
}

async function processJob(job) {
    const bookId = Number(job.book_id);
    const isbn = String(job.isbn || '').trim();
    const adsId = job.ads_id ? String(job.ads_id) : null;
    const providers = Array.isArray(job.requested_providers) && job.requested_providers.length
        ? job.requested_providers
        : ['momox', 'gibert'];

    console.log(`[provider-price-worker] claimed job=${job.id} bookId=${bookId} isbn=${isbn || '-'} attempt=${job.attempts}`);

    const result = { momox: null, gibert: null };
    const errors = {};

    if (providers.includes('momox')) {
        try {
            const r = await runProviderLookup(`momox book=${bookId} isbn=${isbn} (job ${job.id})`, () => updateMomoxPricesForAd({ adsId, isbns: [isbn], limit: 5 }));
            result.momox = { ok: r?.ok ?? null, updated: r?.updated ?? null };
        } catch (error) {
            errors.momox = error?.message || String(error);
            console.warn(`[provider-price-worker] momox threw job=${job.id} bookId=${bookId}: ${errors.momox}`);
        }
    }

    if (providers.includes('gibert')) {
        try {
            const r = await runProviderLookup(`gibert book=${bookId} isbn=${isbn} (job ${job.id})`, () => updateGibertPricesForAd({ adsId, isbns: [isbn], limit: 5 }));
            result.gibert = { ok: r?.ok ?? null, updated: r?.updated ?? null };
        } catch (error) {
            errors.gibert = error?.message || String(error);
            console.warn(`[provider-price-worker] gibert threw job=${job.id} bookId=${bookId}: ${errors.gibert}`);
        }
    }

    // A provider that COMPLETED (even "no offer") persisted its own status into `books`.
    // Only a TOTAL failure (every requested provider threw) is a transient job failure
    // worth retrying; a partial/complete run is a processed job.
    await reconcileBookAfterProviders({ bookId, adsId });

    if (Object.keys(errors).length >= providers.length) {
        const err = new Error(`all providers failed: ${JSON.stringify(errors)}`);
        err.code = 'provider_price_lookup_failed';
        throw err;
    }

    return { ...result, errors: Object.keys(errors).length ? errors : null };
}

async function runJob(job) {
    running += 1;
    try {
        const result = await processJob(job);
        await markProviderPriceJobProcessed(job.id, result);
        console.log(`[provider-price-worker] processed job=${job.id} bookId=${job.book_id}`);
    } catch (error) {
        const attempts = Number(job.attempts || 0); // already incremented at claim
        const max = Number(job.max_attempts || 2);
        const retry = attempts < max;
        await markProviderPriceJobOutcome(job.id, {
            retry,
            errorCode: error?.code || 'provider_price_lookup_failed',
            errorMessage: error?.message || String(error),
        });
        console.log(`[provider-price-worker] failed job=${job.id} bookId=${job.book_id} attempt=${attempts}/${max} retry=${retry} error=${error?.message || error}`);
    } finally {
        running -= 1;
    }
}

async function tick() {
    try {
        if (!(await hasProviderPriceJobsTable())) return; // migration not applied yet
        await resetStaleProviderPriceJobs(staleMs());

        while (running < maxConcurrency()) {
            const job = await claimNextProviderPriceJob();
            if (!job) break;
            runJob(job).catch((error) => console.error('[provider-price-worker] unhandled job error:', error));
            await sleep(50);
        }
    } catch (error) {
        console.error('[provider-price-worker] tick failed:', error);
    }
}

export function startProviderPriceWorker() {
    if (started) return;
    if (process.env.PROVIDER_PRICE_WORKER_ENABLED === 'false') {
        console.log('[provider-price-worker] disabled by PROVIDER_PRICE_WORKER_ENABLED=false');
        return;
    }
    started = true;
    console.log(`[provider-price-worker] enabled concurrency=${maxConcurrency()} pollMs=${pollIntervalMs()} staleMs=${staleMs()}`);
    setInterval(() => { tick().catch((error) => console.error('[provider-price-worker] interval error:', error)); }, pollIntervalMs());
    setTimeout(() => { tick().catch((error) => console.error('[provider-price-worker] boot tick error:', error)); }, 600);
}
