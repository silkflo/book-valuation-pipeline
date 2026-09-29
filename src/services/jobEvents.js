// src/services/jobEvents.js
//
// Append-only backend timeline for the queue system (public.processing_job_events).
// processing_jobs stays the current-state table; this records the lifecycle so the
// admin UI can show scrape/process status.
//
// SAFETY: recording NEVER throws and never blocks the queue. If the migration
// (006_processing_job_events.sql) has not been applied yet, the table is missing →
// recording self-disables after one warning. Metadata is sanitized + size-capped and
// MUST NOT carry secrets/tokens/cookies/full raw payloads (call sites pass compact data;
// the sanitizer also redacts obviously-sensitive keys as a backstop).

import { pool } from '../db.js';

let eventsDisabled = false; // flips true when the table is missing -> graceful no-op

const SENSITIVE_KEY = /(token|secret|cookie|authorization|auth|password|passwd|api[-_]?key|bearer|credential|webhookurl)/i;
const MAX_STRING = 500;
const MAX_ARRAY = 25;
const MAX_JSON_BYTES = 6000;
const TABLE_MISSING = /relation .*processing_job_events.* does not exist/i;

function sanitize(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 4) return '[depth-capped]';
    if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitize(v, depth + 1);
        }
        return out;
    }
    return undefined;
}

function safeMetadata(metadata) {
    let obj;
    try { obj = sanitize(metadata && typeof metadata === 'object' ? metadata : {}); } catch { obj = {}; }
    try {
        const json = JSON.stringify(obj ?? {});
        if (json.length > MAX_JSON_BYTES) return JSON.stringify({ truncated: true, note: 'metadata exceeded size cap' });
        return json;
    } catch {
        return '{}';
    }
}

function clip(value, max = 2000) {
    return value == null ? null : String(value).slice(0, max);
}

// Best-effort parent lookup so a child payload job's events inherit its parent_job_id
// even when the caller doesn't pass it. Reads processing_jobs (always present); never throws.
async function lookupParentJobId(jobId) {
    try {
        const r = await pool.query('SELECT parent_job_id FROM public.processing_jobs WHERE id = $1', [jobId]);
        return r.rows[0]?.parent_job_id ?? null;
    } catch {
        return null;
    }
}

/**
 * Append one timeline event for a job. Non-throwing. Returns the new row id or null.
 */
export async function recordJobEvent(jobId, {
    parentJobId = null,
    eventType,
    stage = null,
    status = null,
    progress = null,
    severity = 'info',
    message = null,
    errorCode = null,
    errorMessage = null,
    metadata = {},
} = {}) {
    if (eventsDisabled || !jobId || !eventType) return null;

    // Inherit the job's parent_job_id when the caller didn't pass one, so child
    // payload-job events carry parent_job_id (fixes null-parent timeline rows).
    const resolvedParentJobId = parentJobId != null ? parentJobId : await lookupParentJobId(jobId);

    try {
        const result = await pool.query(
            `
            INSERT INTO public.processing_job_events
                (job_id, parent_job_id, event_type, stage, status, progress,
                 severity, message, error_code, error_message, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            RETURNING id
            `,
            [
                jobId,
                resolvedParentJobId || null,
                String(eventType),
                stage || null,
                status || null,
                Number.isInteger(progress) ? progress : null,
                String(severity || 'info'),
                clip(message),
                errorCode || null,
                clip(errorMessage),
                safeMetadata(metadata),
            ]
        );
        return result.rows[0]?.id || null;
    } catch (error) {
        if (TABLE_MISSING.test(error?.message || '')) {
            eventsDisabled = true;
            console.warn('[job-events] processing_job_events table missing — event recording disabled until migration 006 is applied.');
        } else {
            console.warn(`[job-events] failed to record ${eventType} for job=${jobId}: ${error?.message || error}`);
        }
        return null;
    }
}

/** Convenience: a progress snapshot event. */
export async function recordJobProgress(jobId, { stage = null, status = null, progress = null, message = null, metadata = {} } = {}) {
    return recordJobEvent(jobId, { eventType: 'progress', stage, status, progress, message, metadata });
}

/** Full timeline for one job (ascending). Non-throwing -> [] on any error. */
export async function getJobEvents(jobId, { limit = 200 } = {}) {
    if (eventsDisabled || !jobId) return [];
    try {
        const result = await pool.query(
            `
            SELECT id, job_id, parent_job_id, event_type, stage, status, progress,
                   severity, message, error_code, error_message, metadata, created_at
              FROM public.processing_job_events
             WHERE job_id = $1
             ORDER BY created_at ASC, id ASC
             LIMIT $2
            `,
            [jobId, Math.max(1, Math.min(Number(limit) || 200, 1000))]
        );
        return result.rows;
    } catch (error) {
        if (TABLE_MISSING.test(error?.message || '')) { eventsDisabled = true; return []; }
        console.warn(`[job-events] failed to read events for job=${jobId}: ${error?.message || error}`);
        return [];
    }
}

/** Last N events per job for a batch of job ids (for /jobs/status?includeEvents=true). */
export async function getRecentEventsForJobs(jobIds, { perJob = 5 } = {}) {
    if (eventsDisabled || !Array.isArray(jobIds) || !jobIds.length) return {};
    try {
        const result = await pool.query(
            `
            SELECT id, job_id, parent_job_id, event_type, stage, status, progress,
                   severity, message, error_code, error_message, metadata, created_at
              FROM (
                  SELECT e.*,
                         ROW_NUMBER() OVER (PARTITION BY e.job_id ORDER BY e.created_at DESC, e.id DESC) AS rn
                    FROM public.processing_job_events e
                   WHERE e.job_id = ANY($1::bigint[])
              ) t
             WHERE t.rn <= $2
             ORDER BY t.job_id ASC, t.created_at ASC, t.id ASC
            `,
            [jobIds.map(Number).filter(Number.isInteger), Math.max(1, Math.min(Number(perJob) || 5, 50))]
        );
        const byJob = {};
        for (const row of result.rows) {
            (byJob[row.job_id] ||= []).push(row);
        }
        return byJob;
    } catch (error) {
        if (TABLE_MISSING.test(error?.message || '')) { eventsDisabled = true; return {}; }
        console.warn(`[job-events] failed to read recent events: ${error?.message || error}`);
        return {};
    }
}
