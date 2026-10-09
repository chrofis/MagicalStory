#!/usr/bin/env node
/**
 * Jev as the trial idea's reviewer instead of the CHECK/EVENT/ACT block (prompts/trial-idea.txt, server/lib/trialIdeaCheck.js).
 * Input: the 60 stored trial cards of evals/runs/2026-10-09_trial-idea-chain (old/new/new-r1 x 20). Narrow nouls on the three-slot contract.
 *   node scripts/analysis/eval-jev-trial-idea.js run | show
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const RUN = path.join(__dirname, '../../evals/runs/2026-10-09_jev-idea-review/');
const SRC = path.join(__dirname, '../../evals/runs/2026-10-09_trial-idea-chain/');
const { callJev } = require('../../server/lib/jevAudit');
const { stripIdeaSelfCheck } = require('../../server/lib/trialIdeaCheck');
const N = instructions => ({ type: 'noul', instructions });
const Q = {
  T_WANT: N('Sentence 1 says what the main character wants.'),
  T_EVENT: N('Sentence 1 also names one outside event that stops that want: something that happens in the world, not a feeling.'),
  T_ACT: N('Sentence 2 is an act of the main character that works on exactly that outside event.'),
  T_FORCED: N('That outside event forces that act: without the event the act would make no sense.'),
  T_RESULT: N('Sentence 3 settles exactly the want from sentence 1.'),
  T_CHANCE: N('Something the act uses was not named in sentence 1 and simply turns up by chance.'),
  T_WIND: N('The outside event is wind or weather.'),
  T_STUCK: N('The text stops on the problem, or leaves one of its three parts unwritten.'),
};
const rows = () => ['old', 'new', 'new-r1'].flatMap(f => fs.readFileSync(SRC + f + '.jsonl', 'utf8').split('\n').filter(Boolean).map((l, i) => ({ f, i, ...JSON.parse(l) })));
async function run() {
  const out = []; let spent = 0;
  for (const r of rows()) {
    const idea = stripIdeaSelfCheck(r.text).trim();
    const state = ['# A THREE-SENTENCE STORY IDEA FOR A CHILD\'S PICTURE BOOK', `Character: ${r.c.n}, ${r.c.age} years old. Kind of story: ${[r.c.cat, r.c.theme, r.c.topic].filter(Boolean).join(', ')}.`, `Language: ${r.c.lang}.`, '# THE IDEA', idea].join('\n');
    const t0 = Date.now(); const a = await callJev({ state, questions: Q }); spent += a.cost;
    out.push({ f: r.f, i: r.i, cell: r.cell, arm: r.arm, idea, ms: Date.now() - t0, p: Object.fromEntries(Object.entries(a.answers).map(([k, v]) => [k, v.noul])) });
  }
  fs.writeFileSync(RUN + 'trial-jev.json', JSON.stringify(out, null, 1)); console.log('spent', spent.toFixed(4), 'cards', out.length);
}
function show() {
  const o = JSON.parse(fs.readFileSync(RUN + 'trial-jev.json'));
  const good = ['T_WANT', 'T_EVENT', 'T_ACT', 'T_FORCED', 'T_RESULT']; const bad = ['T_CHANCE', 'T_WIND', 'T_STUCK'];
  const flag = c => [...good.filter(q => c.p[q] < 0.5), ...bad.filter(q => c.p[q] > 0.5)];
  const fl = o.filter(c => flag(c).length);
  console.log('cards', o.length, 'flagged', fl.length, 'by question', JSON.stringify(Object.fromEntries([...good, ...bad].map(q => [q, o.filter(c => flag(c).includes(q)).length]))));
  console.log('ms p50', o.map(c => c.ms).sort((a, b) => a - b)[Math.floor(o.length / 2)]);
  for (const c of fl) console.log(`\n[${c.f} ${c.cell}${c.arm[0]}] ${flag(c).map(q => q + '=' + c.p[q].toFixed(2)).join(' ')}\n  ${c.idea.replace(/\n/g, ' ')}`);
}
if (process.argv[2] === 'run') run().catch(e => { console.error(e); process.exit(1); });
if (process.argv[2] === 'show') show();
