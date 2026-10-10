#!/usr/bin/env node
'use strict';

/**
 * Measure the avatar sheet defect judge (server/lib/avatarSheetJudge.js) against the hand-labelled sheets in
 * evals/datasets/avatar-sheet-defects-v1.json. Replays STORED sheets only: no image is generated.
 *
 *   node scripts/analysis/eval-avatar-sheet-judge.js run   --images-dir <dir> --run-id <id> [--model gemini-2.5-flash] [--cap-usd 0.30] [--only a,b]
 *   node scripts/analysis/eval-avatar-sheet-judge.js score --run-id <id> [--append] [--notes "..."]
 *
 * `run` writes raw judge answers + usage + latency to evals/runs/<run-id>/raw/<sheet>.json (re-inspectable).
 * `score` computes per-type precision/recall, split BY CHARACTER into a tuning fold and a held-out fold:
 * the per-type signal choice (verdict word / per-cell enum comparison / either) is picked on the tuning fold only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const ROOT = path.join(__dirname, '../..');
const DATASET = path.join(ROOT, 'evals/datasets/avatar-sheet-defects-v1.json');
const FLASH = { 'gemini-2.5-flash': { input: 0.30, output: 2.50 }, 'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 } };
const arg = (n, d = null) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };

const dataset = () => JSON.parse(fs.readFileSync(DATASET, 'utf8'));
const runDir = (id) => path.join(ROOT, 'evals/runs', id);
const dataUri = (f) => `data:image/jpeg;base64,${fs.readFileSync(f).toString('base64')}`;
const foldOf = (character) => (crypto.createHash('md5').update(character).digest()[0] % 2 === 0 ? 'tune' : 'test');

async function run() {
  await require('../../server/services/prompts').loadPromptTemplates();
  const { judgeAvatarSheet } = require('../../server/lib/avatarSheetJudge');
  const dir = arg('images-dir'); const runId = arg('run-id'); const model = arg('model', 'gemini-2.5-flash');
  const cap = Number(arg('cap-usd', 0.30)); const only = arg('only') ? String(arg('only')).split(',') : null;
  const prices = FLASH[model]; if (!prices) throw new Error(`no price for ${model}`);
  const raw = path.join(runDir(runId), 'raw'); fs.mkdirSync(raw, { recursive: true });
  const todo = dataset().entries.filter(e => !e.ambiguous && (!only || only.includes(e.id)) && !fs.existsSync(path.join(raw, e.id + '.json')));
  let spent = 0;
  const priorFiles = fs.readdirSync(raw).map(f => JSON.parse(fs.readFileSync(path.join(raw, f), 'utf8')));
  for (const p of priorFiles) spent += p.costUsd || 0;
  console.log(`run ${runId} model ${model}: ${todo.length} sheets to judge, spent so far USD ${spent.toFixed(4)}, cap USD ${cap}`);
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const e = todo[i++];
      if (spent >= cap) { console.log('CAP REACHED - stopping'); return; }
      const usage = [];
      const t0 = Date.now();
      let rec;
      try {
        const r = await judgeAvatarSheet({
          sheet: dataUri(path.join(dir, e.file)), photo: e.photoFile ? dataUri(path.join(dir, e.photoFile)) : null,
          kind: e.kind, model, usageTracker: (_k, u) => usage.push(u),
        });
        rec = { id: e.id, ok: true, raw: r.raw };
      } catch (err) { rec = { id: e.id, ok: false, error: String(err.message).slice(0, 500) }; }
      const inTok = usage.reduce((s, u) => s + (u.input_tokens || 0), 0);
      const outTok = usage.reduce((s, u) => s + (u.output_tokens || 0) + (u.thinking_tokens || 0), 0);
      rec.latencyMs = Date.now() - t0; rec.inTokens = inTok; rec.outTokens = outTok;
      rec.costUsd = (inTok * prices.input + outTok * prices.output) / 1e6; rec.model = model;
      spent += rec.costUsd;
      fs.writeFileSync(path.join(raw, e.id + '.json'), JSON.stringify(rec));
      console.log(`${rec.ok ? 'ok ' : 'ERR'} ${e.id} ${rec.latencyMs}ms $${rec.costUsd.toFixed(4)} total $${spent.toFixed(4)}${rec.ok ? '' : ' ' + rec.error}`);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log(`done. spent USD ${spent.toFixed(4)}`);
}

const MODES = ['verdict', 'consistency', 'cells', 'either', 'eitherConsistency'];
const LABELLED = ['hat', 'hair', 'bald', 'costume', 'rowMatch', 'held', 'layout']; // identity/age were not labelled against the photo: reported, never counted in ANY
function prf(rows, type) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) { const truth = r.truth.includes(type); const pred = r.pred.has(type); if (truth && pred) tp++; else if (!truth && pred) fp++; else if (truth) fn++; else tn++; }
  return { tp, fp, fn, tn, positives: tp + fn, recall: tp + fn ? tp / (tp + fn) : null, precision: tp + fp ? tp / (tp + fp) : null };
}

function score() {
  const { parseAvatarSheetVerdict, defectsOf, DEFECT_TYPES } = require('../../server/lib/avatarSheetJudge');
  const runId = arg('run-id'); const raw = path.join(runDir(runId), 'raw');
  const ds = dataset();
  const rows = []; const failed = [];
  for (const e of ds.entries) {
    if (e.ambiguous) continue;
    const f = path.join(raw, e.id + '.json'); if (!fs.existsSync(f)) continue;
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!rec.ok) { failed.push({ id: e.id, error: rec.error }); continue; }
    let parsed; try { parsed = parseAvatarSheetVerdict(rec.raw); } catch (err) { failed.push({ id: e.id, error: err.message }); continue; }
    rows.push({ e, rec, parsed, truth: e.defects, fold: foldOf(e.character) });
  }
  const evalWith = (subset, use) => subset.map(r => ({ ...r, pred: new Set(defectsOf(r.parsed, use)) }));
  const tune = rows.filter(r => r.fold === 'tune'); const test = rows.filter(r => r.fold === 'test');
  // pick each type's signal on the tuning fold: max recall, then fewest false alarms, then the plain verdict word
  const chosen = {};
  for (const t of DEFECT_TYPES) {
    let best = null;
    for (const m of MODES) {
      const m1 = prf(evalWith(tune, { [t]: m }), t);
      const key = [m1.recall ?? 1, -m1.fp, m === 'verdict' ? 1 : 0];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] > best.key[2])))) best = { mode: m, key };
    }
    chosen[t] = best.mode;
  }
  const table = (subset, use) => { const ev = evalWith(subset, use); const out = {}; for (const t of DEFECT_TYPES) out[t] = prf(ev, t); const any = (r) => r.truth.some(x => LABELLED.includes(x)), anyP = (r) => [...r.pred].some(x => LABELLED.includes(x)); let tp = 0, fp = 0, fn = 0, tn = 0; for (const r of ev) { if (any(r) && anyP(r)) tp++; else if (!any(r) && anyP(r)) fp++; else if (any(r)) fn++; else tn++; } out.ANY = { tp, fp, fn, tn, positives: tp + fn, recall: tp + fn ? tp / (tp + fn) : null, precision: tp + fp ? tp / (tp + fp) : null }; return out; };
  const allModes = { verdict: {}, either: Object.fromEntries(DEFECT_TYPES.map(t => [t, 'either'])), consistency: Object.fromEntries(DEFECT_TYPES.map(t => [t, 'consistency'])), chosen };
  const result = { runId, sheets: rows.length, failed, chosen, tuneChars: [...new Set(tune.map(r => r.e.character))].length, testChars: [...new Set(test.map(r => r.e.character))].length, tables: {} };
  for (const [name, use] of Object.entries(allModes)) result.tables[name] = { all: table(rows, use), tune: table(tune, use), test: table(test, use) };
  const lat = rows.map(r => r.rec.latencyMs).sort((a, b) => a - b);
  result.latencyMs = { p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)], mean: Math.round(lat.reduce((s, x) => s + x, 0) / lat.length) };
  result.costPerSheetUsd = rows.reduce((s, r) => s + r.rec.costUsd, 0) / rows.length;
  result.totalCostUsd = rows.reduce((s, r) => s + r.rec.costUsd, 0);
  result.misses = rows.flatMap(r => { const pred = new Set(defectsOf(r.parsed, chosen)); return r.truth.filter(t => !pred.has(t)).map(t => ({ id: r.e.id, type: t, fold: r.fold })); });
  result.falseAlarms = rows.flatMap(r => { const pred = defectsOf(r.parsed, chosen); return pred.filter(t => !r.truth.includes(t)).map(t => ({ id: r.e.id, type: t, fold: r.fold, evidence: r.parsed.evidence.slice(0, 120) })); });
  const fmt = (n) => (n == null ? '  -  ' : (n * 100).toFixed(0).padStart(4) + '%');
  for (const [name, t] of Object.entries(result.tables)) {
    console.log(`\n== signal set: ${name} (chosen on tune fold: ${JSON.stringify(chosen)}) ==`);
    for (const [fold, tb] of Object.entries(t)) {
      console.log(`  [${fold}]  type       pos  recall  precision   tp fp fn tn`);
      for (const [ty, m] of Object.entries(tb)) console.log(`          ${ty.padEnd(9)} ${String(m.positives).padStart(3)}  ${fmt(m.recall)}  ${fmt(m.precision)}   ${m.tp} ${m.fp} ${m.fn} ${m.tn}`);
    }
  }
  console.log('\nmisses (chosen):', JSON.stringify(result.misses));
  console.log('false alarms (chosen):', result.falseAlarms.length, JSON.stringify(result.falseAlarms.slice(0, 40)));
  console.log('failed:', JSON.stringify(failed));
  console.log('latency', result.latencyMs, 'cost/sheet', result.costPerSheetUsd.toFixed(5), 'total', result.totalCostUsd.toFixed(4));
  fs.writeFileSync(path.join(runDir(runId), 'metrics.json'), JSON.stringify(result, null, 1));
  if (arg('append')) {
    const promptFile = 'prompts/avatar-sheet-defect-judge.txt';
    const line = {
      date: new Date().toISOString().slice(0, 10), git_commit: require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(),
      model_id: rows[0].rec.model, prompt_file: promptFile, prompt_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, promptFile))).digest('hex'),
      dataset: 'avatar-sheet-defects-v1', params: { signals: chosen, folds: 'character md5 parity' },
      metrics: { sheets: rows.length, failed: failed.length, held_out: result.tables.chosen.test, all: result.tables.chosen.all, latencyMs: result.latencyMs, costPerSheetUsd: result.costPerSheetUsd }, notes: arg('notes', ''),
    };
    fs.appendFileSync(path.join(ROOT, 'evals/results/results.jsonl'), JSON.stringify(line) + '\n');
    console.log('appended results.jsonl line');
  }
}


// ------------------------------------------------------------------ cell judge (server/lib/avatarCellJudge.js)

async function runCells() {
  await require('../../server/services/prompts').loadPromptTemplates();
  const { describeSheetCells } = require('../../server/lib/avatarCellJudge');
  const dir = arg('images-dir'); const runId = arg('run-id'); const model = arg('model', 'gemini-2.5-flash');
  const cap = Number(arg('cap-usd', 0.30)); const only = arg('only') ? String(arg('only')).split(',') : null;
  const prices = FLASH[model]; if (!prices) throw new Error(`no price for ${model}`);
  const raw = path.join(runDir(runId), 'raw'); fs.mkdirSync(raw, { recursive: true });
  const todo = dataset().entries.filter(e => !e.ambiguous && (!only || only.includes(e.id)) && !fs.existsSync(path.join(raw, e.id + '.json')));
  let spent = fs.readdirSync(raw).reduce((s2, f) => s2 + (JSON.parse(fs.readFileSync(path.join(raw, f), 'utf8')).costUsd || 0), 0);
  console.log(`cells ${runId} ${model}: ${todo.length} sheets, spent so far USD ${spent.toFixed(4)}, cap ${cap}`);
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      if (spent >= cap) { console.log('CAP REACHED'); return; }
      const e = todo[i++]; const usage = []; const t0 = Date.now(); let rec;
      try {
        const r = await describeSheetCells({ sheetBuf: fs.readFileSync(path.join(dir, e.file)), model, usageTracker: (_k, u) => usage.push(u) });
        rec = { id: e.id, ok: true, raw: r.raw, cutMs: r.cutMs, callMs: r.callMs };
      } catch (err) { rec = { id: e.id, ok: false, cutFailed: /sheet cut:/.test(err.message), error: String(err.message).slice(0, 400) }; }
      const inTok = usage.reduce((a, u) => a + (u.input_tokens || 0), 0), outTok = usage.reduce((a, u) => a + (u.output_tokens || 0) + (u.thinking_tokens || 0), 0);
      Object.assign(rec, { latencyMs: Date.now() - t0, inTokens: inTok, outTokens: outTok, costUsd: (inTok * prices.input + outTok * prices.output) / 1e6, model });
      spent += rec.costUsd;
      fs.writeFileSync(path.join(raw, e.id + '.json'), JSON.stringify(rec));
      console.log(`${rec.ok ? 'ok ' : rec.cutFailed ? 'CUT' : 'ERR'} ${e.id} ${rec.latencyMs}ms $${rec.costUsd.toFixed(4)} total $${spent.toFixed(4)}${rec.ok ? '' : ' ' + rec.error}`);
    }
  }
  await Promise.all([worker(), worker()]);
  console.log(`done. spent USD ${spent.toFixed(4)}`);
}

function scoreCells() {
  const cj = require('../../server/lib/avatarCellJudge');
  const runId = arg('run-id'); const raw = path.join(runDir(runId), 'raw');
  const rows = []; const failed = [];
  for (const e of dataset().entries) {
    if (e.ambiguous) continue;
    const f = path.join(raw, e.id + '.json'); if (!fs.existsSync(f)) continue;
    const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
    const row = { e, rec, truth: e.defects, fold: foldOf(e.character), cells: null, cutFailed: false };
    if (!rec.ok && rec.cutFailed) row.cutFailed = true;
    else if (!rec.ok) { failed.push({ id: e.id, error: rec.error }); continue; }
    else { try { row.cells = rec.raw.map((r, i) => cj.parseCellAnswer(r, `cell ${i + 1}`)); } catch (err) { failed.push({ id: e.id, error: err.message }); continue; } }
    rows.push(row);
  }
  const predOf = (r, config) => new Set(r.cutFailed ? ['layout'] : cj.defectsOfCells(r.cells, config));
  const withPred = (subset, config) => subset.map(r => ({ ...r, pred: predOf(r, config) }));
  const tune = rows.filter(r => r.fold === 'tune'), test = rows.filter(r => r.fold === 'test');
  const chosen = {};
  for (const t of cj.DECIDER_TYPES) {
    let best = null;
    for (const name of Object.keys(cj.DECIDERS[t])) {
      const m = prf(withPred(tune, { [t]: name }), t);
      const key = [m.recall ?? 1, -m.fp];
      if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) best = { name, key };
    }
    chosen[t] = best.name;
  }
  const TYPES = cj.DECIDER_TYPES;
  const table = (subset, config) => {
    const ev = withPred(subset, config); const out = {};
    for (const t of TYPES) out[t] = prf(ev, t);
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of ev) { const a = r.truth.some(x => TYPES.includes(x)), b = [...r.pred].some(x => TYPES.includes(x)); if (a && b) tp++; else if (!a && b) fp++; else if (a) fn++; else tn++; }
    out.ANY = { tp, fp, fn, tn, positives: tp + fn, recall: tp + fn ? tp / (tp + fn) : null, precision: tp + fp ? tp / (tp + fp) : null, cleanPassRate: tn + fp ? tn / (tn + fp) : null };
    return out;
  };
  const result = { runId, sheets: rows.length, failed, chosen, tables: { chosen: { all: table(rows, chosen), tune: table(tune, chosen), test: table(test, chosen) } } };
  result.allDeciders = {};
  for (const t of TYPES) for (const name of Object.keys(cj.DECIDERS[t])) { const m = prf(withPred(rows, { [t]: name }), t); result.allDeciders[`${t}.${name}`] = { tp: m.tp, fp: m.fp, fn: m.fn, recall: m.recall, precision: m.precision }; }
  const ok = rows.filter(r => !r.cutFailed);
  const lat = ok.map(r => r.rec.latencyMs).sort((a, b) => a - b);
  result.latencyMs = { p50: lat[Math.floor(lat.length / 2)], p90: lat[Math.floor(lat.length * 0.9)], mean: Math.round(lat.reduce((a, x) => a + x, 0) / lat.length) };
  result.costPerSheetUsd = ok.reduce((a, r) => a + r.rec.costUsd, 0) / ok.length; result.totalCostUsd = ok.reduce((a, r) => a + r.rec.costUsd, 0);
  result.misses = rows.flatMap(r => r.truth.filter(t => TYPES.includes(t) && !predOf(r, chosen).has(t)).map(t => ({ id: r.e.id, type: t, fold: r.fold })));
  const fmt = (n) => (n == null ? '  -  ' : (n * 100).toFixed(0).padStart(4) + '%');
  console.log('chosen on tune fold:', JSON.stringify(chosen));
  for (const [fold, tb] of Object.entries(result.tables.chosen)) {
    console.log(`[${fold}] type pos recall precision tp fp fn tn`);
    for (const [ty, m] of Object.entries(tb)) console.log(`   ${ty.padEnd(9)} ${String(m.positives).padStart(3)} ${fmt(m.recall)} ${fmt(m.precision)}  ${m.tp} ${m.fp} ${m.fn} ${m.tn}${m.cleanPassRate != null ? '  clean-sheet pass rate ' + fmt(m.cleanPassRate) : ''}`);
  }
  console.log('all deciders:'); for (const [k, m] of Object.entries(result.allDeciders)) console.log('  ', k.padEnd(28), `tp${m.tp} fp${m.fp} fn${m.fn} recall ${fmt(m.recall)} prec ${fmt(m.precision)}`);
  console.log('misses:', JSON.stringify(result.misses)); console.log('failed:', JSON.stringify(failed));
  console.log('latency', result.latencyMs, 'cost/sheet', result.costPerSheetUsd.toFixed(5), 'total', result.totalCostUsd.toFixed(4));
  fs.writeFileSync(path.join(runDir(runId), 'metrics.json'), JSON.stringify(result, null, 1));
  if (arg('append')) {
    const promptFile = 'prompts/avatar-cell-judge.txt';
    const line = { date: new Date().toISOString().slice(0, 10), git_commit: require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(), model_id: ok[0].rec.model, prompt_file: promptFile, prompt_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, promptFile))).digest('hex'), dataset: 'avatar-sheet-defects-v1', params: { judge: 'cells', deciders: chosen, folds: 'character md5 parity' }, metrics: { sheets: rows.length, failed: failed.length, held_out: result.tables.chosen.test, all: result.tables.chosen.all, latencyMs: result.latencyMs, costPerSheetUsd: result.costPerSheetUsd }, notes: arg('notes', '') };
    fs.appendFileSync(path.join(ROOT, 'evals/results/results.jsonl'), JSON.stringify(line) + '\n'); console.log('appended results.jsonl line');
  }
}

if (require.main === module) {
  const cmd = process.argv[2];
  (cmd === 'run' ? run() : cmd === 'score' ? Promise.resolve(score()) : cmd === 'run-cells' ? runCells() : cmd === 'score-cells' ? Promise.resolve(scoreCells()) : Promise.reject(new Error('usage: run|score')))
    .then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
module.exports = { foldOf, prf };
