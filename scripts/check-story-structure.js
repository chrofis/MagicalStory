require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const storyId = process.argv[2] || 'job_1769285688015_idstty79v';

  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  if (result.rows.length === 0) {
    console.log('Story not found');
    return;
  }

  const data = result.rows[0].data;
  const story = typeof data === 'string' ? JSON.parse(data) : data;

  console.log('Story:', story.title);
  console.log('Keys:', Object.keys(story).join(', '));

  if (story.sceneImages && story.sceneImages.length > 0) {
    console.log('\nFirst sceneImage keys:', Object.keys(story.sceneImages[0]).join(', '));
    const scene = story.sceneImages[0];
    console.log('  pageNumber:', scene.pageNumber);
    console.log('  imageData:', scene.imageData ? 'present (' + scene.imageData.length + ' chars)' : 'MISSING');
    console.log('  imageUrl:', scene.imageUrl || 'MISSING');
    console.log('  url:', scene.url || 'MISSING');
  }

  if (story.pages && story.pages.length > 0) {
    console.log('\nFirst page keys:', Object.keys(story.pages[0]).join(', '));
    const page = story.pages[0];
    console.log('  imageData:', page.imageData ? 'present' : 'MISSING');
    console.log('  imageUrl:', page.imageUrl || 'MISSING');
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
