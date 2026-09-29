-- Technical cost events: one row per paid provider call (Scrapfly, Apify, OpenAI...).
-- Referenced by src/services/costEvents.js.

CREATE TABLE IF NOT EXISTS technical_cost_events (
    id          BIGSERIAL PRIMARY KEY,
    ads_id      TEXT,
    book_id     BIGINT,
    cost_type   TEXT NOT NULL,
    provider    TEXT NOT NULL,
    amount      NUMERIC NOT NULL,
    currency    TEXT,
    unit_count  INTEGER,
    unit_type   TEXT,
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_technical_cost_events_ads_id
    ON technical_cost_events (ads_id);

CREATE INDEX IF NOT EXISTS idx_technical_cost_events_provider_type
    ON technical_cost_events (provider, cost_type);

CREATE INDEX IF NOT EXISTS idx_technical_cost_events_created_at
    ON technical_cost_events (created_at);
