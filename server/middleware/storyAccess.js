// Story access guards shared by every router mounted on /api/stories/:id/...
const { dbQuery } = require('../services/database');
const { isAdminActing } = require('./auth');

// A story generated while an admin impersonates a user is an "admin draft": owned by that
// user but invisible to them until an admin publishes it (decisions.md 2026-08-10). The
// list and GET /:id hid it, but the owner could still reach it by id through every other
// /:id route (metadata, images, share, edits) - code review R7. One guard on the router
// closes all of them, so a new /:id route is covered without remembering a filter.
//
// Admins and impersonating admins pass: they must keep working on drafts.
// Drafts change state only on publish, so a short per-id cache keeps the per-image
// request burst of a story page from costing one query each.
const DRAFT_CACHE_TTL_MS = 10 * 1000;
const DRAFT_CACHE_MAX = 500;
const draftCache = new Map(); // `${userId}:${storyId}` -> { isDraft, at }

async function hideAdminDraftFromOwner(req, res, next) {
  try {
    if (isAdminActing(req.user)) return next();
    const key = `${req.user.id}:${req.params.id}`;
    const hit = draftCache.get(key);
    let isDraft;
    if (hit && Date.now() - hit.at < DRAFT_CACHE_TTL_MS) {
      isDraft = hit.isDraft;
    } else {
      const rows = await dbQuery(
        'SELECT 1 FROM stories WHERE id = $1 AND user_id = $2 AND admin_draft',
        [req.params.id, req.user.id]
      );
      isDraft = rows.length > 0;
      if (draftCache.size >= DRAFT_CACHE_MAX) draftCache.clear();
      draftCache.set(key, { isDraft, at: Date.now() });
    }
    if (isDraft) return res.status(404).json({ error: 'Story not found' });
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { hideAdminDraftFromOwner };
