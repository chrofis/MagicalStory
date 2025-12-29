/**
 * Story Routes - /api/stories/*
 *
 * Story CRUD operations (list, get, save, delete, cover)
 *
 * NOTE: Regenerate/edit routes remain in server.js due to AI generation dependencies
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode, logActivity, getPool } = require('../services/database');
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

      // Get paginated data using JSON operators to extract only metadata (not full image data)
      // This is MUCH faster than loading the entire data blob which contains base64 images
      // Note: data column is TEXT, so we cast to jsonb inline
      const rows = await dbQuery(
        `SELECT
          (data::jsonb)->>'id' as id,
          (data::jsonb)->>'title' as title,
          (data::jsonb)->>'createdAt' as "createdAt",
          (data::jsonb)->>'updatedAt' as "updatedAt",
          ((data::jsonb)->>'pages')::int as pages,
          (data::jsonb)->>'language' as language,
          (data::jsonb)->>'languageLevel' as "languageLevel",
          (data::jsonb)->'characters' as characters_json,
          COALESCE(jsonb_array_length((data::jsonb)->'sceneImages'), 0) as scene_count,
          ((data::jsonb)->>'isPartial')::boolean as "isPartial",
          ((data::jsonb)->>'generatedPages')::int as "generatedPages",
          ((data::jsonb)->>'totalPages')::int as "totalPages",
          CASE
            WHEN (data::jsonb)->'coverImages'->'frontCover'->'imageData' IS NOT NULL THEN true
            WHEN (data::jsonb)->'coverImages'->'frontCover' IS NOT NULL AND jsonb_typeof((data::jsonb)->'coverImages'->'frontCover') = 'string' THEN true
            WHEN (data::jsonb)->>'thumbnail' IS NOT NULL THEN true
            ELSE false
          END as "hasThumbnail"
        FROM stories
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      );

      // Map database results to response format (no JSON parsing needed!)
      userStories = rows.map(row => {
        // Calculate page count:
        // - Picture book (1st-grade): 1 scene = 1 page (image with text below)
        // - Standard/Advanced: 1 scene = 2 pages (text page + image page)
        // - Plus 3 cover pages (front, back, initial/dedication)
        const sceneCount = parseInt(row.scene_count) || 0;
        const isPictureBook = row.languageLevel === '1st-grade';
        const storyPages = isPictureBook ? sceneCount : sceneCount * 2;
        const pageCount = sceneCount > 0 ? storyPages + 3 : 0;

        // Parse characters from JSON (small data)
        let characters = [];
        try {
          const charsData = typeof row.characters_json === 'string'
            ? JSON.parse(row.characters_json)
            : row.characters_json;
          characters = (charsData || []).map(c => ({ name: c.name, id: c.id }));
        } catch (e) {
          // Ignore parse errors
        }

        return {
          id: row.id,
          title: row.title,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          pages: row.pages,
          language: row.language,
          languageLevel: row.languageLevel,
          characters,
          pageCount,
          hasThumbnail: row.hasThumbnail || false,
          isPartial: row.isPartial || false,
          generatedPages: row.generatedPages,
          totalPages: row.totalPages
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

// GET /api/stories/:id/metadata - Get story WITHOUT image data (for fast initial load)
router.get('/:id/metadata', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📖 GET /api/stories/${id}/metadata - User: ${req.user.username}`);

    let story = null;

    if (isDatabaseMode()) {
      let rows;
      if (req.user.impersonating && req.user.originalAdminId) {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (rows.length === 0) {
          rows = await dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [id]);
        }
      } else {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      }

      if (rows.length > 0) {
        story = JSON.parse(rows[0].data);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Strip out image data but keep metadata
    const metadata = {
      ...story,
      sceneImages: story.sceneImages?.map(img => ({
        ...img,
        imageData: undefined, // Remove actual image data
        hasImage: !!img.imageData,
        // Keep version info but strip image data
        imageVersions: img.imageVersions?.map(v => ({
          ...v,
          imageData: undefined,
          hasImage: !!v.imageData
        }))
      })),
      coverImages: story.coverImages ? {
        frontCover: story.coverImages.frontCover ? {
          ...(typeof story.coverImages.frontCover === 'object' ? story.coverImages.frontCover : {}),
          imageData: undefined,
          hasImage: !!(typeof story.coverImages.frontCover === 'string' ? story.coverImages.frontCover : story.coverImages.frontCover?.imageData)
        } : null,
        initialPage: story.coverImages.initialPage ? {
          ...(typeof story.coverImages.initialPage === 'object' ? story.coverImages.initialPage : {}),
          imageData: undefined,
          hasImage: !!(typeof story.coverImages.initialPage === 'string' ? story.coverImages.initialPage : story.coverImages.initialPage?.imageData)
        } : null,
        backCover: story.coverImages.backCover ? {
          ...(typeof story.coverImages.backCover === 'object' ? story.coverImages.backCover : {}),
          imageData: undefined,
          hasImage: !!(typeof story.coverImages.backCover === 'string' ? story.coverImages.backCover : story.coverImages.backCover?.imageData)
        } : null
      } : null,
      // Include image count for progress tracking
      totalImages: (story.sceneImages?.length || 0) + (story.coverImages ? 3 : 0)
    };

    console.log(`📖 Returning story metadata: ${story.title} (${metadata.totalImages} images to load)`);
    res.json(metadata);
  } catch (err) {
    console.error('❌ Error fetching story metadata:', err);
    res.status(500).json({ error: 'Failed to fetch story metadata', details: err.message });
  }
});

// GET /api/stories/:id/image/:pageNumber - Get individual page image
router.get('/:id/image/:pageNumber', authenticateToken, async (req, res) => {
  try {
    const { id, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);

    let story = null;

    if (isDatabaseMode()) {
      let rows;
      if (req.user.impersonating && req.user.originalAdminId) {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (rows.length === 0) {
          rows = await dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
        }
      } else {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      }

      if (rows.length > 0) {
        story = JSON.parse(rows[0].data);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const sceneImage = story.sceneImages?.find(img => img.pageNumber === pageNum);
    if (!sceneImage || !sceneImage.imageData) {
      return res.status(404).json({ error: 'Image not found' });
    }

    res.json({
      pageNumber: pageNum,
      imageData: sceneImage.imageData,
      imageVersions: sceneImage.imageVersions
    });
  } catch (err) {
    console.error('❌ Error fetching page image:', err);
    res.status(500).json({ error: 'Failed to fetch image', details: err.message });
  }
});

// GET /api/stories/:id/cover-image/:coverType - Get individual cover image
router.get('/:id/cover-image/:coverType', authenticateToken, async (req, res) => {
  try {
    const { id, coverType } = req.params;

    let story = null;

    if (isDatabaseMode()) {
      let rows;
      if (req.user.impersonating && req.user.originalAdminId) {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (rows.length === 0) {
          rows = await dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
        }
      } else {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      }

      if (rows.length > 0) {
        story = JSON.parse(rows[0].data);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    if (!story) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const coverData = story.coverImages?.[coverType];
    if (!coverData) {
      return res.status(404).json({ error: 'Cover not found' });
    }

    // Handle both string (legacy) and object formats
    const imageData = typeof coverData === 'string' ? coverData : coverData.imageData;
    if (!imageData) {
      return res.status(404).json({ error: 'Cover image not found' });
    }

    res.json({
      coverType,
      imageData,
      ...(typeof coverData === 'object' ? { description: coverData.description, storyTitle: coverData.storyTitle } : {})
    });
  } catch (err) {
    console.error('❌ Error fetching cover image:', err);
    res.status(500).json({ error: 'Failed to fetch cover', details: err.message });
  }
});

// GET /api/stories/:id - Get single story with ALL data (images included)
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📖 GET /api/stories/${id} - User: ${req.user.username}, impersonating: ${req.user.impersonating || false}`);

    let story = null;

    if (isDatabaseMode()) {
      let rows;
      if (req.user.impersonating && req.user.originalAdminId) {
        // Admin impersonating - try impersonated user first, then any story
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
        if (rows.length === 0) {
          rows = await dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [id]);
          if (rows.length > 0) {
            console.log(`📖 [IMPERSONATE] Admin viewing story owned by user_id: ${rows[0].user_id}`);
          }
        }
      } else {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      }

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

    log.debug(`🖼️ GET /api/stories/${id}/cover - User: ${req.user.username} (ID: ${req.user.id})`);

    if (isDatabaseMode()) {
      const result = await dbQuery(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
      log.debug(`🖼️ Cover query returned ${result.length} rows for story ${id}`);
      if (result.length > 0) {
        const story = JSON.parse(result[0].data);
        coverImage = story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null;
        log.debug(`🖼️ Cover image found: ${coverImage ? 'yes' : 'no'}`);
      }
    } else {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    if (!coverImage) {
      log.debug(`🖼️ No cover image for story ${id}`);
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

    console.log(`📝 PUT /api/stories/${id}/text - Saving edited text (user: ${req.user.username}, impersonating: ${req.user.impersonating || false})`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // If admin is impersonating, allow access to the impersonated user's stories
    // The impersonation token has req.user.id set to the impersonated user's ID
    let rows;
    if (req.user.impersonating && req.user.originalAdminId) {
      // Admin impersonating - try with impersonated user's ID first, then allow any story
      rows = await dbQuery(
        'SELECT data, user_id FROM stories WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
      // If not found with user_id, admin can still access any story
      if (rows.length === 0) {
        rows = await dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [id]);
        if (rows.length > 0) {
          console.log(`📝 [IMPERSONATE] Admin accessing story owned by user_id: ${rows[0].user_id}`);
        }
      }
    } else {
      rows = await dbQuery(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(rows[0].data);

    // Preserve original story text on first edit
    if (!storyData.originalStory && storyData.story) {
      storyData.originalStory = storyData.story;
      console.log(`📝 Preserved original story text (${storyData.originalStory.length} chars)`);
    }

    // Update story text
    storyData.story = newStoryText;
    storyData.storyText = newStoryText; // Also update storyText for compatibility
    storyData.updatedAt = new Date().toISOString();

    await dbQuery('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(storyData), id]);

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

// PUT /api/stories/:id/title - Update story title
router.put('/:id/title', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title } = req.body;

    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title is required' });
    }

    console.log(`📝 PUT /api/stories/${id}/title - Saving title (user: ${req.user.username})`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Handle impersonation similar to text endpoint
    let rows;
    if (req.user.impersonating && req.user.originalAdminId) {
      rows = await dbQuery(
        'SELECT data, user_id FROM stories WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
      if (rows.length === 0) {
        rows = await dbQuery('SELECT data, user_id FROM stories WHERE id = $1', [id]);
      }
    } else {
      rows = await dbQuery(
        'SELECT data FROM stories WHERE id = $1 AND user_id = $2',
        [id, req.user.id]
      );
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const storyData = JSON.parse(rows[0].data);

    // Update title
    storyData.title = title.trim();
    storyData.updatedAt = new Date().toISOString();

    await dbQuery('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(storyData), id]);

    console.log(`✅ Story title updated for ${id}: "${title.trim()}"`);
    await logActivity(req.user.id, req.user.username, 'STORY_TITLE_EDITED', { storyId: id, newTitle: title.trim() });

    res.json({
      success: true,
      message: 'Story title saved successfully',
      title: title.trim()
    });

  } catch (err) {
    console.error('Error saving story title:', err);
    res.status(500).json({ error: 'Failed to save story title: ' + err.message });
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
