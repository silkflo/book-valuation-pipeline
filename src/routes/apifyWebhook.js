// src/routes/apifyWebhook.js

import express from 'express';
import { processApifyPayload } from '../workflows/processApifyPayload.js';
import { updateMomoxPriceFromPayload } from '../services/updateMomoxPrice.js';
import { updateGibertPricesForAd } from '../services/updateGibertBatch.js';
import { updateMomoxPricesForAd } from '../services/updateMomoxBatch.js';
import { refreshAdProviderCompletion } from '../services/adStatus.js';
import { queueApifyRunCostCapture } from '../services/apifyCost.js';
import { enqueueApifyPayloadProcessingJob, getJobsStatus, attachParentJob } from '../services/processingJobs.js';
import { completeApifyStartJobForWebhook, failApifyStartJobForUnsupportedWebhookMode, isApifyFailureWebhook, markApifyStartJobFailedFromWebhook } from '../services/apifyStartQueue.js';
import { recordJobEvent } from '../services/jobEvents.js';
import { verifyProviderImagesForAd } from '../services/providerImageVerifyForAd.js';
import { runProviderLookup } from '../services/providerLookupLimiter.js';

const router = express.Router();

export function checkWebhookSecret(req, res) {
    const secret = req.query.secret || req.headers['x-webhook-secret'];

    if (!process.env.WEBHOOK_SECRET) {
        res.status(500).json({
            success: false,
            error: 'Server missing WEBHOOK_SECRET',
        });
        return false;
    }

    if (secret !== process.env.WEBHOOK_SECRET) {
        res.status(401).json({
            success: false,
            error: 'Invalid webhook secret',
        });
        return false;
    }

    return true;
}


function webhookProcessingMode() {
    return String(process.env.WEBHOOK_PROCESSING_MODE || 'queue').toLowerCase();
}




// Gibert runs ONCE at workflow level after all ISBN candidate rows are saved.
// It is intentionally NOT scheduled from individual Momox webhooks anymore:
// that caused duplicated/partial Gibert updates per ad.

router.post('/apify', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        console.log('Webhook received');
        console.log('Payload is array:', Array.isArray(req.body));
        console.log(
            'Payload item count:',
            Array.isArray(req.body)
                ? req.body.length
                : Array.isArray(req.body?.items)
                    ? req.body.items.length
                    : 'not array'
        );

        // Actor FAILURE webhook (403 / timeout / no records): mark the matching
        // apify_start_% job failed + record a timeline event. Do NOT enqueue a payload
        // job, and do NOT touch the normal success path below.
        if (isApifyFailureWebhook(req.body)) {
            const outcome = await markApifyStartJobFailedFromWebhook(req.body);

            console.log('Apify failure webhook handled:', {
                mode: req.body?.mode || null,
                runId: req.body?.apifyRunId || null,
                jobId: outcome.job?.id || null,
                unmatched: outcome.unmatched || false,
                alreadyHandled: outcome.alreadyHandled || false,
                alreadyProcessed: outcome.alreadyProcessed || false,
            });

            if (outcome.unmatched) {
                return res.status(200).json({ success: true, handledFailure: false, unmatched: true });
            }

            return res.status(200).json({
                success: true,
                handledFailure: true,
                jobId: outcome.job?.id != null ? String(outcome.job.id) : null,
                status: outcome.job?.status || 'failed',
                stage: outcome.job?.stage || 'apify_run_failed',
                ...(outcome.alreadyHandled ? { alreadyHandled: true } : {}),
                ...(outcome.alreadyProcessed ? { alreadyProcessed: true } : {}),
            });
        }

        // Per-record search webhooks (sendWebhookPerRecord=true). Not fully supported yet:
        // handle SAFELY so the actor's per-record callbacks never crash the backend or
        // create stuck apify_payload_processing jobs. (Run the actor with
        // sendWebhookPerRecord=false until full support lands.)
        const mode = String(req.body?.mode || '').trim();
        if (mode === 'search_page_item') {
            // One scraped item arriving on its own — do NOT enqueue a payload job and do NOT
            // complete the parent start job. This run will never deliver a payload the
            // backend can process, so FAIL the parent start job terminally — leaving it at
            // apify_running/40% would hold the Apify-active lock and block the whole queue.
            // Acknowledge with 200 so Apify does not retry.
            let failedStartJobId = null;
            let matchedBy = null;
            try {
                const outcome = await failApifyStartJobForUnsupportedWebhookMode(req.body);
                failedStartJobId = outcome?.job?.id ?? null;
                matchedBy = outcome?.matchedBy ?? null;
            } catch (failError) {
                console.warn(`[apify-webhook] unsupported mode=${mode}: could not fail parent start job; ignoring safely: ${failError?.message || failError}`);
            }
            console.warn(`[apify-webhook] unsupported mode=${mode}; not enqueuing; failedStartJob=${failedStartJobId || '-'} matchedBy=${matchedBy || '-'}`);
            return res.status(200).json({
                success: true,
                ignored: true,
                reason: 'unsupported_webhook_mode',
                mode,
                failedStartJobId: failedStartJobId != null ? String(failedStartJobId) : null,
                matchedBy,
            });
        }
        if (mode === 'search_page_completed') {
            // End-of-run marker: release the Apify-active lock by completing the matching
            // start job if we can match it; otherwise ignore safely. Never throw.
            let completedStartJobId = null;
            let matchedBy = null;
            try {
                const completion = await completeApifyStartJobForWebhook(req.body?.apifyRunId || req.body?.actorRunId);
                completedStartJobId = completion?.job?.id ?? null;
                matchedBy = completion?.matchedBy ?? null;
            } catch (completeError) {
                console.warn(`[apify-webhook] search_page_completed: could not complete start job; ignoring safely: ${completeError?.message || completeError}`);
            }
            console.log(`[apify-webhook] mode=${mode} handled (no payload job); completedStartJob=${completedStartJobId || '-'} matchedBy=${matchedBy || '-'}`);
            return res.status(200).json({
                success: true,
                ignored: completedStartJobId == null,
                mode,
                completedStartJobId: completedStartJobId != null ? String(completedStartJobId) : null,
                matchedBy,
            });
        }

        if (webhookProcessingMode() === 'queue') {
            const queued = await enqueueApifyPayloadProcessingJob(req.body, {
                source: 'webhook_apify',
            });

            // Release the Apify-active lock: complete the matching apify_start_% job for
            // THIS run so the next Apify run may start. Independent of backend payload
            // processing (the payload job is already queued above and runs sequentially
            // via the backend worker). Failures here must not break the 202.
            let startJob = null;
            let startMatchedBy = null;
            try {
                const completion = await completeApifyStartJobForWebhook(queued.runInfo?.runId);
                startJob = completion.job;
                startMatchedBy = completion.matchedBy;
                if (startJob?.id && queued.job?.id) {
                    await attachParentJob(queued.job.id, startJob.id);
                }
            } catch (linkError) {
                console.error('Webhook: failed to complete apify_start job / link parent:', linkError?.message || linkError);
            }

            // Timeline: webhook landed for the payload job (compact counts only, no raw body).
            // Recorded AFTER the parent link above so the event carries parent_job_id.
            if (queued.job?.id) {
                const itemCount = Array.isArray(req.body)
                    ? req.body.length
                    : Array.isArray(req.body?.items) ? req.body.items.length : null;
                await recordJobEvent(queued.job.id, {
                    parentJobId: startJob?.id || null,
                    eventType: 'webhook_received',
                    stage: 'webhook_received',
                    status: queued.job.status || 'queued',
                    progress: 25,
                    message: 'Apify webhook received',
                    metadata: { runId: queued.runInfo?.runId || null, itemCount, adsCount: queued.adsIds?.length || 0 },
                });
            }

            console.log('Webhook queued:', {
                jobId: queued.job?.id,
                status: queued.job?.status,
                adsIds: queued.adsIds,
                runId: queued.runInfo?.runId,
                apifyStartJobId: startJob?.id || null,
                startMatchedBy,
            });

            return res.status(202).json({
                success: true,
                queued: true,
                jobId: queued.job?.id,
                status: queued.job?.status,
                stage: queued.job?.stage,
                progress: queued.job?.progress,
                adsIds: queued.adsIds,
                apifyRunId: queued.runInfo?.runId || null,
                apifyStartJobId: startJob?.id || null,
            });
        }

        // Compatibility fallback: old behavior.
        const result = await processApifyPayload(req.body);

        console.log('Webhook process result:', result);

        const apifyCostCapture = queueApifyRunCostCapture({
            payload: req.body,
            result,
        });

        console.log('Apify cost capture queued:', apifyCostCapture);

        return res.json({
            success: true,
            ...result,
            apifyCostCapture,
        });
    } catch (error) {
        console.error('Webhook error:', error);

        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Per-book results from the Momox APIFY FALLBACK actor.
router.post('/momox', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        console.log('Momox webhook received:', req.body);

        const result = await updateMomoxPriceFromPayload(req.body);

        console.log('Momox update result:', result);

        return res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        console.error('Momox webhook error:', error);

        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Manual/admin trigger: run one Momox Scrapfly batch for an ad.
router.post('/momox-batch/ad/:adsId', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const adsId = String(req.params.adsId || '').trim();
        const limit = Number(req.body?.limit || req.query.limit || 30);
        const isbns = Array.isArray(req.body?.isbns) ? req.body.isbns : null;

        if (!adsId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid adsId',
            });
        }

        const result = await runProviderLookup(`momox adsId=${adsId} (manual-batch)`, () => updateMomoxPricesForAd({
            adsId,
            isbns,
            limit,
        }));

        const completion = await refreshAdProviderCompletion(adsId);

        return res.json({
            success: true,
            ...result,
            completion: completion?.counts || null,
        });
    } catch (error) {
        console.error('Manual Momox batch error:', error);

        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Manual/admin trigger: run one Gibert Scrapfly batch for an ad.
router.post('/gibert/ad/:adsId', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const adsId = String(req.params.adsId || '').trim();
        const limit = Number(req.body?.limit || req.query.limit || 30);
        const isbns = Array.isArray(req.body?.isbns) ? req.body.isbns : null;

        if (!adsId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid adsId',
            });
        }

        const result = await runProviderLookup(`gibert adsId=${adsId} (manual-batch)`, () => updateGibertPricesForAd({
            adsId,
            isbns,
            limit,
        }));

        const completion = await refreshAdProviderCompletion(adsId);

        return res.json({
            success: true,
            ...result,
            completion: completion?.counts || null,
        });
    } catch (error) {
        console.error('Manual Gibert batch error:', error);

        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Manual/admin trigger: run provider IMAGE verification for an ad.
router.post('/verify-images/ad/:adsId', async (req, res) => {
    try {
        if (!checkWebhookSecret(req, res)) return;

        const adsId = String(req.params.adsId || '').trim();
        const limit = req.body?.limit || req.query.limit || null;

        if (!adsId) {
            return res.status(400).json({ success: false, error: 'Invalid adsId' });
        }

        const result = await verifyProviderImagesForAd({ adsId, limit: limit ? Number(limit) : null });
        const completion = await refreshAdProviderCompletion(adsId);

        return res.json({
            success: true,
            ...result,
            completion: completion?.counts || null,
        });
    } catch (error) {
        console.error('Manual image-verify error:', error);

        return res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

export default router;
