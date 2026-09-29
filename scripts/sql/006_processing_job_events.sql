-- Append-only backend timeline for the queue system. Current state stays in
-- public.processing_jobs; this table records WHAT happened and WHEN, so the admin UI
-- can show scrape/process status. Referenced by src/services/jobEvents.js.
-- Idempotent; safe to re-run. Apply as the admin DB role (app role has no DDL rights).

CREATE TABLE IF NOT EXISTS public.processing_job_events (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT NOT NULL REFERENCES public.processing_jobs(id) ON DELETE CASCADE,
    parent_job_id   BIGINT NULL REFERENCES public.processing_jobs(id) ON DELETE SET NULL,
    event_type      TEXT NOT NULL,
    stage           TEXT NULL,
    status          TEXT NULL,
    progress        INT NULL,
    severity        TEXT NOT NULL DEFAULT 'info',
    message         TEXT NULL,
    error_code      TEXT NULL,
    error_message   TEXT NULL,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processing_job_events_job_created
    ON public.processing_job_events (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_processing_job_events_parent_created
    ON public.processing_job_events (parent_job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_processing_job_events_severity_created
    ON public.processing_job_events (severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_processing_job_events_type_created
    ON public.processing_job_events (event_type, created_at DESC);
