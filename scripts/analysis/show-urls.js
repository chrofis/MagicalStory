require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`SELECT image_type, version_index, image_url FROM story_images WHERE story_id = $1 AND page_number = 2 ORDER BY image_type, version_index`, [process.argv[2]]);
  for (const row of r.rows) console.log(`${row.image_type} v${row.version_index}: ${row.image_url}`);
  await pool.end();
})();
