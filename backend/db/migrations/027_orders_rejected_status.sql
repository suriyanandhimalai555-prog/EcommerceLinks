-- Allow management to reject a payment proof so the member can re-upload.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('created', 'paid', 'confirmed', 'refunded', 'failed', 'rejected'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
