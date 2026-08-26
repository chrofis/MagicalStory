// Backfill: upload story_images rows that have image_data but no image_url to
// R2, then NULL out image_data. Idempotent — re-runs skip rows that already
// have image_url. Run via:
//   DATABASE_URL=... R2_*=... node scripts/backfill-data-only-to-r2.js
const { Pool } = require('pg');

const root = require('path').resolve(__dirname, '..');
process.chdir(root);
const r2 = require(require('path').join(root, 'server/lib/r2'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('proxy.rlwy.net') ? { rejectUnauthorized: false } : false,
});

(async () => {
  if (!r2.isConfigured()) {
    console.error('R2 is not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_URL');
    process.exit(1);
  }

  const { rows } = await pool.query(`
    SELECT story_id, image_type, page_number, version_index,
           OCTET_LENGTH(image_data) AS bytes,
           image_data
    FROM story_images
    WHERE image_data IS NOT NULL AND image_url IS NULL
    ORDER BY generated_at NULLS FIRST
  `);
  console.log(`Found ${rows.length} rows to backfill`);

  let uploaded = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const key = r2.keyForStoryImage(r.story_id, r.image_type, r.page_number, r.version_index);
      const url = await r2.uploadImage(r.image_data, key);
      if (!url) throw new Error('uploadImage returned null');
      await pool.query(
        `UPDATE story_images
         SET image_url = $1, image_data = NULL
         WHERE story_id = $2 AND image_type = $3
           AND page_number IS NOT DISTINCT FROM $4 AND version_index = $5`,
        [url, r.story_id, r.image_type, r.page_number, r.version_index]
      );
      uploaded++;
      console.log(`  [${uploaded}/${rows.length}] ${r.story_id} ${r.image_type} v${r.version_index} → ${(r.bytes/1024).toFixed(0)} KB → ${url}`);
    } catch (err) {
      failed++;
      console.warn(`  FAIL ${r.story_id} ${r.image_type} v${r.version_index}: ${err.message}`);
    }
  }

  console.log(`\nDone. uploaded=${uploaded}, failed=${failed}`);

  const after = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE image_data IS NOT NULL AND image_url IS NULL)::int AS data_only,
      COUNT(*) FILTER (WHERE image_data IS NULL AND image_url IS NOT NULL)::int AS url_only,
      COUNT(*) FILTER (WHERE image_data IS NOT NULL AND image_url IS NOT NULL)::int AS both
    FROM story_images
  `);
  console.log('After:', after.rows[0]);

  await pool.end();
})().catch(err => {
  console.error('script failed:', err);
  process.exit(1);
});
