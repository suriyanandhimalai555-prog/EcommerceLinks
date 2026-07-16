-- Multiple payment-proof screenshots per order.
CREATE TABLE order_payment_proofs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   BIGINT NOT NULL REFERENCES orders(id),
  s3_key     TEXT   NOT NULL UNIQUE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_payment_proofs_order ON order_payment_proofs (order_id);
