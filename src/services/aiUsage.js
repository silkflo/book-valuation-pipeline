// src/services/aiUsage.js
//
// Phase A AI cost OBSERVABILITY (no behavior change). A thin, non-invasive wrapper
// around every `openai.responses.create(...)` call site that:
//   - measures duration + reads token usage from the response,
//   - keeps in-memory per-ad counters for a [ai-usage] summary,
//   - logs a [ai-call] line when AI_COST_DEBUG=1,
//   - records a technical_cost_events row (REUSES the existing cost system) for the
//     previously-untracked expensive sites (catalog cover verify, crop retry, AI
//     fallback v2). Sites that already persist their own cost event pass
//     persistCost:false so we never double-count.
//
// Contract: the wrapper NEVER changes call behavior. It returns exactly what fn()
// returns and re-throws the original error unchanged. All logging / counters /
// cost-event writes are defensive and can never fail ad processing.

import { saveTechnicalCostEvent } from './costEvents.js';

function inputUsdPer1M() {
    const n = Number(process.env.OPENAI_INPUT_USD_PER_1M || 0);
    return Number.isFinite(n) ? n : 0;
}
function outputUsdPer1M() {
    const n = Number(process.env.OPENAI_OUTPUT_USD_PER_1M || 0);
    return Number.isFinite(n) ? n : 0;
}
function estimateUsd({ inputTokens, outputTokens }) {
    const usd = (inputTokens / 1_000_000) * inputUsdPer1M() + (outputTokens / 1_000_000) * outputUsdPer1M();
    return Number(usd.toFixed(6));
}

// Per-call-site model routing. Returns the site-specific override env if set, else the
// global OPENAI_MODEL, else the existing built-in default. Pure (env-only), no side effects.
export function getOpenAiModelForCallSite(callSite) {
    const fallback = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
    const bySite = {
        pass1_extract: process.env.OPENAI_PASS1_MODEL,
        pass2_crop_retry: process.env.OPENAI_PASS2_CROP_MODEL,
        catalog_cover_verify: process.env.OPENAI_CATALOG_VERIFY_MODEL,
        ai_isbn_inline: process.env.OPENAI_AI_ISBN_INLINE_MODEL,
        ai_isbn_fallback_v2: process.env.OPENAI_AI_ISBN_FALLBACK_MODEL,
        provider_image_verify: process.env.OPENAI_PROVIDER_IMAGE_VERIFY_MODEL,
    };
    return bySite[callSite] || fallback;
}

// Reads usage from a Responses API (input_tokens/output_tokens) or Chat Completions
// (prompt_tokens/completion_tokens) shape; missing usage -> zeros (still counts the call).
export function readOpenAiUsage(response) {
    const u = response?.usage || {};
    const inputTokens = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
    const outputTokens = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
    const totalTokens = Number(u.total_tokens ?? inputTokens + outputTokens) || inputTokens + outputTokens;
    return { inputTokens, outputTokens, totalTokens };
}

// ---------------------------------------------------------------------------
// Ambient ad context: ads are processed sequentially in processApifyPayload, so a
// single "current ad" correctly attributes deeply-nested AI calls (e.g. catalog
// cover verify) without threading adsId through every signature. Call sites that
// already have adsId pass it explicitly and take precedence over the ambient value.
// ---------------------------------------------------------------------------
let currentAdsId = null;
export function setCurrentAd(adsId) {
    currentAdsId = adsId || null;
}

// adsId -> { calls, images, inputTokens, outputTokens, estUsd, ok, failed, bySite }
const adCounters = new Map();
function counterFor(adsId) {
    const key = adsId || '_no_ad';
    if (!adCounters.has(key)) {
        adCounters.set(key, { calls: 0, images: 0, inputTokens: 0, outputTokens: 0, estUsd: 0, ok: 0, failed: 0, bySite: {} });
    }
    return adCounters.get(key);
}

let configLogged = false;
// Logs the AI config once (startup or first AI call) + a one-time warning when the
// OpenAI price env vars are zero/missing (cost estimates will read zero).
export function logAiConfigOnce() {
    if (configLogged) return;
    configLogged = true;
    try {
        console.log(
            `[ai-config] model_default=${process.env.OPENAI_MODEL || 'gpt-5.4-mini'} ` +
            `pass1=${getOpenAiModelForCallSite('pass1_extract')} ` +
            `pass2_crop=${getOpenAiModelForCallSite('pass2_crop_retry')} ` +
            `catalog=${getOpenAiModelForCallSite('catalog_cover_verify')} ` +
            `ai_isbn_inline=${getOpenAiModelForCallSite('ai_isbn_inline')} ` +
            `ai_fallback=${getOpenAiModelForCallSite('ai_isbn_fallback_v2')} ` +
            `provider_image=${getOpenAiModelForCallSite('provider_image_verify')} ` +
            `cost_debug=${process.env.AI_COST_DEBUG === '1' ? 1 : 0} ` +
            `catalog_max_compare=${process.env.CATALOG_MATCH_MAX_COMPARE || '(default 10)'} ` +
            `catalog_max_books=${process.env.CATALOG_MAX_KEYWORD_SEARCHES_PER_AD || '(default 15)'} ` +
            `ai_fb_max_books=${process.env.AI_FB_MAX_BOOKS_PER_AD ?? '(default 0=unlimited)'} ` +
            `ai_isbn_fallback=${process.env.ENABLE_AI_ISBN_FALLBACK === 'true' ? 'on' : 'off'} ` +
            `provider_image_verify=${process.env.ENABLE_PROVIDER_IMAGE_VERIFY === 'true' ? 'on' : 'off'}`
        );
        if (inputUsdPer1M() === 0 || outputUsdPer1M() === 0) {
            console.warn('[ai-cost] OPENAI_INPUT_USD_PER_1M / OPENAI_OUTPUT_USD_PER_1M are zero or missing; cost estimates will be zero.');
        }
    } catch { /* never throw */ }
}

function recordCounter({ adsId, callSite, imageCount, usage, ok }) {
    try {
        const c = counterFor(adsId);
        c.calls += 1;
        c.images += Number(imageCount) || 0;
        c.inputTokens += usage.inputTokens;
        c.outputTokens += usage.outputTokens;
        c.estUsd += estimateUsd(usage);
        if (ok) c.ok += 1; else c.failed += 1;
        c.bySite[callSite] = (c.bySite[callSite] || 0) + 1;
    } catch { /* never throw */ }
}

/**
 * Wrap one OpenAI call for observability. Returns fn()'s result unchanged; re-throws
 * fn()'s error unchanged. Logging/counters/cost-events are best-effort and never throw.
 *
 * @param {object}   a
 * @param {string}   a.callSite      stable id: pass1_extract | pass2_crop_retry | catalog_cover_verify | ai_isbn_inline | provider_image_verify | ai_isbn_fallback_v2
 * @param {string}   [a.adsId]       explicit ad id (falls back to the ambient current ad)
 * @param {number}   [a.bookId]
 * @param {string}   [a.model]
 * @param {string}   [a.inputKind]   text | image_url | base64 | multi_image
 * @param {number}   [a.imageCount]
 * @param {string}   [a.costType]    technical_cost_events cost_type (only when persistCost)
 * @param {boolean}  [a.persistCost] persist a cost event (false for sites that already do)
 * @param {Function} a.fn            () => openai.responses.create({...})
 */
export async function trackedOpenAiCall({
    callSite,
    adsId = null,
    bookId = null,
    model = null,
    inputKind = null,
    imageCount = 0,
    costType = null,
    persistCost = true,
    fn,
}) {
    logAiConfigOnce();

    const ad = adsId || currentAdsId;
    // Resolve the per-call-site model (explicit `model` wins, else site override, else
    // OPENAI_MODEL). Injected into fn so the ACTUAL create() model == the logged/recorded one.
    const usedModel = model || getOpenAiModelForCallSite(callSite);
    const start = Date.now();

    let response;
    let ok = true;
    let caught = null;
    try {
        response = await fn(usedModel);
    } catch (error) {
        ok = false;
        caught = error;
    }

    const durationMs = Date.now() - start;
    const usage = ok ? readOpenAiUsage(response) : { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const estUsd = estimateUsd(usage);

    recordCounter({ adsId: ad, callSite, imageCount, usage, ok });

    if (process.env.AI_COST_DEBUG === '1') {
        try {
            console.log(
                `[ai-call] site=${callSite} ads_id=${ad || '-'} book_id=${bookId || '-'} model=${usedModel} ` +
                `images=${imageCount} duration_ms=${durationMs} ok=${ok} ` +
                `tokens_in=${usage.inputTokens} tokens_out=${usage.outputTokens} estimated_cost_usd=${estUsd}` +
                (caught ? ` err=${String(caught?.message || caught).slice(0, 120)}` : '')
            );
        } catch { /* never throw */ }
    }

    if (persistCost && costType) {
        try {
            await saveTechnicalCostEvent({
                adsId: ad,
                bookId,
                costType,
                provider: 'openai',
                amount: estUsd,
                amountUsd: estUsd,
                currency: 'USD',
                unitCount: usage.totalTokens,
                unitType: 'tokens',
                metadata: {
                    callSite,
                    model: usedModel,
                    inputKind,
                    imageCount,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens: usage.totalTokens,
                    durationMs,
                    ok,
                    cacheHit: false,
                },
            });
        } catch (e) {
            console.warn(`[ai-cost] cost event failed for ${callSite}: ${e?.message || e}`);
        }
    }

    if (!ok) throw caught; // preserve existing error handling exactly
    return response;
}

// Emits the per-ad [ai-usage] summary and clears the ad's counters. Never throws.
// Safe to call once per ad (e.g. in processApifyPayload's per-ad finally block).
export function summarizeAdAiUsage(adsId) {
    try {
        const key = adsId || '_no_ad';
        const c = adCounters.get(key);
        if (!c || !c.calls) {
            adCounters.delete(key);
            return null;
        }
        const estUsd = Number(c.estUsd.toFixed(6));
        console.log(
            `[ai-usage] ads_id=${adsId || '-'} calls=${c.calls} images=${c.images} ` +
            `input_tokens=${c.inputTokens} output_tokens=${c.outputTokens} ` +
            `failed=${c.failed} estimated_cost_usd=${estUsd}`
        );
        const bySite = Object.entries(c.bySite).map(([s, n]) => `${s}=${n}`).join(' ') || '(none)';
        console.log(`[ai-usage] by_site ${bySite}`);
        adCounters.delete(key);
        return { ...c, estUsd };
    } catch {
        return null;
    }
}
