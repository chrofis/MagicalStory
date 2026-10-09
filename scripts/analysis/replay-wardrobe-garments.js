#!/usr/bin/env node
/**
 * Rung 2 replay of the wardrobe producer's typed `garments` list (docs/decisions.md,
 * 2026-10-09 "typed garment colour"). For each STORED staging story the REAL builder
 * (promptBuilders.buildStoryBibleFromBeatsPrompt, fed through beatsReplayInputs) makes the
 * wardrobe prompt, the production model (MODEL_DEFAULTS.outline at beatsPlanEffort)
 * answers it, the production parser reads the reply (UnifiedStoryParser, which validates the
 * list), and this prints every used outfit with its description and typed rows for hand
 * labelling, plus the automatic rates (outfits with a list, rows kept by the validator).
 *
 * Paid. Hard cap over one ledger (evals/runs/<run>/ledger.jsonl).
 *
 *   node scripts/analysis/replay-wardrobe-garments.js --n 20 --cap 0.40 [--stride 2] [--offset 0] [--dry]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const RUN_DIR = path.join(__dirname, '..', '..', 'evals', 'runs', '2026-10-09_vb-slot-colour-replay');
const LEDGER = path.join(RUN_DIR, 'ledger.jsonl');

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  return a;
}
const spentOn = (label) => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.label === label).reduce((s, r) => s + (r.cost || 0), 0) : 0);

async function main() {
  const a = args();
  const n = parseInt(a.n || '20', 10);
  const stride = parseInt(a.stride || '2', 10);
  const offset = parseInt(a.offset || '0', 10);
  const cap = parseFloat(a.cap || '0.40');
  const reserve = parseFloat(a.reserve || '0.06');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { loadStory, rebuildBriefBeats } = require('./ad-stage-model-replay');
  const PB = require('../../server/lib/promptBuilders');
  const { resolveReplayInputData, resolveReplayArc } = require('../../server/lib/beatsReplayInputs');
  const { parseBeats } = require('../../server/lib/storyHelpers');
  const { MODEL_DEFAULTS, TEXT_MODELS, priceUsage } = require('../../server/config/models');
  const textModels = require('../../server/lib/textModels');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  await require('../../server/services/prompts').loadPromptTemplates();

  const ids = (await pool.query(
    `select id from stories
      where data ? 'visualBible' and data ? 'sceneImages' and data ? 'clothingRequirements'
        and data->'sceneImages'->0->>'outlineExtract' like '%PLAN:%'
        and jsonb_array_length(coalesce(data->'visualBible'->'artifacts','[]'::jsonb)) + jsonb_array_length(coalesce(data->'visualBible'->'clothing','[]'::jsonb)) > 0
      order by id`)).rows.map(r => r.id);
  const picked = ids.filter((_, i) => i % stride === 0).slice(offset, offset + n);
  console.log(`candidates ${ids.length}, picked ${picked.length}`);
  fs.mkdirSync(RUN_DIR, { recursive: true });

  const model = MODEL_DEFAULTS.outline;
  const tally = { stories: 0, parsed: 0, outfits: 0, outfitsWithList: 0, rows: 0, rowsWithColour: 0 };
  for (const id of picked) {
    const story = await loadStory(pool, id);
    const input = resolveReplayInputData(story);
    const beats = rebuildBriefBeats(story).filter(b => Number(b.pageNumber) > 0);
    const prompt = PB.buildStoryBibleFromBeatsPrompt(input, beats, { arc: resolveReplayArc(story, { parseBeats }) });
    if (a.dry) { console.log(id, 'prompt chars', prompt.length, 'has list rule', /`garments`/.test(prompt)); continue; }
    if (cap - spentOn('wardrobe-garments') < reserve) { console.log(`CAP: ${spentOn('wardrobe-garments').toFixed(4)} of ${cap} spent - stopping before ${id}`); break; }
    const t0 = Date.now();
    const res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'beats_story_bible', effort: MODEL_DEFAULTS.beatsPlanEffort });
    const cost = res.usage?.direct_cost ?? priceUsage(res.modelId || TEXT_MODELS[model].modelId, res.usage || {});
    fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), story: id, label: 'wardrobe-garments', model, cost, in: res.usage?.input_tokens, out: res.usage?.output_tokens, ms: Date.now() - t0 }) + '\n');
    tally.stories++;
    const reqs = new UnifiedStoryParser(String(res.text || '')).extractClothingRequirements();
    if (!reqs) { console.log(`${id}: no clothing requirements parsed`); continue; }
    tally.parsed++;
    const out = [];
    for (const [who, cats] of Object.entries(reqs)) {
      for (const [cat, e] of Object.entries(cats || {})) {
        if (!e || !e.used || !e.description) continue;
        tally.outfits++;
        const g = Array.isArray(e.garments) ? e.garments : null;
        if (g) { tally.outfitsWithList++; tally.rows += g.length; tally.rowsWithColour += g.filter(x => x.colour).length; }
        out.push({ who, cat, description: e.description, garments: g });
      }
    }
    fs.writeFileSync(path.join(RUN_DIR, `${id}__wardrobe.json`), JSON.stringify({ model, cost, prompt, reply: res.text, outfits: out }, null, 1));
    console.log(`\n== ${id} cost ${cost.toFixed(4)}`);
    for (const o of out) {
      console.log(`-- ${o.who}/${o.cat}: ${o.description}`);
      console.log(`   ${o.garments ? o.garments.map(x => `${x.colour || '-'} ${x.name} [${x.slot}]`).join(' | ') : 'NO LIST'}`);
    }
  }
  console.log('\nTALLY', JSON.stringify(tally), `SPENT(wardrobe) ${spentOn('wardrobe-garments').toFixed(4)} of ${cap}`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
