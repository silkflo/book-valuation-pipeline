-- Persistent queue for ASYNC manual provider price lookups (admin "Demander le prix").
-- The HTTP endpoint enqueues a row and returns 202 immediately; a background worker
-- (providerPriceWorker) processes jobs FIFO, one at a time, through the existing
-- Momox/Gibert updaters + providerLookupLimiter. Additive + idempotent. Apply as the
-- admin DB role (the app role has no DDL rights).

CREATE TABLE IF NOT EXISTS public.provider_price_jobs (
    id                  BIGSERIAL PRIMARY KEY,
    book_id             BIGINT NOT NULL REFERENCES public.books(id) ON DELETE CASCADE,
    ads_id              TEXT,
    isbn                TEXT,
    requested_providers TEXT[] NOT NULL DEFAULT ARRAY['momox', 'gibert'],
    status              TEXT NOT NULL DEFAULT 'queued',  -- queued | running | processed | failed
    stage               TEXT,
    attempts            INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 2,
    locked_by           TEXT,
    locked_at           TIMESTAMPTZ,
    error_code          TEXT,
    error_message       TEXT,
    result              JSONB,
    requested_by_user_id TEXT,
    requested_by_name   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ
);

-- Duplicate-click guard: at most ONE active (queued/running) job per book at any time.
-- Used as the ON CONFLICT target so a second click reuses the active job instead of
-- creating a duplicate (race-safe at the DB level).
CREATE UNIQUE INDEX IF NOT EXISTS provider_price_jobs_active_book_uniq
    ON public.provider_price_jobs (book_id)
    WHERE status IN ('queued', 'running');

-- FIFO claim index for the worker (queued jobs, oldest first).
CREATE INDEX IF NOT EXISTS provider_price_jobs_claim_idx
    ON public.provider_price_jobs (created_at)
    WHERE status = 'queued';

-- Status-endpoint lookups: latest job per book.
CREATE INDEX IF NOT EXISTS provider_price_jobs_book_idx
    ON public.provider_price_jobs (book_id, id DESC);
