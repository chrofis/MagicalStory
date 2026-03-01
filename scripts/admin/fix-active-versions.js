/**
 * Fix activeVersion for stories generated before the pipeline fix.
 *
 * The old code used getActiveIndexAfterPush() which pointed to the LAST
 * imageVersions entry (the demoted original), not version_index 0 (the best/promoted).
 * This script resets all scene activeVersions to 0 for stories where the repair
 * pipeline ran (wasRegenerated pages exist).
 *
 * Usage: node scripts/admin/fix-active-versions.js [--dry-run]
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dryRun = process.argv.includes('--dry-run');

async function fix() {
  console.log(dryRun ? '=== DRY RUN ===' : '=== FIXING ===');

  // Find all stories with image_version_meta entries where activeVersion > 0 for scene pages
  const stories = await pool.query(
    `SELECT id, image_version_meta FROM stories WHERE image_version_meta IS NOT NULL AND image_version_meta != '{}'::jsonb`
  );

  let fixed = 0;
  for (const story of stories.rows) {
    const meta = story.image_version_meta || {};
    const badPages = [];

    for (const [pageKey, pageMeta] of Object.entries(meta)) {
      // Skip cover types (frontCover, backCover, initialPage)
      if (isNaN(parseInt(pageKey))) continue;

      if (pageMeta.activeVersion && pageMeta.activeVersion > 0) {
        badPages.push({ page: pageKey, currentActive: pageMeta.activeVersion });
      }
    }

    if (badPages.length > 0) {
      console.log(`\nStory ${story.id}:`);
      for (const bp of badPages) {
        console.log(`  Page ${bp.page}: activeVersion=${bp.currentActive} → 0`);
      }

      if (!dryRun) {
        // Reset all bad scene pages to activeVersion=0
        for (const bp of badPages) {
          await pool.query(
            `UPDATE stories SET image_version_meta = jsonb_set(
              COALESCE(image_version_meta, '{}')::jsonb,
              $1::text[],
              $2::jsonb
            ) WHERE id = $3`,
            [[bp.page], JSON.stringify({ activeVersion: 0 }), story.id]
          );
        }
        fixed += badPages.length;
        console.log(`  Fixed ${badPages.length} pages`);
      }
    }
  }

  console.log(`\n${dryRun ? 'Would fix' : 'Fixed'} ${fixed} pages across ${stories.rows.length} stories`);
  await pool.end();
}

fix().catch(e => { console.error(e); process.exit(1); });
