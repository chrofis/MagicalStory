'use strict';
// Grok vs Gemini avatar A/B across ALL characters. Round 1 (realistic anchor)
// then Round 2 (Pixar style transfer) on the Grok anchor. Same refs + prompt
// for both backends. Faces + standard avatars pulled from the DB (canonical).
// Usage: node avatar-grok-vs-gemini.js            # all 5 chars, both rounds
//        node avatar-grok-vs-gemini.js Emma       # one character
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const r2 = require('../../server/lib/r2');
const { getFacePhoto, getStandardAvatar } = require('../../server/lib/characterPhotos');
const { editWithGrok, GROK_MODELS } = require('../../server/lib/grok');
const { _internal } = require('../../server/lib/character2x4Sheet');
const { buildPrompt, buildStyleTransferPrompt, quickLayoutCheck } = _internal;

// Round-1 anchor MUST be layout-validated (quickLayoutCheck) or Grok's
// split-figure failure (one figure across the mid-row gutter → headless cutout)
// slips into the experiment. Mirrors production generateCharacter2x4Sheet.
// quickLayoutCheck is reliable here because Round-1 anchors are white-bg realistic.
async function grokAnchorValidated(prompt, refs, tries = 3) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    const img = (await editWithGrok(prompt, refs, { aspectRatio: '16:9', model: GROK_MODELS.STANDARD })).imageData;
    last = img;
    const q = await quickLayoutCheck(img);
    if (q.valid) return img;
    console.log(`    R1-grok attempt ${i}/${tries} bad layout (${q.reason}) — retrying`);
  }
  console.log('    R1-grok: all attempts failed layout check — using last');
  return last;
}

const OUT = 'C:/Users/roger/AppData/Local/Temp/avatar-ab5';
const USER_ID = 'b020e093-90d9-431a-acd4-372eb8438cbe';
const GEMINI_MODEL = 'gemini-3-pro-image-preview';
const ASSETS = path.resolve(__dirname, '..', '..', 'server', 'assets');

function phantomTier(age) { const n = parseInt(age, 10); if (!Number.isFinite(n)) return 'child'; if (n <= 4) return 'toddler'; if (n <= 11) return 'child'; if (n <= 17) return 'teen'; return 'adult'; }
function phantom(age) {
  const f = path.join(ASSETS, `phantom-watercolor-${phantomTier(age)}-axes.png`);
  const file = fs.existsSync(f) ? f : path.join(ASSETS, 'phantom-watercolor-axes.png');
  return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}
const bytesToUri = (b, mime = 'image/jpeg') => `data:${mime};base64,${b.toString('base64')}`;

async function geminiEdit(prompt, refs, aspect = '16:9') {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const parts = [{ text: prompt }, ...refs.map(img => ({ inlineData: { mimeType: String(img).startsWith('data:image/png') ? 'image/png' : 'image/jpeg', data: String(img).replace(/^data:image\/\w+;base64,/, '') } }))];
  const body = { contents: [{ parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], temperature: 0.8, imageConfig: { aspectRatio: aspect } } };
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
  const data = await resp.json();
  const p = (data.candidates?.[0]?.content?.parts || []).find(x => x.inlineData);
  if (!p) throw new Error('Gemini no image');
  return 'data:image/jpeg;base64,' + p.inlineData.data;
}
const save = (name, uri) => { fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(uri.split(',')[1], 'base64')); console.log(`    saved ${name}.jpg`); };
const tryGen = async (label, fn) => { try { return await fn(); } catch (e) { console.log(`    ${label} FAILED: ${e.message}`); return null; } };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv[2];
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const r = await pool.query('SELECT data FROM characters WHERE user_id=$1', [USER_ID]);
  await pool.end();
  let d = r.rows[0].data; if (typeof d === 'string') d = JSON.parse(d);
  let chars = d.characters || [];
  if (only) chars = chars.filter(c => c.name.toLowerCase() === only.toLowerCase());

  for (const ch of chars) {
    console.log(`\n=== ${ch.name} (age ${ch.age}) ===`);
    const faceB = await r2.bytesFromAnyImage(getFacePhoto(ch));
    const stdB = await r2.bytesFromAnyImage(getStandardAvatar(ch, 'standard'));
    if (!faceB) { console.log('  no face — skip'); continue; }
    const refs = stdB ? [phantom(ch.age), bytesToUri(stdB), bytesToUri(faceB)] : [phantom(ch.age), bytesToUri(faceB)];
    const p1 = buildPrompt('pixar', 'everyday casual outfit', ch);
    const p2 = buildStyleTransferPrompt('pixar');

    console.log('  Round 1 (anchor)...');
    const g1 = await tryGen('R1-grok', () => grokAnchorValidated(p1, refs));
    if (g1) save(`${ch.name}_pass1_GROK`, g1);
    const m1 = await tryGen('R1-gemini', () => geminiEdit(p1, refs));
    if (m1) save(`${ch.name}_pass1_GEMINI`, m1);

    // Round 2 on the Grok anchor (Grok won Round 1 identity). Isolates stylization.
    const anchor = g1 || m1;
    if (anchor) {
      console.log('  Round 2 (Pixar, on Grok anchor)...');
      const g2 = await tryGen('R2-grok', () => editWithGrok(p2, [anchor], { aspectRatio: '16:9', model: GROK_MODELS.STANDARD }).then(x => x.imageData));
      if (g2) save(`${ch.name}_pass2_GROK`, g2);
      const m2 = await tryGen('R2-gemini', () => geminiEdit(p2, [anchor]));
      if (m2) save(`${ch.name}_pass2_GEMINI`, m2);
    }
  }
  console.log(`\nDone. Images in ${OUT}`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
