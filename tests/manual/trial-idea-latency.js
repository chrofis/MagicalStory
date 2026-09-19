/**
 * Added latency on the PASSING path — the ~85% that must not get slower.
 *
 * Strictly sequential, alternating baseline / self-check on the SAME built prompt,
 * so nothing runs in parallel and no pair is favoured by ordering. The passing
 * path costs one extra model call of nothing: the only difference is the CHECK
 * block's output tokens.
 *
 *   node tests/manual/trial-idea-latency.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const tpl = fs.readFileSync(path.join(ROOT, 'prompts/trial-idea.txt'), 'utf8');
const oldTpl = fs.readFileSync(path.join(__dirname, 'trial-idea-precommit.txt'), 'utf8');
const pb = require(path.join(ROOT, 'server/lib/promptBuilders'));
const chk = require(path.join(ROOT, 'server/lib/trialIdeaCheck'));
const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
const { getLanguageInstruction } = require(path.join(ROOT, 'server/lib/languages'));
const { buildSeasonInstruction } = require(path.join(ROOT, 'server/lib/season'));

const MODEL = 'claude-sonnet';
const PAIRS = 6;

(async () => {
  const rows = [];
  for (let i = 0; i < PAIRS; i++) {
    const mk = (t) => pb.buildTrialIdeaPrompts({
      template: t,
      characters: [{ name: 'Zara', age: 5, gender: 'female' }],
      charDesc: 'Zara, 5 years old, female',
      categoryContext: 'This is a life skills story about "waiting-turn". The idea names one outside event that forces the child to use this skill — something that happens in the world, never a feeling on its own — and what it costs them.',
      townName: 'Fislisbach',
      storyTheme: 'ocean',
      langInstruction: getLanguageInstruction('de'),
      seasonInstruction: buildSeasonInstruction({}),
    });
    // The BEFORE prompt is the pre-commit template, not the new one with the check
    // block deleted: that leaves the opening line referring to a block the model was
    // never given, and it invents a sprawling audit of its own.
    const local = mk(tpl).local;
    const baseline = mk(oldTpl).local.replace(`\n\n${chk.TRIAL_IDEA_SELF_CHECK_RULE}`, '');
    if (baseline.includes('CHECK')) throw new Error('baseline prompt still mentions a check block');
    const order = i % 2 === 0 ? [['baseline', baseline], ['selfcheck', local]] : [['selfcheck', local], ['baseline', baseline]];
    for (const [kind, prompt] of order) {
      const t = Date.now();
      const r = await callTextModelStreaming(prompt, null, null, MODEL, { usageLabel: 'trial_idea_latency' });
      rows.push({ pair: i, kind, ms: Date.now() - t, out: r.usage?.output_tokens, in: r.usage?.input_tokens });
      process.stderr.write(`${i} ${kind} ${Date.now() - t}ms ${r.usage?.output_tokens}tok\n`);
    }
  }
  const of = k => rows.filter(r => r.kind === k);
  const mean = a => Math.round(a.reduce((s, x) => s + x, 0) / a.length);
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const res = {
    n: PAIRS,
    baseline: { meanMs: mean(of('baseline').map(r => r.ms)), medianMs: med(of('baseline').map(r => r.ms)), meanOut: mean(of('baseline').map(r => r.out)) },
    selfcheck: { meanMs: mean(of('selfcheck').map(r => r.ms)), medianMs: med(of('selfcheck').map(r => r.ms)), meanOut: mean(of('selfcheck').map(r => r.out)) },
    rows,
  };
  fs.writeFileSync(path.join(ROOT, 'tests/manual/round10-latency.json'), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
