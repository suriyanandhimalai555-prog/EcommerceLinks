-- Product PDF attachments (datasheets, brochures, manuals). Mirrors
-- product_images (migration 018) but preserves the original filename so the
-- member-facing download list on /buy/:id is human-readable. Uploaded by
-- management separately from images; served via S3 presigned GET URLs.

CREATE TABLE product_documents (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id    SMALLINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  s3_key        TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  sort_order    SMALLINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_product_documents_product ON product_documents (product_id, sort_order);
