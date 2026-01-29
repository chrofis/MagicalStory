// Check story images in database
// Usage: node scripts/check-story-images.js <storyId>
const { Pool } = require('pg');

async function main() {
  const storyId = process.argv[2] || 'job_1769721538434_3yzhru0ga';

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    // Get story basic info
    const storyResult = await pool.query(
      `SELECT id, title, job_id, jsonb_array_length(data->'pages') as data_pages,
              jsonb_array_length(data->'sceneImages') as scene_images_in_data
       FROM stories WHERE job_id = $1 OR id = $1`,
      [storyId]
    );

    if (storyResult.rows.length === 0) {
      console.log('Story not found:', storyId);
      return;
    }

    const story = storyResult.rows[0];
    console.log('=== STORY INFO ===');
    console.log('ID:', story.id);
    console.log('Title:', story.title);
    console.log('Pages in data.pages:', story.data_pages);
    console.log('SceneImages in data:', story.scene_images_in_data);

    // Check story_images table
    const imagesResult = await pool.query(
      `SELECT image_type, page_number, version_index,
              length(image_data) as data_length,
              quality_score
       FROM story_images
       WHERE story_id = $1
       ORDER BY image_type, page_number, version_index`,
      [story.id]
    );

    console.log('\n=== STORY_IMAGES TABLE ===');
    console.log('Total rows:', imagesResult.rows.length);

    const sceneImages = imagesResult.rows.filter(r => r.image_type === 'scene');
    console.log('Scene images:', sceneImages.length);
    console.log('\nPage numbers with images:');
    sceneImages.forEach(img => {
      console.log(`  Page ${img.page_number}: ${Math.round(img.data_length/1024)}KB, quality=${img.quality_score}, version=${img.version_index}`);
    });

    // Check sceneImages array in data blob
    const dataResult = await pool.query(
      `SELECT data->'sceneImages' as scene_images FROM stories WHERE id = $1`,
      [story.id]
    );

    if (dataResult.rows[0]?.scene_images) {
      console.log('\n=== SCENE IMAGES IN DATA BLOB ===');
      const scenes = dataResult.rows[0].scene_images;
      scenes.forEach((s, i) => {
        const hasImage = s.imageData ? `${Math.round(s.imageData.length/1024)}KB` : 'NO IMAGE';
        console.log(`  [${i}] pageNumber=${s.pageNumber}: ${hasImage}`);
      });
    }

    // Check if page 5 specifically exists
    console.log('\n=== PAGE 5 CHECK ===');
    const page5 = await pool.query(
      `SELECT page_number, version_index, length(image_data) as len, quality_score
       FROM story_images
       WHERE story_id = $1 AND image_type = 'scene' AND page_number = 5`,
      [story.id]
    );
    if (page5.rows.length > 0) {
      console.log('Page 5 EXISTS in story_images:', page5.rows);
    } else {
      console.log('Page 5 NOT FOUND in story_images table!');
    }

  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await pool.end();
  }
}

main();
