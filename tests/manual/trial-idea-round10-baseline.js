/**
 * Round 10 BASELINE arm, rebuilt from the PRE-COMMIT template.
 *
 * The first attempt derived the baseline by deleting the self-check block from
 * the new prompt — which left the template's opening line ("...and then its
 * check block") with nothing to refer to, and the model invented a sprawling
 * self-audit of its own. That is not the before state. This run builds from
 * `git show f26c364d8^:prompts/trial-idea.txt`, the template as it stood before
 * the change, so the baseline is the real one.
 *
 *   node tests/manual/trial-idea-round10-baseline.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const oldTpl = fs.readFileSync(path.join(__dirname, 'trial-idea-precommit.txt'), 'utf8');
const pb = require(path.join(ROOT, 'server/lib/promptBuilders'));
const chk = require(path.join(ROOT, 'server/lib/trialIdeaCheck'));
const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
const { getLanguageInstruction } = require(path.join(ROOT, 'server/lib/languages'));
const { buildThemePlaySentence } = require(path.join(ROOT, 'server/config/storyThemes'));
const { buildSeasonInstruction } = require(path.join(ROOT, 'server/lib/season'));
const { getTrialTitle } = require(path.join(ROOT, 'server/config/trialTitles'));
const { getTrialCostumeForStory } = require(path.join(ROOT, 'server/config/trialCostumes'));

const MODEL = 'claude-sonnet';
const CELLS = require('./round10-cells.json');

function categoryContextFor(topic, theme) {
  const themeSentence = buildThemePlaySentence(theme);
  const guide = pb.getTeachingGuide('life-challenge', topic);
  return `This is a life skills story about "${topic}". The idea names one outside event that forces the child to use this skill — something that happens in the world, never a feeling on its own — and what it costs them.${themeSentence ? ` ${themeSentence}` : ''}${guide ? `\nGuidance for this topic:\n${String(guide).trim()}` : ''}`;
}

async function runCell(cell, out) {
  const args = {
    template: oldTpl,
    characters: [{ name: cell.name, age: cell.age, gender: cell.gender }],
    charDesc: `${cell.name}, ${cell.age} years old, ${cell.gender}`,
    categoryContext: categoryContextFor(cell.topic, cell.theme),
    landmarksText: 'At least one scene must take place at one of these real local landmarks: Reformierte Kirche Fislisbach, Schulhaus Birch, Waldhütte Fislisbach.',
    townName: 'Fislisbach',
    storyTheme: cell.theme,
    trialTitle: getTrialTitle(cell.topic, 'life-challenge', cell.gender, 'de'),
    langInstruction: getLanguageInstruction('de'),
    seasonInstruction: buildSeasonInstruction({}),
    ideaCostume: getTrialCostumeForStory({ storyCategory: 'life-challenge', storyTheme: cell.theme, storyTopic: cell.topic, gender: cell.gender }),
  };
  const prompts = pb.buildTrialIdeaPrompts(args);
  const row = { cell, arms: {} };
  for (const arm of ['local', 'fantasy']) {
    const p = prompts[arm].replace(`\n\n${chk.TRIAL_IDEA_SELF_CHECK_RULE}`, '');
    if (p.includes('CHECK')) throw new Error('baseline prompt still mentions a check block');
    const r = await callTextModelStreaming(p, null, null, MODEL, { usageLabel: 'trial_idea_round10_baseline' });
    row.arms[arm] = { idea: String(r.text || '').trim(), usage: r.usage };
  }
  out.push(row);
  process.stderr.write(`baseline ${cell.name}/${cell.topic} done\n`);
}

(async () => {
  const out = [];
  for (let i = 0; i < CELLS.length; i += 4) {
    await Promise.all(CELLS.slice(i, i + 4).map(c => runCell(c, out)));
  }
  out.sort((a, b) => CELLS.findIndex(c => c.name === a.cell.name) - CELLS.findIndex(c => c.name === b.cell.name));
  fs.writeFileSync(path.join(__dirname, 'round10-baseline.json'), JSON.stringify({ cells: out }, null, 2));
  console.log('written round10-baseline.json');
})().catch(e => { console.error(e); process.exit(1); });
