// One-shot diagnostic: what are the rows that still have image_data and no
// image_url? Group by image_type and date, list a sample.
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('proxy.rlwy.net') ? { rejectUnauthorized: false } : false,
});

(async () => {
  try {
    const byType = await pool.query(`
      SELECT image_type, COUNT(*)::int AS n,
             pg_size_pretty(SUM(OCTET_LENGTH(image_data))::bigint) AS total_bytes,
             MIN(generated_at) AS oldest,
             MAX(generated_at) AS newest
      FROM story_images
      WHERE image_data IS NOT NULL AND image_url IS NULL
      GROUP BY image_type
      ORDER BY n DESC
    `);
    console.log('story_images data_only by image_type:');
    for (const r of byType.rows) console.log(' ', r);

    const sample = await pool.query(`
      SELECT story_id, image_type, page_number, version_index,
             OCTET_LENGTH(image_data) AS data_bytes,
             generated_at
      FROM story_images
      WHERE image_data IS NOT NULL AND image_url IS NULL
      ORDER BY generated_at DESC NULLS LAST
      LIMIT 15
    `);
    console.log('\nsample (most recent 15):');
    for (const r of sample.rows) console.log(' ', r);

    const byStory = await pool.query(`
      SELECT story_id, COUNT(*)::int AS n,
             pg_size_pretty(SUM(OCTET_LENGTH(image_data))::bigint) AS total_bytes
      FROM story_images
      WHERE image_data IS NOT NULL AND image_url IS NULL
      GROUP BY story_id
      ORDER BY n DESC
      LIMIT 20
    `);
    console.log('\ntop stories with data_only rows:');
    for (const r of byStory.rows) console.log(' ', r);
  } catch (err) {
    console.error('failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
