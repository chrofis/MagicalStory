'use strict';
/**
 * Pure helpers for promote-story-to-prod.js: staging -> production image URL
 * rewriting. Staging and production have SEPARATE R2 buckets
 * (images-staging.magicalstory.ch vs images.magicalstory.ch), so a story moved
 * between them must have its image bytes copied and every URL it references
 * rewritten. See docs/decisions.md ("Promote copies image bytes").
 */

const STAGING_BASE = 'https://images-staging.magicalstory.ch';
const PROD_BASE = 'https://images.magicalstory.ch';
const BASES = [STAGING_BASE, PROD_BASE];

// Object keys only use these characters; a query string (?v=1) stays outside the match
// and is carried through the rewrite untouched.
const STAGING_URL_RE = /https:\/\/images-staging\.magicalstory\.ch\/[A-Za-z0-9_\-./%]*[A-Za-z0-9_\-/%]/g;
const BUCKET_URL_RE = /https:\/\/images(?:-staging)?\.magicalstory\.ch\/[A-Za-z0-9_\-./%]*[A-Za-z0-9_\-/%]/g;

/** Same format the app uses for job/story ids (server/routes/jobs.js). */
function makeJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/** Object key behind a bucket URL (either bucket), with the story id swapped when the story is re-identified. */
function keyForUrl(url, oldId, newId) {
  const key = url.replace(/^https:\/\/[^/]+\//, '');
  return oldId && newId && oldId !== newId ? key.split(oldId).join(newId) : key;
}

const baseOf = (url) => url.slice(0, url.indexOf('/', 'https://'.length));

/**
 * Where one bucket URL goes: a staging-bucket URL moves to production when that is the target, and
 * (as-new) a URL whose key carries the old story id moves to `targetBase` under the new id. Anything
 * else (shared assets such as landmark photos or character art, already-production URLs in an
 * update) stays exactly where it is: it resolves publicly from either environment.
 * Production URLs under the old id MUST move too: a story pulled from production keeps its untouched
 * images at images.magicalstory.ch/stories/<oldId>/..., and deleting a story prunes R2 by that
 * prefix, so the copy needs its own objects under the new id (and the new id in the URL).
 */
function rewriteUrl(url, oldId, newId, targetBase = PROD_BASE) {
  const base = baseOf(url);
  const key = keyForUrl(url);
  const newKey = keyForUrl(url, oldId, newId);
  const moves = (targetBase === PROD_BASE && base === STAGING_BASE) || newKey !== key;
  return `${moves ? targetBase : base}/${newKey}`;
}

/** Rewrite one string: every bucket URL via rewriteUrl, and (as-new) the old story id -> the new one everywhere. */
function rewriteString(s, oldId, newId, targetBase = PROD_BASE) {
  let out = s.replace(BUCKET_URL_RE, (u) => rewriteUrl(u, oldId, newId, targetBase));
  if (oldId && newId && oldId !== newId) out = out.split(oldId).join(newId);
  return out;
}

function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[fn(k)] = mapStrings(v, fn);
    return o;
  }
  return value;
}

/** Deep copy of `value` with every string (keys included) rewritten. */
function rewriteDeep(value, oldId, newId, targetBase = PROD_BASE) {
  return mapStrings(value, (s) => rewriteString(s, oldId, newId, targetBase));
}

/** Distinct staging URLs referenced anywhere in `value` (strings and object keys). */
function collectStagingUrls(value, into = new Set()) {
  if (typeof value === 'string') {
    for (const u of value.match(STAGING_URL_RE) || []) into.add(u);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectStagingUrls(v, into));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { collectStagingUrls(k, into); collectStagingUrls(v, into); }
  }
  return into;
}

/** Guard: nothing may still point at the staging bucket after the rewrite. Throws otherwise. */
function assertNoStagingUrls(value, label = 'payload') {
  const left = collectStagingUrls(value);
  if (left.size) {
    throw new Error(`${left.size} staging URL(s) left in ${label}, e.g. ${[...left][0]}`);
  }
}

/** Raw 'images-staging' host mentions (catches forms the URL regex would skip, e.g. a bare host). */
function countStagingHostMentions(value) {
  let n = 0;
  mapStrings(value, (s) => { n += (s.match(/images-staging\.magicalstory\.ch/g) || []).length; return s; });
  return n;
}

/** Every bucket URL (either bucket) referenced anywhere in `value`, strings and object keys. */
function collectBucketUrls(value, into = new Set()) {
  if (typeof value === 'string') {
    for (const u of value.match(BUCKET_URL_RE) || []) into.add(u);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectBucketUrls(v, into));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { collectBucketUrls(k, into); collectBucketUrls(v, into); }
  }
  return into;
}

/** Source URLs whose bytes must be copied so the rewritten payload resolves: exactly those rewriteUrl changes. */
function collectCopySources(value, oldId, newId, targetBase = PROD_BASE) {
  return new Set([...collectBucketUrls(value)].filter((u) => rewriteUrl(u, oldId, newId, targetBase) !== u));
}

/**
 * Guard after a rewrite: no URL may still carry the old story id, none may carry the new id on the
 * wrong bucket, and none may be a staging URL when production is the target. Throws otherwise.
 */
function assertAllOnBase(value, targetBase, label = 'payload', oldId = null, newId = null) {
  const reidentified = oldId && newId && oldId !== newId;
  const wrong = [...collectBucketUrls(value)].filter((u) => (
    (targetBase === PROD_BASE && baseOf(u) === STAGING_BASE)
    || (reidentified && (u.includes(oldId) || (u.includes(newId) && baseOf(u) !== targetBase)))));
  if (wrong.length) throw new Error(`${wrong.length} URL(s) not rewritten for ${targetBase} in ${label}, e.g. ${wrong[0]}`);
}

/**
 * Guard for --restore-from: a promote backup is a row of the TARGET environment, so its image URLs are
 * already in the target bucket and nothing is copied. For production, any staging-bucket URL means the
 * file is not a production backup; restoring it would point users at staging.
 */
function assertRestorable(backup, storyId, targetBase = PROD_BASE) {
  if (!backup || typeof backup !== 'object') throw new Error('backup is not an object');
  for (const k of ['takenAt', 'storyId', 'story', 'story_images']) {
    if (backup[k] === undefined) throw new Error(`backup is missing "${k}"`);
  }
  if (backup.storyId !== storyId) throw new Error(`backup is for ${backup.storyId}, not ${storyId}`);
  if (backup.story?.id !== storyId) throw new Error(`backup.story.id is ${backup.story?.id}, not ${storyId}`);
  if (!Array.isArray(backup.story_images)) throw new Error('backup.story_images is not an array');
  // A production backup may only reference the production bucket (and non-bucket hosts). Shared production
  // URLs inside a STAGING backup are fine, so the check only guards the production target.
  if (targetBase === PROD_BASE) {
    const mentions = countStagingHostMentions(backup);
    if (mentions) {
      throw new Error(`REFUSED: backup contains ${mentions} mention(s) of the staging bucket; a production backup may only reference the production bucket`);
    }
  }
}

// Columns of a restored stories row that production owns and a restore must never touch.
const RESTORE_KEEP_STORY_COLS = ['id', 'user_id', 'share_token', 'is_shared', 'created_at'];

/**
 * Column list for the restore UPDATE: the backup's columns minus the kept ones. A backup column
 * the live table no longer has is an error (schema moved on; restoring would silently drop data).
 */
function restoreStoryColumns(backupRow, liveRow) {
  const cols = Object.keys(backupRow).filter((c) => !RESTORE_KEEP_STORY_COLS.includes(c));
  const missing = cols.filter((c) => !(c in liveRow));
  if (missing.length) throw new Error(`backup column(s) not in the live stories table: ${missing.join(', ')}`);
  return cols;
}

/**
 * A backup is JSON, so jsonb arrives as parsed values and timestamps as ISO strings. Convert back
 * the way node-pg expects: jsonb -> JSON text (arrays would otherwise become PG array literals),
 * timestamp(tz) -> Date (pg serialises a Date in local time, the same convention it read it with,
 * so naive timestamps round-trip exactly).
 */
function toDbValue(value, dataType) {
  if (value === null || value === undefined) return null;
  if (dataType === 'jsonb' || dataType === 'json') return JSON.stringify(value);
  if (typeof dataType === 'string' && dataType.startsWith('timestamp')) return new Date(value);
  return value;
}

module.exports = {
  STAGING_BASE, PROD_BASE, BASES, makeJobId, keyForUrl, rewriteUrl, collectBucketUrls, collectCopySources, assertAllOnBase,
  assertRestorable, restoreStoryColumns, RESTORE_KEEP_STORY_COLS, toDbValue, rewriteString, rewriteDeep,
  collectStagingUrls, assertNoStagingUrls, countStagingHostMentions,
};
