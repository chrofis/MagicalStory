require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query(`SELECT image_type, version_index, length(image_data) as len, substring(image_data, 1, 60) as head FROM story_images WHERE story_id = $1 AND page_number = 2`, [process.argv[2]]);
  console.table(r.rows);
  await pool.end();
})();
