#!/usr/bin/env node
/**
 * Cleanup: Extract inline images from story data blobs into story_retry_images,
 * then strip them from the blob to reclaim space.
 *
 * For old stories created before the extraction logic existed, images are still
 * inline in the JSON blob. This script:
 *   1. Extracts images to story_retry_images (preserving them)
 *   2. Strips the inline copies from the blob
 *
 * Usage:
 *   node scripts/admin/cleanup-blob-images.js [--dry-run] [--story-id <id>]
 */

const { Pool } = require('pg');

const isDryRun = process.argv.includes('--dry-run');
const storyIdArg = process.argv.includes('--story-id')
  ? process.argv[process.argv.indexOf('--story-id') + 1]
  : null;

const IMAGE_FIELDS = ['imageData', 'bboxOverlayImage', 'originalImage', 'annotatedOriginal'];
const IMAGE_TYPE_MAP = {
  imageData: 'attempt',
  bboxOverlayImage: 'bboxOverlay',
  originalImage: 'original',
  annotatedOriginal: 'annotatedOriginal',
};

async function extractRetryImages(pool, storyId, pageNumber, retryHistory) {
  let extracted = 0;
  if (!retryHistory?.length) return extracted;

  for (let retryIdx = 0; retryIdx < retryHistory.length; retryIdx++) {
    const entry = retryHistory[retryIdx];

    for (const field of IMAGE_FIELDS) {
      if (entry[field] && entry[field].length > 1000) {
        const imageType = IMAGE_TYPE_MAP[field];
        await pool.query(
          `INSERT INTO story_retry_images (story_id, page_number, retry_index, image_type, image_data)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1))
           DO UPDATE SET image_data = EXCLUDED.image_data`,
          [storyId, pageNumber, retryIdx, imageType, entry[field]]
        );
        extracted++;
      }
    }

    // Extract grid images
    if (entry.grids && Array.isArray(entry.grids)) {
      for (let gridIdx = 0; gridIdx < entry.grids.length; gridIdx++) {
        const grid = entry.grids[gridIdx];
        const originalData = grid.imageData || grid.original;
        const repairedData = grid.repaired || grid.repairedImageData;

        if (originalData && originalData.length > 1000) {
          await pool.query(
            `INSERT INTO story_retry_images (story_id, page_number, retry_index, image_type, grid_index, image_data)
             VALUES ($1, $2, $3, 'grid', $4, $5)
             ON CONFLICT (story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1))
             DO UPDATE SET image_data = EXCLUDED.image_data`,
            [storyId, pageNumber, retryIdx, gridIdx, originalData]
          );
          extracted++;
        }
        if (repairedData && repairedData.length > 1000) {
          await pool.query(
            `INSERT INTO story_retry_images (story_id, page_number, retry_index, image_type, grid_index, image_data)
             VALUES ($1, $2, $3, 'gridRepaired', $4, $5)
             ON CONFLICT (story_id, page_number, retry_index, image_type, COALESCE(grid_index, -1))
             DO UPDATE SET image_data = EXCLUDED.image_data`,
            [storyId, pageNumber, retryIdx, gridIdx, repairedData]
          );
          extracted++;
        }
      }
    }
  }
  return extracted;
}

function stripRetryHistory(retryHistory) {
  let stripped = 0;
  if (!retryHistory?.length) return stripped;
  for (const entry of retryHistory) {
    for (const field of IMAGE_FIELDS) {
      if (entry[field]) { delete entry[field]; stripped++; }
    }
    if (entry.grids && Array.isArray(entry.grids)) {
      for (const grid of entry.grids) {
        for (const f of ['imageData', 'repairedImageData', 'original', 'repaired']) {
          if (grid[f]) { delete grid[f]; stripped++; }
        }
      }
    }
  }
  return stripped;
}

function stripRepairHistory(repairHistory) {
  let stripped = 0;
  if (!repairHistory?.length) return stripped;
  for (const entry of repairHistory) {
    for (const f of ['imageData', 'originalImage', 'fixedImage']) {
      if (entry[f]) { delete entry[f]; stripped++; }
    }
  }
  return stripped;
}

function stripImageVersions(imageVersions) {
  let stripped = 0;
  if (!imageVersions?.length) return stripped;
  for (const v of imageVersions) {
    for (const f of ['imageData', 'bboxOverlayImage']) {
      if (v[f]) { delete v[f]; stripped++; }
    }
  }
  return stripped;
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 120000,
    statement_timeout: 300000,
  });

  try {
    console.log(`${isDryRun ? '[DRY RUN] ' : ''}Extracting & cleaning inline images from story data blobs...`);

    // Process one story at a time to avoid loading all blobs into memory
    const whereClause = storyIdArg ? `AND id = '${storyIdArg}'` : '';
    const { rows: storyList } = await pool.query(
      `SELECT id, pg_column_size(data) as blob_size, metadata->>'title' as title
       FROM stories
       WHERE pg_column_size(data) > 1000000 ${whereClause}
       ORDER BY pg_column_size(data) DESC`
    );

    console.log(`Found ${storyList.length} stories > 1MB to process\n`);

    let totalSaved = 0;
    let storiesUpdated = 0;
    let totalExtracted = 0;

    for (let i = 0; i < storyList.length; i++) {
      const { id: storyId, blob_size: beforeSize, title } = storyList[i];
      const label = title || storyId;

      // Load one story at a time
      const { rows } = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
      if (!rows.length) continue;

      const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
      if (!data) continue;

      let fieldsStripped = 0;
      let fieldsExtracted = 0;

      // Process scene images
      if (Array.isArray(data.sceneImages)) {
        for (const img of data.sceneImages) {
          const pageNum = img.pageNumber ?? data.sceneImages.indexOf(img);

          // Extract retry images to story_retry_images before stripping
          if (img.retryHistory?.length && !isDryRun) {
            fieldsExtracted += await extractRetryImages(pool, storyId, pageNum, img.retryHistory);
          }

          // Strip sceneCharacters avatar/photo data (duplicated from characters table on every page)
          if (Array.isArray(img.sceneCharacters)) {
            for (const sc of img.sceneCharacters) {
              if (sc.avatars) { delete sc.avatars; fieldsStripped++; }
              if (sc.photos) { delete sc.photos; fieldsStripped++; }
            }
          }

          // Strip inline image fields
          for (const f of ['originalImage', 'bboxOverlayImage', 'previousImage']) {
            if (img[f]) { delete img[f]; fieldsStripped++; }
          }
          // Strip consistency regen images
          if (img.consistencyRegen) {
            for (const f of ['originalImage', 'fixedImage', 'imageData']) {
              if (img.consistencyRegen[f]) { delete img.consistencyRegen[f]; fieldsStripped++; }
            }
          }
          fieldsStripped += stripRetryHistory(img.retryHistory);
          fieldsStripped += stripRepairHistory(img.repairHistory);
          fieldsStripped += stripImageVersions(img.imageVersions);
        }
      }

      // Strip avatars/photos from top-level characters (already in characters DB table)
      if (Array.isArray(data.characters)) {
        for (const ch of data.characters) {
          if (ch.avatars) { delete ch.avatars; fieldsStripped++; }
          if (ch.photos) { delete ch.photos; fieldsStripped++; }
        }
      }

      // Strip visualBible grid images
      if (data.visualBible) {
        for (const [key, val] of Object.entries(data.visualBible)) {
          if (val && typeof val === 'object') {
            if (val.gridImage) { delete val.gridImage; fieldsStripped++; }
            if (val.imageData) { delete val.imageData; fieldsStripped++; }
          }
        }
      }

      // Strip styledAvatarGeneration/costumedAvatarGeneration image data
      for (const genKey of ['styledAvatarGeneration', 'costumedAvatarGeneration']) {
        if (data[genKey] && typeof data[genKey] === 'object') {
          for (const [charId, genData] of Object.entries(data[genKey])) {
            if (genData && typeof genData === 'object') {
              if (genData.imageData) { delete genData.imageData; fieldsStripped++; }
              if (genData.resultImage) { delete genData.resultImage; fieldsStripped++; }
              if (Array.isArray(genData.results)) {
                for (const result of genData.results) {
                  if (result.imageData) { delete result.imageData; fieldsStripped++; }
                }
              }
            }
          }
        }
      }

      // Process cover images
      if (data.coverImages) {
        for (const coverType of ['frontCover', 'backCover', 'initialPage']) {
          const cover = data.coverImages[coverType];
          if (!cover || typeof cover !== 'object') continue;
          for (const f of ['imageData', 'originalImage', 'previousImage']) {
            if (cover[f]) { delete cover[f]; fieldsStripped++; }
          }
          fieldsStripped += stripImageVersions(cover.imageVersions);
          fieldsStripped += stripRetryHistory(cover.retryHistory);
        }
      }

      if (fieldsStripped === 0) continue;

      const newJson = JSON.stringify(data);
      const afterSize = Buffer.byteLength(newJson, 'utf8');
      const saved = beforeSize - afterSize;

      console.log(`  [${i + 1}/${storyList.length}] ${label}: ${(beforeSize / 1048576).toFixed(1)}MB → ${(afterSize / 1048576).toFixed(1)}MB (saved ${(saved / 1048576).toFixed(1)}MB, extracted ${fieldsExtracted}, stripped ${fieldsStripped})`);

      if (!isDryRun) {
        await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [newJson, storyId]);
      }

      totalSaved += saved;
      totalExtracted += fieldsExtracted;
      storiesUpdated++;
    }

    console.log(`\n${isDryRun ? '[DRY RUN] ' : ''}Done.`);
    console.log(`  Stories updated: ${storiesUpdated}/${storyList.length}`);
    console.log(`  Images extracted to story_retry_images: ${totalExtracted}`);
    console.log(`  Total space saved: ${(totalSaved / 1048576).toFixed(1)} MB`);

    if (!isDryRun && storiesUpdated > 0) {
      console.log('\nRunning VACUUM FULL on stories table (reclaims disk space)...');
      await pool.query('VACUUM FULL stories');
      console.log('VACUUM complete.');
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
