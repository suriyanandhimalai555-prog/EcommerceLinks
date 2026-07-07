CREATE TABLE products (
  id         SMALLINT PRIMARY KEY,
  name       TEXT NOT NULL,
  base_price NUMERIC(14,2) NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO products (id, name, base_price) VALUES
  (1, 'Starter Product', 10000.00),
  (2, 'Pro Product',     25000.00),
  (3, 'Premium Product', 50000.00);

CREATE TABLE orders (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id       BIGINT NOT NULL REFERENCES members(id),
  product_id      SMALLINT NOT NULL REFERENCES products(id),
  base_amount     NUMERIC(14,2) NOT NULL,
  gst_amount      NUMERIC(14,2) NOT NULL,
  total_amount    NUMERIC(14,2) NOT NULL,
  payment_ref     TEXT,
  status          TEXT NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created','paid','confirmed','refunded')),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ
);
CREATE INDEX idx_orders_member ON orders (member_id);
