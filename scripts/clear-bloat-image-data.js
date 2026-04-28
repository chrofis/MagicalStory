// One-shot cleanup: NULL out image_data on any row that already has an
// image_url across story_images / story_retry_images / style_lab_images.
// R2 already has the bytes; the inline copy is dead weight. Idempotent —
// re-runs are no-ops once clean.
//
// Run via: DATABASE_URL=... node scripts/clear-bloat-image-data.js
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('proxy.rlwy.net') ? { rejectUnauthorized: false } : false,
});

const TABLES = ['story_images', 'story_retry_images', 'style_lab_images'];

(async () => {
  try {
    for (const table of TABLES) {
      const before = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE image_data IS NOT NULL AND image_url IS NOT NULL)::int AS both,
          pg_size_pretty(COALESCE(SUM(OCTET_LENGTH(image_data)) FILTER (WHERE image_url IS NOT NULL), 0)::bigint) AS bloat_bytes,
          pg_size_pretty(pg_total_relation_size('${table}')) AS table_size
        FROM ${table}
      `);
      console.log(`\n[${table}] before:`, before.rows[0]);
      if (before.rows[0].both === 0) {
        console.log(`[${table}] nothing to clear.`);
        continue;
      }
      const result = await pool.query(`
        UPDATE ${table}
        SET image_data = NULL
        WHERE image_data IS NOT NULL AND image_url IS NOT NULL
      `);
      console.log(`[${table}] cleared image_data on ${result.rowCount} rows.`);
      const after = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE image_data IS NOT NULL AND image_url IS NOT NULL)::int AS both,
          COUNT(*) FILTER (WHERE image_data IS NULL AND image_url IS NOT NULL)::int AS url_only,
          COUNT(*) FILTER (WHERE image_data IS NOT NULL AND image_url IS NULL)::int AS data_only,
          pg_size_pretty(pg_total_relation_size('${table}')) AS table_size
        FROM ${table}
      `);
      console.log(`[${table}] after:`, after.rows[0]);
    }
    console.log('\nTip: run VACUUM (FULL, ANALYZE) <table> per table to reclaim disk; takes an exclusive table lock.');
  } catch (err) {
    console.error('cleanup failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
