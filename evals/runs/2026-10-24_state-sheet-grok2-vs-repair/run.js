#!/usr/bin/env node
/**
 * Same 5 stored cases as evals/runs/2026-10-23_state-full-desc-removed. No writer call, no new prompt wording for arm A.
 *  Arm A: the stored sheet prompt (sheet.json) sent once to Grok 2 (model key grok-imagine-2) through callGeminiAPIForImage, split like production.
 *  Arm B: the already-paid Grok 1 cells; every non-base state cell gets ONE editWithGrok (Grok Imagine 1.x) with a prompt built only from the state's fields.
 *   node evals/runs/2026-10-24_state-sheet-grok2-vs-repair/run.js --arm=A|B|dry [--only=<storyId,...>] [--cap=0.45]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sharp = require('sharp');
const ROOT = path.resolve(__dirname, '../../..');
const OUT = __dirname;
const PRIOR = path.join(ROOT, 'evals/runs/2026-10-23_state-full-desc-removed');
const LEDGER = path.join(OUT, 'ledger.jsonl');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const arm = arg('arm') || 'dry';
const CAP = Number(arg('cap') || 0.45);
const spent = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost || 0), 0) : 0);
const book = o => fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n');
const CASES = [
  { id: 'job_1792772600127_tv32st82h', env: 'prod' },
  { id: 'job_1792041406330_mxoqmhu6k', env: 'prod' },
  { id: 'job_1792312615714_wpz3fzwyy', env: 'prod' },
  { id: 'job_1790446348343_z3fw660ie', env: 'stg' },
  { id: 'job_1791450210539_nwi88y9lr', env: 'stg' },
].filter(c => !arg('only') || arg('only').split(',').includes(c.id));
const pools = {};
const pool = env => (pools[env] = pools[env] || new Pool({ connectionString: env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } }));

/** Arm B edit prompt: generic, built only from the state's own fields. */
function repairPrompt(cell) {
  const rm = (cell.removed || []).filter(Boolean);
  return `Edit this picture of one object. Keep the object, the painting style, the background and the framing exactly as they are; change only what the description below requires.\n`
    + `The object must look exactly like this: ${cell.description}.\n`
    + (rm.length ? `These parts are gone from the object and must not be drawn anywhere on it, not even a trace or a second copy: ${rm.join('; ')}. Draw the part that replaced them once only.\n` : '')
    + `Output the single object picture, same composition.`;
}

(async () => {
  await require(path.join(ROOT, 'server/services/prompts')).loadPromptTemplates();
  const { MODEL_DEFAULTS, IMAGE_MODELS } = require(path.join(ROOT, 'server/config/models'));
  const { stripDataUriPrefix } = require(path.join(ROOT, 'server/lib/r2'));
  if (arm === 'dry') {
    for (const c of CASES) {
      const s = require(path.join(PRIOR, c.id, 'sheet.json'));
      console.log(c.id, s.cells.length, 'cells; edits', s.cells.slice(1).length);
      s.cells.slice(1).forEach(x => console.log(repairPrompt(x), '\n'));
    }
    return;
  }
  if (arm === 'A') {
    const refSheets = require(path.join(ROOT, 'server/lib/referenceSheets'));
    const { callGeminiAPIForImage } = require(path.join(ROOT, 'server/lib/images'));
    for (const c of CASES) {
      const dir = path.join(OUT, 'A', c.id);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(path.join(dir, 'sheet.jpg'))) { console.log(c.id, 'done'); continue; }
      const s = require(path.join(PRIOR, c.id, 'sheet.json'));
      const sr = await pool(c.env).query(`select data->'layout' l from stories where id = $1`, [c.id]);
      const aspect = sr.rows[0].l?.imageAspect || MODEL_DEFAULTS.pageAspect;
      if (spent() + 0.04 > CAP) { console.log('CAP stop', spent()); break; }
      const t0 = Date.now();
      const r = await callGeminiAPIForImage(s.prompt, [], null, 'avatar', null, 'grok-imagine-2', null, '', null, [], 0, null, null, null, null, aspect);
      const u = r?.usage || {};
      const cost = Number(u.direct_cost ?? u.cost ?? IMAGE_MODELS['grok-imagine-2']?.costPerImage ?? 0.04);
      book({ arm: 'A', story: c.id, modelId: r?.modelId, cost, aspect, ms: Date.now() - t0 });
      if (!r?.imageData) { console.log(c.id, 'NO IMAGE'); continue; }
      const b64 = stripDataUriPrefix(r.imageData);
      fs.writeFileSync(path.join(dir, 'sheet.jpg'), Buffer.from(b64, 'base64'));
      try {
        const parts = await refSheets.splitGridIntoReferences(b64, s.cells.length, s.cells);
        parts.forEach((p, i) => p && fs.writeFileSync(path.join(dir, `cell-${s.cells[i].id.replace('.', '_')}.png`), Buffer.from(p, 'base64')));
      } catch (e) { console.log('split failed', e.message); }
      fs.writeFileSync(path.join(dir, 'sheet.json'), JSON.stringify({ modelId: r.modelId, aspect, cost, cells: s.cells.map(x => x.id) }, null, 1));
      console.log(c.id, r.modelId, '$' + cost, 'running', spent().toFixed(3));
    }
  }
  if (arm === 'B') {
    const { editWithGrok } = require(path.join(ROOT, 'server/lib/grok'));
    const order = ['job_1792772600127_tv32st82h', 'job_1792041406330_mxoqmhu6k'];
    const rank = id => (order.indexOf(id) < 0 ? 9 : order.indexOf(id));
    const list = [...CASES].sort((a, b) => rank(a.id) - rank(b.id));
    for (const c of list) {
      const dir = path.join(OUT, 'B', c.id);
      fs.mkdirSync(dir, { recursive: true });
      const s = require(path.join(PRIOR, c.id, 'sheet.json'));
      const sheet = path.join(PRIOR, c.id, 'new-sheet.jpg');
      for (let i = 1; i < s.cells.length; i++) {
        const cell = s.cells[i];
        const key = cell.id.replace('.', '_');
        const outF = path.join(dir, `edit-${key}.png`);
        if (fs.existsSync(outF)) continue;
        let src = path.join(PRIOR, c.id, `new-${key}.png`);
        if (!fs.existsSync(src)) { // the prior split failed for this sheet: crop the 2x2 quadrant (reading order)
          const half = 512;
          const q = [[0, 0], [half, 0], [0, half], [half, half]][i];
          src = path.join(dir, `src-${key}.png`);
          await sharp(sheet).extract({ left: q[0] + 6, top: q[1] + 6, width: half - 12, height: half - 12 }).png().toFile(src);
        }
        if (spent() + 0.02 > CAP) { console.log('CAP stop', spent()); return; }
        const prompt = repairPrompt(cell);
        const buf = fs.readFileSync(src);
        const t0 = Date.now();
        const r = await editWithGrok(prompt, [`data:image/png;base64,${buf.toString('base64')}`], { model: 'grok-imagine-image', aspectRatio: '1:1', skipOutputCrop: true });
        const cost = Number(r?.usage?.direct_cost ?? r?.usage?.cost ?? 0.02);
        book({ arm: 'B', story: c.id, cell: cell.id, modelId: r?.modelId, cost, ms: Date.now() - t0 });
        fs.writeFileSync(path.join(dir, `prompt-${key}.txt`), prompt);
        fs.writeFileSync(outF, Buffer.from(stripDataUriPrefix(r.imageData), 'base64'));
        console.log(c.id, cell.id, r.modelId, '$' + cost, 'running', spent().toFixed(3));
      }
    }
  }
  console.log('SPENT', spent().toFixed(4), 'of', CAP);
})().then(() => Promise.all(Object.values(pools).map(p => p.end()))).then(() => process.exit(0)).catch(e => { console.error('FAILED', e); process.exit(1); });
