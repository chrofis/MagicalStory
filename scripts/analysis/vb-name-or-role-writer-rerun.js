#!/usr/bin/env node
/**
 * Re-run the Visual Bible WRITER (call 1 of the Art Director, prompts/visual-bible.txt) on stored stories, to count
 * how often it still invents a name for an unnamed figure or splits a group (docs/decisions.md 2026-11-09
 * "Visual Bible: name or role"). PAID when run; the default is a DRY RUN that builds every prompt for real, counts
 * the stories and prices the run from the prompt size and the model's price in server/config/models.js.
 *
 *   node scripts/analysis/vb-name-or-role-writer-rerun.js                 # dry run: stories, tokens, price. No model call.
 *   node scripts/analysis/vb-name-or-role-writer-rerun.js --run --cap-usd 2 --limit 20 --out evals/runs/<dir>
 *
 * --run needs an explicit --cap-usd (the run stops when the spend reaches it, never slightly over: the check is
 * made before each call against the worst case for that call) and calls the same askArtDirector the pipeline uses.
 * Per story it stores the new bible and, for the BEFORE column, the bible already stored on the story. Counting is
 * structural: bible entries per species head, entries carrying `count`, names that equal their species head.
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { loadPromptTemplates } = require('../../server/services/prompts');
const PB = require('../../server/lib/promptBuilders');
const { MODEL_DEFAULTS, MODEL_PRICING: TEXT_MODEL_PRICING } = require('../../server/config/models');
const BRI = require('../../server/lib/beatsReplayInputs');

const arg = (n, d = null) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const RUN = process.argv.includes('--run');
const LIMIT = Number(arg('--limit', 20));
const CAP = Number(arg('--cap-usd', 0));
const OUT = path.resolve(arg('--out', 'evals/runs/2026-11-09_vb-name-or-role-writer'));
const CHARS_PER_TOKEN = 3.5;      // deliberately low: it over-counts tokens, so the estimate is an upper bound
const THINKING_TOKENS = 6000;     // medium-effort adaptive thinking allowance per call, an assumption stated in the report
const head = s => String(s || '').split(',')[0].trim().toLowerCase();

function priceOf(modelId) {
  const table = TEXT_MODEL_PRICING || {};
  const p = table[modelId];
  if (!p) throw new Error(`no price for ${modelId} in server/config/models.js`);
  return p;
}

// Two steps so no image-heavy row is dragged over the network: candidate ids first (cheap), then ONE story at a time
// with the image-bearing keys removed in SQL. The writer prompt needs none of them.
const DROP = ['sceneImages', 'coverImages', 'characterAvatars', 'referenceSheetBatches', 'generationLog', 'analytics', 'runMetrics', 'tokenUsage', 'styledAvatarGeneration', 'costumedAvatarGeneration'];
async function loadStories(limit) {
  const seen = new Set(); const out = [];
  for (const [label, url] of [['prod', process.env.DATABASE_URL], ['staging', process.env.STAGING_DATABASE_URL]]) {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const { rows } = await pool.query(`select id from stories
      where data->'arcReviewReport'->>'finalArc' is not null and data->'sceneDescriptions' is not null
        and jsonb_typeof(data->'visualBible'->'animals')='array' and coalesce(data->>'trialMode','false') <> 'true'
        and (jsonb_array_length(data->'visualBible'->'animals') + jsonb_array_length(coalesce(data->'visualBible'->'secondaryCharacters','[]'::jsonb))) >= 1
      order by created_at desc limit 400`);
    for (const r of rows) {
      if (seen.has(r.id) || out.length >= limit) continue;
      seen.add(r.id);
      const strip = DROP.map(k => `- '${k}'`).join(' ');
      const { rows: [row] } = await pool.query(`select data ${strip} as data from stories where id=$1`, [r.id]);
      out.push({ env: label, id: r.id, data: row.data });
    }
    await pool.end();
  }
  return out;
}

function promptFor(data) {
  const inputData = BRI.resolveReplayInputData(data);
  const beats = data.sceneDescriptions.map((s, i) => ({ pageNumber: i + 1, planLine: s.outlineExtract }));
  return PB.buildVisualBibleCallPrompt(inputData, beats, { maxCharactersPerScene: 3, finalArc: data.arcReviewReport.finalArc });
}

// BEFORE/AFTER structure of one bible: how many animals share one species head (a split group), how many carry `count`.
function shape(vb) {
  const figs = [...(vb?.animals || []), ...(vb?.secondaryCharacters || [])];
  const byHead = {};
  for (const a of vb?.animals || []) byHead[head(a.species)] = (byHead[head(a.species)] || 0) + 1;
  return {
    figures: figs.length,
    splitGroups: Object.values(byHead).filter(n => n >= 2).length,
    counted: figs.filter(f => Number(f.count) >= 2).length,
    nameEqualsSpecies: (vb?.animals || []).filter(a => a.name && head(a.species) && a.name.toLowerCase() === head(a.species)).length,
  };
}

async function main() {
  await loadPromptTemplates();
  const stories = await loadStories(LIMIT);
  const price = priceOf(MODEL_DEFAULTS.visualBibleModel);
  const rows = [];
  for (const s of stories) {
    const prompt = promptFor(s.data);
    if (!prompt) throw new Error(`no prompt for ${s.id}`);
    const inTok = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    const storedOutChars = JSON.stringify(s.data.visualBible || {}).length;
    const outTok = Math.ceil(storedOutChars / CHARS_PER_TOKEN);
    const over = inTok > (price.overTokens?.threshold || Infinity);
    const p = over ? price.overTokens : price;
    const usd = (inTok * p.input + outTok * p.output + THINKING_TOKENS * p.thinking) / 1e6;
    rows.push({ env: s.env, id: s.id, pages: s.data.sceneDescriptions.length, promptChars: prompt.length, inTok, outTok, usd, before: shape(s.data.visualBible) });
  }
  const total = rows.reduce((a, r) => a + r.usd, 0);
  const report = { mode: RUN ? 'run' : 'dry-run', model: MODEL_DEFAULTS.visualBibleModel, effort: MODEL_DEFAULTS.visualBibleEffort, stories: rows.length, estimate_usd: +total.toFixed(4), assumptions: { CHARS_PER_TOKEN, THINKING_TOKENS, output: 'length of the stored bible JSON', price }, rows };
  if (!RUN) { console.log(JSON.stringify({ ...report, rows: rows.map(r => ({ ...r, usd: +r.usd.toFixed(4) })) }, null, 2)); return; }
  if (!(CAP > 0)) throw new Error('--run needs --cap-usd > 0');
  fs.mkdirSync(OUT, { recursive: true });
  const { askArtDirector } = require('../../server/lib/artDirectorCall');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  let spent = 0; const results = [];
  for (const s of stories) {
    const r = rows.find(x => x.id === s.id);
    if (spent + r.usd > CAP) { console.log(`cap ${CAP} reached at ${spent.toFixed(4)}; stopping before ${s.id}`); break; }
    const res = await askArtDirector(promptFor(s.data), null, MODEL_DEFAULTS.visualBibleModel, { usageLabel: 'vb_name_or_role_rerun', effort: MODEL_DEFAULTS.visualBibleEffort });
    spent += r.usd; // the estimate is the worst case; the real usage is in res.usage and written below
    const vb = new UnifiedStoryParser(String(res.text || '')).extractVisualBible();
    fs.writeFileSync(path.join(OUT, `${s.id}.txt`), String(res.text || ''));
    results.push({ id: s.id, before: r.before, after: shape(vb), usage: res.usage || null });
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ ...report, spentEstimate: +spent.toFixed(4), results }, null, 2));
  console.log(JSON.stringify({ stories: results.length, spentEstimate: +spent.toFixed(4), results }, null, 2));
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
