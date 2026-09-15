/**
 * Check and clean up orphaned characters and stories (not linked to any user)
 *
 * SAFETY: --dry-run by default. Pass --apply to actually delete.
 */

const { Pool } = require('pg');
require('dotenv').config();
// Stories marked as evidence are never orphan-swept — one predicate, shared
// with the admin route (server/lib/evidenceStories.js, migration 038).
const { ORPHAN_STORIES_WHERE } = require('../../server/lib/evidenceStories');

const DRY_RUN = !process.argv.includes('--apply');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function cleanupOrphanedData() {
  const client = await pool.connect();

  try {
    console.log('🔍 Checking for orphaned data...\n');

    // Check for orphaned characters
    const orphanedCharsResult = await client.query(
      `SELECT COUNT(*) as count FROM characters WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedCharsCount = parseInt(orphanedCharsResult.rows[0].count);
    console.log(`Found ${orphanedCharsCount} orphaned characters (no user_id)`);

    // Check for orphaned stories
    const orphanedStoriesResult = await client.query(
      `SELECT COUNT(*) as count FROM stories ${ORPHAN_STORIES_WHERE}`
    );
    const orphanedStoriesCount = parseInt(orphanedStoriesResult.rows[0].count);
    console.log(`Found ${orphanedStoriesCount} orphaned stories (no user_id)`);

    if (orphanedCharsCount === 0 && orphanedStoriesCount === 0) {
      console.log('\n✅ No orphaned data found. Database is clean!');
      return;
    }

    if (DRY_RUN) {
      console.log('\n[DRY RUN] Would delete the rows above. Pass --apply to actually delete.');
      return;
    }

    console.log('\n🗑️  Deleting orphaned data...\n');

    // Delete orphaned characters
    if (orphanedCharsCount > 0) {
      const deleteCharsResult = await client.query(
        `DELETE FROM characters WHERE user_id IS NULL OR user_id = '' RETURNING id`
      );
      console.log(`✓ Deleted ${deleteCharsResult.rowCount} orphaned characters`);
    }

    // Delete orphaned stories
    if (orphanedStoriesCount > 0) {
      const deleteStoriesResult = await client.query(
        `DELETE FROM stories ${ORPHAN_STORIES_WHERE} RETURNING id`
      );
      console.log(`✓ Deleted ${deleteStoriesResult.rowCount} orphaned stories`);

      // Prune R2 prefixes for the orphans we just dropped — through the
      // failed-prune ledger (server/lib/r2Pending.js), so a prune that does not
      // finish is recorded in r2_pending_deletions and retried daily. pruneStory
      // records its own failures and does not throw; anything that reaches the
      // catch means the prune could not even be RECORDED, which is an error,
      // not a partial cleanup.
      const r2Pending = require('../../server/lib/r2Pending');
      let totalR2 = 0;
      for (const row of deleteStoriesResult.rows) {
        try {
          totalR2 += await r2Pending.pruneStory(row.id, 'orphan cleanup');
        } catch (r2Err) {
          console.error(`✗ R2 prune for orphaned story ${row.id} failed and could NOT be recorded for retry: ${r2Err.message}`);
          process.exitCode = 1;
        }
      }
      if (totalR2 > 0) console.log(`☁️  Pruned ${totalR2} R2 objects for orphaned stories`);
    }

    console.log('\n✅ Cleanup complete!');

  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

cleanupOrphanedData()
  .then(() => process.exit(process.exitCode || 0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
