-- 047: gift / campaign vouchers (tasks/vouchers-2026-10-25.md).
--
-- A voucher is 500 credits + one softcover book credit. The code is never stored in clear:
-- code_hash (sha256 of the normalized code) is the lookup key, code_enc (AES-256-GCM, key from
-- VOUCHER_SECRET) lets the owner re-download / re-send the card. users.id is VARCHAR in this
-- schema, so every user reference below is TEXT.

CREATE TABLE IF NOT EXISTS vouchers (
  id SERIAL PRIMARY KEY,
  code_hash TEXT UNIQUE NOT NULL,
  code_enc TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gift','campaign')),
  credits INT NOT NULL,
  book_cents INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','void')),
  batch_label TEXT,
  expires_at TIMESTAMPTZ,
  purchaser_user_id VARCHAR REFERENCES users(id),
  purchaser_email TEXT,
  stripe_session_id TEXT UNIQUE,
  stripe_mode TEXT,
  language TEXT NOT NULL DEFAULT 'de',
  redeemed_by_user_id VARCHAR REFERENCES users(id),
  redeemed_at TIMESTAMPTZ,
  book_order_session_id TEXT,
  created_by_user_id VARCHAR,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers (status);
CREATE INDEX IF NOT EXISTS idx_vouchers_redeemed_by ON vouchers (redeemed_by_user_id) WHERE redeemed_by_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_purchaser ON vouchers (purchaser_user_id) WHERE purchaser_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vouchers_book_session ON vouchers (book_order_session_id) WHERE book_order_session_id IS NOT NULL;

-- A voucher can credit a user exactly once, even if the app-level state check is bypassed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_voucher_ref
  ON credit_transactions (reference_id) WHERE transaction_type = 'voucher_redeem';
