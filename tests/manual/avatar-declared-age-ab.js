/**
 * Clean A/B for the declared-age block in the 2×4 identity sheet.
 *
 * Four sheet generations from prod story job_1789227389389_z18dmvnt6:
 *   Liz  (declared 5) with the age block / without it (control)
 *   Ayan (declared 8) with the age block / without it (control)
 *
 * The control arm does NOT edit character2x4Sheet.js — it passes a character
 * whose age is absent/unparseable, for which declaredAgeBlock() returns '' and
 * the prompt is byte-identical to the pre-change one.
 *
 * Fixes the two flaws in tests/manual/redo-avatars-declared-age.js:
 *   - passes the story's REAL artStyle (so all four match the shipped avatars)
 *   - does NOT skip the sheet review (contaminated rows get caught + retried)
 *
 * `--dry` runs the free preflight only: builds the prompts for every arm and
 * reports where the age block does / does not appear. No paid calls.
 *
 * Paid: 4 × (~2 Grok rows + style transfer + judges) ≈ $0.25 + retries.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT = 'C:/Users/roger/AppData/Local/Temp/claude/C--Users-roger-MagicalStory/7c09c544-3c41-4f8c-9a49-e4d09a0c3db8/scratchpad/img';
const JOB = 'job_1789227389389_z18dmvnt6';
const DRY = process.argv.includes('--dry');

const sheet = require('../../server/lib/character2x4Sheet.js');
const { generateCharacter2x4Sheet, declaredAgeBlock, buildPrompt, _internal } = sheet;
const { buildBodyRowPrompt, buildHeadRowPrompt } = _internal;

const count = (s, needle) => s.split(needle).length - 1;

// Strip every age field so declaredAgeBlock() returns '' → old prompt exactly.
function stripAge(c) {
  const { age, declaredAge, ...rest } = c;
  return rest;
}

async function loadStory() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('select data from stories where data::text like $1 limit 1', ['%' + JOB + '%']);
  await pool.end();
  if (!r.rows[0]) throw new Error(`story for ${JOB} not found`);
  return r.rows[0].data;
}

(async () => {
  const story = await loadStory();
  const artStyle = story.artStyle;
  if (!artStyle) throw new Error('story.artStyle missing — refusing to guess');
  console.log(`story artStyle = ${artStyle}`);

  const arms = [];
  for (const name of ['Liz', 'Ayan']) {
    const c = (story.characters || []).find(x => x.name === name);
    if (!c) throw new Error(`character ${name} not in story`);
    const refs = JSON.stringify(c.avatars?.generationRefs || {});
    const face = (refs.match(/https:\/\/[^"]*face-[^"]*\.jpg/) || [])[0];
    const body = (refs.match(/https:\/\/[^"]*body-[^"]*\.jpg/) || [])[0];
    if (!face) throw new Error(`${name}: no face reference photo`);
    const clothing = story.clothingRequirements?.[name]?.standard?.description || '';
    if (!clothing) throw new Error(`${name}: no standard clothing description`);
    const base = { ...c, photos: { ...(c.photos || {}), face, original: body || face } };
    arms.push({ label: `${name}_age`,   name, character: base,            clothing, treatment: true });
    arms.push({ label: `${name}_noage`, name, character: stripAge(base),  clothing, treatment: false });
  }

  // ── Free preflight: what the prompts actually contain ──
  console.log('\n=== PROMPT PREFLIGHT (no paid calls) ===');
  let bad = 0;
  for (const a of arms) {
    const blk = declaredAgeBlock(a.character);
    const combined = buildPrompt(artStyle, a.clothing, a.character);
    const live = buildBodyRowPrompt(a.clothing, a.character) + '\n' + buildHeadRowPrompt(a.character, a.clothing);
    const nCombined = count(combined, 'years old');
    const nLive = count(live, 'years old');
    const want = a.treatment ? 2 : 0;
    const ok = nCombined === want;
    if (!ok) bad++;
    console.log(`${a.label.padEnd(11)} ageBlock=${blk ? 'yes' : 'EMPTY'}  buildPrompt "years old"×${nCombined} (want ${want}) ${ok ? 'OK' : 'MISMATCH'}   LIVE body+head rows "years old"×${nLive}`);
  }
  if (bad) throw new Error(`${bad} arm(s) failed the prompt assertion — aborting before any paid call`);
  if (DRY) { console.log('\n--dry: stopping before paid calls.'); return; }

  // ── Paid arm ──
  fs.mkdirSync(OUT, { recursive: true });
  for (const a of arms) {
    console.log(`\n=== ${a.label} (age=${a.character.age ?? 'none'}) style=${artStyle}`);
    const t0 = Date.now();
    let res;
    try {
      res = await generateCharacter2x4Sheet(a.character, {
        costumeDescription: a.clothing,
        artStyle,                 // real story style; review NOT skipped
      });
    } catch (e) {
      console.log(`   FAILED: ${e.message}`);
      continue;
    }
    const data = res?.imageData;
    if (!data) { console.log('   no image returned'); continue; }
    const file = path.join(OUT, `ab_${a.label}.jpg`);
    fs.writeFileSync(file, Buffer.from(String(data).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
    console.log(`   OK in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${file} (${Math.round(fs.statSync(file).size / 1024)} KB), pass1 score=${res?.pass1?.finalScore ?? 'n/a'}`);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
