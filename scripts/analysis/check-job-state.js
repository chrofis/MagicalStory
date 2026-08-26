require('dotenv').config();
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const j = await pool.query(`SELECT status, progress, completed_at, created_at FROM story_jobs WHERE id = $1`, [process.argv[2]]);
  console.log('job:', j.rows[0]);
  const i = await pool.query(`SELECT image_type, page_number, COUNT(*) FROM story_images WHERE story_id = $1 GROUP BY image_type, page_number ORDER BY page_number`, [process.argv[2]]);
  console.log('images:', i.rows.slice(0, 20));
  await pool.end();
})();
