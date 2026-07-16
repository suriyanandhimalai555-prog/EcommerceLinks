-- Drop the single-key column added in 024; multiple proofs now live in order_payment_proofs (025).
ALTER TABLE orders DROP COLUMN IF EXISTS payment_proof_key;
