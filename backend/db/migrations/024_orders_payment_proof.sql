-- Add payment proof S3 key to orders.
-- Nullable: webhook-confirmed / older orders will not have a proof image.
ALTER TABLE orders ADD COLUMN payment_proof_key TEXT;
