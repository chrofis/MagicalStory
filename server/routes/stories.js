/**
 * Story Routes - /api/stories/*
 *
 * Story CRUD operations (list, get, save, delete, cover)
 *
 * NOTE: Regenerate/edit routes remain in server.js due to AI generation dependencies
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode, logActivity } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');

// GET /api/stories - List user's stories (paginated, metadata only)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    log.debug(`📚 GET /api/stories - User: ${req.user.username}, limit: ${limit}, offset: ${offset}`);
    log.debug(`📚 [DEBUG] Stories query user ID: "${req.user.id}" (type: ${typeof req.user.id})`);
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
        // Calculate page count:
        // - Picture book (1st-grade): 1 scene = 1 page (image with text below)
        // - Standard/Advanced: 1 scene = 2 pages (text page + image page)
        // - Plus 3 cover pages (front, back, initial/dedication)
        const sceneCount = story.sceneImages?.length || 0;
        const isPictureBook = story.languageLevel === '1st-grade';
        const storyPages = isPictureBook ? sceneCount : sceneCount * 2;
        const pageCount = sceneCount > 0 ? storyPages + 3 : 0;
        return {
          id: story.id,
          title: story.title,
          createdAt: story.createdAt,
          updatedAt: story.updatedAt,
          pages: story.pages,
          language: story.language,
          languageLevel: story.languageLevel,
          characters: story.characters?.map(c => ({ name: c.name, id: c.id })) || [],
          pageCount,
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

// Helper function to update page text
function updatePageText(storyText, pageNumber, newText) {
  const pageRegex = new RegExp(`(Page ${pageNumber}[:\\s]*\\n?)([\\s\\S]*?)(?=Page \\d+|$)`, 'i');
  const match = storyText.match(pageRegex);

  if (match) {
    return storyText.replace(pageRegex, `$1${newText}\n\n`);
  }
  return storyText;
}

// PATCH /api/stories/:id/page/:pageNum - Update page text or scene description
router.patch('/:id/page/:pageNum', authenticateToken, async (req, res) => {
  try {
    const { id, pageNum } = req.params;
    const { text, sceneDescription } = req.body;
    const pageNumber = parseInt(pageNum);

    if (!text && !sceneDescription) {
      return res.status(400).json({ error: 'Provide text or sceneDescription to update' });
    }

    console.log(`📝 Editing page ${pageNumber} for story ${id}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const pool = getPool();
    const storyResult = await pool.query(
      'SELECT * FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (storyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = storyResult.rows[0];
    const storyData = typeof story.data === 'string' ? JSON.parse(story.data) : story.data;

    // Update page text if provided
    if (text !== undefined) {
      storyData.storyText = updatePageText(storyData.storyText, pageNumber, text);
    }

    // Update scene description if provided
    if (sceneDescription !== undefined) {
      let sceneDescriptions = storyData.sceneDescriptions || [];
      const existingIndex = sceneDescriptions.findIndex(s => s.pageNumber === pageNumber);

      if (existingIndex >= 0) {
        sceneDescriptions[existingIndex].description = sceneDescription;
      } else {
        sceneDescriptions.push({ pageNumber, description: sceneDescription });
        sceneDescriptions.sort((a, b) => a.pageNumber - b.pageNumber);
      }
      storyData.sceneDescriptions = sceneDescriptions;
    }

    // Save updated story
    await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(storyData), id]);

    console.log(`✅ Page ${pageNumber} updated for story ${id}`);

    res.json({
      success: true,
      pageNumber,
      updated: { text: text !== undefined, sceneDescription: sceneDescription !== undefined }
    });

  } catch (err) {
    console.error('Error editing page:', err);
    res.status(500).json({ error: 'Failed to edit page: ' + err.message });
  }
});

// PUT /api/stories/:id/visual-bible - Update Visual Bible
router.put('/:id/visual-bible', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { visualBible } = req.body;

    if (!visualBible) {
      return res.status(400).json({ error: 'visualBible is required' });
    }

    console.log(`📖 PUT /api/stories/${id}/visual-bible - User: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(result.rows[0].data);
    storyData.visualBible = visualBible;
    storyData.updatedAt = new Date().toISOString();

    await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(storyData), id]);

    console.log(`✅ Visual Bible updated for story ${id}`);

    res.json({
      success: true,
      message: 'Visual Bible updated successfully'
    });

  } catch (err) {
    console.error('Error updating Visual Bible:', err);
    res.status(500).json({ error: 'Failed to update Visual Bible: ' + err.message });
  }
});

// PUT /api/stories/:id/text - Bulk update story text (for edit mode)
router.put('/:id/text', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { story: newStoryText } = req.body;

    if (!newStoryText) {
      return res.status(400).json({ error: 'story text is required' });
    }

    console.log(`📝 PUT /api/stories/${id}/text - Saving edited text`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(result.rows[0].data);

    // Preserve original story text on first edit
    if (!storyData.originalStory && storyData.story) {
      storyData.originalStory = storyData.story;
      console.log(`📝 Preserved original story text (${storyData.originalStory.length} chars)`);
    }

    // Update story text
    storyData.story = newStoryText;
    storyData.storyText = newStoryText; // Also update storyText for compatibility
    storyData.updatedAt = new Date().toISOString();

    await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(storyData), id]);

    console.log(`✅ Story text updated for ${id}`);
    await logActivity(req.user.id, req.user.username, 'STORY_TEXT_EDITED', { storyId: id });

    res.json({
      success: true,
      message: 'Story text saved successfully',
      hasOriginal: !!storyData.originalStory
    });

  } catch (err) {
    console.error('Error saving story text:', err);
    res.status(500).json({ error: 'Failed to save story text: ' + err.message });
  }
});

// PUT /api/stories/:id/pages/:pageNumber/active-image - Select which image version is active
router.put('/:id/pages/:pageNumber/active-image', authenticateToken, async (req, res) => {
  try {
    const { id, pageNumber } = req.params;
    const { versionIndex } = req.body;
    const pageNum = parseInt(pageNumber);

    if (typeof versionIndex !== 'number' || versionIndex < 0) {
      return res.status(400).json({ error: 'Valid versionIndex is required' });
    }

    console.log(`🖼️ PUT /api/stories/${id}/pages/${pageNum}/active-image - Selecting version ${versionIndex}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    const pool = getPool();
    const result = await pool.query(
      'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(result.rows[0].data);
    const sceneImages = storyData.sceneImages || [];
    const sceneIndex = sceneImages.findIndex(s => s.pageNumber === pageNum);

    if (sceneIndex === -1) {
      return res.status(404).json({ error: 'Scene not found for this page' });
    }

    const scene = sceneImages[sceneIndex];
    const versions = scene.imageVersions || [];

    if (versionIndex >= versions.length) {
      return res.status(400).json({ error: 'Invalid version index' });
    }

    // Update isActive flags
    versions.forEach((v, i) => {
      v.isActive = (i === versionIndex);
    });

    // Also update the main imageData to the selected version
    scene.imageData = versions[versionIndex].imageData;
    scene.imageVersions = versions;

    storyData.sceneImages = sceneImages;
    storyData.updatedAt = new Date().toISOString();

    await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(storyData), id]);

    console.log(`✅ Active image set to version ${versionIndex} for page ${pageNum}`);

    res.json({
      success: true,
      activeVersion: versionIndex,
      pageNumber: pageNum
    });

  } catch (err) {
    console.error('Error setting active image:', err);
    res.status(500).json({ error: 'Failed to set active image: ' + err.message });
  }
});

module.exports = router;
