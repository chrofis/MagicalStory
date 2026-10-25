/**
 * A/B: does the word "open" in the hand-sized scale phrase pull Grok toward
 * drawing a closed object open? (prod job_1792859316244_6429d0n83 p6: book
 * stated closed 5x, drawn open.)
 *   A = stored page prompt as sent (imageVersions[0].prompt)
 *   B = same prompt, only the hand-size phrases reworded:
 *       "fills an open hand" -> "fills a hand"
 *       "about the size of X's open hand" -> "about the size of X's hand"
 * Same model (stored modelId, grok-imagine-image-2.0), same stored reference
 * slots (sceneImages[].grokRefImages, R2 debug refs), same output aspect as
 * the stored page image. REAL paid calls, USD 0.04 each, hard cap USD 1.00.
 *
 *   node evals/runs/2026-10-24_open-hand-phrase/run.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');
const { editWithGrok } = require('../../../server/lib/grok');

const PRICE = 0.04;
const CAP = 1.00;
const LEDGER = path.join(__dirname, 'ledger.json');

function armB(prompt) {
  return prompt
    .replace(/fills an open hand/g, 'fills a hand')
    .replace(/(about the size of [^—\n]*?) open hand/g, '$1 hand');
}

async function dataUri(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return 'data:image/jpeg;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
}

function aspectOf(w, h) {
  const opts = { '1:1': 1, '3:4': 3 / 4, '4:3': 4 / 3, '2:3': 2 / 3, '3:2': 3 / 2, '9:16': 9 / 16, '16:9': 16 / 9 };
  return Object.entries(opts).sort((a, b) => Math.abs(a[1] - w / h) - Math.abs(b[1] - w / h))[0][0];
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
  const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, 'utf8')) : { spend: 0, calls: [] };
  const ssl = { rejectUnauthorized: false };
  const pools = { prod: new Pool({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl }), staging: new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl }) };
  const prepOnly = process.argv.includes("--prep");
  for (const c of cases) {
    const dir = path.join(__dirname, c.key);
    fs.mkdirSync(dir, { recursive: true });
    const r = await pools[c.env].query(
      `SELECT e->'grokRefImages' refs FROM stories s, jsonb_array_elements(s.data->'sceneImages') e
       WHERE s.id=$1 AND (e->>'pageNumber')::int=$2`, [c.storyId, c.page]);
    const refUrls = r.rows[0] && r.rows[0].refs;
    if (!Array.isArray(refUrls) || !refUrls.length) throw new Error('no stored refs for ' + c.key);
    const img = await pools[c.env].query(
      `SELECT image_url FROM story_images WHERE story_id=$1 AND page_number=$2 AND image_type='scene' AND version_index=0 AND NOT is_test`, [c.storyId, c.page]);
    const origUrl = img.rows[0].image_url;
    const orig = Buffer.from(await (await fetch(origUrl)).arrayBuffer());
    fs.writeFileSync(path.join(dir, 'original_v0.jpg'), orig);
    const meta = await sharp(orig).metadata();
    const aspect = aspectOf(meta.width, meta.height);
    const refs = [];
    for (const u of refUrls) refs.push(await dataUri(u));
    const prompts = { A: c.promptA, B: armB(c.promptA) };
    const changed = (c.promptA.match(/open hand/g) || []).length;
    const left = (prompts.B.match(/open hand/g) || []).length;
    fs.writeFileSync(path.join(dir, 'prompt_A.txt'), prompts.A);
    fs.writeFileSync(path.join(dir, 'prompt_B.txt'), prompts.B);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...c, promptA: undefined, refUrls, origUrl, aspect, openHandInA: changed, openHandLeftInB: left }, null, 1));
    if (prepOnly) continue;
    for (const arm of ["A", "B"]) {
      const out = path.join(dir, `out_${arm}.jpg`);
      if (fs.existsSync(out)) continue;
      if (ledger.spend + PRICE > CAP + 1e-9) { console.log('CAP reached, stopping'); break; }
      const res = await editWithGrok(prompts[arm], refs, { model: c.model, aspectRatio: aspect });
      ledger.spend = +(ledger.spend + PRICE).toFixed(2);
      ledger.calls.push({ key: c.key, arm, model: res.modelId || c.model, usd: PRICE });
      fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));
      fs.writeFileSync(out, Buffer.from(String(res.imageData).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      console.log(c.key, arm, aspect, 'spend USD', ledger.spend.toFixed(2));
    }
  }
  await Promise.all(Object.values(pools).map(p => p.end()));
}
main().catch(e => { console.error(e); process.exit(1); });
