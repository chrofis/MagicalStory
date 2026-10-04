/**
 * Referral CHF balance — the only module that mutates users.referral_balance_cents
 * or users.referral_pending_cents. Every change is recorded in referral_payouts
 * (the ledger) with the post-change balance + pending values.
 *
 * Concurrency model:
 *   - Conditional UPDATE pattern (mirrors server/routes/jobs.js:327): the UPDATE
 *     only succeeds if the available amount covers the spend, prevents double-spend
 *     without SELECT FOR UPDATE.
 *   - Database CHECK (>= 0) is the safety net.
 *   - Pending column tracks in-flight checkout holds; available = balance - pending.
 *
 * Idempotency:
 *   - earned: unique partial index on (session_id) WHERE type='earned'.
 *   - pending_checkout: unique partial index on (session_id) WHERE type='pending_checkout'.
 *   - confirm/release pending: check for existing 'spent_discount' or 'restored' row
 *     for the session before mutating.
 *
 * All functions accept an optional `dbClient` (a pg PoolClient inside an existing
 * transaction). If omitted, they acquire/release a client and run their own BEGIN/COMMIT.
 */

const { getPool } = require('../services/database');
const { log } = require('../utils/logger');

const LEDGER_TYPES = {
  EARNED: 'earned',
  PENDING_CHECKOUT: 'pending_checkout',
  SPENT_DISCOUNT: 'spent_discount',
  SPENT_CREDITS: 'spent_credits',
  SPENT_REFUND: 'spent_refund',
  RESTORED: 'restored',
  ADMIN_ADJUST: 'admin_adjust',
};

/**
 * Run `fn(client)` inside a transaction. If `existingClient` is provided,
 * uses it without managing the transaction (caller already in a tx).
 */
async function withTransaction(existingClient, fn) {
  if (existingClient) {
    return fn(existingClient);
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insertLedger(client, row) {
  const res = await client.query(
    `INSERT INTO referral_payouts
       (user_id, amount_cents, type, balance_after_cents, pending_after_cents,
        order_stripe_session_id, stripe_refund_id, source_user_id, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      row.userId,
      row.amountCents,
      row.type,
      row.balanceAfter,
      row.pendingAfter,
      row.sessionId || null,
      row.refundId || null,
      row.sourceUserId || null,
      row.description || null,
    ]
  );
  return res.rows[0].id;
}

/**
 * Read current balance state. Cheap, no transaction needed.
 * @returns {Promise<{balanceCents: number, pendingCents: number, availableCents: number}>}
 */
async function getBalance(userId) {
  const result = await getPool().query(
    `SELECT referral_balance_cents AS balance, referral_pending_cents AS pending
       FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) {
    return { balanceCents: 0, pendingCents: 0, availableCents: 0 };
  }
  const balanceCents = result.rows[0].balance || 0;
  const pendingCents = result.rows[0].pending || 0;
  return { balanceCents, pendingCents, availableCents: balanceCents - pendingCents };
}

/**
 * Record a referral earning. Called from the Stripe webhook when a buyer's
 * order completes. Idempotent on sessionId via the unique partial index —
 * a duplicate INSERT throws, caller should handle/ignore.
 */
async function creditEarned({ userId, amountCents, sessionId, sourceUserId, description }, dbClient = null) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`creditEarned: invalid amountCents=${amountCents}`);
  }
  return withTransaction(dbClient, async (client) => {
    const updated = await client.query(
      `UPDATE users
          SET referral_balance_cents = referral_balance_cents + $1
        WHERE id = $2
        RETURNING referral_balance_cents, referral_pending_cents`,
      [amountCents, userId]
    );
    if (updated.rows.length === 0) {
      throw new Error(`creditEarned: user ${userId} not found`);
    }
    const balanceAfter = updated.rows[0].referral_balance_cents;
    const pendingAfter = updated.rows[0].referral_pending_cents;
    await insertLedger(client, {
      userId,
      amountCents,
      type: LEDGER_TYPES.EARNED,
      balanceAfter,
      pendingAfter,
      sessionId,
      sourceUserId,
      description: description || `Referral reward (buyer session ${sessionId})`,
    });
    return { balanceCents: balanceAfter, pendingCents: pendingAfter };
  });
}

/**
 * Reserve `amountCents` against the user's available balance for a pending
 * checkout. Idempotent on sessionId. Returns false if insufficient available.
 */
async function holdPending({ userId, amountCents, sessionId, description }, dbClient = null) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`holdPending: invalid amountCents=${amountCents}`);
  }
  if (!sessionId) throw new Error('holdPending: sessionId required');

  return withTransaction(dbClient, async (client) => {
    // Idempotency: existing pending_checkout for this session?
    const existing = await client.query(
      `SELECT amount_cents FROM referral_payouts
         WHERE order_stripe_session_id = $1 AND type = $2`,
      [sessionId, LEDGER_TYPES.PENDING_CHECKOUT]
    );
    if (existing.rows.length > 0) {
      log.warn(`[referralBalance] holdPending: session ${sessionId} already held — idempotent skip`);
      return { ok: true, alreadyHeld: true };
    }

    // Conditional UPDATE: succeeds only if available >= amount.
    const updated = await client.query(
      `UPDATE users
          SET referral_pending_cents = referral_pending_cents + $1
        WHERE id = $2
          AND (referral_balance_cents - referral_pending_cents) >= $1
        RETURNING referral_balance_cents, referral_pending_cents`,
      [amountCents, userId]
    );
    if (updated.rows.length === 0) {
      return { ok: false, reason: 'insufficient_available' };
    }
    await insertLedger(client, {
      userId,
      amountCents,
      type: LEDGER_TYPES.PENDING_CHECKOUT,
      balanceAfter: updated.rows[0].referral_balance_cents,
      pendingAfter: updated.rows[0].referral_pending_cents,
      sessionId,
      description: description || `Hold for checkout ${sessionId}`,
    });
    return { ok: true, alreadyHeld: false };
  });
}

/**
 * Convert a pending hold to a confirmed spend. Called from the
 * checkout.session.completed webhook for sessions that used the balance.
 * Decrements both balance and pending by the held amount. Idempotent.
 *
 * Returns { confirmed: true|false, amountCents, alreadyResolved? }.
 */
async function confirmPending({ userId, sessionId }, dbClient = null) {
  if (!sessionId) throw new Error('confirmPending: sessionId required');
  return withTransaction(dbClient, async (client) => {
    // Idempotency: was this session already resolved (confirmed or restored)?
    const resolved = await client.query(
      `SELECT id, type FROM referral_payouts
         WHERE order_stripe_session_id = $1
           AND type IN ($2, $3)`,
      [sessionId, LEDGER_TYPES.SPENT_DISCOUNT, LEDGER_TYPES.RESTORED]
    );
    if (resolved.rows.length > 0) {
      log.warn(`[referralBalance] confirmPending: session ${sessionId} already ${resolved.rows[0].type} — idempotent skip`);
      return { confirmed: false, alreadyResolved: true, resolvedAs: resolved.rows[0].type };
    }

    // Find the pending entry. If none, this checkout didn't use balance.
    const pending = await client.query(
      `SELECT amount_cents FROM referral_payouts
         WHERE order_stripe_session_id = $1 AND type = $2`,
      [sessionId, LEDGER_TYPES.PENDING_CHECKOUT]
    );
    if (pending.rows.length === 0) {
      return { confirmed: false, amountCents: 0, noPending: true };
    }
    const amountCents = pending.rows[0].amount_cents;

    const updated = await client.query(
      `UPDATE users
          SET referral_balance_cents = referral_balance_cents - $1,
              referral_pending_cents = referral_pending_cents - $1
        WHERE id = $2
          AND referral_balance_cents >= $1
          AND referral_pending_cents >= $1
        RETURNING referral_balance_cents, referral_pending_cents`,
      [amountCents, userId]
    );
    if (updated.rows.length === 0) {
      throw new Error(`confirmPending: invariant violation for user ${userId} session ${sessionId} amount ${amountCents}`);
    }
    await insertLedger(client, {
      userId,
      amountCents: -amountCents,
      type: LEDGER_TYPES.SPENT_DISCOUNT,
      balanceAfter: updated.rows[0].referral_balance_cents,
      pendingAfter: updated.rows[0].referral_pending_cents,
      sessionId,
      description: `Discount applied to order (session ${sessionId})`,
    });
    return { confirmed: true, amountCents };
  });
}

/**
 * Release a pending hold without spending. Called from the
 * checkout.session.expired webhook. Idempotent.
 */
async function releasePending({ userId, sessionId, reason }, dbClient = null) {
  if (!sessionId) throw new Error('releasePending: sessionId required');
  return withTransaction(dbClient, async (client) => {
    const resolved = await client.query(
      `SELECT id, type FROM referral_payouts
         WHERE order_stripe_session_id = $1
           AND type IN ($2, $3)`,
      [sessionId, LEDGER_TYPES.SPENT_DISCOUNT, LEDGER_TYPES.RESTORED]
    );
    if (resolved.rows.length > 0) {
      log.warn(`[referralBalance] releasePending: session ${sessionId} already ${resolved.rows[0].type} — idempotent skip`);
      return { released: false, alreadyResolved: true, resolvedAs: resolved.rows[0].type };
    }
    const pending = await client.query(
      `SELECT amount_cents FROM referral_payouts
         WHERE order_stripe_session_id = $1 AND type = $2`,
      [sessionId, LEDGER_TYPES.PENDING_CHECKOUT]
    );
    if (pending.rows.length === 0) {
      return { released: false, amountCents: 0, noPending: true };
    }
    const amountCents = pending.rows[0].amount_cents;

    const updated = await client.query(
      `UPDATE users
          SET referral_pending_cents = referral_pending_cents - $1
        WHERE id = $2
          AND referral_pending_cents >= $1
        RETURNING referral_balance_cents, referral_pending_cents`,
      [amountCents, userId]
    );
    if (updated.rows.length === 0) {
      throw new Error(`releasePending: invariant violation for user ${userId} session ${sessionId} amount ${amountCents}`);
    }
    await insertLedger(client, {
      userId,
      amountCents,
      type: LEDGER_TYPES.RESTORED,
      balanceAfter: updated.rows[0].referral_balance_cents,
      pendingAfter: updated.rows[0].referral_pending_cents,
      sessionId,
      description: reason || `Hold released for expired checkout ${sessionId}`,
    });
    return { released: true, amountCents };
  });
}

/**
 * Spend balance to top up story credits. Atomic decrement on balance +
 * increment on users.credits. Returns { ok, creditsAdded } or { ok: false, reason }.
 */
async function spendForCredits({ userId, amountCents, creditsPerChf, description }, dbClient = null) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`spendForCredits: invalid amountCents=${amountCents}`);
  }
  const creditsToAdd = Math.floor((amountCents * creditsPerChf) / 100);
  if (creditsToAdd <= 0) {
    return { ok: false, reason: 'amount_yields_zero_credits' };
  }
  return withTransaction(dbClient, async (client) => {
    const updated = await client.query(
      `UPDATE users
          SET referral_balance_cents = referral_balance_cents - $1
        WHERE id = $2
          AND (referral_balance_cents - referral_pending_cents) >= $1
        RETURNING referral_balance_cents, referral_pending_cents`,
      [amountCents, userId]
    );
    if (updated.rows.length === 0) {
      return { ok: false, reason: 'insufficient_available' };
    }
    // Top up credits — special-case credits=-1 (admin unlimited) → leave as -1.
    const creditsResult = await client.query(
      `UPDATE users
          SET credits = CASE WHEN credits = -1 THEN -1 ELSE credits + $1 END
        WHERE id = $2
        RETURNING credits`,
      [creditsToAdd, userId]
    );
    const newCredits = creditsResult.rows[0].credits;

    await insertLedger(client, {
      userId,
      amountCents: -amountCents,
      type: LEDGER_TYPES.SPENT_CREDITS,
      balanceAfter: updated.rows[0].referral_balance_cents,
      pendingAfter: updated.rows[0].referral_pending_cents,
      description: description || `Converted CHF ${(amountCents / 100).toFixed(2)} to ${creditsToAdd} credits`,
    });
    // Mirror in credit_transactions so the credits side has a record too.
    await client.query(
      `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
       VALUES ($1, $2, $3, 'referral_conversion', $4, $5)`,
      [userId, creditsToAdd, newCredits, null, `Converted CHF ${(amountCents / 100).toFixed(2)} from referral balance`]
    );
    return { ok: true, creditsAdded: creditsToAdd, newCredits };
  });
}

/**
 * Cash-out step 1 of 3 (review 2026-10-04 P1): debit the balance BEFORE the Stripe
 * refund is issued. The conditional UPDATE is the double-spend guard - two concurrent
 * cash-outs cannot both debit the same balance, so only the one that debits may refund.
 * `{ok:false}` means nothing was debited and NO refund may be issued.
 *
 * Step 2 (caller): stripe.refunds.create with an idempotency key derived from the
 * returned ledgerId. Step 3: attachRefundId on success, restoreRefundSpend on failure.
 *
 * @returns {Promise<{ok: true, ledgerId: number} | {ok: false, reason: string}>}
 */
async function spendForRefund({ userId, amountCents, sessionId, description }, dbClient = null) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`spendForRefund: invalid amountCents=${amountCents}`);
  }
  return withTransaction(dbClient, async (client) => {
    const updated = await client.query(
      `UPDATE users
          SET referral_balance_cents = referral_balance_cents - $1
        WHERE id = $2
          AND (referral_balance_cents - referral_pending_cents) >= $1
        RETURNING referral_balance_cents, referral_pending_cents`,
      [amountCents, userId]
    );
    if (updated.rows.length === 0) {
      return { ok: false, reason: 'insufficient_available' };
    }
    const ledgerId = await insertLedger(client, {
      userId,
      amountCents: -amountCents,
      type: LEDGER_TYPES.SPENT_REFUND,
      balanceAfter: updated.rows[0].referral_balance_cents,
      pendingAfter: updated.rows[0].referral_pending_cents,
      sessionId: sessionId || null,
      description: description || `Cash-out of CHF ${(amountCents / 100).toFixed(2)} (Stripe refund pending)`,
    });
    return { ok: true, ledgerId };
  });
}

/** Cash-out step 3a: the Stripe refund succeeded - record its id on the debit row. */
async function attachRefundId({ ledgerId, refundId }) {
  if (!ledgerId || !refundId) throw new Error('attachRefundId: ledgerId and refundId required');
  await getPool().query(
    `UPDATE referral_payouts
        SET stripe_refund_id = $2,
            description = $3
      WHERE id = $1 AND type = $4`,
    [ledgerId, refundId, `Cashed out via Stripe refund ${refundId}`, LEDGER_TYPES.SPENT_REFUND]
  );
}

/**
 * Cash-out step 3b: the Stripe refund failed - give the debited amount back. Writes a
 * `restored` row WITHOUT a session id so the confirm/release idempotency lookups (which
 * key on the checkout session) never mistake it for a resolved checkout hold.
 */
async function restoreRefundSpend({ userId, amountCents, ledgerId, reason }, dbClient = null) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`restoreRefundSpend: invalid amountCents=${amountCents}`);
  }
  return withTransaction(dbClient, async (client) => {
    const updated = await client.query(
      `UPDATE users
          SET referral_balance_cents = referral_balance_cents + $1
        WHERE id = $2
        RETURNING referral_balance_cents, referral_pending_cents`,
      [amountCents, userId]
    );
    if (updated.rows.length === 0) throw new Error(`restoreRefundSpend: user ${userId} not found`);
    await insertLedger(client, {
      userId,
      amountCents,
      type: LEDGER_TYPES.RESTORED,
      balanceAfter: updated.rows[0].referral_balance_cents,
      pendingAfter: updated.rows[0].referral_pending_cents,
      description: reason || `Cash-out refund failed - balance restored (debit row ${ledgerId})`,
    });
    return { ok: true };
  });
}

/**
 * One cash-out leg: debit first, then refund with an idempotency key, restore on failure.
 * `order` is an entry of getRefundableAmount().orders; `stripe` the client for that order's mode.
 *
 * @returns {Promise<{ok:true, refundId:string} | {ok:false, error:string, code?:string, restoreFailed?:boolean}>}
 */
async function cashOutToCard({ userId, order, amountCents, stripe }) {
  const debit = await spendForRefund({ userId, amountCents, sessionId: order.sessionId });
  if (!debit.ok) return { ok: false, error: `Balance debit refused: ${debit.reason}`, code: debit.reason };

  let refund;
  try {
    refund = await stripe.refunds.create(
      {
        payment_intent: order.paymentIntentId,
        amount: amountCents,
        reason: 'requested_by_customer',
        metadata: { type: 'referral_cashout', user_id: userId, order_session_id: order.sessionId, ledger_id: String(debit.ledgerId) },
      },
      { idempotencyKey: `referral-cashout-${debit.ledgerId}` }
    );
  } catch (stripeErr) {
    try {
      await restoreRefundSpend({
        userId, amountCents, ledgerId: debit.ledgerId,
        reason: `Cash-out refund failed (${stripeErr.message}) - balance restored (debit row ${debit.ledgerId})`,
      });
    } catch (restoreErr) {
      log.error(`CRITICAL [referralBalance] cash-out refund failed AND balance restore failed for user ${userId}, ledger row ${debit.ledgerId}, CHF ${(amountCents / 100).toFixed(2)}: ${restoreErr.message}`);
      return { ok: false, error: stripeErr.message, code: stripeErr.code, restoreFailed: true };
    }
    return { ok: false, error: stripeErr.message, code: stripeErr.code };
  }

  try {
    await attachRefundId({ ledgerId: debit.ledgerId, refundId: refund.id });
  } catch (attachErr) {
    // Money moved and the balance is debited; only the audit link is missing.
    log.error(`[referralBalance] cash-out refund ${refund.id} succeeded but ledger row ${debit.ledgerId} could not be annotated: ${attachErr.message}`);
  }
  return { ok: true, refundId: refund.id };
}

/**
 * Recent ledger entries. Latest first.
 */
async function getPayoutHistory(userId, limit = 20) {
  const result = await getPool().query(
    `SELECT id, amount_cents, type, balance_after_cents, pending_after_cents,
            order_stripe_session_id, stripe_refund_id, source_user_id,
            description, created_at
       FROM referral_payouts
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map(r => ({
    id: r.id,
    amountCents: r.amount_cents,
    type: r.type,
    balanceAfterCents: r.balance_after_cents,
    pendingAfterCents: r.pending_after_cents,
    sessionId: r.order_stripe_session_id,
    refundId: r.stripe_refund_id,
    sourceUserId: r.source_user_id,
    description: r.description,
    createdAt: r.created_at,
  }));
}

/**
 * For each of the user's paid orders with a payment_intent_id, query Stripe
 * for the actual refundable amount (PI.amount - PI.amount_refunded) — this
 * catches refunds issued via Stripe Dashboard that are invisible to our DB.
 *
 * @param {string} userId
 * @param {(order) => Stripe} pickStripeForOrder — caller-provided fn that
 *   returns the test/live Stripe client for a given order row (must use
 *   order.stripe_mode, never current user state).
 * @returns {Promise<{totalRefundableCents: number, orders: Array<{orderId, sessionId, paymentIntentId, refundableCents, currency, stripeMode}>}>}
 */
async function getRefundableAmount(userId, pickStripeForOrder) {
  // `payment_status` flips 'paid' → 'processing' → 'completed' (or 'failed')
  // within seconds of insert, so filtering on 'paid' alone found nothing and
  // silently broke cashout for every user with a fulfilled order. Every row
  // here was paid via Stripe; the real over-refund guard is the per-order
  // paymentIntent refundable check below.
  const ordersResult = await getPool().query(
    `SELECT id, stripe_session_id, stripe_payment_intent_id, amount_total, currency, stripe_mode, created_at
       FROM orders
      WHERE user_id = $1
        AND payment_status IN ('paid','processing','completed','failed')
        AND stripe_payment_intent_id IS NOT NULL
        AND (currency = 'CHF' OR currency IS NULL)
      ORDER BY created_at DESC`,
    [userId]
  );

  const orders = [];
  let totalRefundableCents = 0;

  for (const row of ordersResult.rows) {
    const stripe = pickStripeForOrder(row);
    if (!stripe) continue;
    try {
      const pi = await stripe.paymentIntents.retrieve(row.stripe_payment_intent_id);
      const refundable = Math.max(0, (pi.amount || 0) - (pi.amount_refunded || 0));
      if (refundable > 0) {
        orders.push({
          orderId: row.id,
          sessionId: row.stripe_session_id,
          paymentIntentId: row.stripe_payment_intent_id,
          refundableCents: refundable,
          currency: row.currency || 'CHF',
          stripeMode: row.stripe_mode || 'live',
        });
        totalRefundableCents += refundable;
      }
    } catch (err) {
      log.warn(`[referralBalance] getRefundableAmount: Stripe error for PI ${row.stripe_payment_intent_id}: ${err.message}`);
    }
  }

  return { totalRefundableCents, orders };
}

module.exports = {
  LEDGER_TYPES,
  getBalance,
  creditEarned,
  holdPending,
  confirmPending,
  releasePending,
  spendForCredits,
  spendForRefund,
  attachRefundId,
  restoreRefundSpend,
  cashOutToCard,
  getPayoutHistory,
  getRefundableAmount,
};
