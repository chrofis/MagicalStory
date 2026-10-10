#!/usr/bin/env node
'use strict';

/**
 * A/B of the references the ONE avatar-sheet call gets (docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call"):
 *   a) face photo only   b) face + the character's wizard avatar (2x2, avatars.standard)   c) face + the body cut-out (photos.bodyNoBg)
 * on stored staging characters, through the real generateOneCallSheet. No judge, no redo: the sheets are viewed and measured
 * (scripts/analysis/measure-sheet-heads.js on <out>/img).
 *
 *   node scripts/analysis/ab-sheet-references.js --out <dir> --cap-usd 0.50 [--plan "Emma:costume,Noah:costume,Daniel:costume,Noah:standard"]
 *
 * Paid: one Grok 2.0 call (USD 0.04) per cell of the plan x 3 sets. Stops at the cap.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '../..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; };
const out = arg('out');
const cap = Number(arg('cap-usd', 0.5));
if (!out) throw new Error('--out <dir> is required');
fs.mkdirSync(path.join(out, 'img'), { recursive: true });
const ROW = 'characters_680c30fd-2839-4c23-b00c-b91603352a6d'; // staging family: Emma 4, Noah 7, Daniel 38, Sarah 36, Hans 68
const PLAN = (arg('plan', 'Emma:costume,Noah:costume,Daniel:costume,Noah:standard')).split(',').map(s => s.split(':'));
const GROK_USD = 0.04;
let spent = 0;

async function main() {
  await require('../../server/services/prompts').loadPromptTemplates();
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const sheet = require('../../server/lib/character2x4Sheet');
  const { getTrialCostume } = require('../../server/config/trialCostumes');
  const { seasonOutfitGuidance } = require('../../server/lib/season');
  const res = await pool.query('SELECT data FROM characters WHERE id = $1', [ROW]);
  const data = typeof res.rows[0].data === 'string' ? JSON.parse(res.rows[0].data) : res.rows[0].data;
  const jobs = [];
  for (const [name, kind] of PLAN) {
    const c = data.characters.find(x => x.name === name);
    if (!c) throw new Error(`no ${name}`);
    const base = { id: c.id, name: c.name, age: c.age, gender: c.gender, photos: {}, physical: c.physical || {}, physicalTraitsSource: c.physicalTraitsSource || {} };
    const sets = {
      a_face: { references: 'face', photos: c.photos },
      b_face_avatar2x2: { references: 'face+body', photos: { ...c.photos, bodyNoBg: c.avatars.standard } }, // the 2x2 avatar stands in as the body reference
      c_face_bodyNoBg: { references: 'face+body', photos: c.photos },
    };
    const costume = kind === 'costume' ? getTrialCostume('wizard', 'adventure', c.gender) : null;
    for (const [set, def] of Object.entries(sets)) {
      jobs.push({ name, kind, set, references: def.references, character: { ...base, photos: def.photos }, costume });
    }
  }
  await pool.end();
  const results = [];
  const run = async (j) => {
    if (spent + GROK_USD > cap + 1e-9) throw new Error(`spend cap USD ${cap} reached`);
    spent += GROK_USD;
    const t0 = Date.now();
    const r = await sheet.generateOneCallSheet(j.character, {
      artStyle: 'watercolor', kind: j.kind, references: j.references,
      costumeDescription: j.costume ? j.costume.description : 'standard outfit', costumeName: j.costume ? 'wizard' : null,
      seasonOutfit: j.kind === 'standard' ? seasonOutfitGuidance({ storyCategory: 'adventure' }) : null,
    });
    const file = `${j.name}-${j.kind}-${j.set}.png`;
    fs.writeFileSync(path.join(out, 'img', file), Buffer.from(r.imageData.split(',')[1], 'base64'));
    results.push({ file, ms: Date.now() - t0 });
    console.log(file, Date.now() - t0, 'ms');
  };
  // three sets of one character at a time
  for (let i = 0; i < jobs.length; i += 3) await Promise.all(jobs.slice(i, i + 3).map(run));
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ spentUsd: spent, results }, null, 1));
  console.log('spent USD', spent.toFixed(2));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
