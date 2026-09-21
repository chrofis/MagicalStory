/**
 * STORY VIEW INSTRUMENTATION.
 *
 * WHY THIS EXISTS (owner, 2026-09-21): nothing recorded that a story had been
 * opened. There is no viewed_at or view_count column on stories, the
 * authenticated GET /api/stories/:id logged a console line and no row, and the
 * public shared viewer had no hit counter at all. So "did the customer ever
 * look at the book we made them" was unanswerable.
 *
 * NO NEW TABLE. The production activity table is `logs` (CLAUDE.md's DB section
 * names an `activity_log` that does not exist in this database — verified
 * against staging information_schema on 2026-09-21), and logActivity() in
 * server/services/database.js is the house convention that every other
 * behavioural event already uses. A view is one of those events.
 *
 * ONE construction, TWO call sites. The authenticated route
 * (server/routes/stories.js) and the public shared viewer
 * (server/routes/sharing.js) are siblings — the shared/trial path in this repo
 * has repeatedly lagged the full path by weeks. Both therefore call THIS
 * function rather than each hand-rolling a logActivity payload, so a field
 * added here cannot reach one path and miss the other.
 *
 * DEDUPING. A story page fires many requests (images, metadata, version
 * lists); only the two ROUTES THAT RETURN THE STORY ITSELF call this. On top of
 * that an in-process window suppresses a repeat view of the same story by the
 * same viewer, so a refresh loop or a React strict-mode double mount does not
 * write two rows a second. The window is in-process on purpose: it is a noise
 * damper, not a correctness mechanism, and an undercount after a deploy is
 * cheaper than a query that runs on every page open.
 */

'use strict';

const { log } = require('../utils/logger');

/** Repeat views of the same story by the same viewer inside this window are dropped. */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/** Bounded so a long-running container cannot grow the map without limit. */
const MAX_DEDUPE_KEYS = 5000;

const _recent = new Map();

function _shouldRecord(key, now) {
  const last = _recent.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;
  if (_recent.size >= MAX_DEDUPE_KEYS) {
    for (const [k, t] of _recent) {
      if (now - t >= DEDUPE_WINDOW_MS) _recent.delete(k);
    }
    // Still full of live entries: drop the oldest insertion (Map preserves it).
    if (_recent.size >= MAX_DEDUPE_KEYS) {
      const oldest = _recent.keys().next().value;
      if (oldest !== undefined) _recent.delete(oldest);
    }
  }
  _recent.set(key, now);
  return true;
}

/** Test seam — the dedupe window is process state, and a test must be able to clear it. */
function _resetViewDedupe() {
  _recent.clear();
}

/**
 * The viewer identity a view is deduped and attributed by.
 * An authenticated viewer is their user id. An anonymous shared-link viewer has
 * no id, so the request's IP is used — which is also all that is stored, never
 * a user agent string or anything else that profiles a visitor.
 */
function viewerKey(req) {
  if (req && req.user && req.user.id) return `u:${req.user.id}`;
  const ip = (req && (req.ip || (req.connection && req.connection.remoteAddress))) || 'unknown';
  return `a:${ip}`;
}

/**
 * Record that a story was opened.
 *
 * @param {object}  args
 * @param {string}  args.storyId    the story that was opened
 * @param {string}  args.source     'owner' | 'admin' | 'shared'
 * @param {object}  [args.req]      the request, for viewer identity
 * @param {string}  [args.shareToken] shared path only
 * @param {string}  [args.ownerUserId] whose story it is, when known
 * @returns {Promise<boolean>} true if a row was written
 */
async function recordStoryView(args = {}) {
  const { storyId, source, req, shareToken, ownerUserId } = args;
  if (!storyId || !source) return false;

  const viewer = viewerKey(req);
  if (!_shouldRecord(`${storyId}|${viewer}|${source}`, Date.now())) return false;

  try {
    const { logActivity } = require('../services/database');
    const authed = !!(req && req.user && req.user.id);
    await logActivity(
      authed ? req.user.id : null,
      authed ? (req.user.username || req.user.email || null) : null,
      'STORY_VIEWED',
      {
        storyId,
        source,
        authenticated: authed,
        ...(shareToken ? { shareToken } : {}),
        ...(ownerUserId ? { ownerUserId } : {}),
        ...(req && req.user && req.user.impersonating ? { impersonating: true } : {}),
      },
      req ? req.user : null
    );
    return true;
  } catch (err) {
    // logActivity already swallows DB errors; this catch covers a bad require
    // or a malformed request object. A view that cannot be logged must never
    // fail the story the customer is trying to read.
    log.error(`❌ [STORY VIEW] could not record view of ${storyId}: ${err.message}`);
    return false;
  }
}

module.exports = {
  recordStoryView,
  viewerKey,
  DEDUPE_WINDOW_MS,
  _resetViewDedupe,
};
