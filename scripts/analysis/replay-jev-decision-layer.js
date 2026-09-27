#!/usr/bin/env node
/**
 * REPLAY the Jev decision layer's PRODUCTION functions (server/lib/jevDecisions.js)
 * on the stored eval datasets and score them against the committed reading
 * labels (rung 1 of the validation ladder: stored data, Jev calls only,
 * ~$0.00012 a call, no paid model call).
 *
 * Why this exists: the evals measured each decision with the STORY TEXT in the
 * state where the text existed. In production the decisions run before the
 * text is written (arc + plan only, the page marked), and they run through the
 * production module — this measures exactly what ships.
 *
 *   node scripts/analysis/replay-jev-decision-layer.js shots --items=<jev-shot-budget-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js cuts  --items=<jev-decision-layer-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js light --items=<jev-decision-layer-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js vb    --items=<jev-decision-layer-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js pop   --items=<jev-shot-budget-v1 items.jsonl>
 *   node scripts/analysis/replay-jev-decision-layer.js gaze  --items=<jev-extra-fields-v1 items.jsonl>
 *   [--dotenv=<path>] [--only=<story id,…>] [--out=<file.json>]
 *
 * Items are gitignored (story text); the reading labels are committed.
 * see docs/decisions.md 2026-09-27 "Jev decision layer wired"
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '../..');
const argv = Object.fromEntries(process.argv.slice(3).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
require('dotenv').config({ path: argv.dotenv || path.join(ROOT, '.env') });
const JD = require('../../server/lib/jevDecisions');
const SV = require('../../server/lib/shotVocabulary');

const mode = process.argv[2];
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const loadItems = () => fs.readFileSync(argv.items, 'utf8').trim().split('\n').map(JSON.parse);
const labelsOf = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const only = argv.only ? new Set(String(argv.only).split(',')) : null;
const P = SV.PLAN_SHOT_PLACEHOLDER;
const totals = { calls: 0, costUsd: 0, retries: 0, failed: 0, errors: [] };
const addStats = s => { totals.calls += s.calls; totals.costUsd += s.costUsd; totals.retries += s.retries; totals.failed += s.failed; totals.errors.push(...s.errors); };

async function shots() {
  const L = labelsOf('evals/datasets/jev-shot-budget-v1/reading_labels.json');
  const stories = loadItems().filter(i => i.kind === 'story' && (!only || only.has(i.id)));
  let n = 0; let ok = 0; let best = 0; let viol = 0; let groupNotWider = 0; let groupN = 0;
  const rows = [];
  for (const st of stories) {
    const pages = st.pages.map(p => ({ pageNumber: p.page, planLine: `${P} — ${p.line}` }));
    // Head count: the reading's group flag stands in for planCounters' `present`
    // (the eval's --readingGroup); the state never sees these names.
    const present = new Map(st.pages.map(p => {
      const l = L[hash(`shot:${st.id}:${p.page}`)];
      const count = l && l.group ? Math.max(4, p.roster.length) : Math.min(p.roster.length, 3);
      return [p.page, Array.from({ length: count }, (_, k) => p.roster[k] || `figure${k}`)];
    }));
    const d = await JD.decideShots({ arc: st.arc, pages, present });
    addStats(d.stats);
    viol += d.violations.length;
    d.shots.forEach((s, i) => {
      const l = L[hash(`shot:${st.id}:${st.pages[i].page}`)];
      if (!l) return;
      n++; if (l.ok.includes(s)) ok++; if (l.best === s) best++;
      if (l.group) { groupN++; if (!SV.GROUP_WIDER_SHOTS.includes(s)) groupNotWider++; }
    });
    rows.push({ story: st.id, shots: d.shots.join(' '), violations: d.violations, unmet: d.unmet });
    console.log(`${st.id}: ${d.violations.length ? d.violations.join(',') : 'clean'} ${d.shots.map((s, i) => `p${st.pages[i].page}:${s}`).join(' ')}`);
  }
  return { mode: 'shots', books: stories.length, pages: n, acceptable: +(ok / n).toFixed(3), best: +(best / n).toFixed(3), ruleViolations: viol, groupPagesNotWider: `${groupNotWider}/${groupN}`,
    measuredEval: { acceptable: 0.918, readingGroupAcceptable: 0.938, best: 0.615, violations: 0 }, rows };
}

async function main() {
  const fn = { shots }[mode];
  if (!fn) { console.log('usage: shots | cuts | light | vb | pop | gaze  --items=<items.jsonl>'); return; }
  const t0 = Date.now();
  const res = await fn();
  res.jev = { ...totals, costUsd: +totals.costUsd.toFixed(5), errors: totals.errors.slice(0, 20), failureRate: totals.calls ? +(totals.errors.length / (totals.calls + totals.errors.length)).toFixed(4) : null };
  res.elapsedMs = Date.now() - t0;
  const { rows, ...summary } = res;
  console.log(JSON.stringify(summary, null, 2));
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(res, null, 2));
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
