/**
 * Check and clean up orphaned characters and stories (not linked to any user)
 */

const { Pool } = require('pg');
require('dotenv').config();

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
      `SELECT COUNT(*) as count FROM stories WHERE user_id IS NULL OR user_id = ''`
    );
    const orphanedStoriesCount = parseInt(orphanedStoriesResult.rows[0].count);
    console.log(`Found ${orphanedStoriesCount} orphaned stories (no user_id)`);

    if (orphanedCharsCount === 0 && orphanedStoriesCount === 0) {
      console.log('\n✅ No orphaned data found. Database is clean!');
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
        `DELETE FROM stories WHERE user_id IS NULL OR user_id = '' RETURNING id`
      );
      console.log(`✓ Deleted ${deleteStoriesResult.rowCount} orphaned stories`);
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
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
