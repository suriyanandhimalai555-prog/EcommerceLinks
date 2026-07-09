-- G-7: add 'failed' as a valid order status so failed payments are not marked 'paid'
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('created', 'paid', 'confirmed', 'refunded', 'failed'));
