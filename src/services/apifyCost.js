// src/services/apifyCost.js

import { pool } from '../db.js';
import { saveTechnicalCostEvent } from './costEvents.js';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function roundUsd(value) {
    const n = toNumber(value);
    if (n === null) return null;
    return Number(n.toFixed(6));
}

function normalizePayloadItems(payload) {
    if (Array.isArray(payload)) {
        return payload;
    }

    if (payload && Array.isArray(payload.items)) {
        return payload.items;
    }

    if (payload && Array.isArray(payload.data)) {
        return payload.data;
    }

    return [];
}

function extractApifyRunInfo(payload) {
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

        actorTaskId:
            payload?.apifyActorTaskId ||
            payload?.actorTaskId ||
            firstItem.apifyActorTaskId ||
            firstItem.actorTaskId ||
            null,
    };
}

function extractAdsIdsFromPayload(payload, result = {}) {
    const ids = new Set();

    const items = normalizePayloadItems(payload);

    for (const item of items) {
        const id = item?.adsId || item?.ads_id || item?.id;

        if (id) {
            ids.add(String(id));
        }
    }

    if (Array.isArray(result?.ads)) {
        for (const ad of result.ads) {
            const id = ad?.adsId || ad?.ads_id || ad?.id;

            if (id) {
                ids.add(String(id));
            }
        }
    }

    if (Array.isArray(result?.items)) {
        for (const item of result.items) {
            const id = item?.adsId || item?.ads_id || item?.id;

            if (id) {
                ids.add(String(id));
            }
        }
    }

    return Array.from(ids);
}

function pickRunCostUsd(run) {
    const candidates = [
        run?.usageTotalUsd,
        run?.usageUsd,
        run?.stats?.usageTotalUsd,
        run?.stats?.usageUsd,
        run?.usage?.totalUsd,
        run?.usage?.usd,
    ];

    for (const value of candidates) {
        const n = toNumber(value);

        if (n !== null && n >= 0) {
            return roundUsd(n);
        }
    }

    return null;
}

async function fetchApifyRun(runId) {
    const token = process.env.APIFY_TOKEN;

    if (!token) {
        console.warn('APIFY_TOKEN is missing. Apify cost capture skipped.');
        return null;
    }

    if (!runId) {
        return null;
    }

    const url = new URL(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`);
    url.searchParams.set('token', token);

    const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `Apify run fetch failed ${response.status}: ${text.slice(0, 1000)}`
        );
    }

    let parsed;

    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`Apify run JSON parse failed: ${text.slice(0, 1000)}`);
    }

    return parsed.data || parsed;
}

async function hasExistingApifyCostEvent({ adsId, runId }) {
    const result = await pool.query(
        `
        SELECT id
          FROM public.technical_cost_events
         WHERE ads_id = $1
           AND provider = 'apify'
           AND cost_type = 'apify_actor_run'
           AND metadata->>'runId' = $2
         LIMIT 1
        `,
        [String(adsId), String(runId)]
    );

    return result.rowCount > 0;
}

async function saveApifyRunCostForAds({
    runId,
    actorId = null,
    actorTaskId = null,
    adsIds,
    payloadSource = null,
}) {
    if (!runId) {
        return {
            saved: 0,
            skipped: true,
            reason: 'missing_run_id',
        };
    }

    const uniqueAdsIds = Array.from(new Set((adsIds || []).map(String).filter(Boolean)));

    if (!uniqueAdsIds.length) {
        return {
            saved: 0,
            skipped: true,
            reason: 'missing_ads_ids',
            runId,
        };
    }

    const run = await fetchApifyRun(runId);

    if (!run) {
        return {
            saved: 0,
            skipped: true,
            reason: 'missing_run',
            runId,
        };
    }

    const totalRunCostUsd = pickRunCostUsd(run);

    if (totalRunCostUsd === null) {
        console.warn(`Apify run ${runId}: no USD cost field found yet.`);
        return {
            saved: 0,
            skipped: true,
            reason: 'missing_cost',
            runId,
            status: run.status || null,
        };
    }

    const costPerAdUsd = roundUsd(totalRunCostUsd / uniqueAdsIds.length);

    if (costPerAdUsd === null) {
        return {
            saved: 0,
            skipped: true,
            reason: 'invalid_cost_per_ad',
            runId,
        };
    }

    let saved = 0;
    let alreadyExists = 0;

    for (const adsId of uniqueAdsIds) {
        const exists = await hasExistingApifyCostEvent({
            adsId,
            runId,
        });

        if (exists) {
            alreadyExists += 1;
            continue;
        }

        await saveTechnicalCostEvent({
            adsId,
            costType: 'apify_actor_run',
            provider: 'apify',
            amount: costPerAdUsd,
            amountUsd: costPerAdUsd,
            currency: 'USD',
            unitCount: 1,
            unitType: 'run_share',
            metadata: {
                runId,
                actorId,
                actorTaskId,
                payloadSource,
                runStatus: run.status || null,
                totalRunCostUsd,
                adsCount: uniqueAdsIds.length,
                costPerAdUsd,
                startedAt: run.startedAt || null,
                finishedAt: run.finishedAt || null,
                usageUsd: run.usageUsd ?? null,
                usageTotalUsd: run.usageTotalUsd ?? null,
                usage: run.usage || null,
                stats: run.stats || null,
            },
        });

        saved += 1;
    }

    return {
        saved,
        alreadyExists,
        skipped: false,
        runId,
        status: run.status || null,
        totalRunCostUsd,
        adsCount: uniqueAdsIds.length,
        costPerAdUsd,
    };
}

export function queueApifyRunCostCapture({ payload, result = {} }) {
    const runInfo = extractApifyRunInfo(payload);
    const adsIds = extractAdsIdsFromPayload(payload, result);

    if (!runInfo.runId || !adsIds.length) {
        return {
            queued: false,
            runId: runInfo.runId,
            adsCount: adsIds.length,
            reason: !runInfo.runId ? 'missing_run_id' : 'missing_ads_ids',
        };
    }

    const delayMs = Number(process.env.APIFY_COST_CAPTURE_DELAY_MS || 15000);

    setTimeout(async () => {
        try {
            await sleep(0);

            const captureResult = await saveApifyRunCostForAds({
                runId: runInfo.runId,
                actorId: runInfo.actorId,
                actorTaskId: runInfo.actorTaskId,
                adsIds,
                payloadSource:
                    payload?.source ||
                    payload?.mode ||
                    normalizePayloadItems(payload)[0]?.source ||
                    null,
            });

            console.log('Apify cost capture result:', captureResult);
        } catch (error) {
            console.warn(
                `Apify cost capture failed for run ${runInfo.runId}:`,
                error?.message || error
            );
        }
    }, delayMs);

    return {
        queued: true,
        runId: runInfo.runId,
        actorId: runInfo.actorId,
        actorTaskId: runInfo.actorTaskId,
        adsCount: adsIds.length,
        delayMs,
    };
}
