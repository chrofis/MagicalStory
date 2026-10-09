/**
 * Trial backgrounds eval: how many DISTINCT backgrounds (plates) does the real trial writer
 * prompt (buildTrialStoryPrompt, as storyJobPipeline.js) produce on stored trial inputs?
 *
 *   node scripts/analysis/eval-trial-backgrounds.js --phase=before|after [--model=claude-haiku-5-5] [--n=24] [--cap=0.5]
 *   node scripts/analysis/eval-trial-backgrounds.js --pick        (rebuild the input list from staging)
 *
 * before: the story-trial.txt of git ref --before-ref (default HEAD) and the OLD plate grouping
 *         (one plate per location, the 2026-09-13 rule).
 * after:  the working-tree template and groupTrialPlatePagesByVantage (one plate per backgrounds[] entry).
 * Inputs: stored staging trial stories (evals/datasets/trial-backgrounds-v1/jobs.json). Text only:
 * no images, no story run, no trial account. Raw writer output goes to evals/runs/<run>/<phase>-<model>/.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'after';
const model = arg('model') || 'claude-haiku-5-5';
const N = parseInt(arg('n') || '24', 10);
const cap = parseFloat(arg('cap') || '0.5');
const beforeRef = arg('before-ref') || 'HEAD';
const run = arg('run') || '2026-10-09_trial-backgrounds';
const outDir = path.join(ROOT, 'evals/runs', run, `${phase}-${model}`);
const datasetFile = path.join(ROOT, 'evals/datasets/trial-backgrounds-v1/jobs.json');

const { Pool } = require('pg');
const pool = () => new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

// The OLD trial grouping (one plate per LOCATION), kept only to measure "before".
function oldPlateCount(vb) {
  const { groupPagesByVantage } = require(path.join(ROOT, 'server/lib/sceneMetadata'));
  const pagesOf = new Set();
  for (const bg of vb.backgrounds || []) for (const pn of bg.pages || []) pagesOf.add(pn);
  const pages = [...pagesOf].sort((a, b) => a - b);
  const synthetic = pages.map(pageNumber => {
    const loc = (vb.locations || []).find(l => Array.isArray(l.pages) && l.pages.includes(pageNumber));
    return { pageNumber, sceneMetadata: { objects: loc ? [`${loc.name || ''} [${loc.id}]`.trim()] : [] }, emptyScenePrompt: '' };
  });
  const g = groupPagesByVantage(synthetic, vb);
  let n = 0;
  for (const [k, v] of g.entries()) n += k === '__unassigned__' ? v.pageNumbers.length : 1;
  return n;
}

function extractVb(text) {
  const i = text.indexOf('---VISUAL BIBLE---');
  if (i < 0) return null;
  const seg = text.slice(i);
  const m = seg.match(/```json\s*([\s\S]*?)```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

(async () => {
  if (process.argv.includes('--pick')) {
    const p = pool();
    const r = await p.query(`select id from stories where data->>'trialMode'='true' and data->'replayInputs' is not null and data->>'pages' = '6' order by created_at desc limit 60`);
    fs.writeFileSync(datasetFile, JSON.stringify(r.rows.map(x => x.id), null, 1));
    console.log('picked', r.rowCount); await p.end(); return;
  }
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  if (phase === 'before') {
    // The old template, with the placeholder the old builder filled (3 to N) filled the same way.
    PROMPT_TEMPLATES.storyTrial = execSync(`git show ${beforeRef}:prompts/story-trial.txt`, { cwd: ROOT, maxBuffer: 1 << 24 }).toString('utf8')
      .replace('{BACKGROUND_RANGE}', '3-6');
  }
  const pb = require(path.join(ROOT, 'server/lib/promptBuilders'));
  const { groupTrialPlatePagesByVantage } = require(path.join(ROOT, 'server/lib/sceneMetadata'));
  const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
  const { MODEL_DEFAULTS, priceUsage } = require(path.join(ROOT, 'server/config/models'));
  fs.mkdirSync(outDir, { recursive: true });

  const ids = JSON.parse(fs.readFileSync(datasetFile, 'utf8')).slice(0, N);
  const p = pool();
  let spend = 0; const rows = [];
  const limit = require('p-limit')(6);
  await Promise.all(ids.map(id => limit(async () => {
    if (spend >= cap) { console.log(`cap ${cap} reached, skipping ${id}`); return; }
    const r = await p.query('select data from stories where id=$1', [id]);
    const d = r.rows[0].data;
    const inputData = { ...d, trialMode: true, pages: 6, availableLandmarks: d.replayInputs?.availableLandmarks || null };
    let prompt = pb.buildTrialStoryPrompt(inputData, 6);
    // The old landmark sentence (the citation went on the location only).
    if (phase === 'before') prompt = prompt.replace("The plate is a `backgrounds[]` entry: the citation goes on that entry, and on the location's own entry as the default for its backgrounds.", "The plate of a location is its `backgrounds[]` description, and the citation goes on the location's own entry.");
    const t = Date.now();
    const res = await callTextModelStreaming(prompt, null, null, model, { usageLabel: 'eval_trial_backgrounds', effort: MODEL_DEFAULTS.trialStoryEffort });
    const cost = priceUsage(res.modelId || '', res.usage || {});
    spend += cost;
    fs.writeFileSync(path.join(outDir, `${id}.txt`), String(res.text || ''));
    const vb = extractVb(String(res.text || ''));
    const row = { id, ms: Date.now() - t, cost: +cost.toFixed(4), vbParsed: !!vb };
    if (vb) {
      const locs = vb.locations || [];
      const landmarks = locs.filter(l => l.isRealLandmark);
      const cover = (String(res.text).match(/---COVER SCENE---[\s\S]*?"location"\s*:\s*"([^"]*)"/) || [])[1] || '';
      const coverLoc = (cover.match(/LOC\d+/) || [])[0];
      row.plates = phase === 'before' ? oldPlateCount(vb) : groupTrialPlatePagesByVantage(vb).length;
      row.bgEntries = (vb.backgrounds || []).length;
      row.distinctDesc = new Set((vb.backgrounds || []).map(b => b.description)).size;
      row.locations = locs.length;
      row.hadLandmarks = !!(inputData.availableLandmarks && inputData.availableLandmarks.length);
      row.landmarkLocs = landmarks.length;
      row.coverIsLandmark = !!(coverLoc && landmarks.some(l => l.id === coverLoc));
      row.coveredPages = [...new Set((vb.backgrounds || []).flatMap(b => b.pages || []))].length;
      row.photosCited = (vb.backgrounds || []).filter(b => b.landmarkPhoto !== undefined).length;
      row.distinctPhotos = new Set((vb.backgrounds || []).filter(b => b.landmarkPhoto !== undefined).map(b => String(b.landmarkPhoto))).size;
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  })));
  await p.end();
  const ok = rows.filter(r => r.vbParsed);
  const hist = {}; ok.forEach(r => { hist[r.plates] = (hist[r.plates] || 0) + 1; });
  const lm = ok.filter(r => r.hadLandmarks);
  const summary = {
    phase, model, stories: rows.length, parsed: ok.length, platesHist: hist,
    ge2: ok.filter(r => r.plates >= 2).length, ge3: ok.filter(r => r.plates >= 3).length,
    onePlate: ok.filter(r => r.plates === 1).length,
    allPagesCovered: ok.filter(r => r.coveredPages === 6).length,
    landmarkStories: lm.length, landmarkStaged: lm.filter(r => r.landmarkLocs > 0).length, landmarkCover: lm.filter(r => r.coverIsLandmark).length,
    landmarkStoriesGe2: lm.filter(r => r.plates >= 2).length,
    spendUsd: +spend.toFixed(4), meanMs: Math.round(rows.reduce((a, r) => a + r.ms, 0) / Math.max(1, rows.length)),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ summary, rows }, null, 1));
  console.log('SUMMARY ' + JSON.stringify(summary));
})().catch(e => { console.error(e); process.exit(1); });
