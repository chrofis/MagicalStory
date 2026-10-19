/**
 * Trial planner (call A) Visual Bible coverage replay: the REAL builder (buildTrialArcPrompt) and the REAL call
 * (callTextModelStreaming, MODEL_DEFAULTS.trialArcModel at trialArcEffort) over stored trial inputs, then the real
 * parser (UnifiedStoryParser, isTrial) and the real reference-cell selector (getElementsNeedingReferenceImages).
 * Text only; call B (pages) is NOT run. Measures docs/decisions.md 2026-10-19 "Trial Visual Bible: no category caps".
 *
 *   node scripts/analysis/eval-trial-vb-coverage.js --phase=inputs               (list the input set)
 *   node scripts/analysis/eval-trial-vb-coverage.js --phase=dry                  (build every prompt, no model call)
 *   node scripts/analysis/eval-trial-vb-coverage.js --phase=run [--cap=0.8] [--conc=3] [--limit=N]
 *   node scripts/analysis/eval-trial-vb-coverage.js --phase=report               (summary over evals/runs/2026-10-19_trial-vb-coverage)
 * Inputs: the stored v4 inputs (real inputData), 17 staging trials (inputs.stg.json, from stories.data) and 15 prod
 * trials (inputs.prod.json, reconstructed from the stored story: idea, language, main character; artStyle not stored).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'dry';
const CAP = Number(arg('cap') || 0.8);
const CONC = Number(arg('conc') || 3);
const OUT = path.join(ROOT, 'evals/runs/2026-10-19_trial-vb-coverage');
const V4 = path.join(ROOT, 'evals/runs/2026-10-10_trial-flash-arc-vb-v4');
const dirs = [
  'evals/runs/2026-10-09_trial-writer-effort', 'evals/runs/2026-10-10_trial-split-writer-v2',
  'evals/runs/2026-10-10_trial-flash-arc-vb-v2-fresh', 'evals/runs/2026-10-10_trial-pages-openings-stored',
].map(d => path.join(ROOT, d));
const V4_IDS = fs.existsSync(V4) ? fs.readdirSync(V4).filter(f => f.startsWith('job_')) : [];
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const v4Input = id => { for (const d of dirs) { const f = path.join(d, id, 'inputData.json'); if (fs.existsSync(f)) return readJson(f); } return null; };

function loadSet() {
  const set = {};
  for (const id of V4_IDS) {
    const inputData = v4Input(id); if (!inputData) continue;
    const m = readJson(path.join(V4, id, 'run-metrics.json'), {});
    set[id] = { src: 'v4', inputData, baselineA: fs.readFileSync(path.join(V4, id, 'output-A.txt'), 'utf8'), baselineMs: m.aTotalMs, baselineOut: m.aOut };
  }
  for (const [id, o] of Object.entries(readJson(path.join(OUT, 'inputs.stg.json'), {}))) if (!set[id]) set[id] = { src: 'stg', inputData: o.inputData };
  for (const [id, o] of Object.entries(readJson(path.join(OUT, 'inputs.prod.json'), {}))) if (!set[id]) set[id] = { src: 'prod', inputData: o.inputData, baselineA: o.baselineA || null };
  return set;
}

function parseArc(text) {
  const m = text.match(/---STORY ARC---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i); if (!m) return [];
  return m[1].split(/\r?\n/).map(l => l.match(/^\s*PAGE\s+(\d+)\s*:\s*(.*?)\|\s*WITH\s*:\s*(.*?)(?:\|\s*STATE\s*:\s*(.*))?$/i)).filter(Boolean)
    .map(x => ({ n: Number(x[1]), with: x[3].split(';').map(w => w.trim()).filter(Boolean) }));
}

/** the real parser + the real cell selector; entries by category, and which would get a reference cell */
function analyse(text, inputData) {
  const { UnifiedStoryParser } = require(path.join(ROOT, 'server/lib/outlineParser'));
  const { getElementsNeedingReferenceImages } = require(path.join(ROOT, 'server/lib/visualBible'));
  const p = new UnifiedStoryParser(text, { isTrial: true });
  let vb = null, err = null;
  try { vb = p.extractVisualBible(); } catch (e) { err = e.message; }
  if (!vb) return { err: err || 'no vb' };
  const ent = c => (vb[c] || []).map(e => ({ id: e.id, name: e.name, label: e.label, properName: e.properName, pages: e.pages || e.appearsInPages || [] }));
  const cats = { sec: ent('secondaryCharacters'), ani: ent('animals'), art: ent('artifacts'), veh: ent('vehicles'), loc: ent('locations') };
  const cells = getElementsNeedingReferenceImages(vb, 2, 1, 1);
  const main = (inputData.characters || []).map(c => String(c.name || '').toLowerCase());
  const arc = parseArc(text);
  const norm = w => String(w).toLowerCase().replace(/[^a-z0-9äöüéèàß ]/g, ' ').split(/\s+/).filter(x => x.length > 2);
  const entTxt = Object.values(cats).flat().map(e => new Set(norm([e.name, e.label, e.properName].filter(Boolean).join(' '))));
  const withItems = [...new Set(arc.flatMap(a => a.with))].filter(w => !main.some(m => m && w.toLowerCase().includes(m)));
  const uncovered = withItems.filter(w => !entTxt.some(set => norm(w).some(t => set.has(t))));
  return {
    counts: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, v.length])), cats,
    cellCount: cells.length, cellIds: cells.map(c => c.id), trimmed: Math.max(0, cells.length - 6), withItems, uncovered,
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const set = loadSet();
  const ids = Object.keys(set);
  if (phase === 'inputs') {
    for (const id of ids) console.log(id, set[id].src, set[id].inputData.language, set[id].inputData.pages, (set[id].inputData.storyDetails || '').slice(0, 80));
    console.log(ids.length, 'inputs'); return;
  }
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { buildTrialArcPrompt } = require(path.join(ROOT, 'server/lib/promptBuilders'));
  if (phase === 'dry') {
    for (const id of ids) {
      const pr = buildTrialArcPrompt(set[id].inputData, set[id].inputData.pages);
      if (/\{[A-Z_]{4,}\}/.test(pr)) console.log(id, 'UNFILLED', pr.match(/\{[A-Z_]{4,}\}/g));
    }
    console.log('dry ok', ids.length, 'prompts built'); return;
  }
  if (phase === 'vehicles') {
    // SYNTHETIC probe (labelled as such in the results): does the planner use `vehicles` when the idea is about one?
    // The idea sentences are written here, not stored; the rest of each input is a stored trial input.
    const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
    const { MODEL_DEFAULTS, priceUsage } = require(path.join(ROOT, 'server/config/models'));
    const ideas = [
      'sails a small rowing boat across the pond to bring a lantern to the lighthouse keeper, but the boat springs a leak halfway',
      'drives a red wooden toy train around the living room to deliver a letter, but the track has a gap',
      'flies a homemade cardboard rocket to the moon to return a lost star, and the rocket loses a fin on the way',
      'rides a horse-drawn sleigh through the snow to bring bread to the village, but the sleigh gets stuck in a drift',
      'pedals a three-wheeled cart down the hill to rescue a runaway pumpkin, but the brakes squeal',
      'steers a hot-air balloon over the valley to find a lost kite, but the balloon sinks toward the lake',
    ];
    const bases = ids.filter(id => set[id].src === 'v4').slice(0, ideas.length);
    const out = path.join(OUT, 'vehicle-probe'); fs.mkdirSync(out, { recursive: true });
    const ledger = path.join(OUT, 'ledger.jsonl');
    await Promise.all(bases.map(async (id, i) => {
      const inputData = { ...set[id].inputData, storyDetails: `${(set[id].inputData.characters.find(c => c.role === 'main') || set[id].inputData.characters[0]).name} ${ideas[i]}.`, language: 'en' };
      const prompt = buildTrialArcPrompt(inputData, inputData.pages);
      const r = await callTextModelStreaming(prompt, null, () => {}, MODEL_DEFAULTS.trialArcModel, { usageLabel: 'unified_story', reasoning: { effort: MODEL_DEFAULTS.trialArcEffort } });
      const cost = priceUsage(r.modelId, r.usage || {}); fs.appendFileSync(ledger, JSON.stringify({ id: 'probe-' + i, cost }) + String.fromCharCode(10));
      const text = String(r.text || '').trim(); fs.writeFileSync(path.join(out, `probe-${i}.txt`), text);
      const a = analyse(text, inputData);
      console.log(`probe-${i}`, ideas[i].slice(0, 40), JSON.stringify(a.counts), 'veh:', JSON.stringify((a.cats?.veh || []).map(e => e.id + ' ' + (e.label || e.name))), 'cells', a.cellCount, 'uncovered', JSON.stringify(a.uncovered));
    }));
    return;
  }
  if (phase === 'run') {
    const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
    const { MODEL_DEFAULTS, priceUsage } = require(path.join(ROOT, 'server/config/models'));
    const ledger = path.join(OUT, 'ledger.jsonl');
    const spend = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).reduce((n, l) => n + JSON.parse(l).cost, 0) : 0);
    const todo = ids.filter(id => !fs.existsSync(path.join(OUT, id, 'metrics.json'))).slice(0, Number(arg('limit') || 999));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const id = todo[next++];
        if (spend() + 0.03 > CAP) { console.log('STOP: cap reached', spend().toFixed(3)); return; }
        try {
          const inputData = set[id].inputData; const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
          const prompt = buildTrialArcPrompt(inputData, inputData.pages);
          const t0 = Date.now();
          const r = await callTextModelStreaming(prompt, null, () => {}, MODEL_DEFAULTS.trialArcModel, { usageLabel: 'unified_story', reasoning: { effort: MODEL_DEFAULTS.trialArcEffort } });
          const ms = Date.now() - t0;
          const cost = priceUsage(r.modelId, r.usage || {});
          fs.appendFileSync(ledger, JSON.stringify({ id, cost }) + '\n');
          const text = String(r.text || '').trim();
          fs.writeFileSync(path.join(dir, 'prompt-A.txt'), prompt); fs.writeFileSync(path.join(dir, 'output-A.txt'), text);
          const m = { id, src: set[id].src, modelId: r.modelId, ms, cost, outTokens: r.usage?.output_tokens, truncated: !!r.truncation?.suspected, ...analyse(text, inputData) };
          fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(m, null, 2));
          console.log(id, `${(ms / 1000).toFixed(1)}s $${cost.toFixed(4)} counts=${JSON.stringify(m.counts)} cells=${m.cellCount} uncovered=${(m.uncovered || []).length} spend=$${spend().toFixed(3)}`);
        } catch (e) { console.log(id, 'ERROR', String(e.message || e).slice(0, 300)); }
      }
    };
    await Promise.all(Array.from({ length: CONC }, worker));
    console.log('DONE spend', spend().toFixed(3)); return;
  }
  if (phase === 'report') {
    const rows = ids.filter(id => fs.existsSync(path.join(OUT, id, 'metrics.json'))).map(id => ({
      ...readJson(path.join(OUT, id, 'metrics.json')), base: set[id].baselineA ? analyse(set[id].baselineA, set[id].inputData) : null,
      baselineMs: set[id].baselineMs, baselineOut: set[id].baselineOut,
    }));
    const sum = a => a.reduce((x, y) => x + y, 0);
    const mean = a => (a.length ? Math.round(sum(a) / a.length) : null);
    const hist = (a) => a.reduce((d, v) => { d[v] = (d[v] || 0) + 1; return d; }, {});
    const withBase = rows.filter(r => r.base && !r.base.err);
    const withMs = withBase.filter(r => r.baselineMs);
    console.log(JSON.stringify({
      n: rows.length, newUncoveredStories: rows.filter(r => (r.uncovered || []).length).length,
      vehicleStories: rows.filter(r => r.counts?.veh > 0).length, cellDist: hist(rows.map(r => r.cellCount)), wouldTrim: rows.filter(r => r.trimmed > 0).length,
      artifactsDist: hist(rows.map(r => r.counts?.art)), secDist: hist(rows.map(r => r.counts?.sec)),
      nBase: withBase.length, baseUncoveredStories: withBase.filter(r => r.base.uncovered.length).length,
      newUncoveredOnBaseSet: withBase.filter(r => (r.uncovered || []).length).length,
      baseArtifactsDist: hist(withBase.map(r => r.base.counts?.art)),
      latency: { newMsMean: mean(rows.map(r => r.ms)), newMsMeanOnBaseSet: mean(withMs.map(r => r.ms)), baseMsMean: mean(withMs.map(r => r.baselineMs)), newOutTokMean: mean(rows.map(r => r.outTokens || 0)), newOutTokOnBaseSet: mean(withMs.map(r => r.outTokens || 0)), baseOutTokMean: mean(withMs.map(r => r.baselineOut || 0)) },
      spend: sum(rows.map(r => r.cost)),
    }, null, 1));
    for (const r of rows) console.log(r.id, r.src, JSON.stringify(r.counts), 'cells', r.cellCount, 'uncov new:', JSON.stringify(r.uncovered), r.base ? 'BASE uncov: ' + JSON.stringify(r.base.uncovered) + ' baseArt ' + r.base.counts?.art : '');
  }
})().then(() => process.exit(0)).catch(e => { console.error('ERR', e); process.exit(1); });
