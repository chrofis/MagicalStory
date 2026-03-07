// Quick script to check story images and version metadata
// Usage: railway run node scripts/admin/check-story-images.js <storyId>

const { Pool } = require('pg');
const storyId = process.argv[2] || 'job_1772890610565_wn3qlimza';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    // Check images
    const images = await pool.query(
      'SELECT image_type, page_number, version_index, LENGTH(image_data) as len FROM story_images WHERE story_id = $1 ORDER BY image_type, page_number, version_index',
      [storyId]
    );
    console.log('\n=== IMAGES ===');
    console.log(`Total: ${images.rows.length}`);
    for (const r of images.rows) {
      console.log(`  ${r.image_type} page=${r.page_number} version=${r.version_index} len=${r.len}`);
    }

    // Check version meta
    const meta = await pool.query(
      'SELECT image_version_meta, is_shared, share_token IS NOT NULL as has_token FROM stories WHERE id = $1',
      [storyId]
    );
    console.log('\n=== VERSION META ===');
    if (meta.rows.length > 0) {
      console.log('  image_version_meta:', JSON.stringify(meta.rows[0].image_version_meta));
      console.log('  is_shared:', meta.rows[0].is_shared);
      console.log('  has_token:', meta.rows[0].has_token);
    } else {
      console.log('  Story not found!');
    }

    // Check story text page count
    const data = await pool.query(
      "SELECT jsonb_array_length(data->'storyText') as text_pages FROM stories WHERE id = $1",
      [storyId]
    );
    console.log('\n=== STORY DATA ===');
    if (data.rows.length > 0) {
      console.log('  storyText pages:', data.rows[0].text_pages);
    }
  } catch (e) {
    console.error(e.message);
  } finally {
    await pool.end();
  }
}

main();
