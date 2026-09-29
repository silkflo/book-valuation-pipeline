// src/routes/adminRoutes.js
//
// Admin override endpoints (mounted at /admin), protected by the same
// WEBHOOK_SECRET as the provider webhooks.
//
// POST /admin/books/:bookId/request-provider-price
//   Request Momox + Gibert resale prices for ONE book by id, even when the
//   automatic cost-stop eligibility held it back (e.g. ISBN confidence below
//   threshold). This is the manual escape hatch behind the UI's "Demander le
//   prix" button on a NULL + not_sent row.

import express from 'express';

import { pool } from '../db.js';
import { checkWebhookSecret } from './apifyWebhook.js';
import { updateMomoxPricesForAd } from '../services/updateMomoxBatch.js';
import { updateGibertPricesForAd } from '../services/updateGibertBatch.js';
import { runProviderLookup } from '../services/providerLookupLimiter.js';
import {
    refreshAdProviderCompletion,
    deriveMomoxState,
    deriveGibertState,
    deriveBackendStatus,
} from '../services/adStatus.js';
import { hasMomoxStatusColumn, hasBooksColumn } from '../services/bookColumns.js';
import { getJobsStatus } from '../services/processingJobs.js';
import { getJobEvents, getRecentEventsForJobs } from '../services/jobEvents.js';
import {
    enqueueManualAdScrapeJob,
    enqueuePageRangeScrapeJobs,
} from '../services/apifyStartQueue.js';
import {
    hasProviderPriceJobsTable,
    enqueueProviderPriceJob,
    getProviderPriceJobsForBooks,
} from '../services/providerPriceJobs.js';

const router = express.Router();

// EAN-13 checksum. The pipeline stores ISBN-13 in books.isbn, so this is the
// right validity test for the override ("require a valid ISBN").
function isValidIsbn13(value) {
    const digits = String(value || '').replace(/[^0-9]/g, '');
    if (digits.length !== 13) return false;

    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
        sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
    }
    const check = (10 - (sum % 10)) % 10;

    return check === Number(digits[12]);
}

function checkAdminSecret(req, res) {
    const expected = String(process.env.WEBHOOK_SECRET || process.env.BOOKS_API_SECRET || '').trim();
    const provided = String(req.query.secret || req.body?.secret || req.get('x-books-secret') || '').trim();

    if (!expected || provided !== expected) {
        res.status(401).json({
            success: false,
            error: 'Unauthorized',
        });
        return false;
    }

    return true;
}

// Curated, feature-detected column list for the response (never SELECT * — the
// raw_response blobs are large). Optional columns are added only when present.
async function loadBookForResponse(bookId) {
    const withMomoxStatus = await hasMomoxStatusColumn();
    const withBackendStatus = await hasBooksColumn('backend_status');
    const withNotSentReason = await hasBooksColumn('not_sent_reason');

    const cols = [
        'id', 'ads_id', 'isbn', 'title',
        'momox_price', 'gibert_price', 'best_resale_price', 'best_resale_platform',
        'gibert_status', 'gibert_checked_at', 'provider_match_status',
        'status', 'candidate_status', 'review_status', 'admin_status',
    ];
    if (withMomoxStatus) cols.push('momox_status');
    if (withBackendStatus) cols.push('backend_status');
    if (withNotSentReason) cols.push('not_sent_reason');

    const { rows } = await pool.query(
        `SELECT ${cols.join(', ')} FROM books WHERE id = $1`,
        [bookId]
    );

    return rows[0] || null;
}

function hasProviderResult(book) {
    return (
        book?.momox_price !== null ||
        book?.gibert_price !== null ||
        book?.momox_status === 'momox_price_found' ||
        book?.momox_status === 'momox_no_offer' ||
        book?.momox_status === 'momox_failed' ||
        book?.gibert_status === 'gibert_price_found' ||
        book?.gibert_status === 'gibert_non_repris' ||
        book?.gibert_status === 'gibert_missing' ||
        book?.gibert_status === 'gibert_failed'
    );
}

function isProviderPending(book) {
    return (
        book?.momox_status === 'momox_pending' ||
        book?.gibert_status === 'gibert_pending'
    );
}


router.get('/jobs/status', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const limit = Number(req.query.limit || 50);
        const status = await getJobsStatus({ limit });

        // Optional, lightweight: attach the last N events per job (default off).
        if (String(req.query.includeEvents) === 'true' && status.jobs?.length) {
            const perJob = Math.max(1, Math.min(Number(req.query.eventsPerJob || 5), 20));
            const eventsByJob = await getRecentEventsForJobs(status.jobs.map((j) => j.id), { perJob });
            status.jobs = status.jobs.map((j) => ({ ...j, recentEvents: eventsByJob[j.id] || [] }));
        }

        return res.json({
            success: true,
            ...status,
        });
    } catch (error) {
        console.error('Admin jobs status error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Detailed timeline for one job: job fields + full event list (ASC) + child jobs.
router.get('/jobs/:id/events', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const jobId = Number(req.params.id);
        if (!Number.isInteger(jobId) || jobId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid job id' });
        }

        const jobResult = await pool.query(
            `
            SELECT id, parent_job_id, type, status, stage, progress, ads_id, leboncoin_url,
                   apify_actor_id, apify_run_id, apify_dataset_id, apify_status,
                   error_code, error_message, attempts,
                   created_at, updated_at, started_at, finished_at, webhook_received_at
              FROM public.processing_jobs
             WHERE id = $1
            `,
            [jobId]
        );

        const job = jobResult.rows[0] || null;
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }

        const events = await getJobEvents(jobId, { limit: Number(req.query.limit || 200) });

        const childrenResult = await pool.query(
            `
            SELECT id, type, status, stage, progress, apify_run_id, error_code,
                   created_at, updated_at, finished_at
              FROM public.processing_jobs
             WHERE parent_job_id = $1
             ORDER BY created_at ASC
            `,
            [jobId]
        );

        return res.json({
            success: true,
            job,
            events,
            children: childrenResult.rows,
        });
    } catch (error) {
        console.error('Admin job events error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

router.post('/books/:bookId/request-provider-price', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const bookId = Number(req.params.bookId);
        if (!Number.isInteger(bookId) || bookId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid bookId' });
        }

        const existing = await loadBookForResponse(bookId);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Book not found' });
        }

        const isbn = String(existing.isbn || '').trim();
        if (!isbn || !isValidIsbn13(isbn)) {
            return res.status(400).json({
                success: false,
                error: 'Book has no valid ISBN-13 to look up',
                isbn: existing.isbn || null,
            });
        }

        const force = req.query.force === '1';

        // A final provider result already exists -> nothing to do (unless forced).
        if (hasProviderResult(existing) && !force) {
            return res.status(200).json({
                ok: true,
                queued: false,
                alreadyHasResult: true,
                bookId,
                book: existing,
                message: 'Un prix fournisseur existe déjà pour ce livre.',
            });
        }

        const adsId = existing.ads_id ? String(existing.ads_id) : null;

        // Preferred path: enqueue an async provider-price job and return 202 immediately.
        // The endpoint NEVER calls Momox/Gibert inline anymore — the worker does, behind the
        // shared providerLookupLimiter. Falls back to synchronous only if the queue table
        // has not been migrated yet (graceful degradation).
        if (await hasProviderPriceJobsTable()) {
            const { job, alreadyQueued } = await enqueueProviderPriceJob({
                bookId,
                adsId,
                isbn,
                requestedByName: req.body?.requestedByName || req.get('x-admin-user') || null,
            });

            if (alreadyQueued) {
                console.log(`[provider-price-job] already_queued bookId=${bookId} jobId=${job?.id || '-'}`);
                return res.status(202).json({
                    ok: true,
                    queued: true,
                    alreadyQueued: true,
                    jobId: job?.id ?? null,
                    bookId,
                    message: 'Recherche du prix déjà en file d’attente.',
                });
            }

            // New job created: mark the book's provider lifecycle pending so the UI shows
            // "en cours" immediately (the worker overwrites with the real result).
            await markBookProviderPending(bookId);
            console.log(`[provider-price-job] queued bookId=${bookId} adsId=${adsId || '-'} isbn=${isbn} jobId=${job?.id || '-'}`);

            return res.status(202).json({
                ok: true,
                queued: true,
                alreadyQueued: false,
                jobId: job?.id ?? null,
                bookId,
                message: 'Recherche du prix ajoutée à la file d’attente.',
            });
        }

        // ---- Fallback (queue table not migrated yet): the previous synchronous path. ----
        return await runProviderPriceSynchronously({ res, bookId, isbn, adsId, force });
    } catch (error) {
        console.error('Admin request-provider-price error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Mark a book's provider lifecycle as pending (clears stale prices) so the status endpoint
// reflects "queued/pending" immediately after a job is enqueued. Feature-detected columns.
async function markBookProviderPending(bookId) {
    const withMomoxStatus = await hasMomoxStatusColumn();
    const withBackendStatus = await hasBooksColumn('backend_status');
    const withNotSentReason = await hasBooksColumn('not_sent_reason');
    await pool.query(
        `
        UPDATE books SET
            momox_price = NULL,
            gibert_price = NULL,
            best_resale_price = NULL,
            best_resale_platform = NULL,
            gibert_checked_at = NULL,
            gibert_status = 'gibert_pending',
            ${withMomoxStatus ? `momox_status = 'momox_pending',` : ''}
            ${withBackendStatus ? `backend_status = 'isbn_confirmed',` : ''}
            ${withNotSentReason ? `not_sent_reason = NULL,` : ''}
            updated_at = NOW()
        WHERE id = $1
        `,
        [bookId]
    );
}

// Synchronous fallback for when provider_price_jobs is not migrated yet. Same behavior as
// the historical endpoint: atomic same-book claim, inline Momox+Gibert via the limiter,
// recompute backend_status, refresh completion. Returns 200.
async function runProviderPriceSynchronously({ res, bookId, isbn, adsId, force }) {
    const withMomoxStatus = await hasMomoxStatusColumn();
    const withBackendStatus = await hasBooksColumn('backend_status');
    const withNotSentReason = await hasBooksColumn('not_sent_reason');

    const claim = await pool.query(
        `
        UPDATE books SET
            momox_price = NULL, gibert_price = NULL,
            best_resale_price = NULL, best_resale_platform = NULL,
            gibert_checked_at = NULL, gibert_status = 'gibert_pending',
            ${withMomoxStatus ? `momox_status = 'momox_pending',` : ''}
            ${withBackendStatus ? `backend_status = 'isbn_confirmed',` : ''}
            ${withNotSentReason ? `not_sent_reason = NULL,` : ''}
            updated_at = NOW()
        WHERE id = $1
        ${force ? '' : `
          AND gibert_status IS DISTINCT FROM 'gibert_pending'
          ${withMomoxStatus ? `AND momox_status IS DISTINCT FROM 'momox_pending'` : ''}
          AND momox_price IS NULL AND gibert_price IS NULL`}
        RETURNING id
        `,
        [bookId]
    );
    if (claim.rowCount === 0) {
        const current = await loadBookForResponse(bookId);
        return res.status(409).json({ success: false, error: 'Provider lookup already pending or already has a result. Use ?force=1 to re-run.', book: current });
    }

    const errors = {};
    let momox = null;
    let gibert = null;
    try { momox = await runProviderLookup(`momox book=${bookId} isbn=${isbn} (admin-sync)`, () => updateMomoxPricesForAd({ adsId, isbns: [isbn], limit: 5 })); }
    catch (error) { errors.momox = error.message; }
    try { gibert = await runProviderLookup(`gibert book=${bookId} isbn=${isbn} (admin-sync)`, () => updateGibertPricesForAd({ adsId, isbns: [isbn], limit: 5 })); }
    catch (error) { errors.gibert = error.message; }

    if (withBackendStatus) {
        const fresh = await loadBookForResponse(bookId);
        if (fresh) {
            const backendStatus = deriveBackendStatus(fresh, deriveMomoxState(fresh, withMomoxStatus), deriveGibertState(fresh));
            await pool.query(`UPDATE books SET backend_status = $2, updated_at = NOW() WHERE id = $1`, [bookId, backendStatus]);
        }
    }
    let completion = null;
    try { completion = await refreshAdProviderCompletion(adsId); } catch { /* non-fatal */ }

    const book = await loadBookForResponse(bookId);
    return res.json({ success: true, queued: false, book, momox, gibert, completion: completion?.counts || null, errors: Object.keys(errors).length ? errors : null });
}

// Lightweight polling endpoint: provider/job status for ONLY the requested book ids.
// GET /admin/books/provider-price-status?bookIds=1,2,3  (no ad/table HTML).
router.get('/books/provider-price-status', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const ids = String(req.query.bookIds || '')
            .split(',')
            .map((s) => Number(String(s).trim()))
            .filter((n) => Number.isInteger(n) && n > 0)
            .slice(0, 500);

        if (!ids.length) {
            return res.status(400).json({ ok: false, error: 'bookIds query param required (comma-separated ids)' });
        }

        const withMomoxStatus = await hasMomoxStatusColumn();
        const cols = ['id', 'momox_price', 'gibert_price', 'best_resale_price', 'best_resale_platform', 'gibert_status'];
        if (withMomoxStatus) cols.push('momox_status');
        const { rows } = await pool.query(
            `SELECT ${cols.join(', ')} FROM books WHERE id = ANY($1::bigint[])`,
            [ids]
        );
        const bookById = new Map(rows.map((r) => [Number(r.id), r]));

        const jobByBook = (await hasProviderPriceJobsTable())
            ? await getProviderPriceJobsForBooks(ids)
            : new Map();

        const books = ids.map((id) => {
            const b = bookById.get(id) || {};
            const job = jobByBook.get(id) || null;
            return {
                bookId: id,
                jobStatus: job?.status || null,
                momoxStatus: withMomoxStatus ? (b.momox_status ?? null) : null,
                gibertStatus: b.gibert_status ?? null,
                momoxPrice: b.momox_price ?? null,
                gibertPrice: b.gibert_price ?? null,
                bestResalePrice: b.best_resale_price ?? null,
                bestResalePlatform: b.best_resale_platform ?? null,
            };
        });

        return res.json({ ok: true, books });
    } catch (error) {
        console.error('Admin provider-price-status error:', error);
        return res.status(500).json({ ok: false, error: error.message });
    }
});


router.post('/books/:bookId/reject', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const bookId = Number(req.params.bookId);
        if (!Number.isInteger(bookId) || bookId <= 0) {
            return res.status(400).json({ success: false, error: 'Invalid bookId' });
        }

        const existing = await loadBookForResponse(bookId);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'Book not found' });
        }

        const withMomoxStatus = await hasMomoxStatusColumn();
        const withBackendStatus = await hasBooksColumn('backend_status');
        const withNotSentReason = await hasBooksColumn('not_sent_reason');

        await pool.query(
            `
            UPDATE books SET
                status = 'bad',
                candidate_status = 'rejected',
                review_status = 'rejected',
                admin_status = 'rejected',
                skip_reason = COALESCE($2, 'Rejected by admin'),
                gibert_status = CASE
                    WHEN gibert_checked_at IS NULL
                         AND (gibert_status IS NULL OR gibert_status IN ('gibert_pending', 'not_sent'))
                        THEN 'not_sent'
                    ELSE gibert_status
                END,
                ${withMomoxStatus ? `
                momox_status = CASE
                    WHEN momox_status IS NULL OR momox_status IN ('momox_pending', 'not_sent')
                        THEN 'not_sent'
                    ELSE momox_status
                END,
                ` : ''}
                ${withBackendStatus ? `backend_status = 'rejected',` : ''}
                ${withNotSentReason ? `not_sent_reason = 'admin_rejected',` : ''}
                updated_at = NOW()
            WHERE id = $1
            `,
            [bookId, req.body?.reason || null]
        );

        let completion = null;
        try {
            completion = await refreshAdProviderCompletion(String(existing.ads_id));
        } catch (error) {
            console.error(`[admin reject book ${bookId}] completion refresh failed:`, error.message);
        }

        const book = await loadBookForResponse(bookId);

        return res.json({
            success: true,
            book,
            completion: completion?.counts || null,
        });
    } catch (error) {
        console.error('Admin reject book error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/scrape/ad', async (req, res) => {
    try {
        if (!checkAdminSecret(req, res)) return;

        const adUrl = String(req.body?.adUrl || '').trim();

        if (!adUrl) {
            return res.status(400).json({
                success: false,
                error: 'adUrl is required.',
            });
        }

        const job = await enqueueManualAdScrapeJob({ adUrl });

        return res.status(202).json({
            success: true,
            queued: true,
            jobId: job.id,
            type: job.type,
            status: job.status,
            stage: job.stage,
            progress: job.progress,
            adUrl,
        });
    } catch (error) {
        console.error('[admin scrape ad] queue error:', error);

        return res.status(500).json({
            success: false,
            error: error.message || 'Unable to queue ad scrape.',
        });
    }
});

router.post('/scrape/page-range', async (req, res) => {
    try {
        if (!checkAdminSecret(req, res)) return;

        const searchUrl = String(req.body?.searchUrl || '').trim();
        const fromPage = Number(req.body?.fromPage || 1);
        const toPage = Number(req.body?.toPage || fromPage);

        if (!searchUrl) {
            return res.status(400).json({
                success: false,
                error: 'searchUrl is required.',
            });
        }

        const result = await enqueuePageRangeScrapeJobs({
            searchUrl,
            fromPage,
            toPage,
        });

        return res.status(202).json({
            success: true,
            queued: true,
            fromPage: result.fromPage,
            toPage: result.toPage,
            // True when the URL was a direct ad URL: queued as apify_start_manual_ad
            // (the search-page actor cannot process direct ad URLs).
            ...(result.reroutedAsManualAd ? { reroutedAsManualAd: true } : {}),
            jobs: result.jobs.map((job) => ({
                jobId: job.id,
                type: job.type,
                status: job.status,
                stage: job.stage,
                progress: job.progress,
            })),
        });
    } catch (error) {
        console.error('[admin scrape page-range] queue error:', error);

        return res.status(500).json({
            success: false,
            error: error.message || 'Unable to queue page scrape.',
        });
    }
});


export default router;
