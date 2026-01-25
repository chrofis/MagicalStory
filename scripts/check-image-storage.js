require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const storyId = process.argv[2] || 'job_1769285688015_idstty79v';

  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  const story = result.rows[0].data;

  console.log('Checking image storage locations...\n');

  // Check coverImages
  if (story.coverImages) {
    console.log('coverImages:', JSON.stringify(story.coverImages, null, 2).substring(0, 500));
  }

  // Check if there's a visualBible with images
  if (story.visualBible) {
    console.log('\nvisualBible keys:', Object.keys(story.visualBible).join(', '));
    const vb = story.visualBible;
    if (vb.characters) {
      const charNames = Object.keys(vb.characters);
      console.log('visualBible characters:', charNames.join(', '));
      if (charNames.length > 0) {
        const firstChar = vb.characters[charNames[0]];
        console.log('First character keys:', Object.keys(firstChar).join(', '));
      }
    }
  }

  // Check story_jobs table for image data
  const jobResult = await pool.query(
    "SELECT result FROM story_jobs WHERE story_id = $1 ORDER BY created_at DESC LIMIT 1",
    [storyId]
  );
  if (jobResult.rows.length > 0 && jobResult.rows[0].result) {
    const jobData = jobResult.rows[0].result;
    console.log('\nstory_jobs result keys:', Object.keys(jobData).join(', '));
    if (jobData.sceneImages && jobData.sceneImages[0]) {
      console.log('job sceneImages[0] keys:', Object.keys(jobData.sceneImages[0]).join(', '));
      const scene = jobData.sceneImages[0];
      console.log('  imageData:', scene.imageData ? 'present (' + scene.imageData.substring(0, 50) + '...)' : 'MISSING');
    }
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
