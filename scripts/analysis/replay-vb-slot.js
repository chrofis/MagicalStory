#!/usr/bin/env node
/**
 * Rung 2 replay of the Visual Bible producer's typed `slot` field (docs/decisions.md,
 * 2026-10-09 "typed slot"). For each STORED staging story the REAL builder
 * (promptBuilders.buildVisualBibleCallPrompt, fed through beatsReplayInputs) makes the
 * Visual Bible prompt, the production model (MODEL_DEFAULTS.visualBibleModel at its
 * effort) answers it, the production parser reads the reply, and this prints every
 * worn-candidate entry (clothing, artifacts, vehicles) with its `slot` for hand labelling,
 * plus the automatic rates (valid enum, agreement with wornAs, clothing-pool coverage).
 *
 * Paid. Hard cap over one ledger (evals/runs/<run>/ledger.jsonl): a call that would start
 * with less than --reserve left is refused.
 *
 *   node scripts/analysis/replay-vb-slot.js --n 24 --cap 0.45 [--stride 3] [--offset 0] [--dry]
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
const spent = () => (fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost || 0), 0) : 0);

async function main() {
  const a = args();
  const n = parseInt(a.n || '24', 10);
  const stride = parseInt(a.stride || '1', 10);
  const offset = parseInt(a.offset || '0', 10);
  const cap = parseFloat(a.cap || '0.45');
  const reserve = parseFloat(a.reserve || '0.03');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { loadStory, rebuildBriefBeats } = require('./ad-stage-model-replay');
  const PB = require('../../server/lib/promptBuilders');
  const { resolveReplayInputData, buildReplaySceneOptions } = require('../../server/lib/beatsReplayInputs');
  const { buildAvailableAvatarsForPrompt } = require('../../server/lib/clothingResolve');
  const { MODEL_DEFAULTS, TEXT_MODELS, priceUsage } = require('../../server/config/models');
  const textModels = require('../../server/lib/textModels');
  const { extractBibleSections, AD_BIBLE_MARKERS } = require('../../server/lib/beatsPipeline');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  const { WORN_SLOTS, parseWornAs } = require('../../server/lib/wornItems');
  await require('../../server/services/prompts').loadPromptTemplates();

  const ids = (await pool.query(
    `select id from stories
      where data ? 'visualBible' and data ? 'sceneImages'
        and data->'sceneImages'->0->>'outlineExtract' like '%PLAN:%'
        and jsonb_array_length(coalesce(data->'visualBible'->'artifacts','[]'::jsonb)) + jsonb_array_length(coalesce(data->'visualBible'->'clothing','[]'::jsonb)) > 0
      order by id`)).rows.map(r => r.id);
  const picked = ids.filter((_, i) => i % stride === 0).slice(offset, offset + n);
  console.log(`candidates ${ids.length}, picked ${picked.length}`);
  fs.mkdirSync(RUN_DIR, { recursive: true });

  const model = MODEL_DEFAULTS.visualBibleModel;
  const tally = { stories: 0, parsed: 0, clothing: 0, clothingTyped: 0, workable: 0, slotInEnum: 0, withSlot: 0, wornAsLinked: 0, wornAsAgree: 0 };
  for (const id of picked) {
    const story = await loadStory(pool, id);
    const input = resolveReplayInputData(story);
    const beats = rebuildBriefBeats(story);
    const opts = buildReplaySceneOptions(story, { availableAvatars: buildAvailableAvatarsForPrompt(story.characters || [], story.clothingRequirements || null), maxCharactersPerScene: 3 });
    const prompt = PB.buildVisualBibleCallPrompt(input, beats, opts);
    if (a.dry) { console.log(id, 'prompt chars', prompt.length, 'has slot rule', /`slot`/.test(prompt)); continue; }
    const left = cap - spent();
    if (left < reserve) { console.log(`CAP: ${spent().toFixed(4)} of ${cap} spent - stopping before ${id}`); break; }
    const t0 = Date.now();
    const res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'beats_visual_bible', ...(MODEL_DEFAULTS.visualBibleEffort ? { effort: MODEL_DEFAULTS.visualBibleEffort } : {}) });
    const cost = res.usage?.direct_cost ?? priceUsage(res.modelId || TEXT_MODELS[model].modelId, res.usage || {});
    fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), story: id, label: 'vb-slot', model, cost, in: res.usage?.input_tokens, out: res.usage?.output_tokens, ms: Date.now() - t0 }) + '\n');
    tally.stories++;
    const sections = extractBibleSections(res.text || '', AD_BIBLE_MARKERS);
    const vb = sections ? new UnifiedStoryParser(sections.body).extractVisualBible() : null;
    if (!vb) { console.log(`${id}: VB did not parse`); continue; }
    tally.parsed++;
    const rows = [];
    for (const pool_ of ['clothing', 'artifacts', 'vehicles']) {
      for (const e of (Array.isArray(vb[pool_]) ? vb[pool_] : [])) {
        const link = parseWornAs(e.wornAs);
        rows.push({ story: id, pool: pool_, id: e.id, name: e.label || e.name, type: e.type || null, slot: e.slot ?? null, wornAs: e.wornAs || null });
        if (pool_ === 'clothing') { tally.clothing++; if (WORN_SLOTS.includes(e.slot)) tally.clothingTyped++; }
        if (e.slot != null) { tally.withSlot++; if (WORN_SLOTS.includes(e.slot)) tally.slotInEnum++; }
        if (link && link.slotKnown) { tally.wornAsLinked++; if (link.slot === e.slot) tally.wornAsAgree++; }
      }
    }
    fs.writeFileSync(path.join(RUN_DIR, `${id}__vb-slot.json`), JSON.stringify({ model, cost, prompt, reply: res.text, rows }, null, 1));
    console.log(`\n== ${id} cost ${cost.toFixed(4)}`);
    for (const r of rows) console.log(`${r.pool.padEnd(9)} ${String(r.id).padEnd(7)} slot=${String(r.slot).padEnd(11)} wornAs=${String(r.wornAs).padEnd(18)} type=${r.type} :: ${r.name}`);
  }
  console.log('\nTALLY', JSON.stringify(tally), `SPENT ${spent().toFixed(4)} of ${cap}`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
