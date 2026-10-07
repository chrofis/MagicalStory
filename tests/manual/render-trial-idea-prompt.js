#!/usr/bin/env node
/**
 * Render the two trial idea prompts (own town / make-believe) offline, for
 * both costume branches, exactly as production sends them.
 *
 * The assembly is buildTrialIdeaPrompts (server/lib/promptBuilders.js) — the
 * ONE function the /try route (server/routes/trial.js POST
 * /api/trial/generate-ideas-stream) and the Lab's variety stage call. This
 * harness only supplies the route's inputs (character line, category context,
 * landmark text, title, season, costume) and prints the result, so a
 * prompts/trial-idea.txt change can be read here without a paid call.
 * No network: the landmark names are fixed instead of resolved from the index.
 *
 *   node tests/manual/render-trial-idea-prompt.js
 */
const { loadPromptTemplates } = require('../../server/services/prompts');
const { buildTrialIdeaPrompts, trialIdeaLandmarksText } = require('../../server/lib/promptBuilders');
const { getTrialCostumeForStory } = require('../../server/config/trialCostumes');
const { getLanguageInstruction } = require('../../server/lib/languages');
const { getTrialTitle } = require('../../server/config/trialTitles');
const { buildSeasonInstruction } = require('../../server/lib/season');

// Stored inputs of prod job_1788698812047_q5b1vuds7 (costume-less) and the same
// wizard shape on a theme that has a costume.
const CASES = [
  { label: 'costume-less (prod job_1788698812047_q5b1vuds7)', storyCategory: 'adventure', storyTheme: 'mothers-day', storyTopic: '' },
  { label: 'costume available', storyCategory: 'adventure', storyTheme: 'pirate', storyTopic: '' },
];

const characters = [{ name: 'MAIN', age: 1, gender: 'male', traits: [] }];
const language = 'de-ch';
const townName = 'TOWN';

function render({ storyCategory, storyTheme, storyTopic }) {
  const mainChar = characters[0];
  // Route-mirror inputs (server/routes/trial.js), generic adventure branch.
  const charDesc = `${mainChar.name}, ${mainChar.age} years old, ${mainChar.gender}`;
  const categoryContext = `This is a ${storyTheme || 'adventure'} story${storyTopic ? ` about "${storyTopic}"` : ''}. Make it exciting and appropriate for children.`;
  const ideaCostume = getTrialCostumeForStory({ storyCategory, storyTheme, storyTopic, gender: mainChar.gender });
  const prompts = buildTrialIdeaPrompts({
    characters,
    charDesc,
    categoryContext,
    landmarksText: trialIdeaLandmarksText(['LANDMARK A', 'LANDMARK B']),
    townName,
    storyTheme,
    trialTitle: getTrialTitle(storyTopic, storyCategory, mainChar.gender, language),
    langInstruction: getLanguageInstruction(language),
    seasonInstruction: storyCategory === 'historical' ? '' : buildSeasonInstruction({}),
    ideaCostume,
  });
  return { costume: ideaCostume, ...prompts };
}

async function main() {
  let unfilled = 0;
  for (const c of CASES) {
    const r = render(c);
    console.log('='.repeat(78));
    console.log(`${c.label} — costume: ${r.costume ? r.costume.costumeType : 'none'} — axes: local=${r.axes.local.want}/${r.axes.local.shape}, fantasy=${r.axes.fantasy.want}/${r.axes.fantasy.shape}`);
    console.log('='.repeat(78));
    console.log('--- IDEA 1 (own town) ---');
    console.log(r.local);
    console.log('--- IDEA 2 (make-believe) ---');
    console.log(r.fantasy);
    console.log();
    for (const [arm, text] of [['local', r.local], ['fantasy', r.fantasy]]) {
      const left = text.match(/\{[A-Z_]+\}/g) || [];
      if (left.length) { unfilled += left.length; console.error(`UNFILLED placeholders in ${c.label} / ${arm}: ${left.join(' ')}`); }
    }
  }
  console.log('unfilled placeholders:', unfilled);
  if (unfilled) process.exit(1);
}
loadPromptTemplates().then(main).catch(e => { console.error(e); process.exit(1); });
