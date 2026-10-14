-- Links auto-created upgrade delivery orders back to their parent upgrade payment order.
-- NULL on all regular orders and on upgrade payment orders themselves.
ALTER TABLE orders
  ADD COLUMN source_upgrade_order_id BIGINT REFERENCES orders(id);
