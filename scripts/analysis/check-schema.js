require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'story_images' ORDER BY ordinal_position`);
  console.table(r.rows);
  // Now check actual data
  const r2 = await pool.query(`SELECT image_type, version_index, length(image_data) as data_len, length(image_url) as url_len FROM story_images WHERE story_id = $1 AND page_number = 2`, [process.argv[2]]);
  console.table(r2.rows);
  await pool.end();
})();
