const { Pool } = require('pg');

async function main() {
  const storyId = process.argv[2] || '73';
  const pageNum = parseInt(process.argv[3] || '3');
  
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  const result = await pool.query(
    "SELECT image_data FROM story_images WHERE story_id = $1 AND page_number = $2 ORDER BY version_index DESC, created_at DESC LIMIT 1",
    [storyId, pageNum]
  );
  
  if (result.rows[0]?.image_data) {
    // Output just the base64 data (strip data URI prefix)
    const data = result.rows[0].image_data;
    const base64 = data.replace(/^data:image\/\w+;base64,/, '');
    console.log(base64);
  } else {
    console.error('NOT_FOUND');
  }
  
  await pool.end();
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
