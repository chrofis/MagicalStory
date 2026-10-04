/**
 * Credit movements that must be ONE atomic unit (review 2026-10-04 BILL-1 / P5 / R1 / R2).
 *
 * - chargeCredits: post-hoc debit with a balance floor. The ledger row is written only
 *   when the UPDATE matched a row, with the real post-debit balance.
 * - settleJobWithRefund: move a story job to a terminal status AND refund its reserved
 *   credits in one transaction. Claim, credit and ledger row commit together or not at
 *   all, so a crash between statements can no longer lose a reservation. The status
 *   guard lives in the same UPDATE, so a refund can only happen for the transition that
 *   actually changed the row (a finished job is never refunded, a cancelled job is never
 *   flipped to failed).
 */

/**
 * @returns {Promise<{charged: boolean, credits: number|null}>} credits = post-debit balance when charged.
 */
async function chargeCredits(pool, { userId, cost, transactionType, description, referenceId = null }) {
  if (!(cost > 0)) throw new Error(`chargeCredits: cost must be positive (got ${cost})`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      'UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1 RETURNING credits',
      [cost, userId]
    );
    if (upd.rows.length === 0) {
      await client.query('ROLLBACK');
      return { charged: false, credits: null };
    }
    const credits = upd.rows[0].credits;
    await client.query(
      `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, -cost, credits, transactionType, referenceId, description]
    );
    await client.query('COMMIT');
    return { charged: true, credits };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Give back a charge whose paid work did not deliver. Ledger row in the same transaction. */
async function refundCharge(pool, { userId, amount, description, referenceId = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      'UPDATE users SET credits = credits + $1 WHERE id = $2 AND credits <> -1 RETURNING credits',
      [amount, userId]
    );
    if (upd.rows.length > 0) {
      await client.query(
        `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
         VALUES ($1, $2, $3, 'story_refund', $4, $5)`,
        [userId, amount, upd.rows[0].credits, referenceId, description]
      );
    }
    await client.query('COMMIT');
    return upd.rows.length > 0 ? upd.rows[0].credits : null;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move a job to `status` and refund its credits_reserved in one transaction.
 *
 * Guards (all evaluated inside the UPDATE, on the locked row):
 *   statusIn / statusNotIn  - the transition only happens from / not from these statuses
 *   progressBelow           - the transition only happens while progress < this
 *   idleForMinutes          - the transition only happens if updated_at is older than this
 *   refundIfProgressBelow   - status still moves, but the reservation is only claimed below this progress
 *
 * @param {(ctx:{refunded:number, progress:number}) => string} opts.describe  ledger description
 * @returns {Promise<{changed:boolean, refunded:number, userId:string|null, progress:number}>}
 */
async function settleJobWithRefund(pool, jobId, opts) {
  const {
    status, errorMessage = null, statusIn = null, statusNotIn = null, progressBelow = null,
    idleForMinutes = null, refundIfProgressBelow = null, describe,
  } = opts;
  if (!status) throw new Error('settleJobWithRefund: status is required');
  if (typeof describe !== 'function') throw new Error('settleJobWithRefund: describe is required');

  const params = [jobId, status, errorMessage];
  const next = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['s.id = $1'];
  if (statusIn) where.push(`s.status = ANY(${next(statusIn)}::text[])`);
  if (statusNotIn) where.push(`NOT (s.status = ANY(${next(statusNotIn)}::text[]))`);
  if (progressBelow != null) where.push(`COALESCE(old.prog, 0) < ${next(progressBelow)}`);
  if (idleForMinutes != null) where.push(`s.updated_at < NOW() - (${next(idleForMinutes)} * INTERVAL '1 minute')`);
  const claimSql = refundIfProgressBelow != null
    ? `CASE WHEN COALESCE(old.prog, 0) < ${next(refundIfProgressBelow)} THEN 0 ELSE s.credits_reserved END`
    : '0';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE in the subquery: `old` is read after any concurrent writer committed,
    // so prev/prog are the values this UPDATE really replaces.
    const res = await client.query(
      `UPDATE story_jobs s
          SET status = $2, error_message = COALESCE($3, s.error_message),
              credits_reserved = ${claimSql}, updated_at = NOW()
         FROM (SELECT credits_reserved AS prev, user_id AS uid, progress AS prog
                 FROM story_jobs WHERE id = $1 FOR UPDATE) old
        WHERE ${where.join(' AND ')}
        RETURNING old.prev AS prev, old.uid AS uid, COALESCE(old.prog, 0) AS prog,
                  (s.credits_reserved = 0 AND old.prev > 0) AS claimed`,
      params
    );
    if (res.rows.length === 0) {
      await client.query('ROLLBACK');
      return { changed: false, refunded: 0, userId: null, progress: 0 };
    }
    const { prev, uid, prog, claimed } = res.rows[0];
    let refunded = 0;
    if (claimed && uid && prev > 0) {
      const credit = await client.query(
        'UPDATE users SET credits = credits + $1 WHERE id = $2 AND credits <> -1 RETURNING credits',
        [prev, uid]
      );
      if (credit.rows.length > 0) {
        await client.query(
          `INSERT INTO credit_transactions (user_id, amount, balance_after, transaction_type, reference_id, description)
           VALUES ($1, $2, $3, 'story_refund', $4, $5)`,
          [uid, prev, credit.rows[0].credits, jobId, describe({ refunded: prev, progress: prog })]
        );
        refunded = prev;
      }
    }
    await client.query('COMMIT');
    return { changed: true, refunded, userId: uid, progress: prog };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

// Progress the pipeline writes (guarded on status='processing') right before it saves the
// story row. From here a user cancel is refused: the story is about to exist, so refunding
// it would hand out the story for free.
const JOB_SAVING_PROGRESS = 99;

module.exports = { chargeCredits, refundCharge, settleJobWithRefund, JOB_SAVING_PROGRESS };
