-- Multiple crop VARIANTS per detected book (JSON array of relative public paths, primary
-- first), e.g. ['/uploads/book-crops/<ads_id>/4-abc-primary.jpg', '...-wide.jpg', '...-xwide.jpg'].
-- crop_image_url stays the primary/default crop (== crop_image_urls[0]); this column just
-- adds wider-context variants so admin can verify a book quickly. Additive + idempotent.
-- Apply as the admin DB role (app role has no DDL).

ALTER TABLE public.books
    ADD COLUMN IF NOT EXISTS crop_image_urls JSONB;
