/**
 * R2 cleanup for a deleted character (bug character-delete-leaves-photos-on-r2,
 * docs/decisions.md 2026-10-21).
 *
 * A character's files live in TWO key layouts:
 *   1. characters/<user>/<characterId>/...                (photos/, avatars/, avatar-refs/)
 *   2. characters/<user>/characters_<rowId>/inline/<json-path>-<contenthash>.jpg
 *      — the JSONB offload (database.js offloadCharacterImages). The folder is
 *      shared by EVERY character of the user's row and names files by array
 *      index, so it can never be pruned as a prefix.
 *
 * So the files to remove are found by what the deleted character's RECORD
 * references (plus its own per-id prefix), and a key is deleted only if nothing
 * else still points at it: a remaining character of the row, or a story, job or
 * trial record of the user. Stories keep character-folder URLs (measured on prod 2026-10-21:
 * 51 of 155 stories), so a blind prefix prune breaks finished books.
 */
'use strict';

const r2 = require('./r2');
const r2Pending = require('./r2Pending');
const { log } = require('../utils/logger');

/** Every string anywhere in `value` that is a public URL of one of OUR objects under characters/<userId>/. */
function collectCharacterKeys(value, userId) {
  const own = `characters/${userId}/`;
  const keys = new Set();
  const seen = new WeakSet();
  const walk = (node) => {
    if (typeof node === 'string') {
      const key = r2.keyFromPublicUrl(node);
      if (key && key.startsWith(own)) keys.add(key);
      return;
    }
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const v of Array.isArray(node) ? node : Object.values(node)) walk(v);
  };
  walk(value);
  return keys;
}

/**
 * Which of `keys` are still named by data that is NOT the deleted character:
 * the remaining row (data + metadata), and the user's stories, jobs and trial data.
 * THROWS on a query error — an unanswered check must never read as "unreferenced".
 * @param {(sql:string, params:any[]) => Promise<any[]>} query
 */
async function findReferencedKeys(query, { userId, rowId, keys }) {
  if (keys.length === 0) return new Set();
  const rows = await query(
    `SELECT k FROM unnest($1::text[]) AS k
      WHERE EXISTS (SELECT 1 FROM characters c WHERE c.id = $3
                      AND (strpos(c.data::text, k) > 0 OR strpos(c.metadata::text, k) > 0))
         OR EXISTS (SELECT 1 FROM stories s WHERE s.user_id::text = $2 AND strpos(s.data::text, k) > 0)
         OR EXISTS (SELECT 1 FROM story_jobs j WHERE j.user_id::text = $2
                      AND (strpos(j.input_data::text, k) > 0 OR strpos(COALESCE(j.result_data::text, ''), k) > 0))
         OR EXISTS (SELECT 1 FROM users u WHERE u.id::text = $2 AND strpos(COALESCE(u.trial_data::text, ''), k) > 0)`,
    [keys, String(userId), rowId]);
  return new Set(rows.map(r => r.k));
}

/**
 * Delete the R2 objects that belong to a character that has just been removed
 * from its row. Call AFTER the row update (the remaining-row check must not see
 * the deleted character). Throws if the reference check or listing fails, so
 * nothing is deleted on an unanswered question; per-key delete failures are
 * recorded in r2_pending_deletions by pruneObject and returned in `failed`.
 *
 * @returns {Promise<{candidates:number, deleted:number, keptReferenced:string[], failed:string[]}>}
 */
async function pruneDeletedCharacterFiles({ userId, characterId, rowId, deletedChar, query }) {
  const candidates = collectCharacterKeys(deletedChar, userId);
  for (const o of await r2.listByPrefix(`characters/${userId}/${characterId}/`)) candidates.add(o.key);
  const all = [...candidates];

  const referenced = await findReferencedKeys(query, { userId, rowId, keys: all });
  const keptReferenced = all.filter(k => referenced.has(k));
  const failed = [];
  let deleted = 0;
  for (const key of all) {
    if (referenced.has(key)) continue;
    if (await r2Pending.pruneObject(key, 'character deleted')) deleted++;
    else failed.push(key);
  }
  if (failed.length > 0) {
    log.error(`[Characters] PRIVACY: ${failed.length} R2 file(s) of deleted character ${characterId} (user ${userId}) `
      + `were NOT deleted; queued in r2_pending_deletions for retry: ${failed.join(', ')}`);
  }
  if (keptReferenced.length > 0) {
    log.warn(`[Characters] ${keptReferenced.length} R2 file(s) of deleted character ${characterId} kept because a remaining `
      + `character, story or job still references them: ${keptReferenced.join(', ')}`);
  }
  return { candidates: all.length, deleted, keptReferenced, failed };
}

module.exports = { collectCharacterKeys, findReferencedKeys, pruneDeletedCharacterFiles };
