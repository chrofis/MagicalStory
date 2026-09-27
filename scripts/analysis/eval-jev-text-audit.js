#!/usr/bin/env node
/**
 * Run and score the Jev text-audit evaluation.
 *
 *   node scripts/analysis/eval-jev-text-audit.js run   --run=2026-09-27_jev-v1 [--only=grammar,slop] [--concurrency=8]
 *   node scripts/analysis/eval-jev-text-audit.js score --run=2026-09-27_jev-v1 [--append-results]
 *
 * `run` sends every item of evals/datasets/jev-text-audit-v1/items.jsonl to Jev
 * (typesafe/jev-1.13, ~$0.00003/call) through server/lib/jevAudit.js and stores
 * the raw answers in evals/runs/<run>/answers.jsonl (resumable: done items are
 * skipped). `score` computes AUC / best-F1 threshold / precision / recall per
 * check, question, granularity and item kind into evals/runs/<run>/metrics.json;
 * `--append-results` appends one line to evals/results/results.jsonl.
 * Needs OPENROUTER_API_KEY. see docs/decisions.md 2026-09-27 "Jev text audit"
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const J = require('../../server/lib/jevAudit');

const ROOT = path.join(__dirname, '../..');
const DATASET = 'jev-text-audit-v1';
const args = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const mode = process.argv[2];
const RUN = args.run || '2026-09-27_jev-v1';
const RUN_DIR = path.join(ROOT, 'evals/runs', RUN);
const ANSWERS = path.join(RUN_DIR, 'answers.jsonl');
const items = fs.readFileSync(path.join(ROOT, 'evals/datasets', DATASET, 'items.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

function questionsFor(it) {
  switch (it.check) {
    case 'grammar': return J.buildGrammarQuestions(it.language);
    case 'slop': return J.buildSlopQuestions();
    case 'logic': return J.buildLogicQuestions(it.pageNumber);
    case 'arc': return J.buildArcPageQuestions(it.plan);
    case 'arc_cast': return J.buildCastBeatQuestions(it.names);
    case 'shot': return J.buildShotQuestion();
    default: throw new Error(`unknown check ${it.check}`);
  }
}

async function callWithRetry(req) {
  for (let attempt = 0; ; attempt++) {
    try { return await J.callJev(req); } catch (e) {
      const transient = /HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT/.test(e.message);
      if (!transient || attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function run() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const done = new Set(fs.existsSync(ANSWERS) ? fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
  const only = args.only ? new Set(String(args.only).split(',')) : null;
  const todo = items.filter(it => !done.has(it.id) && (!only || only.has(it.check)));
  console.log(`${todo.length} items to run (${done.size} done)`);
  const out = fs.createWriteStream(ANSWERS, { flags: 'a' });
  let i = 0; let cost = 0; let n = 0;
  const conc = Number(args.concurrency || 8);
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < todo.length) {
      const it = todo[i++];
      const questions = questionsFor(it);
      const t0 = Date.now();
      const r = await callWithRetry({ state: it.state, questions });
      cost += r.cost; n++;
      out.write(JSON.stringify({ id: it.id, model: r.model, cost: r.cost, ms: Date.now() - t0, usage: r.usage, answers: r.answers }) + '\n');
      if (n % 100 === 0) console.log(`${n}/${todo.length} $${cost.toFixed(5)}`);
    }
  }));
  out.end();
  console.log(`done ${n} calls, $${cost.toFixed(5)}`);
}

// ───────────── scoring ─────────────
function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
function bestThreshold(pos, neg) {
  const cands = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
  let best = null;
  for (const t of cands) {
    const tp = pos.filter(x => x >= t).length; const fp = neg.filter(x => x >= t).length;
    const prec = tp + fp ? tp / (tp + fp) : 0; const rec = tp / pos.length;
    const f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
    if (!best || f1 > best.f1) best = { threshold: t, f1: +f1.toFixed(3), precision: +prec.toFixed(3), recall: +rec.toFixed(3), tp, fp };
  }
  return best;
}
function recallAtPrecision(pos, neg, target = 0.8) {
  const cands = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
  let best = { threshold: null, recall: 0 };
  for (const t of cands) {
    const tp = pos.filter(x => x >= t).length; const fp = neg.filter(x => x >= t).length;
    if (tp && tp / (tp + fp) >= target && tp / pos.length > best.recall) best = { threshold: t, recall: +(tp / pos.length).toFixed(3) };
  }
  return best;
}
const q = x => +x.toFixed(3);
function summarize(pos, neg) {
  const mean = a => (a.length ? q(a.reduce((s, x) => s + x, 0) / a.length) : null);
  const a = auc(pos, neg);
  return { nPos: pos.length, nNeg: neg.length, auc: a == null ? null : q(a), meanPos: mean(pos), meanNeg: mean(neg), best: pos.length && neg.length ? bestThreshold(pos, neg) : null, atP80: pos.length && neg.length ? recallAtPrecision(pos, neg, 0.8) : null };
}
function pairedWin(rows, scoreFn) {
  // injected vs its own un-edited original: share of pairs where the edit scores higher
  const byId = Object.fromEntries(rows.map(r => [r.it.id, r]));
  let w = 0; let n = 0;
  for (const r of rows) {
    const pairOf = r.it.meta?.pairOf; if (!pairOf || !byId[pairOf]) continue;
    const a = scoreFn(byId[pairOf]); const b = scoreFn(r);
    n++; if (a > b) w++; else if (a === b) w += 0.5;
  }
  return n ? { pairs: n, winRate: q(w / n) } : null;
}

function score() {
  const ans = Object.fromEntries(fs.readFileSync(ANSWERS, 'utf8').trim().split('\n').map(JSON.parse).map(a => [a.id, a]));
  const rows = items.filter(it => ans[it.id]).map(it => ({ it, a: ans[it.id].answers }));
  const metrics = { run: RUN, items: rows.length, cost: q(Object.values(ans).reduce((s, a) => s + a.cost, 0) * 1e5) / 1e5, checks: {} };
  const Q = J.loadQuestions();
  const p = (r, id) => r.a[id]?.noul;

  // grammar / slop / logic: per question + check-level aggregates, per unit, excluding borderline
  for (const [check, section] of [['grammar', 'GRAMMAR'], ['slop', 'SLOP'], ['logic', 'LOGIC']]) {
    // SLOP questions live in proseSlop.js since 2026-09-27 (SLOP_EMOTION_LABEL and
    // SLOP_SUDDENLY left the set); earlier runs' answers carry them and are ignored.
    const ids = section === 'SLOP' ? require('../../server/lib/proseSlop').SLOP_TYPES.map(t => t.id) : Q[section].map(x => x.id);
    const cr = rows.filter(r => r.it.check === check);
    const units = [...new Set(cr.map(r => r.it.unit))];
    const agg = {
      max: r => Math.max(...ids.filter(i => i !== 'GRAM_CLEAN').map(i => p(r, i))),
      ...(check === 'grammar' ? { GRAM_ANY: r => p(r, 'GRAM_ANY'), NOT_CLEAN: r => 1 - p(r, 'GRAM_CLEAN') } : {}),
    };
    metrics.checks[check] = {};
    for (const unit of units) {
      const ur = cr.filter(r => r.it.unit === unit);
      const out = { perQuestion: {}, checkLevel: {} };
      for (const id of ids) {
        const lab = id === 'GRAM_CLEAN' ? null : id;
        if (!lab) continue;
        const usable = ur.filter(r => !(r.it.borderline || []).includes(id));
        const pos = usable.filter(r => r.it.positive.includes(id)).map(r => p(r, id));
        const neg = usable.filter(r => r.it.positive.length === 0).map(r => p(r, id));
        const other = usable.filter(r => r.it.positive.length && !r.it.positive.includes(id)).map(r => p(r, id));
        out.perQuestion[id] = { ...summarize(pos, neg), crossFireMean: other.length ? q(other.reduce((s, x) => s + x, 0) / other.length) : null };
      }
      for (const [name, fn] of Object.entries(agg)) {
        const usable = ur.filter(r => !(r.it.borderline || []).length);
        const pos = usable.filter(r => r.it.positive.length).map(fn);
        const neg = usable.filter(r => !r.it.positive.length).map(fn);
        out.checkLevel[name] = { ...summarize(pos, neg), paired: pairedWin(usable, fn) };
        // by kind of positive
        const kinds = [...new Set(usable.filter(r => r.it.positive.length).map(r => r.it.kind))];
        out.checkLevel[name].byPositiveKind = Object.fromEntries(kinds.map(k => [k, summarize(usable.filter(r => r.it.positive.length && r.it.kind === k).map(fn), neg)]));
      }
      metrics.checks[check][unit] = out;
    }
  }

  // arc page match
  const ar = rows.filter(r => r.it.check === 'arc');
  const arcOut = {};
  for (const [name, fn] of [['1-MATCH', r => 1 - p(r, 'ARC_PAGE_MATCH')], ['CONTRADICT', r => p(r, 'ARC_PAGE_CONTRADICT')], ['avg', r => (1 - p(r, 'ARC_PAGE_MATCH') + p(r, 'ARC_PAGE_CONTRADICT')) / 2]]) {
    const neg = ar.filter(r => r.it.kind === 'original').map(fn);
    arcOut[name] = { shuffled: summarize(ar.filter(r => r.it.kind === 'shuffled').map(fn), neg), subtle: summarize(ar.filter(r => r.it.kind === 'injected').map(fn), neg) };
  }
  metrics.checks.arc = arcOut;

  // arc cast beat: P(yes) for present names vs removed / absent
  const cast = rows.filter(r => r.it.check === 'arc_cast');
  const present = []; const removed = []; const absentNatural = [];
  for (const r of cast) r.it.names.forEach((n, i) => {
    const v = p(r, `ARC_CAST_BEAT__${i}`);
    if (r.it.present[i]) present.push(v);
    else if (r.it.removed === n) removed.push(v);
    else if (r.it.kind === 'original') absentNatural.push(v);
  });
  metrics.checks.arc_cast = { removedVsPresent: summarize(removed.map(x => 1 - x), present.map(x => 1 - x)), absentNatural: absentNatural.map(q) };

  // shot
  const sr = rows.filter(r => r.it.check === 'shot');
  const conf = {}; let right = 0;
  for (const r of sr) { const c = r.a.SHOT_TYPE.choice; conf[`${r.it.label}->${c}`] = (conf[`${r.it.label}->${c}`] || 0) + 1; if (c === r.it.label) right++; }
  const byFmt = {};
  for (const r of sr) { const f = r.it.story.includes('1790') && r.it.state.length > 1500 ? 'prose' : 'json'; byFmt[f] = byFmt[f] || [0, 0]; byFmt[f][1]++; if (r.a.SHOT_TYPE.choice === r.it.label) byFmt[f][0]++; }
  metrics.checks.shot = { n: sr.length, accuracy: sr.length ? q(right / sr.length) : null, confusion: conf, labelDist: J.shotDistribution(sr.map(r => r.it.label)) };

  fs.writeFileSync(path.join(RUN_DIR, 'metrics.json'), JSON.stringify(metrics, null, 1));
  console.log(JSON.stringify(metrics, null, 1).slice(0, 200));
  if (args['append-results']) {
    const promptFile = 'prompts/jev-text-audit.txt';
    const line = {
      date: new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }).slice(0, 16) + ' CH',
      git_commit: execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(),
      model_id: Object.values(ans)[0]?.model || J.JEV_MODEL,
      prompt_file: promptFile,
      prompt_sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, promptFile))).digest('hex'),
      dataset: DATASET,
      params: { run: RUN, items: rows.length },
      metrics: compact(metrics),
      notes: args.notes || '',
    };
    fs.appendFileSync(path.join(ROOT, 'evals/results/results.jsonl'), JSON.stringify(line) + '\n');
    console.log('appended results line');
  }
}
function compact(m) {
  const out = { cost_usd: m.cost };
  for (const [check, units] of Object.entries(m.checks)) {
    if (['grammar', 'slop', 'logic'].includes(check)) {
      for (const [unit, u] of Object.entries(units)) for (const [name, s] of Object.entries(u.checkLevel)) out[`${check}.${unit}.${name}.auc`] = s.auc;
    }
  }
  out['arc.shuffled.avg.auc'] = m.checks.arc?.avg?.shuffled?.auc;
  out['arc.subtle.avg.auc'] = m.checks.arc?.avg?.subtle?.auc;
  out['arc_cast.removed.auc'] = m.checks.arc_cast?.removedVsPresent?.auc;
  out['shot.accuracy'] = m.checks.shot?.accuracy;
  return out;
}

(mode === 'run' ? run() : mode === 'score' ? Promise.resolve(score()) : Promise.reject(new Error('mode: run | score')))
  .catch(e => { console.error(e); process.exit(1); });
