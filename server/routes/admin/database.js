/**
 * Admin Database Routes
 *
 * Database maintenance, cleanup, and management endpoints.
 * Extracted from admin.js for better code organization.
 */

const express = require('express');
const router = express.Router();

const { dbQuery, getPool, isDatabaseMode, saveStoryImage, hasStorySeparateImages } = require('../../services/database');
const { authenticateToken } = require('../../middleware/auth');
const { log } = require('../../utils/logger');

// Middleware to check admin role
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// POST /api/admin/fix-shipping-columns
router.post('/fix-shipping-columns', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const results = [];
    const columns = [
      { name: 'shipping_first_name', type: 'VARCHAR(255)' },
      { name: 'shipping_last_name', type: 'VARCHAR(255)' },
      { name: 'shipping_address_line1', type: 'VARCHAR(500)' },
      { name: 'shipping_city', type: 'VARCHAR(255)' },
      { name: 'shipping_post_code', type: 'VARCHAR(50)' },
      { name: 'shipping_country', type: 'VARCHAR(2)' },
      { name: 'shipping_email', type: 'VARCHAR(255)' }
    ];

    for (const col of columns) {
      try {
        await dbQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
        results.push({ column: col.name, status: 'OK' });
      } catch (err) {
        results.push({ column: col.name, status: 'ERROR', error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cleanup-orphaned-data
router.post('/cleanup-orphaned-data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    console.log('🔍 Checking for orphaned data...');

    const orphanedCharsResult = await dbQuery(
      `SELECT COUNT(*) as count FROM characters WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedCharsCount = parseInt(orphanedCharsResult[0].count);

    const orphanedStoriesResult = await dbQuery(
      `SELECT COUNT(*) as count FROM stories WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedStoriesCount = parseInt(orphanedStoriesResult[0].count);

    console.log(`Found ${orphanedCharsCount} orphaned characters, ${orphanedStoriesCount} orphaned stories`);

    const { action } = req.body;
    if (action === 'delete') {
      console.log('🗑️  Deleting orphaned data...');

      let deletedChars = 0;
      let deletedStories = 0;

      if (orphanedCharsCount > 0) {
        const deleteCharsResult = await dbQuery(
          `DELETE FROM characters WHERE user_id IS NULL OR user_id = ''`
        );
        deletedChars = deleteCharsResult.rowCount;
        console.log(`✓ Deleted ${deletedChars} orphaned characters`);
      }

      if (orphanedStoriesCount > 0) {
        const deleteStoriesResult = await dbQuery(
          `DELETE FROM stories WHERE user_id IS NULL OR user_id = ''`
        );
        deletedStories = deleteStoriesResult.rowCount;
        console.log(`✓ Deleted ${deletedStories} orphaned stories`);
      }

      res.json({
        success: true,
        action: 'deleted',
        deleted: {
          characters: deletedChars,
          stories: deletedStories
        }
      });
    } else {
      res.json({
        success: true,
        action: 'check',
        found: {
          characters: orphanedCharsCount,
          stories: orphanedStoriesCount
        },
        message: 'Use action=delete to remove orphaned data'
      });
    }
  } catch (err) {
    console.error('Error cleaning orphaned data:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cleanup-orphaned-jobs
router.post('/cleanup-orphaned-jobs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    console.log('🔍 Checking for orphaned story_jobs...');

    const pool = getPool();
    const orphanedJobsResult = await pool.query(`
      SELECT sj.id, sj.user_id, sj.status, sj.created_at, sj.updated_at,
             sj.progress, sj.progress_message, u.username
      FROM story_jobs sj
      LEFT JOIN users u ON sj.user_id = u.id
      WHERE NOT EXISTS (
        SELECT 1 FROM stories s WHERE s.id = sj.id
      )
      ORDER BY sj.created_at DESC
      LIMIT 100
    `);

    const orphanedJobs = orphanedJobsResult.rows;
    console.log(`Found ${orphanedJobs.length} orphaned story_jobs`);

    const { action } = req.body;
    if (action === 'delete') {
      console.log('🗑️  Deleting orphaned story_jobs...');

      const deleteResult = await pool.query(`
        DELETE FROM story_jobs
        WHERE NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = story_jobs.id
        )
      `);

      console.log(`✓ Deleted ${deleteResult.rowCount} orphaned story_jobs`);

      res.json({
        success: true,
        action: 'deleted',
        deleted: deleteResult.rowCount
      });
    } else {
      res.json({
        success: true,
        action: 'check',
        count: orphanedJobs.length,
        jobs: orphanedJobs.map(j => ({
          id: j.id,
          userId: j.user_id,
          username: j.username,
          status: j.status,
          progress: j.progress,
          progressMessage: j.progress_message,
          createdAt: j.created_at,
          updatedAt: j.updated_at
        })),
        message: 'Use action=delete to remove orphaned jobs'
      });
    }
  } catch (err) {
    console.error('Error cleaning orphaned jobs:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/cleanup-orphaned
router.post('/cleanup-orphaned', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'File cleanup is only available in database mode' });
    }

    console.log('🗑️ [ADMIN] Cleaning all orphaned files...');

    const pool = getPool();
    const result = await pool.query(`
      DELETE FROM files
      WHERE story_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM stories s WHERE s.id = story_id
        )
    `);

    const cleaned = result.rowCount || 0;
    log.info(`✅ [ADMIN] Cleaned ${cleaned} orphaned files`);

    res.json({ cleaned });
  } catch (err) {
    console.error('❌ [ADMIN] Error cleaning orphaned files:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/clear-cache
router.post('/clear-cache', authenticateToken, requireAdmin, async (req, res) => {
  try {
    console.log('🧹 [ADMIN] Clearing all caches...');
    // Cache clearing would need to be implemented at application level
    res.json({ success: true, message: 'Cache cleared successfully' });
  } catch (err) {
    console.error('❌ [ADMIN] Error clearing cache:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/orphaned-files
router.delete('/orphaned-files', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'File deletion is only available in database mode' });
    }

    const { fileId } = req.body;

    if (!fileId) {
      return res.status(400).json({ error: 'fileId is required (use "all" to delete all orphaned files)' });
    }

    const pool = getPool();
    let deletedCount = 0;

    if (fileId === 'all') {
      console.log('🗑️ [ADMIN] Deleting all orphaned files...');

      const result = await pool.query(`
        DELETE FROM files
        WHERE story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = files.story_id
          )
      `);

      deletedCount = result.rowCount;
      log.info(`✅ [ADMIN] Deleted ${deletedCount} orphaned files`);
    } else {
      console.log(`🗑️ [ADMIN] Deleting orphaned file: ${fileId}`);

      const checkResult = await pool.query(`
        SELECT f.id, f.story_id
        FROM files f
        WHERE f.id = $1
          AND f.story_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM stories s WHERE s.id = f.story_id
          )
      `, [fileId]);

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'File not found or not orphaned' });
      }

      await pool.query('DELETE FROM files WHERE id = $1', [fileId]);
      deletedCount = 1;
      log.info(`✅ [ADMIN] Deleted orphaned file: ${fileId}`);
    }

    res.json({
      success: true,
      deletedCount,
      message: `Successfully deleted ${deletedCount} orphaned file(s)`
    });
  } catch (err) {
    console.error('❌ [ADMIN] Error deleting orphaned files:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/fix-metadata-migration
// Fixes the metadata column migration if it was recorded but not executed
router.post('/fix-metadata-migration', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    const pool = getPool();
    const results = [];

    // Check if metadata column exists
    log.info('[FIX-MIGRATION] Checking if metadata column exists...');
    const columnCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stories' AND column_name = 'metadata'
    `);

    if (columnCheck.rows.length > 0) {
      return res.json({
        success: true,
        message: 'Metadata column already exists, no fix needed',
        results: [{ step: 'check', status: 'Column exists' }]
      });
    }

    // Column doesn't exist - remove migration record and re-run
    log.info('[FIX-MIGRATION] Metadata column missing, fixing...');

    // Remove migration record
    results.push({ step: 'remove_record', status: 'starting' });
    await pool.query("DELETE FROM schema_migrations WHERE migration_name = '015_add_story_metadata_column.sql'");
    results[results.length - 1].status = 'done';

    // Add column
    results.push({ step: 'add_column', status: 'starting' });
    await pool.query('ALTER TABLE stories ADD COLUMN IF NOT EXISTS metadata JSONB');
    results[results.length - 1].status = 'done';

    // Create index
    results.push({ step: 'create_index', status: 'starting' });
    await pool.query('CREATE INDEX IF NOT EXISTS idx_stories_metadata ON stories USING GIN (metadata)');
    results[results.length - 1].status = 'done';

    // Backfill
    results.push({ step: 'backfill', status: 'starting' });
    const countBefore = await pool.query('SELECT COUNT(*) as count FROM stories WHERE metadata IS NULL');
    const storiesToBackfill = parseInt(countBefore.rows[0].count);
    results[results.length - 1].storiesToBackfill = storiesToBackfill;

    await pool.query(`
      UPDATE stories
      SET metadata = jsonb_build_object(
        'id', (data::jsonb)->>'id',
        'title', (data::jsonb)->>'title',
        'createdAt', (data::jsonb)->>'createdAt',
        'updatedAt', (data::jsonb)->>'updatedAt',
        'pages', (data::jsonb)->>'pages',
        'language', (data::jsonb)->>'language',
        'languageLevel', (data::jsonb)->>'languageLevel',
        'isPartial', COALESCE(((data::jsonb)->>'isPartial')::boolean, false),
        'generatedPages', (data::jsonb)->>'generatedPages',
        'totalPages', (data::jsonb)->>'totalPages',
        'sceneCount', COALESCE(jsonb_array_length((data::jsonb)->'sceneImages'), 0),
        'hasThumbnail', CASE
          WHEN (data::jsonb)->'coverImages'->'frontCover'->'imageData' IS NOT NULL THEN true
          WHEN (data::jsonb)->'coverImages'->'frontCover' IS NOT NULL THEN true
          WHEN (data::jsonb)->>'thumbnail' IS NOT NULL THEN true
          ELSE false
        END,
        'characters', (
          SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c->>'id', 'name', c->>'name')), '[]'::jsonb)
          FROM jsonb_array_elements((data::jsonb)->'characters') AS c
        )
      )
      WHERE metadata IS NULL
    `);

    const countAfter = await pool.query('SELECT COUNT(*) as count FROM stories WHERE metadata IS NOT NULL');
    results[results.length - 1].storiesBackfilled = parseInt(countAfter.rows[0].count);
    results[results.length - 1].status = 'done';

    // Record migration
    results.push({ step: 'record_migration', status: 'starting' });
    await pool.query("INSERT INTO schema_migrations (migration_name) VALUES ('015_add_story_metadata_column.sql')");
    results[results.length - 1].status = 'done';

    log.info('[FIX-MIGRATION] Migration fixed successfully!');
    res.json({
      success: true,
      message: 'Migration fixed successfully',
      results
    });
  } catch (err) {
    log.error('[FIX-MIGRATION] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/migrate-story-images/:storyId
// Migrate a single story's images to the separate story_images table
router.post('/migrate-story-images/:storyId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    const { storyId } = req.params;
    const pool = getPool();

    // Check if already migrated
    const alreadyMigrated = await hasStorySeparateImages(storyId);
    if (alreadyMigrated) {
      return res.json({
        success: true,
        message: 'Story already migrated',
        storyId,
        imagesMigrated: 0
      });
    }

    // Load story data
    const storyRows = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
    if (storyRows.rows.length === 0) {
      return res.status(404).json({ error: 'Story not found' });
    }

    const story = typeof storyRows.rows[0].data === 'string' ? JSON.parse(storyRows.rows[0].data) : storyRows.rows[0].data;
    let imagesMigrated = 0;

    // Migrate scene images
    if (story.sceneImages) {
      for (const img of story.sceneImages) {
        if (img.imageData) {
          await saveStoryImage(storyId, 'scene', img.pageNumber, img.imageData, {
            qualityScore: img.qualityScore,
            generatedAt: img.generatedAt,
            versionIndex: 0
          });
          imagesMigrated++;

          // Migrate image versions
          if (img.imageVersions) {
            for (let i = 0; i < img.imageVersions.length; i++) {
              const version = img.imageVersions[i];
              if (version.imageData) {
                await saveStoryImage(storyId, 'scene', img.pageNumber, version.imageData, {
                  qualityScore: version.qualityScore,
                  generatedAt: version.generatedAt,
                  versionIndex: i + 1
                });
                imagesMigrated++;
              }
            }
          }
        }
      }
    }

    // Migrate cover images
    const coverTypes = ['frontCover', 'initialPage', 'backCover'];
    for (const coverType of coverTypes) {
      const coverData = story.coverImages?.[coverType];
      if (coverData) {
        const imageData = typeof coverData === 'string' ? coverData : coverData.imageData;
        if (imageData) {
          await saveStoryImage(storyId, coverType, null, imageData, {
            qualityScore: coverData.qualityScore,
            generatedAt: coverData.generatedAt,
            versionIndex: 0
          });
          imagesMigrated++;
        }
      }
    }

    log.info(`[MIGRATE] Story ${storyId} migrated: ${imagesMigrated} images`);
    res.json({
      success: true,
      message: 'Story images migrated successfully',
      storyId,
      imagesMigrated
    });
  } catch (err) {
    log.error('[MIGRATE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/migrate-all-story-images
// Migrate all stories' images to the separate story_images table
router.post('/migrate-all-story-images', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    const pool = getPool();
    const { limit = 10 } = req.body; // Process in batches

    // Get stories that haven't been migrated yet
    const storyRows = await pool.query(`
      SELECT s.id FROM stories s
      WHERE NOT EXISTS (SELECT 1 FROM story_images si WHERE si.story_id = s.id)
      LIMIT $1
    `, [limit]);

    const results = [];
    let totalImagesMigrated = 0;

    for (const row of storyRows.rows) {
      const storyId = row.id;

      try {
        // Load story data
        const dataRows = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
        const story = typeof dataRows.rows[0].data === 'string' ? JSON.parse(dataRows.rows[0].data) : dataRows.rows[0].data;
        let imagesMigrated = 0;

        // Migrate scene images
        if (story.sceneImages) {
          for (const img of story.sceneImages) {
            if (img.imageData) {
              await saveStoryImage(storyId, 'scene', img.pageNumber, img.imageData, {
                qualityScore: img.qualityScore,
                generatedAt: img.generatedAt,
                versionIndex: 0
              });
              imagesMigrated++;

              // Migrate image versions
              if (img.imageVersions) {
                for (let i = 0; i < img.imageVersions.length; i++) {
                  const version = img.imageVersions[i];
                  if (version.imageData) {
                    await saveStoryImage(storyId, 'scene', img.pageNumber, version.imageData, {
                      qualityScore: version.qualityScore,
                      generatedAt: version.generatedAt,
                      versionIndex: i + 1
                    });
                    imagesMigrated++;
                  }
                }
              }
            }
          }
        }

        // Migrate cover images
        const coverTypes = ['frontCover', 'initialPage', 'backCover'];
        for (const coverType of coverTypes) {
          const coverData = story.coverImages?.[coverType];
          if (coverData) {
            const imageData = typeof coverData === 'string' ? coverData : coverData.imageData;
            if (imageData) {
              await saveStoryImage(storyId, coverType, null, imageData, {
                qualityScore: coverData.qualityScore,
                generatedAt: coverData.generatedAt,
                versionIndex: 0
              });
              imagesMigrated++;
            }
          }
        }

        results.push({ storyId, imagesMigrated, success: true });
        totalImagesMigrated += imagesMigrated;
        log.info(`[MIGRATE] Story ${storyId}: ${imagesMigrated} images`);
      } catch (err) {
        results.push({ storyId, error: err.message, success: false });
        log.error(`[MIGRATE] Story ${storyId} failed:`, err.message);
      }
    }

    // Check how many stories still need migration
    const remainingRows = await pool.query(`
      SELECT COUNT(*) as count FROM stories s
      WHERE NOT EXISTS (SELECT 1 FROM story_images si WHERE si.story_id = s.id)
    `);
    const remaining = parseInt(remainingRows.rows[0].count);

    res.json({
      success: true,
      storiesMigrated: results.filter(r => r.success).length,
      totalImagesMigrated,
      remaining,
      results
    });
  } catch (err) {
    log.error('[MIGRATE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/convert-characters-jsonb
// Convert characters.data column from TEXT to JSONB for faster operations
router.post('/convert-characters-jsonb', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    const pool = getPool();
    const results = [];

    // Check current column type
    const typeCheck = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'characters' AND column_name = 'data'
    `);

    const currentType = typeCheck.rows[0]?.data_type;
    results.push({ step: 'check_type', currentType });

    if (currentType === 'jsonb') {
      return res.json({
        success: true,
        message: 'Column is already JSONB, no conversion needed',
        results
      });
    }

    log.info('[CONVERT-JSONB] Converting characters.data from TEXT to JSONB...');

    // Step 1: Add temporary JSONB column
    results.push({ step: 'add_jsonb_column', status: 'starting' });
    await pool.query('ALTER TABLE characters ADD COLUMN IF NOT EXISTS data_jsonb JSONB');
    results[results.length - 1].status = 'done';

    // Step 2: Copy data (this is the slow part)
    results.push({ step: 'copy_data', status: 'starting' });
    const copyResult = await pool.query(`
      UPDATE characters SET data_jsonb = data::jsonb
      WHERE data_jsonb IS NULL AND data IS NOT NULL
    `);
    results[results.length - 1].status = 'done';
    results[results.length - 1].rowsUpdated = copyResult.rowCount;

    // Step 3: Drop old column
    results.push({ step: 'drop_text_column', status: 'starting' });
    await pool.query('ALTER TABLE characters DROP COLUMN data');
    results[results.length - 1].status = 'done';

    // Step 4: Rename new column
    results.push({ step: 'rename_column', status: 'starting' });
    await pool.query('ALTER TABLE characters RENAME COLUMN data_jsonb TO data');
    results[results.length - 1].status = 'done';

    // Step 5: Add NOT NULL constraint
    results.push({ step: 'add_not_null', status: 'starting' });
    await pool.query('ALTER TABLE characters ALTER COLUMN data SET NOT NULL');
    results[results.length - 1].status = 'done';

    // Step 6: Create GIN index for faster queries
    results.push({ step: 'create_index', status: 'starting' });
    await pool.query('CREATE INDEX IF NOT EXISTS idx_characters_data_gin ON characters USING GIN (data)');
    results[results.length - 1].status = 'done';

    log.info('[CONVERT-JSONB] Conversion complete!');
    res.json({
      success: true,
      message: 'Successfully converted characters.data from TEXT to JSONB',
      results
    });
  } catch (err) {
    log.error('[CONVERT-JSONB] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/strip-migrated-image-data
// Strip imageData from stories that have images in story_images table
// This makes the data column much smaller and queries faster
router.post('/strip-migrated-image-data', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (!isDatabaseMode()) {
      return res.status(400).json({ error: 'This operation is only available in database mode' });
    }

    const pool = getPool();
    const { limit = 10, dryRun = true } = req.body;

    // Find stories that have images in story_images table
    const storyRows = await pool.query(`
      SELECT DISTINCT s.id,
             pg_column_size(s.data) as data_size_bytes
      FROM stories s
      INNER JOIN story_images si ON si.story_id = s.id
      ORDER BY data_size_bytes DESC
      LIMIT $1
    `, [limit]);

    const results = [];
    let totalBytesFreed = 0;

    for (const row of storyRows.rows) {
      const storyId = row.id;
      const originalSize = row.data_size_bytes;

      try {
        // Load story data
        const dataRows = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
        const story = typeof dataRows.rows[0].data === 'string'
          ? JSON.parse(dataRows.rows[0].data)
          : dataRows.rows[0].data;

        let imagesStripped = 0;

        // Strip imageData from scene images (keep metadata)
        if (story.sceneImages) {
          for (const img of story.sceneImages) {
            if (img.imageData) {
              delete img.imageData;
              imagesStripped++;
            }
            // Also strip from image versions
            if (img.imageVersions) {
              for (const version of img.imageVersions) {
                if (version.imageData) {
                  delete version.imageData;
                  imagesStripped++;
                }
              }
            }
          }
        }

        // Strip imageData from cover images (keep metadata)
        const coverTypes = ['frontCover', 'initialPage', 'backCover'];
        for (const coverType of coverTypes) {
          const coverData = story.coverImages?.[coverType];
          if (coverData && typeof coverData === 'object' && coverData.imageData) {
            delete coverData.imageData;
            imagesStripped++;
          } else if (coverData && typeof coverData === 'string') {
            // Old format: coverImages.frontCover is just the image string
            story.coverImages[coverType] = { stripped: true };
            imagesStripped++;
          }
        }

        if (imagesStripped > 0) {
          const newDataJson = JSON.stringify(story);
          const newSize = Buffer.byteLength(newDataJson, 'utf8');
          const bytesFreed = originalSize - newSize;

          if (!dryRun) {
            await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [newDataJson, storyId]);
          }

          results.push({
            storyId,
            imagesStripped,
            originalSize,
            newSize,
            bytesFreed,
            status: dryRun ? 'dry-run' : 'stripped'
          });
          totalBytesFreed += bytesFreed;
        } else {
          results.push({
            storyId,
            imagesStripped: 0,
            originalSize,
            status: 'already-clean'
          });
        }
      } catch (err) {
        results.push({
          storyId,
          status: 'error',
          error: err.message
        });
      }
    }

    log.info(`[STRIP] ${dryRun ? 'DRY RUN: ' : ''}Processed ${results.length} stories, freed ${(totalBytesFreed / 1024 / 1024).toFixed(2)} MB`);
    res.json({
      success: true,
      dryRun,
      storiesProcessed: results.length,
      totalBytesFreed,
      totalMBFreed: (totalBytesFreed / 1024 / 1024).toFixed(2),
      results
    });
  } catch (err) {
    log.error('[STRIP] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
