/**
 * Regenerate the standard 2x4 identity sheets for Liz (5) and Ayan (8) with the
 * declared age now injected into the sheet prompt, so the new sheets can be
 * compared with the ones the story shipped.
 *
 * Reads the two characters out of prod story job_1789227389389_z18dmvnt6 and
 * their face photos from the stored avatar-refs. Writes the results next to the
 * originals in scratchpad/img/.
 *
 * Paid: one Grok/Gemini sheet call per character (~$0.06 each).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/7c09c544-3c41-4f8c-9a49-e4d09a0c3db8/scratchpad';
const JOB = 'job_1789227389389_z18dmvnt6';

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query("select data from stories where data::text like $1 limit 1", ['%' + JOB + '%']);
  const story = r.rows[0].data;
  await pool.end();

  const { generateCharacter2x4Sheet, declaredAgeBlock } = require('../../server/lib/character2x4Sheet.js');

  for (const name of ['Liz', 'Ayan']) {
    const c = (story.characters || []).find(x => x.name === name);
    const refs = JSON.stringify(c.avatars?.generationRefs || {});
    const face = (refs.match(/https:\/\/[^"]*face-[^"]*\.jpg/) || [])[0];
    const body = (refs.match(/https:\/\/[^"]*body-[^"]*\.jpg/) || [])[0];
    if (!face) { console.log(`${name}: NO FACE PHOTO — skipped`); continue; }

    // The clothing the story actually dressed them in (standard variant).
    const clothing = story.clothingRequirements?.[name]?.standard?.description || '';

    const character = {
      ...c,
      photos: { ...(c.photos || {}), face, original: body || face },
    };

    console.log(`\n=== ${name}, declared age ${c.age}`);
    console.log('   age block:', declaredAgeBlock(character).trim().slice(0, 120));
    console.log('   clothing :', clothing.slice(0, 90));

    const t0 = Date.now();
    let res;
    try {
      res = await generateCharacter2x4Sheet(character, {
        costumeDescription: clothing,
        skipReview: true,
      });
    } catch (e) {
      console.log(`   FAILED: ${e.message}`);
      continue;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    const data = res?.imageData || res?.output || res?.image;
    if (!data) { console.log(`   no image returned (keys: ${Object.keys(res || {}).join(',')})`); continue; }
    const b64 = String(data).replace(/^data:image\/\w+;base64,/, '');
    const file = path.join(OUT, 'img', `new_${name}_standard.jpg`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log(`   OK in ${secs}s → ${file} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
