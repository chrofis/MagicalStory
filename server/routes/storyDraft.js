/**
 * Story Draft Routes - /api/story-draft
 *
 * Persist story settings before generation (step 1 & 4 data)
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

// GET /api/story-draft - Get user's story draft
router.get('/', authenticateToken, async (req, res) => {
  try {
    let draftData = {
      storyType: '',
      artStyle: 'pixar',
      storyDetails: '',
      dedication: '',
      pages: 30,
      languageLevel: 'standard',
      mainCharacters: []
    };

    if (isDatabaseMode()) {
      const rows = await dbQuery('SELECT data FROM story_drafts WHERE user_id = $1', [req.user.id]);

      if (rows.length > 0) {
        const data = JSON.parse(rows[0].data);
        draftData = { ...draftData, ...data };
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    res.json(draftData);
  } catch (err) {
    console.error('Error fetching story draft:', err);
    res.status(500).json({ error: 'Failed to fetch story draft' });
  }
});

// POST /api/story-draft - Save user's story draft
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { storyType, artStyle, storyDetails, dedication, pages, languageLevel, mainCharacters } = req.body;

    const draftData = {
      storyType: storyType || '',
      artStyle: artStyle || 'pixar',
      storyDetails: storyDetails || '',
      dedication: dedication || '',
      pages: pages || 30,
      languageLevel: languageLevel || 'standard',
      mainCharacters: mainCharacters || [],
      updatedAt: new Date().toISOString()
    };

    if (isDatabaseMode()) {
      // Upsert - insert or update on conflict
      const upsertQuery = `
        INSERT INTO story_drafts (user_id, data, updated_at)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id) DO UPDATE SET data = $2, updated_at = CURRENT_TIMESTAMP
      `;
      await dbQuery(upsertQuery, [req.user.id, JSON.stringify(draftData)]);
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    log.debug(`📝 [DRAFT] Saved story draft for user ${req.user.username}`);
    res.json({ message: 'Story draft saved successfully' });
  } catch (err) {
    console.error('Error saving story draft:', err);
    res.status(500).json({ error: 'Failed to save story draft' });
  }
});

// DELETE /api/story-draft - Clear user's story draft (after successful generation)
router.delete('/', authenticateToken, async (req, res) => {
  try {
    if (isDatabaseMode()) {
      await dbQuery('DELETE FROM story_drafts WHERE user_id = $1', [req.user.id]);
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    log.debug(`🗑️ [DRAFT] Cleared story draft for user ${req.user.username}`);
    res.json({ message: 'Story draft cleared' });
  } catch (err) {
    console.error('Error clearing story draft:', err);
    res.status(500).json({ error: 'Failed to clear story draft' });
  }
});

module.exports = router;
