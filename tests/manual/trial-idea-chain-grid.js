#!/usr/bin/env node
/**
 * Trial idea chain grid: 10 cells x 2 arms through the REAL builder and the
 * REAL streaming call at the production effort (PAID: ~USD 0.007 per call).
 *
 *   node tests/manual/trial-idea-chain-grid.js <label> <outFile> [builderModule] [templateFile]
 *
 * builderModule defaults to server/lib/promptBuilders; pass a path to compare an
 * older builder (the template defaults to prompts/trial-idea.txt). Each output
 * line records the axes, the raw text and the cell, so a run can be re-read.
 * Used for docs/decisions.md 2026-10-09 "Trial idea chain".
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const [label, outFile, builderArg, tplArg] = process.argv.slice(2);
const pb = require(builderArg ? path.resolve(builderArg) : path.join(ROOT, 'server/lib/promptBuilders'));
const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
const { getTrialCostumeForStory } = require(path.join(ROOT, 'server/config/trialCostumes'));
const { getLanguageInstruction } = require(path.join(ROOT, 'server/lib/languages'));
const { getTrialTitle } = require(path.join(ROOT, 'server/config/trialTitles'));
const { buildSeasonInstruction } = require(path.join(ROOT, 'server/lib/season'));
const { MODEL_DEFAULTS, priceUsage } = require(path.join(ROOT, 'server/config/models'));

const FIS = { town: 'Fislisbach', lm: ['Kirche Rohrdorf'] };
const BAD = { town: 'Baden', lm: ['Ruine Stein', 'Stadtturm', 'Holzbrücke'] };
const CELLS = [
  { n: 'Emma', age: 5, g: 'female', lang: 'de-ch', cat: 'adventure', topic: '', theme: '', ...FIS },
  { n: 'Noah', age: 4, g: 'male', lang: 'de-ch', cat: 'life-challenge', topic: 'first-kindergarten', theme: '', ...FIS },
  { n: 'Lily', age: 7, g: 'female', lang: 'en', cat: 'adventure', topic: '', theme: '', ...FIS },
  { n: 'Noah', age: 4, g: 'male', lang: 'de-ch', cat: 'life-challenge', topic: 'reading-alone', theme: 'wizard', ...BAD },
  { n: 'Tobias', age: 1, g: 'male', lang: 'de-ch', cat: 'adventure', topic: '', theme: 'pirate', ...FIS },
  { n: 'Mia', age: 2, g: 'female', lang: 'de-ch', cat: 'life-challenge', topic: 'going-outside', theme: '', ...FIS },
  { n: 'Ben', age: 4, g: 'male', lang: 'de-ch', cat: 'life-challenge', topic: 'sharing', theme: '', ...BAD },
  { n: 'Sara', age: 8, g: 'female', lang: 'de-ch', cat: 'life-challenge', topic: 'dealing-bully', theme: '', ...BAD },
  { n: 'Jonas', age: 8, g: 'male', lang: 'en', cat: 'life-challenge', topic: 'not-giving-up', theme: '', ...BAD },
  { n: 'Anna', age: 3, g: 'female', lang: 'de-ch', cat: 'life-challenge', topic: 'waiting-turn', theme: '', ...FIS },
];

(async () => {
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const tpl = fs.readFileSync(path.resolve(tplArg || path.join(ROOT, 'prompts/trial-idea.txt')), 'utf8');
  for (const [i, c] of CELLS.entries()) {
    const category = c.cat, topic = c.topic, theme = c.theme;
    const prompts = pb.buildTrialIdeaPrompts({
      template: tpl,
      characters: [{ name: c.n, age: c.age, gender: c.g, traits: [] }],
      charDesc: `${c.n}, ${c.age} years old, ${c.g}`,
      categoryContext: category === 'life-challenge'
        ? pb.buildTrialLifeChallengeContext(topic, theme)
        : `This is a ${theme || 'adventure'} story${topic ? ` about "${topic}"` : ''}. Make it exciting and appropriate for children.`,
      landmarksText: pb.trialIdeaLandmarksText(c.lm),
      townName: c.town,
      storyTheme: theme,
      trialTitle: getTrialTitle(topic, category, c.g, c.lang),
      langInstruction: getLanguageInstruction(c.lang),
      seasonInstruction: buildSeasonInstruction({}),
      ideaCostume: getTrialCostumeForStory({ storyCategory: category, storyTheme: theme, storyTopic: topic, gender: c.g }),
    });
    for (const arm of ['local', 'fantasy']) {
      const r = await callTextModelStreaming(prompts[arm], null, null, 'claude-sonnet',
        { usageLabel: 'trial_idea_chain_grid', effort: MODEL_DEFAULTS.trialIdeaEffort });
      const row = { label, cell: i, arm, c, axis: prompts.axes[arm], usd: priceUsage(r.modelId || 'claude-sonnet-5-5', r.usage || {}), text: r.text };
      fs.appendFileSync(outFile, JSON.stringify(row) + '\n');
      console.log(`${label} cell ${i} ${arm} usd=${row.usd}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
