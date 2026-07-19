'use strict';
// Real oil COMPOSITE cover: feed a borrowed background plate straight into
// generateCoverViaComposite with the oil avatars (no landmark dependency,
// no fallback). Uses the fixed Emma sheet.
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const OUT = 'C:/Users/roger/AppData/Local/Temp/oil-experiment';
const USER_ID = 'b020e093-90d9-431a-acd4-372eb8438cbe';
const SHEETS = { Emma: 'avatar_Emma_oil_FIXED', Noah: 'avatar_Noah_oil', Daniel: 'avatar_Daniel_oil', Sarah: 'avatar_Sarah_oil', Hans: 'avatar_Hans_oil' };
const toUri = p => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');

(async () => {
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const { generateCoverViaComposite } = require('../../server/lib/coverComposite');

  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let cd = (await pool.query('SELECT data FROM characters WHERE user_id=$1', [USER_ID])).rows[0].data;
  if (typeof cd === 'string') cd = JSON.parse(cd);
  await pool.end();
  const characters = (Array.isArray(cd) ? cd : cd.characters || []).filter(c => SHEETS[c.name]);

  // inject oil sheets
  for (const c of characters) {
    c.avatars = c.avatars || {};
    c.avatars.styledAvatars = c.avatars.styledAvatars || {};
    c.avatars.styledAvatars.oil = { standard: toUri(`${OUT}/${SHEETS[c.name]}.jpg`) };
  }
  const landmarkBuf = fs.readFileSync(`${OUT}/bg_p9.jpg`);

  console.log(`Compositing ${characters.length} oil figures onto borrowed background (bg_p9)...`);
  const t0 = Date.now();
  const result = await generateCoverViaComposite({
    coverKey: 'initialPage',
    characters,
    coverHint: null,
    landmarkBuf,
    artStyle: 'oil',
    styleHint: 'oil painting with visible brushwork and rich impasto texture, painterly, soft warm lighting, traditional fine-art oil-on-canvas look',
    title: '',
    dedication: '',
    sceneDescription: 'the family standing together on the cobblestone path in front of the kindergarten building',
    usageTracker: null,
  });
  console.log(`Done in ${Math.round((Date.now() - t0) / 1000)}s. modelId=${result.modelId || 'n/a'}`);
  if (result.imageData) { fs.writeFileSync(`${OUT}/cover_OIL_COMPOSITE_v2.jpg`, Buffer.from(result.imageData.split(',')[1], 'base64')); console.log('saved cover_OIL_COMPOSITE_v2.jpg'); }
  // also dump the intermediate debug images if present
  if (result.debug) {
    for (const [k, v] of Object.entries(result.debug)) {
      if (typeof v === 'string' && v.startsWith('data:')) { fs.writeFileSync(`${OUT}/composite_${k}.jpg`, Buffer.from(v.split(',')[1], 'base64')); console.log(`  debug: composite_${k}.jpg`); }
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message, (e.stack || '').split('\n').slice(1, 3).join(' ')); process.exit(1); });
