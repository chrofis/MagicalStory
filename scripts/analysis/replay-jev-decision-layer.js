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

/**
 * The group-page cut on the over-budget books of the decision-layer eval.
 * Present per page: the group items' rosters for the group pages; the other
 * pages' who columns matched against the book's commissioned names (the
 * replay has no plan-check roster). No obstacle / focal / main data is stored
 * with the items, so those constraints are not exercised here — the coverage
 * floor is.
 */
async function cuts() {
  const L = labelsOf('evals/datasets/jev-decision-layer-v1/reading_labels.json');
  const { castCoverage } = require('../../server/lib/castCoverage');
  const { parsePlanLine, rosterOf } = require('./eval-jev-decision-layer');
  const gp = loadItems().filter(i => i.kind === 'grouppage' && i.overBudget && (!only || only.has(i.story)));
  const stories = [...new Set(gp.map(i => i.story))];
  const out = []; let pagesCut = 0; let pagesCutReadingCut = 0; let removed = 0; let removedNotNeeded = 0; let removedUnlabelled = 0;
  for (const sid of stories) {
    const its = gp.filter(i => i.story === sid);
    const names = [...new Set(its.flatMap(i => i.roster))];
    const pages = its[0].planText.split('\n').map(l => { const m = l.match(/^Page (\d+): (.*)$/); return m && { pageNumber: Number(m[1]), planLine: `${P} — ${parsePlanLine(m[2]).who} — ${parsePlanLine(m[2]).instant} — ${parsePlanLine(m[2]).after}` }; }).filter(Boolean);
    const present = new Map(pages.map(p => [p.pageNumber, rosterOf(parsePlanLine(its[0].planText.split('\n').find(l => l.startsWith(`Page ${p.pageNumber}:`)).replace(/^Page \d+: /, '')).who, names)]));
    for (const i of its) present.set(i.page, i.roster);
    const cov = castCoverage({ pageCount: pages.length, castCount: names.length });
    const d = await JD.decideGroupCuts({ arc: its[0].arc, pages, present, groupPages: its[0].groupPages, budget: its[0].budget,
      listed: names, floor: cov ? cov.appearances.min : 0 });
    addStats(d.stats);
    const rows = d.decisions.map(x => {
      const readKeep = L[hash(`gp:${sid}:${x.pageNumber}`)];
      if (!x.keepsGroup && x.remove && x.remove.length) {
        pagesCut++; if (readKeep === false) pagesCutReadingCut++;
        for (const n of x.remove) { removed++; const r = L[hash(`cd:${sid}:${x.pageNumber}:${n}`)]; if (r === false) removedNotNeeded++; if (r == null) removedUnlabelled++; }
      }
      return { page: x.pageNumber, together: x.together, keepsGroup: x.keepsGroup, readingKeep: readKeep ?? null, keep: x.keep || null, remove: x.remove || null, scores: x.scores || null, required: x.required || null, unsatisfiable: x.unsatisfiable || null };
    });
    const after = new Map(present); for (const x of d.decisions) if (x.keep) after.set(x.pageNumber, x.keep);
    const groupAfter = [...after.values()].filter(v => v.length > SV.GROUP_STAGING_MAX).length;
    const coverageAfter = Object.fromEntries(names.map(n => [n, [...after.values()].filter(v => v.includes(n)).length]));
    console.log(`${sid}: budget ${d.budget}, group pages ${d.groupPages.join(',')} → keep ${d.keepGroup.join(',')}; ${rows.filter(r => r.remove).map(r => `p${r.page} −${r.remove.join('/')} (reading ${r.readingKeep === false ? 'cut' : r.readingKeep === true ? 'KEEP' : '?'})`).join('; ')} | group pages after ${groupAfter} | coverage ${JSON.stringify(coverageAfter)} floor ${cov && cov.appearances.min}`);
    out.push({ story: sid, budget: d.budget, groupAfter, budgetMet: groupAfter <= d.budget, coverageAfter, floor: cov && cov.appearances.min, rows });
  }
  return { mode: 'cuts', stories: stories.length, pagesCut, pagesCutThatReadingCuts: pagesCutReadingCut, charactersRemoved: removed, removedReadingNotNeeded: removedNotNeeded, removedUnlabelled,
    budgetMet: `${out.filter(o => o.budgetMet).length}/${out.length}`,
    measuredEval: { togetherInBudget: '7/7 reading-cut pages', neededBelow05: '51 cuts, 0 wrong' }, rows: out };
}

async function main() {
  const fn = { shots, cuts }[mode];
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
