require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Get story_images columns
  const cols = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'story_images'
  `);
  console.log('story_images columns:');
  for (const row of cols.rows) {
    console.log('  ' + row.column_name + ': ' + row.data_type);
  }

  // Check images for our story
  const images = await pool.query(`
    SELECT id, story_id, page_number, image_type, LENGTH(image_data) as data_len
    FROM story_images
    WHERE story_id = 'job_1769285688015_idstty79v'
    ORDER BY page_number
    LIMIT 20
  `);
  console.log('\nImages for story:');
  for (const row of images.rows) {
    console.log('  Page ' + row.page_number + ' (' + row.image_type + '): ' + row.data_len + ' bytes');
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
