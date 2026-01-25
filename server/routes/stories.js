/**
 * Story Routes - /api/stories/*
 *
 * Story CRUD operations (list, get, save, delete, cover)
 *
 * NOTE: Regenerate/edit routes remain in server.js due to AI generation dependencies
 */

const express = require('express');
const router = express.Router();

const { dbQuery, isDatabaseMode, logActivity, getPool, getStoryImage, getStoryImageWithVersions, hasStorySeparateImages, saveStoryData, updateStoryDataOnly } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const { log } = require('../utils/logger');
const { getEventForStory, getAllEvents, EVENT_CATEGORIES } = require('../lib/historicalEvents');

/**
 * Build metadata object from story data for fast list queries.
 * This extracts only the fields needed for listing stories.
 */
function buildStoryMetadata(story) {
  const sceneCount = story.sceneImages?.length || 0;
  const hasThumbnail = !!(
    story.coverImages?.frontCover?.imageData ||
    story.coverImages?.frontCover ||
    story.thumbnail
  );

  return {
    id: story.id,
    title: story.title,
    createdAt: story.createdAt,
    updatedAt: story.updatedAt,
    pages: story.pages,
    language: story.language,
    languageLevel: story.languageLevel,
    isPartial: story.isPartial || false,
    generatedPages: story.generatedPages,
    totalPages: story.totalPages,
    sceneCount,
    hasThumbnail,
    characters: (story.characters || []).map(c => ({ id: c.id, name: c.name })),
  };
}

// ============================================
// HISTORICAL EVENTS API
// ============================================

// GET /api/stories/historical-events - List all historical events
router.get('/historical-events', async (req, res) => {
  try {
    const events = getAllEvents();
    res.json({
      events,
      categories: EVENT_CATEGORIES
    });
  } catch (error) {
    log.error('Error fetching historical events:', error);
    res.status(500).json({ error: 'Failed to fetch historical events' });
  }
});

// GET /api/stories/historical-events/:id - Get historical event context for story generation
router.get('/historical-events/:id', async (req, res) => {
  try {
    const eventContext = getEventForStory(req.params.id);
    if (!eventContext) {
      return res.status(404).json({ error: 'Historical event not found' });
    }
    res.json(eventContext);
  } catch (error) {
    log.error('Error fetching historical event:', error);
    res.status(500).json({ error: 'Failed to fetch historical event' });
  }
});

// ============================================
// STORY CRUD
// ============================================

// GET /api/stories - List user's stories (paginated, metadata only)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 50);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    log.debug(`📚 GET /api/stories - User: ${req.user.username}, limit: ${limit}, offset: ${offset}`);
    console.log(`📚 [STORIES] Fetching stories for user: ${req.user.username} (id: ${req.user.id})`);
    log.debug(`📚 [DEBUG] Stories query user ID: "${req.user.id}" (type: ${typeof req.user.id})`);
    let userStories = [];
    let totalCount = 0;

    if (isDatabaseMode()) {
      // Get total count
      const countResult = await dbQuery('SELECT COUNT(*) as count FROM stories WHERE user_id = $1', [req.user.id]);
      totalCount = parseInt(countResult[0]?.count || 0);

      // Get paginated data using metadata column (fast - no image data loaded)
      // Falls back to full data parsing if metadata is null (for stories created before migration)
      const rows = await dbQuery(
        'SELECT metadata, CASE WHEN metadata IS NULL THEN data ELSE NULL END as data FROM stories WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
        [req.user.id, limit, offset]
      );

      // Map rows to story metadata
      userStories = rows.map(row => {
        // Use metadata if available, otherwise parse from data (fallback for old stories)
        let meta;
        if (row.metadata) {
          meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
        } else if (row.data) {
          // Fallback: parse full data (slow path for stories without metadata)
          const story = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          meta = buildStoryMetadata(story);
        } else {
          return null; // Skip invalid rows
        }

        // Calculate page count from scene count
        const sceneCount = meta.sceneCount || 0;
        const isPictureBook = meta.languageLevel === '1st-grade';
        const storyPages = isPictureBook ? sceneCount : sceneCount * 2;
        const pageCount = sceneCount > 0 ? storyPages + 3 : 0;

        return {
          id: meta.id,
          title: meta.title,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          pages: meta.pages,
          language: meta.language,
          languageLevel: meta.languageLevel,
          characters: meta.characters || [],
          pageCount,
          hasThumbnail: meta.hasThumbnail || false,
          isPartial: meta.isPartial || false,
          generatedPages: meta.generatedPages,
          totalPages: meta.totalPages
        };
      }).filter(Boolean); // Remove null entries
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

// GET /api/stories/debug/:id - Debug endpoint to check story existence (admin only)
router.get('/debug/:id', authenticateToken, async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const { id } = req.params;
    const rows = await dbQuery(
      'SELECT id, user_id, created_at, (metadata::jsonb->>\'title\') as title FROM stories WHERE id = $1',
      [id]
    );
    if (rows.length === 0) {
      return res.json({ found: false, id });
    }
    const story = rows[0];
    // Also get the user email for this story
    const userRows = await dbQuery('SELECT email FROM users WHERE id = $1', [story.user_id]);
    res.json({
      found: true,
      id: story.id,
      user_id: story.user_id,
      user_email: userRows[0]?.email || 'unknown',
      created_at: story.created_at,
      title: story.title
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stories/:id/metadata - Get story WITHOUT image data (for fast initial load)
// Optimized: If story has separate images, skip the slow blob loading
router.get('/:id/metadata', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`📖 GET /api/stories/${id}/metadata - User: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // First verify access (fast query)
    let accessRows;
    if (req.user.impersonating && req.user.originalAdminId) {
      accessRows = await dbQuery('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (accessRows.length === 0) {
        accessRows = await dbQuery('SELECT id FROM stories WHERE id = $1', [id]);
      }
    } else {
      accessRows = await dbQuery('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    }

    if (accessRows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Check if story has images in separate table (FAST path)
    const hasSeparateImages = await hasStorySeparateImages(id);

    let metadata;

    if (hasSeparateImages) {
      // FAST PATH: Load metadata without image data, get image info from story_images table
      // IMPORTANT: Extract only specific JSONB fields - do NOT use (data::jsonb) - 'field'
      // because that still loads the entire blob before removing fields!
      // Characters are extracted separately with only id/name (not full 7MB+ photo data)
      const metaQuery = `
        SELECT
          jsonb_build_object(
            'id', data::jsonb->'id',
            'title', data::jsonb->'title',
            'createdAt', data::jsonb->'createdAt',
            'updatedAt', data::jsonb->'updatedAt',
            'language', data::jsonb->'language',
            'languageLevel', data::jsonb->'languageLevel',
            'outline', data::jsonb->'outline',
            'outlinePrompt', data::jsonb->'outlinePrompt',
            'outlineModelId', data::jsonb->'outlineModelId',
            'outlineUsage', data::jsonb->'outlineUsage',
            'storyTextPrompts', data::jsonb->'storyTextPrompts',
            'storyText', data::jsonb->'storyText',
            'storyCategory', data::jsonb->'storyCategory',
            'storyTopic', data::jsonb->'storyTopic',
            'storyTheme', data::jsonb->'storyTheme',
            'mainCharacters', data::jsonb->'mainCharacters',
            'generatedPages', data::jsonb->'generatedPages',
            'totalPages', data::jsonb->'totalPages',
            'pages', data::jsonb->'pages',
            'clothingRequirements', data::jsonb->'clothingRequirements',
            'artStyle', data::jsonb->'artStyle',
            'imageGenerationMode', data::jsonb->'imageGenerationMode',
            'isPartial', data::jsonb->'isPartial',
            'historicalEvent', data::jsonb->'historicalEvent',
            'location', data::jsonb->'location',
            'season', data::jsonb->'season',
            'userLocation', data::jsonb->'userLocation'
          ) as base_data,
          COALESCE(jsonb_array_length(data::jsonb->'sceneImages'), 0) as scene_count,
          (SELECT jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name'))
           FROM jsonb_array_elements(data::jsonb->'characters') c) as characters_mini
        FROM stories WHERE id = $1
      `;
      const metaRows = await dbQuery(metaQuery, [id]);
      const baseData = typeof metaRows[0].base_data === 'string'
        ? JSON.parse(metaRows[0].base_data)
        : metaRows[0].base_data;
      const sceneCount = parseInt(metaRows[0].scene_count) || 0;
      // Add minimal characters array (just id/name for GenerationSettingsPanel)
      const charactersMini = metaRows[0].characters_mini || [];
      baseData.characters = Array.isArray(charactersMini)
        ? charactersMini.map(c => ({ id: parseInt(c.id) || c.id, name: c.name }))
        : [];

      // Get image info from story_images table (fast - no large data)
      const imageInfoRows = await dbQuery(
        `SELECT image_type, page_number, version_index, quality_score, generated_at
         FROM story_images WHERE story_id = $1 ORDER BY image_type, page_number, version_index`,
        [id]
      );

      // Build sceneImages array from image info
      const sceneImagesMap = new Map();
      const coverImages = { frontCover: null, initialPage: null, backCover: null };

      for (const row of imageInfoRows) {
        if (row.image_type === 'scene') {
          if (!sceneImagesMap.has(row.page_number)) {
            sceneImagesMap.set(row.page_number, {
              pageNumber: row.page_number,
              hasImage: true,
              qualityScore: row.quality_score,
              generatedAt: row.generated_at,
              imageVersions: []
            });
          }
          if (row.version_index > 0) {
            sceneImagesMap.get(row.page_number).imageVersions.push({
              hasImage: true,
              qualityScore: row.quality_score,
              generatedAt: row.generated_at
            });
          }
        } else {
          // Cover image
          coverImages[row.image_type] = {
            hasImage: true,
            qualityScore: row.quality_score,
            generatedAt: row.generated_at
          };
        }
      }

      const sceneImages = Array.from(sceneImagesMap.values()).sort((a, b) => a.pageNumber - b.pageNumber);
      const coverCount = (coverImages.frontCover ? 1 : 0) + (coverImages.initialPage ? 1 : 0) + (coverImages.backCover ? 1 : 0);

      metadata = {
        ...baseData,
        sceneImages,
        coverImages: coverCount > 0 ? coverImages : null,
        totalImages: sceneImages.length + coverCount
      };

      console.log(`📖 [FAST] Returning story metadata: ${metadata.title} (${metadata.totalImages} images to load)`);
      console.log(`📖 [FAST] storyCategory: "${metadata.storyCategory}", storyTopic: "${metadata.storyTopic}", storyTheme: "${metadata.storyTheme}"`);
      console.log(`📖 [FAST] mainCharacters: ${JSON.stringify(metadata.mainCharacters)}`);
    } else {
      // SLOW PATH: Load full data blob (for non-migrated stories)
      const rows = await dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
      const story = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

      // Strip out image data and full characters (photo data is huge), but include minimal char info
      const { characters: fullCharacters, ...storyWithoutCharacters } = story;
      // Extract just id/name from characters for GenerationSettingsPanel
      const charactersMini = (fullCharacters || []).map(c => ({ id: c.id, name: c.name }));
      metadata = {
        ...storyWithoutCharacters,
        characters: charactersMini,
        sceneImages: story.sceneImages?.map(img => ({
          ...img,
          imageData: undefined,
          hasImage: !!img.imageData,
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
        totalImages: (story.sceneImages?.length || 0) + (story.coverImages ? 3 : 0)
      };

      console.log(`📖 [SLOW] Returning story metadata: ${story.title} (${metadata.totalImages} images to load)`);
      console.log(`📖 [SLOW] storyCategory: "${metadata.storyCategory}", storyTopic: "${metadata.storyTopic}", storyTheme: "${metadata.storyTheme}"`);
      console.log(`📖 [SLOW] mainCharacters: ${JSON.stringify(metadata.mainCharacters)}`);
    }

    res.json(metadata);
  } catch (err) {
    console.error('❌ Error fetching story metadata:', err);
    res.status(500).json({ error: 'Failed to fetch story metadata', details: err.message });
  }
});

// GET /api/stories/:id/dev-metadata - Get developer-only metadata (prompts, quality reasoning, retry history)
// This is loaded separately to keep the main metadata endpoint fast for normal users
router.get('/:id/dev-metadata', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🔧 GET /api/stories/${id}/dev-metadata - User: ${req.user.username}`);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Verify access
    let rows;
    if (req.user.impersonating && req.user.originalAdminId) {
      rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (rows.length === 0) {
        rows = await dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
      }
    } else {
      rows = await dbQuery('SELECT data FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

    // Extract CRITICAL ANALYSIS from outline (if present)
    let criticalAnalysis = null;
    if (story.outline) {
      const analysisMatch = story.outline.match(/---CRITICAL ANALYSIS---\s*\n([\s\S]*?)(?=\n---TITLE---|$)/);
      if (analysisMatch) {
        criticalAnalysis = analysisMatch[1].trim();
      }
    }

    // Extract only dev-relevant fields (no image data, no characters)
    const devMetadata = {
      // Story outline review data
      criticalAnalysis,
      originalStory: story.originalStory || null,
      // Scene images dev data
      sceneImages: story.sceneImages?.map(img => ({
        pageNumber: img.pageNumber,
        prompt: img.prompt || null,
        qualityReasoning: img.qualityReasoning || null,
        retryHistory: img.retryHistory || [],
        repairHistory: img.repairHistory || [],
        wasRegenerated: img.wasRegenerated || false,
        originalImage: img.originalImage ? true : false, // Just flag, not data
        originalScore: img.originalScore || null,
        originalReasoning: img.originalReasoning || null,
        totalAttempts: img.totalAttempts || null,
        faceEvaluation: img.faceEvaluation || null,
        referencePhotos: img.referencePhotos || null,
        landmarkPhotos: img.landmarkPhotos || null,
        // Consistency regeneration data (includes before/after images for comparison)
        consistencyRegen: img.consistencyRegen || null
      })) || [],
      // Cover images dev data
      coverImages: story.coverImages ? {
        frontCover: story.coverImages.frontCover && typeof story.coverImages.frontCover === 'object' ? {
          prompt: story.coverImages.frontCover.prompt || null,
          qualityReasoning: story.coverImages.frontCover.qualityReasoning || null,
          retryHistory: story.coverImages.frontCover.retryHistory || [],
          totalAttempts: story.coverImages.frontCover.totalAttempts || null,
          referencePhotos: story.coverImages.frontCover.referencePhotos || null,
          landmarkPhotos: story.coverImages.frontCover.landmarkPhotos || null
        } : null,
        initialPage: story.coverImages.initialPage && typeof story.coverImages.initialPage === 'object' ? {
          prompt: story.coverImages.initialPage.prompt || null,
          qualityReasoning: story.coverImages.initialPage.qualityReasoning || null,
          retryHistory: story.coverImages.initialPage.retryHistory || [],
          totalAttempts: story.coverImages.initialPage.totalAttempts || null,
          referencePhotos: story.coverImages.initialPage.referencePhotos || null,
          landmarkPhotos: story.coverImages.initialPage.landmarkPhotos || null
        } : null,
        backCover: story.coverImages.backCover && typeof story.coverImages.backCover === 'object' ? {
          prompt: story.coverImages.backCover.prompt || null,
          qualityReasoning: story.coverImages.backCover.qualityReasoning || null,
          retryHistory: story.coverImages.backCover.retryHistory || [],
          totalAttempts: story.coverImages.backCover.totalAttempts || null,
          referencePhotos: story.coverImages.backCover.referencePhotos || null,
          landmarkPhotos: story.coverImages.backCover.landmarkPhotos || null
        } : null
      } : null,
      // Scene descriptions (outline extract, scene prompt, scene description text)
      sceneDescriptions: story.sceneDescriptions || [],
      // Visual Bible (characters, locations, objects)
      visualBible: story.visualBible || null,
      // Generation log (avatar lookups, stage transitions, etc.)
      generationLog: story.generationLog || [],
      // Styled avatar generation log (for developer mode auditing)
      styledAvatarGeneration: story.styledAvatarGeneration || [],
      // Costumed avatar generation log (for developer mode auditing)
      costumedAvatarGeneration: story.costumedAvatarGeneration || [],
      // Final consistency checks report (if final checks were enabled)
      finalChecksReport: story.finalChecksReport || null
    };

    console.log(`🔧 Returning dev metadata: ${devMetadata.sceneImages.length} scene entries, generationLog: ${devMetadata.generationLog?.length || 0} entries, styledAvatars: ${devMetadata.styledAvatarGeneration?.length || 0}, costumedAvatars: ${devMetadata.costumedAvatarGeneration?.length || 0}`);
    res.json(devMetadata);
  } catch (err) {
    console.error('❌ Error fetching dev metadata:', err);
    res.status(500).json({ error: 'Failed to fetch dev metadata', details: err.message });
  }
});

// GET /api/stories/:id/image/:pageNumber - Get individual page image
// Optimized: First tries separate story_images table, falls back to data blob
router.get('/:id/image/:pageNumber', authenticateToken, async (req, res) => {
  try {
    const { id, pageNumber } = req.params;
    const pageNum = parseInt(pageNumber, 10);

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // First, verify user has access to this story (fast query, no data loading)
    let rows;
    if (req.user.impersonating && req.user.originalAdminId) {
      rows = await dbQuery('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (rows.length === 0) {
        rows = await dbQuery('SELECT id FROM stories WHERE id = $1', [id]);
      }
    } else {
      rows = await dbQuery('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Try to get image with all versions in single query (FAST path)
    const separateImage = await getStoryImageWithVersions(id, 'scene', pageNum);
    if (separateImage) {
      return res.json({
        pageNumber: pageNum,
        imageData: separateImage.imageData,
        qualityScore: separateImage.qualityScore,
        generatedAt: separateImage.generatedAt,
        imageVersions: separateImage.versions
      });
    }

    // Fallback: Load from data blob (SLOW path for non-migrated stories)
    const dataRows = await dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
    if (dataRows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = typeof dataRows[0].data === 'string' ? JSON.parse(dataRows[0].data) : dataRows[0].data;
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
// Optimized: First tries separate story_images table, falls back to data blob
router.get('/:id/cover-image/:coverType', authenticateToken, async (req, res) => {
  try {
    const { id, coverType } = req.params;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // First, verify user has access to this story (fast query, no data loading)
    let rows;
    if (req.user.impersonating && req.user.originalAdminId) {
      rows = await dbQuery('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
      if (rows.length === 0) {
        rows = await dbQuery('SELECT id FROM stories WHERE id = $1', [id]);
      }
    } else {
      rows = await dbQuery('SELECT id FROM stories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Try to get cover from separate table first (FAST path)
    const separateImage = await getStoryImage(id, coverType, null, 0);
    if (separateImage) {
      return res.json({
        coverType,
        imageData: separateImage.imageData,
        qualityScore: separateImage.qualityScore,
        generatedAt: separateImage.generatedAt
      });
    }

    // Fallback: Load from data blob (SLOW path for non-migrated stories)
    const dataRows = await dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
    if (dataRows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = typeof dataRows[0].data === 'string' ? JSON.parse(dataRows[0].data) : dataRows[0].data;
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
        story = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
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

// GET /api/stories/:id/cover - Get story cover image only (for lazy loading in story list)
router.get('/:id/cover', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Verify user has access (fast query, no data loading)
    const accessCheck = await dbQuery(
      'SELECT id FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    if (accessCheck.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // FAST PATH: Try to get cover from separate images table first
    const separateImage = await getStoryImage(id, 'frontCover', null, 0);
    if (separateImage) {
      return res.json({ coverImage: separateImage.imageData });
    }

    // SLOW PATH: Fall back to loading from data blob
    const result = await dbQuery('SELECT data FROM stories WHERE id = $1', [id]);
    if (result.length > 0) {
      const story = typeof result[0].data === 'string' ? JSON.parse(result[0].data) : result[0].data;
      const coverImage = story.coverImages?.frontCover?.imageData || story.coverImages?.frontCover || story.thumbnail || null;
      if (coverImage) {
        return res.json({ coverImage });
      }
    }

    return res.status(404).json({ error: 'Cover image not found' });
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

      // Save story (automatically extracts images to story_images table)
      // Use upsertStory which handles both insert and update
      const { upsertStory } = require('../services/database');
      await upsertStory(story.id, req.user.id, story);
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

    // Save updated story with metadata (extracts images to story_images table)
    await saveStoryData(id, storyData);

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

    const storyData = typeof result.rows[0].data === 'string' ? JSON.parse(result.rows[0].data) : result.rows[0].data;
    storyData.visualBible = visualBible;
    storyData.updatedAt = new Date().toISOString();

    // Note: visualBible doesn't affect metadata, but update for consistency
    await saveStoryData(id, storyData);

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

    const storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

    // Preserve original story text on first edit
    if (!storyData.originalStory && storyData.story) {
      storyData.originalStory = storyData.story;
      console.log(`📝 Preserved original story text (${storyData.originalStory.length} chars)`);
    }

    // Update story text
    storyData.story = newStoryText;
    storyData.storyText = newStoryText; // Also update storyText for compatibility
    storyData.updatedAt = new Date().toISOString();

    await saveStoryData(id, storyData);

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

    const storyData = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;

    // Update title
    storyData.title = title.trim();
    storyData.updatedAt = new Date().toISOString();

    // Title is in metadata, so we need to update it
    await saveStoryData(id, storyData);

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

    // OPTIMIZED: Only fetch sceneImages array, not entire 5MB+ data blob
    const result = await pool.query(
      `SELECT data->'sceneImages' as scene_images
       FROM stories WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const sceneImages = result.rows[0].scene_images || [];
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
    scene.imageVersions = versions;

    // OPTIMIZED: Use jsonb_set to update only sceneImages, not entire data blob
    await pool.query(
      `UPDATE stories
       SET data = jsonb_set(data::jsonb, '{sceneImages}', $1::jsonb),
           metadata = jsonb_set(COALESCE(metadata::jsonb, '{}'), '{updatedAt}', $2::jsonb)
       WHERE id = $3`,
      [JSON.stringify(sceneImages), JSON.stringify(new Date().toISOString()), id]
    );

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

// ============================================
// STORY SHARING
// ============================================

const crypto = require('crypto');

/**
 * Generate a cryptographically secure share token
 */
function generateShareToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 char hex string
}

/**
 * GET /api/stories/:id/share-status - Get sharing status for a story
 */
router.get('/:id/share-status', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Verify ownership
    const rows = await dbQuery(
      'SELECT share_token, is_shared FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const { share_token, is_shared } = rows[0];

    res.json({
      isShared: is_shared || false,
      shareToken: is_shared ? share_token : null,
      shareUrl: is_shared && share_token ? `${process.env.FRONTEND_URL || 'https://magicalstory.ch'}/s/${share_token}` : null
    });
  } catch (err) {
    console.error('Error getting share status:', err);
    res.status(500).json({ error: 'Failed to get share status' });
  }
});

/**
 * POST /api/stories/:id/share - Enable sharing for a story
 */
router.post('/:id/share', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Verify ownership and get current token
    const rows = await dbQuery(
      'SELECT share_token FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    let shareToken = rows[0].share_token;

    // Generate new token if none exists
    if (!shareToken) {
      shareToken = generateShareToken();
      await dbQuery(
        'UPDATE stories SET share_token = $1, is_shared = true WHERE id = $2',
        [shareToken, id]
      );
    } else {
      // Just enable sharing
      await dbQuery(
        'UPDATE stories SET is_shared = true WHERE id = $1',
        [id]
      );
    }

    const shareUrl = `${process.env.FRONTEND_URL || 'https://magicalstory.ch'}/s/${shareToken}`;

    console.log(`✅ Sharing enabled for story ${id}, token: ${shareToken.substring(0, 8)}...`);

    res.json({
      success: true,
      shareToken,
      shareUrl
    });
  } catch (err) {
    console.error('Error enabling sharing:', err);
    res.status(500).json({ error: 'Failed to enable sharing' });
  }
});

/**
 * DELETE /api/stories/:id/share - Disable sharing for a story
 */
router.delete('/:id/share', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isDatabaseMode()) {
      return res.status(501).json({ error: 'File storage mode not supported' });
    }

    // Verify ownership
    const rows = await dbQuery(
      'SELECT id FROM stories WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    // Disable sharing (keep token for potential re-enable)
    await dbQuery(
      'UPDATE stories SET is_shared = false WHERE id = $1',
      [id]
    );

    console.log(`🚫 Sharing disabled for story ${id}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Error disabling sharing:', err);
    res.status(500).json({ error: 'Failed to disable sharing' });
  }
});

module.exports = router;
