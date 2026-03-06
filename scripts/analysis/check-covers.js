/**
 * Check cover reference photos for a story
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  const storyId = process.argv[2] || 'job_1769462061080_hyfma04ks';

  // Get story data
  const result = await pool.query('SELECT data FROM stories WHERE id = $1', [storyId]);
  const story = result.rows[0]?.data;

  // Get job input data
  const jobResult = await pool.query(
    "SELECT input_data FROM story_jobs WHERE result_data->>'storyId' = $1 LIMIT 1",
    [storyId]
  );
  const jobInput = jobResult.rows[0]?.input_data;
  if (jobInput) {
    console.log('=== JOB INPUT ===');
    const chars = jobInput.characters || [];
    console.log('Characters count:', chars.length);
    chars.forEach(c => {
      const avatars = c.avatars || c.clothingAvatars;
      const photos = c.photos || {};
      const standardLen = avatars?.standard ? avatars.standard.length : 0;
      const faceLen = photos.face ? photos.face.length : 0;
      const bodyNoBgLen = c.bodyNoBgUrl ? c.bodyNoBgUrl.length : 0;
      const photoUrlLen = c.photoUrl ? c.photoUrl.length : 0;
      console.log(`  - ${c.name} | standard: ${standardLen} | face: ${faceLen} | bodyNoBg: ${bodyNoBgLen} | photoUrl: ${photoUrlLen}`);
    });
    console.log('');
  }

  if (!story) {
    console.log('Story not found:', storyId);
    await pool.end();
    return;
  }

  console.log('Story:', story.title);
  console.log('');

  // Check top-level structure
  console.log('Top-level keys:', Object.keys(story).filter(k => !['sceneImages', 'characters', 'title', 'language', 'artStyle', 'storyTheme', 'visualBible'].includes(k)).join(', '));
  console.log('');

  // Check for covers in different locations
  if (story.covers) console.log('story.covers keys:', Object.keys(story.covers));
  if (story.coverImages) console.log('story.coverImages keys:', Object.keys(story.coverImages));

  const covers = ['frontCover', 'initialPage', 'backCover'];
  for (const cover of covers) {
    // Check multiple locations
    const coverData = story[cover] || story.covers?.[cover] || story.coverImages?.[cover];
    if (coverData) {
      const refs = coverData.referencePhotos || [];
      console.log('===', cover.toUpperCase(), '===');
      const imgLen = coverData.imageData ? coverData.imageData.length : 0;
      console.log('Has image:', !!coverData.imageData, `(${imgLen} bytes)`);
      console.log('All keys:', Object.keys(coverData).join(', '));
      console.log('Reference photos count:', refs.length);
      // Show first 200 chars of prompt to see clothing
      if (coverData.prompt) {
        console.log('Prompt excerpt:', coverData.prompt.substring(0, 300).replace(/\n/g, ' ') + '...');
      }
      if (refs.length === 0) {
        console.log('  (NO REFERENCE PHOTOS)');
      }
      refs.forEach(r => {
        const urlLen = r.photoUrl ? r.photoUrl.length : 0;
        console.log(`  - ${r.name} | type: ${r.photoType} | styled: ${r.isStyled || false} | urlLen: ${urlLen}`);
      });
      console.log('');
    } else {
      console.log('===', cover.toUpperCase(), '=== NOT FOUND\n');
    }
  }

  // Check mainCharacters
  if (story.mainCharacters) {
    console.log('=== MAIN CHARACTERS (story.mainCharacters) ===');
    console.log('Value:', JSON.stringify(story.mainCharacters));
  }

  // Check job checkpoints
  try {
    const cpResult = await pool.query(
      'SELECT step_name, step_index, step_data FROM story_job_checkpoints WHERE job_id = $1 ORDER BY created_at',
      [storyId]
    );
    console.log('');
    console.log('=== JOB CHECKPOINTS ===');
    console.log('Found:', cpResult.rows.length, 'checkpoints');
    cpResult.rows.forEach(cp => {
      const data = cp.step_data;
      if (cp.step_name === 'partial_cover') {
        const refs = data.referencePhotos || [];
        console.log(`  ${cp.step_name}[${cp.step_index}] type=${data.type} refs=${refs.length}`);
      } else {
        console.log(`  ${cp.step_name}[${cp.step_index}]`);
      }
    });
  } catch (e) {
    console.log('Checkpoint query error:', e.message);
  }

  // Also check characters
  console.log('');
  console.log('=== CHARACTERS ===');
  const chars = story.characters || [];
  chars.forEach(c => {
    const hasAvatars = !!c.avatars;
    const avatarKeys = c.avatars ? Object.keys(c.avatars).filter(k => k !== 'clothing' && k !== 'styledAvatars' && k !== 'signatures') : [];
    const isMain = c.isMainCharacter;
    console.log(`  - ${c.name} | isMain: ${isMain} | hasAvatars: ${hasAvatars} | keys: [${avatarKeys.join(',')}]`);
  });

  await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
