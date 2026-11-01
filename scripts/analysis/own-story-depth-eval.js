#!/usr/bin/env node
/**
 * Replay of the own-story depth flags (WHO_DEPTH, WHERE_DEPTH, PROBLEM_DEPTH) on the REAL Jev model.
 * Builds the questions with the endpoint's own questionSet(), makes the endpoint's own call (J.callJev),
 * and compares each depth flag with the expected label in evals/datasets/own-story-depth-v1.jsonl.
 * Raw answers go to evals/runs/<date>_own-story-depth/. Cost: about USD 0.0001 per premise.
 *
 *   node scripts/analysis/own-story-depth-eval.js [--out=evals/runs/2026-11-01_own-story-depth]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const J = require('../../server/lib/jevAudit');
const OS = require('../../server/lib/ownStoryAnalysis');

const root = path.join(__dirname, '../..');
const outArg = process.argv.find(a => a.startsWith('--out='));
const outDir = path.join(root, outArg ? outArg.slice(6) : 'evals/runs/2026-11-01_own-story-depth');
const cases = fs.readFileSync(path.join(root, 'evals/datasets/own-story-depth-v1.jsonl'), 'utf-8')
  .split('\n').filter(Boolean).map(l => JSON.parse(l));
const FLAGS = ['WHO_DEPTH', 'WHERE_DEPTH', 'PROBLEM_DEPTH'];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  let cost = 0;
  const rows = [];
  for (const c of cases) {
    const questions = OS.questionSet(c.age, { pages: c.pages, languageLevel: 'standard' });
    const r = await J.callJev({ state: c.text, questions });
    cost += r.cost;
    const got = {};
    for (const f of FLAGS) got[f] = r.answers[f] ? J.yesProb(r.answers[f]) : null;
    rows.push({ id: c.id, lang: c.lang, pages: c.pages, expect: c.expect, probs: got, partProbs: Object.fromEntries(OS.OWN_STORY_PARTS.map(p => [p, J.yesProb(r.answers[p])])), model: r.model, cost: r.cost });
    process.stdout.write('.');
  }
  fs.writeFileSync(path.join(outDir, 'raw.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const agree = {};
  const misses = [];
  for (const f of FLAGS) {
    const asked = rows.filter(r => r.expect[f] !== null && r.probs[f] !== null);
    const ok = asked.filter(r => (r.probs[f] >= OS.OWN_STORY_THRESHOLD) === r.expect[f]);
    const pos = asked.filter(r => r.expect[f]), neg = asked.filter(r => !r.expect[f]);
    agree[f] = {
      n: asked.length, agree: ok.length, rate: +(ok.length / asked.length).toFixed(3),
      truePositiveRate: +(pos.filter(r => r.probs[f] >= 0.5).length / (pos.length || 1)).toFixed(3),
      trueNegativeRate: +(neg.filter(r => r.probs[f] < 0.5).length / (neg.length || 1)).toFixed(3),
      pos: pos.length, neg: neg.length,
    };
    for (const r of asked) if ((r.probs[f] >= 0.5) !== r.expect[f]) misses.push({ flag: f, id: r.id, expected: r.expect[f], p: r.probs[f] });
  }
  const summary = { cases: rows.length, costUsd: +cost.toFixed(6), model: rows[0] && rows[0].model, agree, misses };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n' + JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
