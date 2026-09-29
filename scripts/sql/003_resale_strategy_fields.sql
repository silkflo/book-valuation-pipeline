-- 003_resale_strategy_fields.sql
--
-- Backend resale-strategy refactor (Phase A): adds the genuinely-new matching
-- fields and makes provider price columns display-safe (never NULL, default 0).
--
-- APPLY ORDER (with the table-owner/admin role — books_user cannot run DDL):
--   1. scripts/sql/add_momox_status.sql   (adds books.momox_status + backfills
--                                           it from the CURRENT status/price,
--                                           while price still distinguishes
--                                           "not checked" (NULL) from "no offer" (0))
--   2. THIS FILE                           (adds new columns, then zeroes the
--                                           NULL prices)
--
-- Why the order matters: once prices are zeroed below, NULL no longer means
-- "not checked" — the per-row momox_status / gibert_status columns become the
-- source of truth for retryability. add_momox_status.sql must run first so the
-- backfill can still read the old NULL prices.
--
-- Existing columns are REUSED (not re-added): lookup_candidates (= isbnsearch
-- candidates), momox_title_match_score / gibert_title_match_score (= provider
-- title match score per provider), admin_status (= admin review status).

-- New matching / provenance fields ----------------------------------------
ALTER TABLE books ADD COLUMN IF NOT EXISTS ai_isbn_candidates       JSONB;
ALTER TABLE books ADD COLUMN IF NOT EXISTS ai_isbn_confidence       NUMERIC;
ALTER TABLE books ADD COLUMN IF NOT EXISTS ai_isbn_reason           TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS selected_isbn            TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS selected_isbn_source     TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS provider_match_status    TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS provider_match_reason    TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS provider_image_match_score NUMERIC;

-- Phase B image-verification + audit fields --------------------------------
-- provider_match_source: momox_image | gibert_image | title_only | none
-- backend_status:        canonical status the book-app reads (deriveBackendStatus)
-- not_sent_reason:       why a row was never sent to a provider
ALTER TABLE books ADD COLUMN IF NOT EXISTS provider_match_source    TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS backend_status           TEXT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS not_sent_reason          TEXT;

-- Image-verify score clarity (Finding 3): provider_image_match_score now means
-- VISUAL SIMILARITY (high=alike). These two split the old ambiguous "score":
--   provider_visual_similarity_score : how alike the covers look (0-1)
--   provider_match_confidence        : how sure the model is of its verdict (0-1)
ALTER TABLE books ADD COLUMN IF NOT EXISTS provider_visual_similarity_score NUMERIC;
ALTER TABLE books ADD COLUMN IF NOT EXISTS provider_match_confidence        NUMERIC;

-- Backfill selected_isbn from the already-resolved ISBN ---------------------
UPDATE books
   SET selected_isbn = COALESCE(selected_isbn, isbn),
       selected_isbn_source = COALESCE(selected_isbn_source, isbn_source)
 WHERE isbn IS NOT NULL
   AND selected_isbn IS NULL;

-- Make provider price columns display-safe: never NULL, default 0 ----------
-- (momox_status / gibert_status now carry the "not checked / failed" meaning.)
UPDATE books
   SET momox_price       = COALESCE(momox_price, 0),
       gibert_price      = COALESCE(gibert_price, 0),
       best_resale_price = COALESCE(best_resale_price, 0)
 WHERE momox_price IS NULL
    OR gibert_price IS NULL
    OR best_resale_price IS NULL;

CREATE INDEX IF NOT EXISTS idx_books_provider_match_status ON books (provider_match_status);
CREATE INDEX IF NOT EXISTS idx_books_selected_isbn ON books (selected_isbn);
CREATE INDEX IF NOT EXISTS idx_books_backend_status ON books (backend_status);
