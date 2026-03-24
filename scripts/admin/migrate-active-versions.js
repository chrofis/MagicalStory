#!/usr/bin/env node
/**
 * Migration script: Update activeVersion in image_version_meta JSONB
 *
 * The image_version_meta column stores: { "1": { "activeVersion": 2 }, "frontCover": { "activeVersion": 0 } }
 * where numeric keys are scene page numbers and string keys are cover types.
 *
 * After migration 021_unify_version_index.sql shifted scene version_index values down by 1
 * for pages with the gap (pages that have v0 and v2+ but no v1), the activeVersion values
 * for those pages also need to be decremented by 1.
 *
 * Pages that already had v1 (no gap) were NOT shifted in the SQL migration, so their
 * activeVersion should NOT be changed either.
 *
 * Usage: node scripts/admin/migrate-active-versions.js [--dry-run]
 */

const { Pool } = require('pg');

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    console.log(`${isDryRun ? '[DRY RUN] ' : ''}Migrating activeVersion in image_version_meta...`);

    // Step 1: Find all pages that HAD the gap (had v2+ but no v1 before the SQL migration ran).
    // After the SQL migration, these pages now have v1 (shifted from v2). So we detect them
    // as pages that have v1 but didn't before. Since the SQL migration already ran,
    // we identify gap pages by: pages where version_index is contiguous starting at 0
    // AND the max version_index >= 1 (i.e. they had versions shifted).
    //
    // Actually, we can't distinguish gap-shifted pages from already-had-v1 pages after the SQL ran.
    // So we need to use a different approach: check which pages' activeVersion needs adjustment
    // by seeing if the activeVersion still points to a valid version_index.

    // Step 1: Build a set of (story_id, page_number) that were gap pages.
    // Gap pages are those where the SQL migration shifted rows. After the shift,
    // the max version_index decreased by 1 compared to what activeVersion might point to.
    // We detect this by: activeVersion >= max(version_index) + 1 for the page.
    // (Or more precisely, activeVersion pointed to old v_idx which is now v_idx-1)

    const { rows: stories } = await pool.query(
      `SELECT id, image_version_meta FROM stories WHERE image_version_meta IS NOT NULL`
    );

    console.log(`Found ${stories.length} stories with image_version_meta`);

    // Build lookup: which (story_id, page_number) pairs have v1 in story_images?
    // After the SQL migration, gap pages now have v1 (shifted from v2).
    // But non-gap pages also have v1 (they always did).
    // We can't distinguish them post-migration via story_images alone.
    //
    // Alternative: check if activeVersion points to a version_index that doesn't exist.
    // If activeVersion = N and max(version_index) = N-1, then this was a gap page
    // whose activeVersion needs decrementing.

    const coverKeys = new Set(['frontCover', 'backCover', 'initialPage']);
    let updatedCount = 0;
    let skippedCount = 0;
    let adjustedPages = 0;

    for (const row of stories) {
      const meta = typeof row.image_version_meta === 'string'
        ? JSON.parse(row.image_version_meta)
        : row.image_version_meta;

      if (!meta || typeof meta !== 'object') continue;

      let changed = false;

      for (const [key, value] of Object.entries(meta)) {
        if (coverKeys.has(key)) continue;
        if (!value || typeof value !== 'object' || typeof value.activeVersion !== 'number') continue;

        const activeV = value.activeVersion;
        if (activeV <= 0) continue; // v0 never needs adjustment

        // Check if this activeVersion still points to a valid row in story_images
        const pageNum = parseInt(key, 10);
        if (isNaN(pageNum)) continue;

        const check = await pool.query(
          `SELECT MAX(version_index) as max_v,
                  EXISTS(SELECT 1 FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene' AND version_index=$3) as exists_at_active
           FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene'`,
          [row.id, pageNum, activeV]
        );

        if (check.rows.length === 0) continue;
        const { max_v, exists_at_active } = check.rows[0];

        if (!exists_at_active && activeV >= 2) {
          // activeVersion points to a non-existent row — this was a gap page whose versions were shifted
          const newV = activeV - 1;
          console.log(`  Story ${row.id}, page ${key}: activeVersion ${activeV} → ${newV} (gap page, old index no longer exists)`);
          value.activeVersion = newV;
          changed = true;
          adjustedPages++;
        } else if (!exists_at_active && activeV === 1) {
          // activeVersion 1 doesn't exist — shouldn't happen, reset to 0
          console.log(`  Story ${row.id}, page ${key}: activeVersion 1 → 0 (doesn't exist)`);
          value.activeVersion = 0;
          changed = true;
          adjustedPages++;
        }
        // If exists_at_active is true, the activeVersion is already correct — don't touch it
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
    console.log(`  Updated: ${updatedCount} stories (${adjustedPages} pages adjusted)`);
    console.log(`  Skipped: ${skippedCount} stories (no adjustment needed)`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
