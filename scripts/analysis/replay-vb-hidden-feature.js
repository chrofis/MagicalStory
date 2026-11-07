#!/usr/bin/env node
/**
 * Rung 2 replay of the "hidden-then-revealed feature is a state" rule (promptBuilders.HIDDEN_FEATURE_STATE_RULE,
 * docs/decisions.md 2026-11-07). Same method as replay-vb-object-placement.js: for each STORED story of
 * evals/datasets/vb-hidden-feature-2026-11-07.json the REAL builder (promptBuilders.buildVisualBibleCallPrompt, fed
 * through beatsReplayInputs) makes the Visual Bible prompt with the working-tree template, the PRODUCTION model answers
 * (MODEL_DEFAULTS.visualBibleModel) and the production parser reads the reply. Optional --old-ref adds a baseline arm
 * (template at that git ref). Per story it dumps every entry that carries states (id, label, state names, pages) next
 * to the dataset's expected answer, for HAND judgement: code never decides whether a state name or a delta is a hidden
 * feature. The only counts are structural (entries with states).
 *
 * Covers the full-story writer site (prompts/visual-bible.txt). The trial site (story-trial-arc.txt) sits inside the arc
 * call and is not replayed here.
 *
 *   node scripts/analysis/replay-vb-hidden-feature.js --estimate                 # price only, no model call
 *   node scripts/analysis/replay-vb-hidden-feature.js --dry                      # build the prompts, no call
 *   node scripts/analysis/replay-vb-hidden-feature.js --cap 1.0 [--old-ref <commit before the rule>] [--ids a,b]
 *
 * PAID (the model call). Hard cap over one ledger; a call that would start with less than --reserve left is refused;
 * no --cap means zero. Read-only on the database.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const DATASET = path.join(__dirname, '..', '..', 'evals', 'datasets', 'vb-hidden-feature-2026-11-07.json');
const RUN_DIR = path.join(__dirname, '..', '..', 'evals', 'runs', '2026-11-07_vb-hidden-feature-state');
const LEDGER = path.join(RUN_DIR, 'ledger.jsonl');

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  return a;
}
const spent = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost || 0), 0) : 0);

async function main() {
  const a = args();
  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  const wanted = a.ids ? String(a.ids).split(',') : dataset.stories.map(s => s.id);
  const expectedOf = Object.fromEntries(dataset.stories.map(s => [s.id, s]));
  const cap = parseFloat(a.cap || '0');
  const reserve = parseFloat(a.reserve || '0.05');
  const oldRef = a['old-ref'] || null;
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { MODEL_DEFAULTS, TEXT_MODELS, priceUsage } = require('../../server/config/models');
  const model = MODEL_DEFAULTS.visualBibleModel;

  if (a.estimate) {
    // The stored beats_visual_bible usage of each story, repriced on the model that would answer now.
    let total = 0;
    for (const id of wanted) {
      const r = await pool.query(`select data->'tokenUsage'->'byFunction'->'beats_visual_bible' u from stories where id = $1`, [id]);
      const u = r.rows[0] && r.rows[0].u;
      if (!u) { total += dataset.fallbackEstimateUsd; console.log(`${id} no stored beats_visual_bible usage -> $${dataset.fallbackEstimateUsd} (dataset fallbackEstimateUsd)`); continue; }
      const cost = priceUsage(TEXT_MODELS[model].modelId, { input_tokens: u.input_tokens, output_tokens: u.output_tokens });
      total += cost;
      console.log(`${id} in ${u.input_tokens} out ${u.output_tokens} -> $${cost.toFixed(4)} on ${model}`);
    }
    console.log(`ESTIMATE one arm, ${wanted.length} stories: $${total.toFixed(3)} (double with --old-ref)`);
    await pool.end();
    return;
  }

  const { loadStory, rebuildBriefBeats } = require('./ad-stage-model-replay');
  const PB = require('../../server/lib/promptBuilders');
  const { PROMPT_TEMPLATES, stripMaintainerComment } = require('../../server/services/prompts');
  const { resolveReplayInputData, buildReplaySceneOptions } = require('../../server/lib/beatsReplayInputs');
  const { buildAvailableAvatarsForPrompt } = require('../../server/lib/clothingResolve');
  const textModels = require('../../server/lib/textModels');
  const { extractBibleSections, AD_BIBLE_MARKERS } = require('../../server/lib/beatsPipeline');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  await require('../../server/services/prompts').loadPromptTemplates();
  const arms = [['new', PROMPT_TEMPLATES.visualBible]];
  if (oldRef) arms.unshift(['old', stripMaintainerComment(execSync(`git show ${oldRef}:prompts/visual-bible.txt`, { maxBuffer: 1 << 24 }).toString('utf8').replace(/\r\n/g, '\n'))]);
  fs.mkdirSync(RUN_DIR, { recursive: true });

  for (const id of wanted) {
    let input, beats, opts;
    try {
      const story = await loadStory(pool, id);
      input = resolveReplayInputData(story);
      beats = rebuildBriefBeats(story);
      opts = buildReplaySceneOptions(story, { availableAvatars: buildAvailableAvatarsForPrompt(story.characters || [], story.clothingRequirements || null), maxCharactersPerScene: 3 });
    } catch (e) {
      // A stored story whose inputs cannot be rebuilt is reported and left out of the rate, never patched around.
      console.log(`SKIPPED ${id}: cannot rebuild the stored inputs - ${e.message}`);
      continue;
    }
    for (const [arm, tpl] of arms) {
      const outFile = path.join(RUN_DIR, `${id}__${arm}.json`);
      if (fs.existsSync(outFile)) continue;
      PROMPT_TEMPLATES.visualBible = tpl;
      const prompt = PB.buildVisualBibleCallPrompt(input, beats, opts);
      if (a.dry) { console.log(id, arm, 'prompt chars', prompt.length, 'placeholder left', /\{HIDDEN_FEATURE_STATE\}/.test(prompt), 'rule in prompt', prompt.includes(PB.HIDDEN_FEATURE_STATE_RULE)); continue; }
      const left = cap - spent();
      if (left < reserve) { console.log(`CAP: ${spent().toFixed(4)} of ${cap} spent - stopping before ${id} ${arm}`); await pool.end(); return; }
      const t0 = Date.now();
      const res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'beats_visual_bible', ...(MODEL_DEFAULTS.visualBibleEffort ? { effort: MODEL_DEFAULTS.visualBibleEffort } : {}) });
      const cost = res.usage?.direct_cost ?? priceUsage(res.modelId || TEXT_MODELS[model].modelId, res.usage || {});
      fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), story: id, arm, model, cost, in: res.usage?.input_tokens, out: res.usage?.output_tokens, ms: Date.now() - t0 }) + '\n');
      const sections = extractBibleSections(res.text || '', AD_BIBLE_MARKERS);
      const vb = sections ? new UnifiedStoryParser(sections.body).extractVisualBible() : null;
      const withStates = vb ? ['secondaryCharacters', 'animals', 'artifacts', 'vehicles'].flatMap(p => (vb[p] || [])
        .filter(e => Array.isArray(e.states) && e.states.length > 0)
        .map(e => ({ pool: p, id: e.id, label: e.label || e.name, states: e.states.map(s => ({ name: s.name, delta: s.delta, pages: s.pages })) }))) : null;
      fs.writeFileSync(outFile, JSON.stringify({ story: id, arm, model, cost, expected: expectedOf[id] || null, entriesWithStates: withStates, prompt, reply: res.text }, null, 1));
      console.log(`${id} ${arm} cost $${cost.toFixed(4)} running $${spent().toFixed(4)} | expected hidden=${expectedOf[id] ? expectedOf[id].hiddenFeature : '?'} | entries with states: ${withStates ? withStates.length : 'PARSE FAIL'}`);
      for (const e of withStates || []) console.log(`    ${e.id} ${e.label}: ` + e.states.map(s => `${s.name}@${(s.pages || []).join(',')}`).join(' | '));
    }
  }
  console.log(`SPENT ${spent().toFixed(4)} of ${cap}`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
