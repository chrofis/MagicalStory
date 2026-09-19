/**
 * Evidence stories — rows that automatic cleanup must never delete.
 *
 * THE PROBLEM. The only age-based deleter in this codebase is the abandoned-
 * anonymous-account sweep in server/routes/trial.js: every 6 hours it deletes
 * anonymous users older than 48 hours together with their story_jobs,
 * characters, files and stories, and then prunes the stories' R2 objects. A
 * trial story that has become the measured basis for a finding therefore has a
 * 48-hour life, and its images go with it — a surviving row pointing at deleted
 * R2 keys is not preserved evidence.
 *
 * THE MECHANISM. `stories.evidence_reason` (migration 038). Not a boolean: the
 * owner's cleanup rule is delete by OWNER, not by artefact type, so an
 * exemption has to record who wants the row kept and why, and a reason string
 * is the only thing that lets a later session judge whether a mark is stale.
 *
 * WHY THE SELECTION IS DONE IN JS. The sweep used to be one SQL filter reused
 * by five DELETEs, which meant "what did it skip, and why" was unobservable —
 * an exemption you cannot see is one redeploy from rotting silently. The
 * candidate query below returns one row per anonymous account past the cutoff
 * along with its evidence count, `selectAnonSweepTargets` splits that into
 * delete-these / skipped-these-for-this-reason, and the caller logs both.
 *
 * Protection is per ACCOUNT, not per story. Keeping a story row while its
 * owner, its characters and its story_jobs row are deleted would leave the
 * evidence unreadable and the row orphaned — and orphan cleanup would then
 * delete it anyway.
 */
'use strict';

/**
 * One row per anonymous account old enough to sweep.
 *
 * Shape verified against staging 2026-09-14: `user_id` is a varchar, and
 * `evidence_stories` comes back from node-pg as a STRING ('0'), because
 * COUNT() is a bigint. Anything that treats it as a number is wrong, which is
 * exactly what selectAnonSweepTargets is tested against.
 */
const ANON_SWEEP_CANDIDATES_SQL = `
  SELECT u.id AS user_id,
         COUNT(s.id) FILTER (WHERE s.evidence_reason IS NOT NULL) AS evidence_stories,
         MIN(s.evidence_reason) FILTER (WHERE s.evidence_reason IS NOT NULL) AS evidence_reason
    FROM users u
    LEFT JOIN stories s ON s.user_id = u.id
   WHERE u.anonymous = true
     AND u.created_at < NOW() - INTERVAL '48 hours'
   GROUP BY u.id`;

/**
 * Orphan cleanup's story predicate, in one place.
 *
 * An evidence story can become an orphan without anyone deleting it on
 * purpose: `stories.user_id` has no cascading FK, so removing the owning
 * account leaves the row with a dangling user_id, and the orphan sweep then
 * deletes it AND prunes its R2 objects. The exemption has to hold there too or
 * it only covers half the route to the same outcome.
 */
const ORPHAN_STORIES_WHERE =
  `WHERE (user_id IS NULL OR user_id = '') AND evidence_reason IS NULL`;

/**
 * Split sweep candidates into the accounts to delete and the ones held back.
 *
 * Pure, so the exemption is pinned without a database. `evidence_stories` is
 * compared numerically after an explicit cast — a truthiness test would keep
 * every account alive, since the string '0' is truthy.
 */
function selectAnonSweepTargets(candidateRows) {
  const deleteUserIds = [];
  const skipped = [];
  for (const row of candidateRows || []) {
    const count = Number(row.evidence_stories || 0);
    if (count > 0) {
      skipped.push({
        userId: row.user_id,
        evidenceStories: count,
        reason: row.evidence_reason || 'marked as evidence (no reason recorded)',
      });
    } else {
      deleteUserIds.push(row.user_id);
    }
  }
  return { deleteUserIds, skipped };
}

/** One log line per held-back account, so the exemption cannot rot unseen. */
function logSkipped(skipped, log, context) {
  if (!skipped || !skipped.length) return;
  log.info(`[${context}] kept ${skipped.length} account(s) holding evidence stories — not deleted`);
  for (const s of skipped) {
    log.info(`[${context}]   ${s.userId}: ${s.evidenceStories} evidence story(ies) — ${s.reason}`);
  }
}

/** Everything currently protected, with its reason. Used by the CLI and admins. */
async function listEvidenceStories(pool) {
  const r = await pool.query(
    `SELECT id, user_id, evidence_reason, evidence_marked_at, created_at
       FROM stories
      WHERE evidence_reason IS NOT NULL
      ORDER BY evidence_marked_at DESC NULLS LAST, created_at DESC`);
  return r.rows;
}

/** Mark one story. `reason` is required — an unexplained exemption is a leak. */
async function markEvidenceStory(pool, storyId, reason) {
  if (!reason || !String(reason).trim()) {
    throw new Error('an evidence mark needs a reason — say what the story proves');
  }
  const r = await pool.query(
    `UPDATE stories SET evidence_reason = $2, evidence_marked_at = NOW()
      WHERE id = $1 RETURNING id`,
    [storyId, String(reason).trim()]);
  return r.rowCount > 0;
}

/** Release a story back to normal cleanup. */
async function unmarkEvidenceStory(pool, storyId) {
  const r = await pool.query(
    `UPDATE stories SET evidence_reason = NULL, evidence_marked_at = NULL
      WHERE id = $1 AND evidence_reason IS NOT NULL RETURNING id`,
    [storyId]);
  return r.rowCount > 0;
}

module.exports = {
  ANON_SWEEP_CANDIDATES_SQL,
  ORPHAN_STORIES_WHERE,
  selectAnonSweepTargets,
  logSkipped,
  listEvidenceStories,
  markEvidenceStory,
  unmarkEvidenceStory,
};
