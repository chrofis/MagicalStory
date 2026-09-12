/**
 * Tracked R2 pruning — "the DB delete wins, but the failure is recorded".
 *
 * Every place that deletes a row whose R2 objects should go with it used to
 * call `r2.deleteByPrefix` / `r2.deleteObject` directly. Those helpers log a
 * failure and return a count rather than throwing (deliberately: a user's
 * delete must not be blocked by R2 being down). The consequence was silent
 * permanent orphans — once the row is gone, nothing in the system knows which
 * keys it owned, so no retry and no audit can reach them.
 *
 * Use `prunePrefix` / `pruneObject` / `pruneStory` instead of the raw r2
 * helpers at any call site that is deleting the owning row. They do the same
 * work and, when the prune does not finish, write the target into
 * `r2_pending_deletions` (migrations/036). `retryPending` — run from the daily
 * housekeeping routine — drains that table.
 *
 * Recording is itself best-effort: if the DB is the thing that is down we log
 * loudly and carry on, because the caller's row delete has already committed.
 */

'use strict';

const r2 = require('./r2');
const { log } = require('../utils/logger');

function pool() {
  try {
    const { getPool, isDatabaseMode } = require('../services/database');
    return isDatabaseMode() ? getPool() : null;
  } catch {
    return null;
  }
}

/**
 * Record a prune that did not finish, so it stays reachable and retryable.
 * Never throws — the caller is on a post-commit path.
 */
async function recordPending(kind, target, reason) {
  if (!target) return false;
  const p = pool();
  if (!p) {
    log.error(`[r2-pending] LOST: cannot record failed ${kind} prune "${target}" (${reason}) — no database`);
    return false;
  }
  try {
    await p.query(
      `INSERT INTO r2_pending_deletions (kind, target, reason, attempts, last_attempt_at)
       VALUES ($1, $2, $3, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (kind, target) WHERE deleted_at IS NULL
       DO UPDATE SET attempts = r2_pending_deletions.attempts + 1,
                     last_attempt_at = CURRENT_TIMESTAMP`,
      [kind, target, reason || null],
    );
    log.warn(`[r2-pending] recorded failed ${kind} prune for retry: "${target}" (${reason || 'no reason given'})`);
    return true;
  } catch (err) {
    log.error(`[r2-pending] LOST: could not record failed ${kind} prune "${target}": ${err.message}`);
    return false;
  }
}

async function markSettled(id) {
  const p = pool();
  if (!p) return;
  try {
    await p.query('UPDATE r2_pending_deletions SET deleted_at = CURRENT_TIMESTAMP WHERE id = $1', [id]);
  } catch (err) {
    log.warn(`[r2-pending] could not mark row ${id} settled: ${err.message}`);
  }
}

async function noteAttempt(id, errMsg) {
  const p = pool();
  if (!p) return;
  try {
    await p.query(
      `UPDATE r2_pending_deletions
         SET attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP, last_error = $2
       WHERE id = $1`,
      [id, errMsg || null],
    );
  } catch (err) {
    log.warn(`[r2-pending] could not update row ${id}: ${err.message}`);
  }
}

/**
 * Delete everything under `prefix`; record the prefix when the prune fails.
 * @returns {Promise<number>} objects deleted
 */
async function prunePrefix(prefix, reason) {
  let res;
  try {
    res = await r2.deleteByPrefixDetailed(prefix);
  } catch (err) {
    // deleteByPrefixDetailed catches its own S3 errors, so this is a
    // programming/config fault — still must not lose the prefix.
    await recordPending('prefix', prefix, reason);
    log.warn(`[r2-pending] prunePrefix(${prefix}) threw: ${err.message}`);
    return 0;
  }
  if (!res.ok) await recordPending('prefix', prefix, reason);
  return res.deleted;
}

/** Delete every R2 artefact for one story; record the prefix on failure. */
async function pruneStory(storyId, reason = 'story deleted') {
  if (!storyId || typeof storyId !== 'string' || storyId.length < 4) return 0;
  return await prunePrefix(r2.storyPrefix(storyId), reason);
}

/**
 * Delete one key; record it when the delete fails.
 * @returns {Promise<number>} 1 on success, 0 otherwise
 */
async function pruneObject(key, reason) {
  if (!key) return 0;
  let ok = false;
  try {
    ok = await r2.deleteObject(key);
  } catch (err) {
    log.warn(`[r2-pending] pruneObject(${key}) threw: ${err.message}`);
  }
  if (!ok && r2.isConfigured()) {
    await recordPending('object', key, reason);
    return 0;
  }
  return ok ? 1 : 0;
}

/**
 * The R2 key behind a `files` row. `file_url` is authoritative once the row
 * has been offloaded (backfill-files-to-r2.js); the keyForOrderPdf shape is
 * the fallback for a row whose URL column is not on this bucket. Returns null
 * for a row that never reached R2 (bytes still in file_data).
 */
function keyForFileRow(row) {
  if (!row) return null;
  if (row.file_url) return r2.keyFromPublicUrl(row.file_url);
  return null;
}

/**
 * Prune the R2 objects of `files` rows that are about to be / have just been
 * deleted. Pass the rows (id + file_url) from a `DELETE … RETURNING id, file_url`.
 * @returns {Promise<number>} objects deleted
 */
async function pruneFileRows(rows, reason = 'files row deleted') {
  let n = 0;
  for (const row of rows || []) {
    const key = keyForFileRow(row);
    if (!key) continue;
    n += await pruneObject(key, reason);
  }
  return n;
}

/**
 * Retry every open pending deletion. Called from the daily housekeeping
 * routine. Returns { tried, settled, stillFailing }.
 */
async function retryPending({ limit = 500 } = {}) {
  const p = pool();
  if (!p || !r2.isConfigured()) return { tried: 0, settled: 0, stillFailing: 0 };
  let rows;
  try {
    rows = (await p.query(
      `SELECT id, kind, target FROM r2_pending_deletions
        WHERE deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT $1`, [limit],
    )).rows;
  } catch (err) {
    log.warn(`[r2-pending] retry query failed: ${err.message}`);
    return { tried: 0, settled: 0, stillFailing: 0 };
  }
  let settled = 0; let stillFailing = 0;
  for (const row of rows) {
    if (row.kind === 'prefix') {
      const res = await r2.deleteByPrefixDetailed(row.target);
      if (res.ok) { await markSettled(row.id); settled++; }
      else { await noteAttempt(row.id, res.error); stillFailing++; }
    } else {
      const ok = await r2.deleteObject(row.target);
      if (ok) { await markSettled(row.id); settled++; }
      else { await noteAttempt(row.id, 'deleteObject returned false'); stillFailing++; }
    }
  }
  if (rows.length > 0) {
    log.info(`[r2-pending] retried ${rows.length} pending deletion(s): ${settled} settled, ${stillFailing} still failing`);
  }
  return { tried: rows.length, settled, stillFailing };
}

module.exports = {
  recordPending,
  prunePrefix,
  pruneStory,
  pruneObject,
  pruneFileRows,
  keyForFileRow,
  retryPending,
};
