'use strict';
// OIL experiment: (1) new avatar creation — Round 2 oil style transfer via the
// wired pipeline (Gemini) on the reused Grok Round-1 anchors, for all 5; then
// (2) cover composite vs direct in oil with those avatars. Logs outcomes.
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const r2 = require('../../server/lib/r2');
const { getFacePhoto } = require('../../server/lib/characterPhotos');

const OUT = 'C:/Users/roger/AppData/Local/Temp/oil-experiment';
const ANCHORS = 'C:/Users/roger/AppData/Local/Temp/avatar-ab5'; // {Name}_pass1_GROK.jpg (style-agnostic realistic anchor)
const STORY_ID = 'job_1784404956456_ggvjxti9d';
const USER_ID = 'b020e093-90d9-431a-acd4-372eb8438cbe';
const NAMES = ['Emma', 'Noah', 'Daniel', 'Sarah', 'Hans'];
const toUri = p => 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
const saveUri = (name, uri) => fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(uri.split(',')[1], 'base64'));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const c2x4 = require('../../server/lib/character2x4Sheet');
  const { iterateCover } = require('../../server/lib/coverIterate');

  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  let storyData = (await pool.query('SELECT data FROM stories WHERE id=$1', [STORY_ID])).rows[0].data;
  if (typeof storyData === 'string') storyData = JSON.parse(storyData);
  let cd = (await pool.query('SELECT data FROM characters WHERE user_id=$1', [USER_ID])).rows[0].data;
  if (typeof cd === 'string') cd = JSON.parse(cd);
  const characters = Array.isArray(cd) ? cd : (cd.characters || []);

  // ── Stage 1: oil avatars via the wired Round-2 pipeline (Gemini) ──
  console.log('=== STAGE 1: oil avatars (Round-2 style transfer, backend=gemini) ===');
  const oilSheets = {};
  for (const name of NAMES) {
    const anchorFile = `${ANCHORS}/${name}_pass1_GROK.jpg`;
    if (!fs.existsSync(anchorFile)) { console.log(`  ${name}: no Grok anchor — skip`); continue; }
    const ch = characters.find(c => c.name === name);
    const faceB = await r2.bytesFromAnyImage(getFacePhoto(ch));
    const face = faceB ? 'data:image/jpeg;base64,' + faceB.toString('base64') : null;
    const t0 = Date.now();
    const r = await c2x4.runStyleTransferPass({
      pass1ImageData: toUri(anchorFile), facePhoto: face, artStyle: 'oil', characterName: name, usageTracker: null,
    });
    const v = r.finalVerdict || {};
    console.log(`  ${name}: ${Math.round((Date.now() - t0) / 1000)}s | style=${v.styleScore} identity=${v.identityScore} bodyFace=${v.bodyFaceScore} clean=${v.cleanScore} final=${r.finalScore} valid=${v.valid} attempts=${r.attempts.length}`);
    if (r.imageData) { oilSheets[name] = r.imageData; saveUri(`avatar_${name}_oil`, r.imageData); }
  }

  // ── Stage 2: cover composite vs direct in oil ──
  console.log('\n=== STAGE 2: cover composite vs direct (oil, all 5) ===');
  storyData.artStyle = 'oil';
  let injected = 0;
  for (const c of characters) {
    if (!oilSheets[c.name]) continue;
    c.avatars = c.avatars || {};
    c.avatars.styledAvatars = c.avatars.styledAvatars || {};
    c.avatars.styledAvatars.oil = { standard: oilSheets[c.name] };
    injected++;
  }
  console.log(`  injected oil sheets for ${injected}/${characters.length}`);
  await pool.end();

  for (const [label, composite] of [['COMPOSITE', true], ['DIRECT', false]]) {
    const t0 = Date.now();
    try {
      const r = await iterateCover('initialPage', storyData, { freshCharacters: characters, compositeCovers: composite });
      console.log(`  ${label}: ${Math.round((Date.now() - t0) / 1000)}s score=${r.score ?? 'n/a'} model=${r.modelId || 'n/a'}`);
      if (r.imageData) saveUri(`cover_${label}`, r.imageData);
    } catch (e) { console.log(`  ${label} FAILED: ${e.message}`); }
  }
  console.log(`\nDone. ${OUT}`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message, (e.stack || '').split('\n').slice(1, 3).join(' ')); process.exit(1); });
