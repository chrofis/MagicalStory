#!/usr/bin/env node
/**
 * Trial idea call: wall time to first visible token and total, per reasoning
 * effort, on the real builder + the real streaming call (PAID: ~USD 0.01-0.05
 * per call; sequential on purpose so runs do not share a rate limit).
 *
 *   node tests/manual/trial-idea-effort.js <template> <arm:local|fantasy> <effort|default> <runs> <outFile>
 *
 * The cell is fixed: a 7-year-old boy, wizard theme, life-challenge
 * "reading-alone", own town with three landmarks. Results are appended to the
 * outFile as JSON lines (evals/runs/2026-10-08_trial-idea-causal/).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const pb = require(path.join(ROOT, 'server/lib/promptBuilders'));
const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
const { getTrialCostumeForStory } = require(path.join(ROOT, 'server/config/trialCostumes'));
const { getLanguageInstruction } = require(path.join(ROOT, 'server/lib/languages'));
const { getTrialTitle } = require(path.join(ROOT, 'server/config/trialTitles'));
const { buildSeasonInstruction } = require(path.join(ROOT, 'server/lib/season'));
const { priceUsage } = require(path.join(ROOT, 'server/config/models'));

const [tplFile, arm, effort, runsArg, outFile] = process.argv.slice(2);
const runs = Number(runsArg) || 1;

function build(tpl) {
  const category = 'life-challenge', topic = 'reading-alone', theme = 'wizard', gender = 'male';
  return pb.buildTrialIdeaPrompts({
    template: tpl,
    characters: [{ name: 'Lukas', age: 7, gender, traits: [] }],
    charDesc: 'Lukas, 7 years old, male',
    categoryContext: pb.buildTrialLifeChallengeContext ? pb.buildTrialLifeChallengeContext(topic, theme) : null,
    landmarksText: pb.trialIdeaLandmarksText(['Ruine Stein', 'Stadtturm', 'Holzbrücke']),
    townName: 'Baden',
    storyTheme: theme,
    trialTitle: getTrialTitle(topic, category, gender, 'de-ch'),
    langInstruction: getLanguageInstruction('de-ch'),
    seasonInstruction: buildSeasonInstruction({}),
    ideaCostume: getTrialCostumeForStory({ storyCategory: category, storyTheme: theme, storyTopic: topic, gender }),
  })[arm];
}

(async () => {
  const tpl = fs.readFileSync(path.resolve(tplFile), 'utf8');
  for (let i = 0; i < runs; i++) {
    const prompt = build(tpl);
    const t0 = Date.now();
    let first = null;
    const r = await callTextModelStreaming(prompt, null, () => { if (first === null) first = Date.now() - t0; }, 'claude-sonnet',
      { usageLabel: 'trial_idea_effort', ...(effort !== 'default' ? { effort } : {}) });
    const row = { tpl: path.basename(tplFile), arm, effort, firstMs: first, totalMs: Date.now() - t0, out: r.usage?.output_tokens, in: r.usage?.input_tokens, usd: priceUsage(r.modelId || 'claude-sonnet-5-5', r.usage || {}), text: r.text };
    fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
    console.log(`${effort} ${arm} first=${row.firstMs}ms total=${row.totalMs}ms out=${row.out} usd=${row.usd}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
