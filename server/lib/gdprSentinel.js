'use strict';

/**
 * The GDPR erasure sentinel user.
 *
 * Owner ruling 2026-09-12 (Q1, tasks/gdpr-erasure-2026-09-11.md): the credit
 * ledger (`credit_transactions`) and the commission ledger (`referral_payouts`)
 * are KEPT when a person is erased — the numbers, types, dates and Stripe
 * references are the audit trail. Both tables have `user_id NOT NULL` with an
 * FK to `users`, so the rows need an owner once the person's row is gone. This
 * is that owner.
 *
 * It is NOT a person and must never behave like one:
 *   - `password` is not a bcrypt hash, so `bcrypt.compare` can never match it;
 *   - `email` is under the reserved `.invalid` TLD (RFC 2606) — undeliverable
 *     by construction, so nothing can ever mail it;
 *   - `email_verified` stays FALSE, credits and quota are 0;
 *   - every admin listing and user count excludes it (see SENTINEL_EXCLUSION_SQL).
 *
 * Moving rows here is only an erasure if the free text and pointers move with
 * nothing identifying on them — the erasure script scrubs
 * `credit_transactions.description` / `.reference_id` and
 * `referral_payouts.description` / `.source_user_id` on the way across.
 */

/** Fixed, obviously-non-real id. Never generated, never reused for a person. */
const GDPR_SENTINEL_USER_ID = 'gdpr-erased-sentinel';
const GDPR_SENTINEL_USERNAME = 'gdpr-erased-sentinel';
/** `.invalid` is reserved by RFC 2606 — guaranteed undeliverable. */
const GDPR_SENTINEL_EMAIL = 'gdpr-erased-sentinel@invalid';
/** Not a bcrypt hash (no `$2` prefix): no password can ever verify against it. */
const GDPR_SENTINEL_PASSWORD = '!gdpr-sentinel-no-login!';

/**
 * SQL fragment excluding the sentinel from user listings and counts.
 * Used with an explicit table alias where the query has one.
 */
function sentinelExclusion(alias) {
  const col = alias ? `${alias}.id` : 'id';
  return `${col} <> '${GDPR_SENTINEL_USER_ID}'`;
}

module.exports = {
  GDPR_SENTINEL_USER_ID,
  GDPR_SENTINEL_USERNAME,
  GDPR_SENTINEL_EMAIL,
  GDPR_SENTINEL_PASSWORD,
  sentinelExclusion,
};
