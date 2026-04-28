// One-shot diagnostic: how many story_images rows still have image_data inlined,
// and how much DB space the column is consuming. Run via `railway run node scripts/db-image-storage-stats.js`.
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_rows,
        COUNT(image_data)::int AS with_image_data,
        COUNT(image_url)::int AS with_image_url,
        COUNT(*) FILTER (WHERE image_data IS NOT NULL AND image_url IS NOT NULL)::int AS both,
        COUNT(*) FILTER (WHERE image_data IS NULL AND image_url IS NOT NULL)::int AS url_only,
        COUNT(*) FILTER (WHERE image_data IS NOT NULL AND image_url IS NULL)::int AS data_only,
        pg_size_pretty(pg_total_relation_size('story_images')) AS table_size_total,
        pg_size_pretty(COALESCE(SUM(OCTET_LENGTH(image_data))::bigint, 0)) AS image_data_bytes
      FROM story_images
    `);
    console.log('story_images:', rows[0]);

    const recent = await pool.query(`
      SELECT story_id, image_type, page_number, version_index,
             OCTET_LENGTH(image_data) AS data_bytes,
             (image_url IS NOT NULL) AS has_url,
             generated_at
      FROM story_images
      ORDER BY generated_at DESC NULLS LAST
      LIMIT 5
    `);
    console.log('most recent 5 rows:');
    for (const r of recent.rows) console.log(' ', r);
  } catch (err) {
    console.error('query failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
