-- 005_catalog_verification_fields.sql
--
-- PROPOSAL — DO NOT RUN YET (shown for review first).
--
-- Phase 2 of the catalog-image edition-verification strategy. Stores the
-- catalog candidate (AbeBooks now; ISBNSearch / ISBNdb later) and the result of
-- comparing its cover image against the Leboncoin crop — SEPARATELY from the
-- existing provider fields, so catalog verification never overwrites or is
-- confused with Momox/Gibert provider images/prices.
--
-- Audit (live books table, 2026-06-15): all 11 columns below are MISSING. The
-- parallel provider/lookup columns already present and LEFT UNTOUCHED are:
--   provider_match_status / provider_match_reason / provider_match_source /
--   provider_match_confidence / provider_image_match_score /
--   provider_visual_similarity_score  (Momox/Gibert image verification)
--   lookup_title / lookup_authors / lookup_publisher / lookup_published_date /
--   lookup_candidates  (ISBNSearch bibliographic data)
--   source_image_url   (the Leboncoin crop we compare against)
--
-- DDL — requires the admin role (the app role cannot ALTER books). Additive and
-- idempotent (IF NOT EXISTS); no backfill needed. Code reads every column via
-- bookColumns.js hasBooksColumn(), so it no-ops until this is applied.

ALTER TABLE books
    -- The selected catalog candidate.
    ADD COLUMN IF NOT EXISTS catalog_source         text,        -- 'abebooks' | 'isbnsearch' | 'isbndb' | ...
    ADD COLUMN IF NOT EXISTS catalog_image_url       text,        -- catalog cover URL compared against source_image_url
    ADD COLUMN IF NOT EXISTS catalog_listing_url     text,
    ADD COLUMN IF NOT EXISTS catalog_title           text,
    ADD COLUMN IF NOT EXISTS catalog_author          text,
    ADD COLUMN IF NOT EXISTS catalog_publisher       text,
    ADD COLUMN IF NOT EXISTS catalog_year            integer,

    -- Result of the catalog-image vs Leboncoin-crop comparison.
    ADD COLUMN IF NOT EXISTS catalog_match_status    text,        -- match | likely_match | uncertain | mismatch | no_candidate | not_checked
    ADD COLUMN IF NOT EXISTS catalog_match_similarity numeric,    -- 0..1 visual cover likeness (high = same edition)
    ADD COLUMN IF NOT EXISTS catalog_match_confidence numeric,    -- 0..1 model confidence in the verdict
    ADD COLUMN IF NOT EXISTS catalog_verified_at     timestamptz; -- when the catalog comparison ran

-- Fast lookup of catalog-verified rows (the ones that may proceed to a provider).
CREATE INDEX IF NOT EXISTS idx_books_catalog_match_status
    ON books (catalog_match_status);
