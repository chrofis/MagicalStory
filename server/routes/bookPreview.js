/**
 * POST /api/book-preview - start or poll the full-book preview (server/lib/bookPreview.js).
 * Story owner (or admin) only: the first call paints the Grok text strips and spends about CHF 0.60 for an A4 book.
 */
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { requestPreview, PreviewError } = require('../lib/bookPreview');
const { log } = require('../utils/logger');

router.post('/book-preview', authenticateToken, async (req, res) => {
  try {
    const { storyIds, layout, coverType, retry } = req.body || {};
    const isAdmin = req.user.role === 'admin' || req.user.impersonating === true;
    const out = await requestPreview({ userId: req.user.id, isAdmin, storyIds, layout, coverType, retry: retry === true });
    res.json(out);
  } catch (err) {
    if (err instanceof PreviewError) return res.status(err.status).json({ error: err.message });
    if (err && err.name === 'BookLayoutError') return res.status(400).json({ error: err.message });
    log.error(`[BOOK PREVIEW] ${err.message}`);
    res.status(500).json({ error: 'Failed to prepare the book preview: ' + err.message });
  }
});

module.exports = router;
