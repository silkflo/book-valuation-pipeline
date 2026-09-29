// src/services/providerLookupLimiter.js
//
// One SHARED, in-process concurrency limiter for ALL paid provider price lookups
// (Momox / Gibert / Scrapfly), whether they originate from normal ad processing or
// from a manual admin action. It bounds how many provider scenarios run at once so we
// avoid 429s, blocked calls, and backend instability when ad processing and admin
// "Demander le prix" clicks overlap.
//
//   PROVIDER_LOOKUP_MAX_CONCURRENCY    max simultaneous provider lookups (default 1)
//   PROVIDER_LOOKUP_QUEUE_WARN_AFTER_MS warn once a lookup waited this long (default 30000)
//
// NOTE: this is a per-PROCESS limiter. With a single `books-api` PM2 instance it gives a
// true global cap. If books-api is ever scaled to multiple instances, this no longer
// serializes across them — a DB advisory lock (e.g. pg_advisory_lock) would be required.

function intEnv(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) ? n : fallback;
}

function maxConcurrency() {
    // Never below 1 (0 would deadlock every lookup).
    return Math.max(1, intEnv('PROVIDER_LOOKUP_MAX_CONCURRENCY', 1));
}

function warnAfterMs() {
    return Math.max(0, intEnv('PROVIDER_LOOKUP_QUEUE_WARN_AFTER_MS', 30000));
}

let active = 0;
const waiters = []; // FIFO queue of resolve() callbacks waiting for a slot

// Resolves immediately if a slot is free, otherwise when one is released (FIFO).
function acquire() {
    if (active < maxConcurrency()) {
        active += 1;
        return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
}

// Hands the freed slot directly to the next waiter (keeps `active` accurate).
function release() {
    if (waiters.length) {
        const next = waiters.shift();
        next(); // slot stays accounted (no decrement): ownership transfers to the waiter
        return;
    }
    active = Math.max(0, active - 1);
}

/**
 * Run one provider lookup under the shared concurrency cap. Returns fn()'s result and
 * re-throws its error unchanged; the slot is always released. Logs queued/start/done/failed.
 *
 * @param {string}   label  short context for logs, e.g. `momox adsId=123`
 * @param {Function} fn     () => Promise<any> performing the actual provider call
 */
export async function runProviderLookup(label, fn) {
    const queuedAt = Date.now();
    const willQueue = active >= maxConcurrency();
    if (willQueue) {
        console.log(`[provider-limiter] queued label=${label} active=${active} waiting=${waiters.length}`);
    }

    await acquire();

    const waitedMs = Date.now() - queuedAt;
    if (waitedMs >= warnAfterMs()) {
        console.warn(`[provider-limiter] long-wait label=${label} waited_ms=${waitedMs}`);
    }

    const startedAt = Date.now();
    console.log(`[provider-limiter] start label=${label}${willQueue ? ` waited_ms=${waitedMs}` : ''}`);

    try {
        const result = await fn();
        console.log(`[provider-limiter] done label=${label} duration_ms=${Date.now() - startedAt}`);
        return result;
    } catch (error) {
        console.log(`[provider-limiter] failed label=${label} duration_ms=${Date.now() - startedAt} err=${error?.message || error}`);
        throw error;
    } finally {
        release();
    }
}

// Test/diagnostics only.
export function providerLimiterStats() {
    return { active, waiting: waiters.length, maxConcurrency: maxConcurrency() };
}
