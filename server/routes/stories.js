/**
 * Story Routes - /api/stories/*
 *
 * Story CRUD operations (list, get, save, delete, cover)
 *
 * NOTE: Regenerate/edit routes remain in server.js due to AI generation dependencies
 */

const express = require('express');
const router = express.Router();

const { dbQuery, getPool } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

// Helper to check if using database mode
const isDatabaseMode = () => {
  return process.env.STORAGE_MODE === 'database' && getPool();
};

// Helper to log activity
async function logActivity(userId, username, action, details) {
  try {
    if (isDatabaseMode()) {
      await dbQuery(
        'INSERT INTO logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
        [userId, username, action, JSON.stringify(details)]
      );
    }
  } catch (err) {
    console.error('Failed to log activity:', err);
  }
}

// GET /api/stories - List user's stories (paginated, metadata only)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    log.debug(`📚 GET /api/stories - User: ${req.user.username}, limit: ${limit}, offset: ${offset}`);
    let userStories = [];
    let totalCount = 0;

    if (isDatabaseMode()) {
      // Get total count
      const countResult = await dbQuery('SELECT COUNT(*) as count FROM stories WHERE user_id = $1', [req.user.id]);
      totalCount = parseInt(countResult[0]?.count || 0);

      // Get paginated data
      const rows = await dbQuery(
        'SELECT data FROM stories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.user.id, limit, offset]
      );

      // Parse and return metadata only (no images for performance)
      userStories = rows.map(row => {
        const story = JSON.parse(row.data);
        const hasThumbnail = !!(story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail);
        return {
          id: story.id,
          title: story.title,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          pages: story.pages,
          language: story.language,
          characters: story.characters?.map(c => ({ name: c.name, id: c.id })) || [],
          pageCount: story.sceneImages?.length || 0,
          hasThumbnail,
          isPartial: story.isPartial || false,
          generatedPages: story.generatedPages,
          totalPages: story.totalPages
        };
      });
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    console.log(`📚 Returning ${userStories.length} stories`);
    await logActivity(req.user.id, req.user.username, 'STORIES_LOADED', { count: userStories.length });

    res.json({
      stories: userStories,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + userStories.length < totalCount
      }
    });
  } catch (err) {
    console.error('❌ Error fetching stories:', err);
    res.status(500).json({ error: 'Failed to fetch stories', details: err.message });
  }
});

// GET /api/stories/:id - Get single story with ALL data (images included)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📖 GET /api/stories/${id} - User: ${req.user.username}`);

    let story = null;

    if (isDatabaseMode()) {
      const rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);

      if (rows.length > 0) {
        story = JSON.parse(rows[0].data);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    console.log(`📖 Returning full story: ${story.title} with ${story.sceneImages?.length || 0} images`);
    res.json(story);
  } catch (err) {
    console.error('❌ Error fetching story:', err);
    res.status(500).json({ error: 'Failed to fetch story', details: err.message });
  }
});

// GET /api/stories/:id/cover - Get story cover image only (for lazy loading)
router.get('/:id/cover', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    let coverImage = null;

    if (isDatabaseMode()) {
      const pool = getPool();
      const result = await pool.query(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
      if (result.rows.length > 0) {
        const story = JSON.parse(result.rows[0].data);
        coverImage = story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null;
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    if (!coverImage) {
      return res.status(404).json({ error: 'Cover image not found' });
    }

    res.json({ coverImage });
  } catch (err) {
    console.error('❌ Error fetching cover image:', err);
    res.status(500).json({ error: 'Failed to fetch cover image' });
  }
});

// POST /api/stories - Save or update a story
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { story } = req.body;

    // Add timestamp and ID if not present
    if (!story.id) {
      story.id = Date.now().toString();
    }
    story.createdAt = story.createdAt || new Date().toISOString();
    story.updatedAt = new Date().toISOString();

    let isNewStory;

    if (isDatabaseMode()) {
      // Check if story exists
      const existing = await dbQuery('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [story.id, req.user.id]);
      isNewStory = existing.length === 0;

      if (isNewStory) {
        await dbQuery('INSERT INTO stories (id, user_id, data) VALUES ($1, $2, $3)', [story.id, req.user.id, JSON.stringify(story)]);
      } else {
        await dbQuery('UPDATE stories SET data = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(story), story.id, req.user.id]);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'STORY_SAVED', {
      storyId: story.id,
      isNew: isNewStory
    });

    res.json({ message: 'Story saved successfully', id: story.id });
  } catch (err) {
    console.error('Error saving story:', err);
    res.status(500).json({ error: 'Failed to save story' });
  }
});

// DELETE /api/stories/:id - Delete a story
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️  DELETE /api/stories/${id} - User: ${req.user.username}`);

    if (isDatabaseMode()) {
      const result = await dbQuery('DELETE FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);

      if (!result.rowCount || result.rowCount === 0) {
        return res.status(404).json({ error: 'Story not found or you do not have permission to delete it' });
      }

      // Also delete associated story_job
      try {
        const pool = getPool();
        await pool.query('DELETE FROM story_jobs WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      } catch (jobErr) {
        log.warn(`Could not delete story_job ${id}:`, jobErr.message);
      }

      console.log(`✅ Successfully deleted story ${id}`);
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    await logActivity(req.user.id, req.user.username, 'STORY_DELETED', { storyId: id });
    res.json({ message: 'Story deleted successfully' });
  } catch (err) {
    console.error('Error deleting story:', err);
    res.status(500).json({ error: 'Failed to delete story' });
  }
});

module.exports = router;
