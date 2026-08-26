#!/usr/bin/env node
/**
 * Monitor the landmark fame backfill progress.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkProgress() {
  const res = await pool.query(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN fame_updated_at IS NOT NULL THEN 1 ELSE 0 END) as processed,
      SUM(CASE WHEN fame_sitelinks IS NOT NULL THEN 1 ELSE 0 END) as with_sitelinks,
      SUM(CASE WHEN fame_pageviews IS NOT NULL THEN 1 ELSE 0 END) as with_pageviews
    FROM landmark_index
  `);

  const row = res.rows[0];
  const pct = Math.round((row.processed / row.total) * 100);
  const remaining = row.total - row.processed;
  const eta = Math.ceil((remaining * 1.5) / 60); // Rough estimate assuming 1.5s per row

  console.log(`Backfill Progress:`);
  console.log(`  ${row.processed}/${row.total} rows (${pct}%)`);
  console.log(`  Sitelinks: ${row.with_sitelinks}`);
  console.log(`  Pageviews: ${row.with_pageviews}`);
  if (remaining > 0) {
    console.log(`  ETA: ~${eta} minutes`);
  } else {
    console.log(`  Status: COMPLETE`);
  }

  process.exit(remaining === 0 ? 0 : 1);
}

checkProgress().catch(err => {
  console.error('Error:', err);
  process.exit(1);
}).finally(() => pool.end());
