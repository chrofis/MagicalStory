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

// Object keys only use these characters; a query string (?v=1) stays outside the match
// and is carried through the rewrite untouched.
const STAGING_URL_RE = /https:\/\/images-staging\.magicalstory\.ch\/[A-Za-z0-9_\-./%]*[A-Za-z0-9_\-/%]/g;

/** Same format the app uses for job/story ids (server/routes/jobs.js). */
function makeJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/** Object key behind a staging URL, with the story id swapped when the story is re-identified. */
function keyForStagingUrl(url, oldId, newId) {
  const key = url.slice(STAGING_BASE.length + 1);
  return oldId && newId && oldId !== newId ? key.split(oldId).join(newId) : key;
}

/** Rewrite one string: staging URLs -> prod URLs, and (as-new) the old story id -> the new one everywhere. */
function rewriteString(s, oldId, newId) {
  let out = s.replace(STAGING_URL_RE, (u) => `${PROD_BASE}/${keyForStagingUrl(u, oldId, newId)}`);
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
function rewriteDeep(value, oldId, newId) {
  return mapStrings(value, (s) => rewriteString(s, oldId, newId));
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

module.exports = {
  STAGING_BASE, PROD_BASE, makeJobId, keyForStagingUrl, rewriteString, rewriteDeep,
  collectStagingUrls, assertNoStagingUrls, countStagingHostMentions,
};
