#!/usr/bin/env node
/**
 * Rung 2 replay of the "object descriptions never name a support" rule (docs/decisions.md 2026-10-17).
 * For each STORED staging story the REAL builder (promptBuilders.buildVisualBibleCallPrompt, fed through
 * beatsReplayInputs) makes the Visual Bible prompt twice: with the template at --old-ref (git ref) and with the
 * working-tree template. The production model answers, the production parser reads the reply, and the artifact and
 * vehicle descriptions of both arms are dumped for HAND judgement (code never decides whether prose is a placement).
 *
 * Paid. Hard cap over one ledger; a call that would start with less than --reserve left is refused.
 *   node scripts/analysis/replay-vb-object-placement.js --ids a,b,c --cap 0.8 [--old-ref HEAD] [--dry]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const RUN_DIR = path.join(__dirname, '..', '..', 'evals', 'runs', '2026-10-17_vb-object-not-placed');
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
  const ids = String(a.ids || '').split(',').filter(Boolean);
  const cap = parseFloat(a.cap || '0.8');
  const reserve = parseFloat(a.reserve || '0.05');
  const oldRef = a['old-ref'] || 'HEAD';
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { loadStory, rebuildBriefBeats } = require('./ad-stage-model-replay');
  const PB = require('../../server/lib/promptBuilders');
  const { PROMPT_TEMPLATES, stripMaintainerComment } = require('../../server/services/prompts');
  const { resolveReplayInputData, buildReplaySceneOptions } = require('../../server/lib/beatsReplayInputs');
  const { buildAvailableAvatarsForPrompt } = require('../../server/lib/clothingResolve');
  const { MODEL_DEFAULTS, TEXT_MODELS, priceUsage } = require('../../server/config/models');
  const textModels = require('../../server/lib/textModels');
  const { extractBibleSections, AD_BIBLE_MARKERS } = require('../../server/lib/beatsPipeline');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  await require('../../server/services/prompts').loadPromptTemplates();
  const newTemplate = PROMPT_TEMPLATES.visualBible;
  const oldTemplate = stripMaintainerComment(execSync(`git show ${oldRef}:prompts/visual-bible.txt`, { maxBuffer: 1 << 24 }).toString('utf8').replace(/\r\n/g, '\n'));
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const model = MODEL_DEFAULTS.visualBibleModel;

  for (const id of ids) {
    const story = await loadStory(pool, id);
    const input = resolveReplayInputData(story);
    const beats = rebuildBriefBeats(story);
    const opts = buildReplaySceneOptions(story, { availableAvatars: buildAvailableAvatarsForPrompt(story.characters || [], story.clothingRequirements || null), maxCharactersPerScene: 3 });
    for (const [arm, tpl] of [['old', oldTemplate], ['new', newTemplate]]) {
      const outFile = path.join(RUN_DIR, `${id}__${arm}.json`);
      if (fs.existsSync(outFile)) continue;
      PROMPT_TEMPLATES.visualBible = tpl;
      const prompt = PB.buildVisualBibleCallPrompt(input, beats, opts);
      if (a.dry) { console.log(id, arm, 'prompt chars', prompt.length, 'placeholder left', /\{OBJECT_NOT_PLACED\}/.test(prompt)); continue; }
      const left = cap - spent();
      if (left < reserve) { console.log(`CAP: ${spent().toFixed(4)} of ${cap} spent - stopping before ${id} ${arm}`); await pool.end(); return; }
      const t0 = Date.now();
      const res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'beats_visual_bible', ...(MODEL_DEFAULTS.visualBibleEffort ? { effort: MODEL_DEFAULTS.visualBibleEffort } : {}) });
      const cost = res.usage?.direct_cost ?? priceUsage(res.modelId || TEXT_MODELS[model].modelId, res.usage || {});
      fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), story: id, arm, model, cost, in: res.usage?.input_tokens, out: res.usage?.output_tokens, ms: Date.now() - t0 }) + '\n');
      const sections = extractBibleSections(res.text || '', AD_BIBLE_MARKERS);
      const vb = sections ? new UnifiedStoryParser(sections.body).extractVisualBible() : null;
      const rows = vb ? ['artifacts', 'vehicles'].flatMap(p => (vb[p] || []).map(e => ({ pool: p, id: e.id, name: e.label || e.name, description: e.description || '' }))) : null;
      fs.writeFileSync(outFile, JSON.stringify({ story: id, arm, model, cost, prompt, reply: res.text, rows }, null, 1));
      console.log(`${id} ${arm} cost $${cost.toFixed(4)} running $${spent().toFixed(4)} rows ${rows ? rows.length : 'PARSE FAIL'}`);
    }
  }
  console.log(`SPENT ${spent().toFixed(4)} of ${cap}`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
