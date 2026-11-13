'use strict';
/**
 * PAID replay of the book review on a SLICE of a stored production story, with or without the cast reference
 * pictures (docs/decisions.md 2026-11-13). Read-only on production data; the model call is the only spend.
 *   node scripts/analysis/replay-book-review-refs.js <storyId> <pages,comma> <arm: new|old> [page=version,...] [capUsd=0.30]
 * arm old = the cast's pictures stripped, so the review is today's (no references, original no-reference rule).
 * Keys come from production's Railway variables into THIS process only. A running total is kept in
 * evals/runs/2026-11-13_book-review-refs/spend.json and the script stops before a call that would pass the cap.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const [storyId, pagesArg, arm, verArg = '', capArg] = process.argv.slice(2);
const CAP = Number(capArg || 0.30);
const outDir = path.join(__dirname, '../../evals/runs/2026-11-13_book-review-refs');
fs.mkdirSync(outDir, { recursive: true });
const spendFile = path.join(outDir, 'spend.json');
const spent = fs.existsSync(spendFile) ? JSON.parse(fs.readFileSync(spendFile, 'utf8')).total : 0;
if (spent >= CAP) { console.error(`cap reached: ${spent}`); process.exit(2); }

const vars = JSON.parse(execSync('railway variables --service MagicalStory --environment production --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
for (const k of ['GEMINI_API_KEY', 'OPENROUTER_API_KEY']) process.env[k] = vars[k];

(async () => {
  const { auditStoryBook } = require('../../server/lib/bookAudit');
  const { MODEL_DEFAULTS } = require('../../server/config/models');
  const r2 = require('../../server/lib/r2');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pool.query('SET default_transaction_read_only = on');
  const row = (await pool.query('select data, image_version_meta meta from stories where id=$1', [storyId])).rows[0];
  const d = row.data;
  const pages = pagesArg.split(',').map(Number);
  const forced = Object.fromEntries(verArg.split(',').filter(Boolean).map(x => x.split('=').map(Number)));
  const sceneImages = [];
  for (const pn of pages) {
    const sc = d.sceneImages.find(s => s.pageNumber === pn);
    const vi = forced[pn] ?? row.meta?.[String(pn)]?.activeVersion ?? 0;
    const img = (await pool.query("select image_url from story_images where story_id=$1 and image_type='scene' and page_number=$2 and version_index=$3", [storyId, pn, vi])).rows[0];
    const buf = await r2.fetchImageBytes(img.image_url);
    const { imageVersions, ...rest } = sc;
    sceneImages.push({ ...rest, imageData: `data:image/jpeg;base64,${buf.toString('base64')}` });
    fs.writeFileSync(path.join(outDir, `${storyId}_p${pn}_v${vi}.jpg`), buf);
  }
  let characters = d.characters || [];
  if (arm === 'old') characters = characters.map(({ avatars, photos, clothingAvatars, ...c }) => c);
  const storyData = { id: storyId, title: d.title, visualBible: d.visualBible || null, characters, mainCharacters: d.mainCharacters, artStyle: d.artStyle, clothingRequirements: d.clothingRequirements || null, sceneImages };
  const res = await auditStoryBook(storyData, { modelId: MODEL_DEFAULTS.bookReviewModel, bookReview: { title: d.title }, objectScale: false });
  const cost = res.usage?.cost_usd ?? null;
  const total = spent + (cost || 0);
  fs.writeFileSync(spendFile, JSON.stringify({ total }));
  const tag = `${storyId}_${pages.join('-')}_${arm}_${verArg.replace(/=/g, 'v') || 'shipped'}`;
  fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify({ storyId, pages, arm, forced, cost, usage: res.usage, faults: res.faults, byRoute: res.byRoute, raw: res.raw }, null, 1));
  console.log(`${tag}: cost USD ${cost} | running total USD ${total.toFixed(4)} | faults ${res.faults}`);
  for (const f of res.byRoute?.IMG || []) console.log('  IMG', f.line || JSON.stringify(f));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
