-- 004_backfill_not_sent_null_prices.sql
--
-- ONE-TIME DATA BACKFILL (DML only — runnable by the app role, no DDL).
--
-- Context: before the not-sent semantics patch, rows that were never sent to a
-- provider were saved with the display-safe price 0 and a NULL *_status. The UI
-- now reads NULL = "not sent / Demander le prix" and 0 = "called, no offer", so
-- those legacy 0s are misleading. This converts NEVER-SENT rows to NULL price +
-- '*_not_sent'.
--
-- CONSERVATIVE BY DESIGN: a row is only touched when there is NO evidence a
-- provider ever ran for it — NULL status, NULL final_url, NULL raw_response (and
-- for Gibert, NULL checked_at). Real no-offers (price 0 WITH a status/url) and
-- real prices (> 0) are left untouched.
--
-- Idempotent: re-running changes nothing once rows are 'not_sent'.
-- Wrapped in a transaction; review the row counts before COMMIT if running
-- interactively.

BEGIN;

-- 1) Momox never sent -> price NULL, status 'not_sent'.
UPDATE books SET
    momox_price = NULL,
    momox_status = 'not_sent'
WHERE momox_status IS NULL
  AND COALESCE(momox_price, 0) = 0
  AND momox_final_url IS NULL
  AND momox_raw_response IS NULL;

-- 2) Gibert never sent -> price NULL, status 'not_sent'.
UPDATE books SET
    gibert_price = NULL,
    gibert_status = 'not_sent'
WHERE gibert_status IS NULL
  AND gibert_checked_at IS NULL
  AND COALESCE(gibert_price, 0) = 0
  AND gibert_final_url IS NULL
  AND gibert_raw_response IS NULL;

-- 3) best_resale: NULL when BOTH providers are now not_sent and there is no
--    price to summarize (keeps a real best price from a one-sided send).
UPDATE books SET
    best_resale_price = NULL,
    best_resale_platform = NULL
WHERE momox_status = 'not_sent'
  AND gibert_status = 'not_sent'
  AND COALESCE(best_resale_price, 0) = 0;

-- 4) backend_status + not_sent_reason for the fully not-sent rows (so the UI can
--    read the canonical value and show a reason). Existing reasons are kept.
UPDATE books SET
    backend_status = CASE
        WHEN COALESCE(isbn, '') = '' THEN 'detected_no_isbn'
        ELSE 'provider_not_sent'
    END,
    not_sent_reason = COALESCE(NULLIF(not_sent_reason, ''),
        CASE
            WHEN COALESCE(isbn, '') = '' THEN 'no_isbn'
            WHEN isbn_is_valid = false THEN 'isbn_invalid'
            ELSE 'isbn_confidence_below_threshold'
        END)
WHERE momox_status = 'not_sent'
  AND gibert_status = 'not_sent';

COMMIT;
