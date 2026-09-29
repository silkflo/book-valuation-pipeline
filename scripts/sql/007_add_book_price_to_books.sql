-- Per-book SELLER price parsed from the Leboncoin ad description (the individual listed
-- price for one book line, e.g. '"Con Brio" Brina Svit / 2€' -> 2.00). This is the
-- seller's asking price for that book, NOT the ad total (ads.price_amount), NOT a
-- provider/resale price (momox_price/gibert_price), NOT profit, and NOT the `cost` column.
-- Additive + non-destructive + idempotent. Apply as the admin DB role (app role has no DDL).

ALTER TABLE public.books
    ADD COLUMN IF NOT EXISTS book_price NUMERIC(10,2);
