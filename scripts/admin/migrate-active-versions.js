#!/usr/bin/env node
/**
 * Migration script: Update activeVersion in image_version_meta JSONB
 *
 * The image_version_meta column stores: { "1": { "activeVersion": 2 }, "frontCover": { "activeVersion": 0 } }
 * where numeric keys are scene page numbers and string keys are cover types.
 *
 * After migration 021_unify_version_index.sql shifted scene version_index values down by 1,
 * the activeVersion values for scene pages also need to be decremented by 1 (if >= 2).
 *
 * - activeVersion 0 → stays 0 (the original image, unchanged)
 * - activeVersion 1 → should not exist (gap), but if found, set to 0
 * - activeVersion >= 2 → decrement by 1
 * - Cover types (frontCover, backCover, initialPage) → unchanged
 *
 * Usage: node scripts/admin/migrate-active-versions.js [--dry-run]
 */

const { Pool } = require('pg');

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log(`${isDryRun ? '[DRY RUN] ' : ''}Migrating activeVersion in image_version_meta...`);

    // Find all stories with non-null image_version_meta
    const { rows } = await pool.query(
      `SELECT id, image_version_meta FROM stories WHERE image_version_meta IS NOT NULL`
    );

    console.log(`Found ${rows.length} stories with image_version_meta`);

    const coverKeys = new Set(['frontCover', 'backCover', 'initialPage']);
    let updatedCount = 0;
    let skippedCount = 0;

    for (const row of rows) {
      const meta = typeof row.image_version_meta === 'string'
        ? JSON.parse(row.image_version_meta)
        : row.image_version_meta;

      if (!meta || typeof meta !== 'object') continue;

      let changed = false;

      for (const [key, value] of Object.entries(meta)) {
        // Skip cover types — they already use identity mapping
        if (coverKeys.has(key)) continue;

        // Numeric keys are scene page numbers
        if (value && typeof value === 'object' && typeof value.activeVersion === 'number') {
          const oldVersion = value.activeVersion;
          if (oldVersion >= 2) {
            value.activeVersion = oldVersion - 1;
            changed = true;
            console.log(`  Story ${row.id}, page ${key}: activeVersion ${oldVersion} → ${value.activeVersion}`);
          } else if (oldVersion === 1) {
            // Gap version — shouldn't exist, but map to 0 for safety
            value.activeVersion = 0;
            changed = true;
            console.log(`  Story ${row.id}, page ${key}: activeVersion 1 (gap) → 0`);
          }
          // activeVersion 0 stays unchanged
        }
      }

      if (changed) {
        if (!isDryRun) {
          await pool.query(
            'UPDATE stories SET image_version_meta = $1 WHERE id = $2',
            [JSON.stringify(meta), row.id]
          );
        }
        updatedCount++;
      } else {
        skippedCount++;
      }
    }

    console.log(`\n${isDryRun ? '[DRY RUN] ' : ''}Done.`);
    console.log(`  Updated: ${updatedCount} stories`);
    console.log(`  Skipped: ${skippedCount} stories (no scene activeVersion >= 2)`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
