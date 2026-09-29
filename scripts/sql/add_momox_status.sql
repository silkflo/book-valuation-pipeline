-- Explicit per-row Momox provider status (gibert_status already exists).
-- Apply with the table-owner/admin role (books_user lacks ALTER rights).
--
-- Values written by the app:
--   momox_pending      sent to Momox, result not yet persisted
--   momox_price_found  offer found, momox_price > 0
--   momox_no_offer     checked, no usable offer (momox_price = 0.00)
--   momox_failed       provider call failed; row needs retry
--   NULL               row never sent to Momox (no ISBN / not eligible)
--
-- Until this is applied the app falls back to the global "status" field and
-- logs a one-time warning.

ALTER TABLE books ADD COLUMN IF NOT EXISTS momox_status TEXT;

CREATE INDEX IF NOT EXISTS idx_books_momox_status ON books (momox_status);

-- Backfill from the global status lifecycle so existing rows are coherent.
UPDATE books
SET momox_status = CASE
    WHEN status IN ('momox_pending', 'momox_pending_duplicate') THEN 'momox_pending'
    WHEN status IN ('momox_price_found', 'momox_price_found_needs_review') THEN 'momox_price_found'
    WHEN status IN ('momox_no_price', 'momox_not_real_offer', 'momox_title_mismatch') THEN 'momox_no_offer'
    WHEN status IN ('momox_error', 'momox_lookup_failed') THEN 'momox_failed'
    WHEN momox_price > 0 THEN 'momox_price_found'
    WHEN momox_price = 0 THEN 'momox_no_offer'
    ELSE NULL
END
WHERE momox_status IS NULL;
