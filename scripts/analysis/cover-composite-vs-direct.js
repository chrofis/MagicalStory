'use strict';
// Composite vs direct front cover with all 5 characters, using the Gemini-Pixar
// 2×4 sheets from the avatar A/B (no regen). Injects them as each character's
// styledAvatars.pixar.standard so the composite pulls the good Pixar cutouts.
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const OUT = 'C:/Users/roger/AppData/Local/Temp/cover-composite';
const AB5 = 'C:/Users/roger/AppData/Local/Temp/avatar-ab5';
const STORY_ID = 'job_1784404956456_ggvjxti9d';
const USER_ID = 'b020e093-90d9-431a-acd4-372eb8438cbe';
const toUri = p => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { iterateCover } = require('../../server/lib/coverIterate');

  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const s = await pool.query('SELECT data FROM stories WHERE id=$1', [STORY_ID]);
  let storyData = s.rows[0].data; if (typeof storyData === 'string') storyData = JSON.parse(storyData);
  const cr = await pool.query('SELECT data FROM characters WHERE user_id=$1', [USER_ID]);
  let cd = cr.rows[0].data; if (typeof cd === 'string') cd = JSON.parse(cd);
  await pool.end();
  const characters = Array.isArray(cd) ? cd : (cd.characters || []);

  // Inject the Gemini-Pixar 2×4 sheets as each character's styled pixar avatar.
  let injected = 0;
  for (const c of characters) {
    const f = `${AB5}/${c.name}_pass2_GEMINI.jpg`;
    if (!fs.existsSync(f)) { console.log(`  no Pixar sheet for ${c.name} — skip inject`); continue; }
    c.avatars = c.avatars || {};
    c.avatars.styledAvatars = c.avatars.styledAvatars || {};
    c.avatars.styledAvatars.pixar = { standard: toUri(f) };
    injected++;
  }
  console.log(`Injected Pixar sheets for ${injected}/${characters.length} characters`);

  const coverKey = process.argv[2] || 'initialPage'; // initialPage = all-5 family portrait
  const run = async (label, composite) => {
    console.log(`\n=== ${coverKey} ${label} (compositeCovers=${composite}) ===`);
    const t0 = Date.now();
    const r = await iterateCover(coverKey, storyData, {
      freshCharacters: characters,
      compositeCovers: composite,
    });
    console.log(`  ${label}: ${Math.round((Date.now() - t0) / 1000)}s, score=${r.score ?? 'n/a'}, model=${r.modelId || 'n/a'}`);
    if (r.imageData) { fs.writeFileSync(`${OUT}/${coverKey}_${label}.jpg`, Buffer.from(r.imageData.split(',')[1], 'base64')); console.log(`  saved ${coverKey}_${label}.jpg`); }
    return r;
  };

  await run('COMPOSITE', true);
  await run('DIRECT', false);
  console.log(`\nDone. ${OUT}`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message, e.stack?.split('\n').slice(1, 3).join(' ')); process.exit(1); });
