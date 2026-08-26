// Dump Werner's record: the ACTUAL physical traits stored on the character,
// vs. what the unified story pass wrote into CHARACTER DETAILS for this story,
// vs. what's in the rendered standard + costumed avatars.

const { Pool } = require('pg');
require('dotenv').config();

const STORY_ID = 'job_1776965594352_um33rf9xl';
const CHAR_NAME = 'Werner';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

(async () => {
  // 1) Pull the character record
  const { rows: charRows } = await pool.query(
    `SELECT id, user_id, data FROM characters
     WHERE data->>'name' ILIKE $1
     ORDER BY id DESC`,
    [CHAR_NAME]
  );
  if (charRows.length === 0) {
    console.log(`No characters found named ${CHAR_NAME}`);
    process.exit(0);
  }

  // 2) Pull the story row to see which Werner record was attached
  const { rows: storyRows } = await pool.query(
    `SELECT id, user_id, data->'characters' as characters, data->'clothingRequirements' as clothing_reqs
     FROM stories WHERE id = $1`,
    [STORY_ID]
  );
  const story = storyRows[0];
  if (!story) {
    console.log(`Story ${STORY_ID} not found`);
    process.exit(1);
  }
  const wernerInStory = (story.characters || []).find(c => c.name === CHAR_NAME);

  console.log('=== Werner record(s) in DB ===\n');
  for (const r of charRows) {
    const d = r.data || {};
    console.log(`id=${r.id}  user=${r.user_id}`);
    console.log(`  physical:`);
    const phys = d.physical || {};
    for (const [k, v] of Object.entries(phys)) {
      if (typeof v === 'string' && v.length < 200) console.log(`    ${k}: ${v}`);
    }
    const avatars = d.avatars || {};
    const styled = avatars.styledAvatars || {};
    console.log(`  avatar clothing entries:`);
    for (const [cat, val] of Object.entries(avatars.clothing || {})) {
      if (typeof val === 'string') {
        console.log(`    ${cat}: ${val.substring(0, 200)}`);
      } else if (typeof val === 'object' && val) {
        const s = JSON.stringify(val).substring(0, 200);
        console.log(`    ${cat}: ${s}`);
      }
    }
    console.log(`  has standard avatar img: ${!!avatars.standard}`);
    console.log(`  has styled[anime] entries: ${Object.keys(styled.anime || {}).join(', ') || '(none)'}`);
    console.log('');
  }

  console.log('=== Werner as attached to story ===\n');
  if (wernerInStory) {
    console.log(`physical:`);
    for (const [k, v] of Object.entries(wernerInStory.physical || {})) {
      if (typeof v === 'string' && v.length < 200) console.log(`  ${k}: ${v}`);
    }
    console.log('');
    console.log('story-embedded avatar clothing:');
    for (const [cat, val] of Object.entries(wernerInStory.avatars?.clothing || {})) {
      if (typeof val === 'string') console.log(`  ${cat}: ${val.substring(0, 200)}`);
      else console.log(`  ${cat}: ${JSON.stringify(val).substring(0, 200)}`);
    }
  } else {
    console.log('  (Werner not in story.characters[] — using external ref)');
  }

  console.log('\n=== Story clothingRequirements for Werner ===\n');
  const cr = story.clothing_reqs?.[CHAR_NAME];
  if (cr) console.log(JSON.stringify(cr, null, 2));

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
