-- Stable PUBLIC crop image URL for one detected book (e.g. '/uploads/book-crops/<ads_id>/4-1a2b3c4d5e6f7a8b.jpg').
-- This is a permanent per-book crop the frontend can display in the book row — NOT a
-- temporary debug/lens crop, and NOT the original ad image (source_image_url stays as-is).
-- Additive + non-destructive + idempotent. Apply as the admin DB role (app role has no DDL).

ALTER TABLE public.books
    ADD COLUMN IF NOT EXISTS crop_image_url TEXT;
