#!/usr/bin/env node
/**
 * Render the trial idea-generation prompt for both costume branches, offline.
 *
 * Reproduces the composition in server/routes/trial.js POST
 * /api/trial/generate-ideas-stream (template + local/fantasy branch suffix) and
 * diffs the costume-available branch against the pre-gate wording, so the gate
 * can be verified without a paid call.
 *
 *   node tests/manual/render-trial-idea-prompt.js
 */
const { PROMPT_TEMPLATES, fillTemplate, loadPromptTemplates } = require('../../server/services/prompts');
const { buildAgeModeSection, buildTrialIdeaCostumeInstructions } = require('../../server/lib/promptBuilders');
const { getTrialCostumeForStory } = require('../../server/config/trialCostumes');
const { getLanguageInstruction } = require('../../server/lib/languages');
const { getTrialTitle } = require('../../server/config/trialTitles');

// Stored inputs of prod job_1788698812047_q5b1vuds7 (costume-less) and the same
// wizard shape on a theme that has a costume.
const CASES = [
  { label: 'costume-less (prod job_1788698812047_q5b1vuds7)', storyCategory: 'adventure', storyTheme: 'mothers-day', storyTopic: '' },
  { label: 'costume available', storyCategory: 'adventure', storyTheme: 'pirate', storyTopic: '' },
];

const characters = [{ name: 'MAIN', age: 1, gender: 'male', traits: [] }];
const language = 'de-ch';

function render({ storyCategory, storyTheme, storyTopic }) {
  const mainChar = characters[0];
  const charDesc = `${mainChar.name}, ${mainChar.age} years old, ${mainChar.gender}`;
  const categoryContext = `This is a ${storyTheme || 'adventure'} story${storyTopic ? ` about "${storyTopic}"` : ''}. Make it exciting and appropriate for children.`;
  const mainGender = mainChar.gender;
  const costume = getTrialCostumeForStory({ storyCategory, storyTheme, storyTopic, gender: mainGender });
  const { costumeRule, themeShows, fantasyOpening } = buildTrialIdeaCostumeInstructions(costume);
  const landmarksText = 'At least one scene must take place at one of these real local landmarks: LANDMARK A, LANDMARK B.';

  const prompt1 = fillTemplate(PROMPT_TEMPLATES.trialIdea, {
    CHARACTER: charDesc,
    CATEGORY_CONTEXT: categoryContext,
    TITLE: getTrialTitle(storyTopic, storyCategory, mainGender, language) || '',
    LANDMARKS: '',
    LANG_INSTRUCTION: getLanguageInstruction(language),
    AGE_MODE: buildAgeModeSection({ characters }),
    COSTUME_RULE: costumeRule,
  });
  const localIdea = `\n${landmarksText}\nSet this idea in the child's own town, at the real local places named above. ${themeShows} — the play is the story, never a trip somewhere else.`;
  const fantasyIdea = `\nGenerate a DIFFERENT idea than the first one, set in a make-believe ${storyTheme && storyTheme !== 'realistic' ? storyTheme + ' ' : ''}world. It opens where the child really is — ${fantasyOpening} — and the make-believe follows from that; the world it enters has no real place names.`;
  return { costume, local: prompt1 + localIdea, fantasy: prompt1 + fantasyIdea };
}

async function main() {
for (const c of CASES) {
  const r = render(c);
  console.log('='.repeat(78));
  console.log(`${c.label} — costume: ${r.costume ? r.costume.costumeType : 'none'}`);
  console.log('='.repeat(78));
  console.log('--- IDEA 1 (own town) ---');
  console.log(r.local);
  console.log('--- IDEA 2 (make-believe) — differing tail only ---');
  console.log(r.fantasy.slice(r.fantasy.lastIndexOf('\nGenerate a DIFFERENT')));
  console.log();
}

// Costume-available branch must render exactly as before the gate.
const pirate = render(CASES[1]);
const legacyTemplate = PROMPT_TEMPLATES.trialIdea.replace('{COSTUME_RULE}', '');
const legacyPrompt1 = fillTemplate(legacyTemplate, {
  CHARACTER: 'MAIN, 1 years old, male',
  CATEGORY_CONTEXT: 'This is a pirate story. Make it exciting and appropriate for children.',
  TITLE: getTrialTitle('', 'adventure', 'male', language) || '',
  LANDMARKS: '',
  LANG_INSTRUCTION: getLanguageInstruction(language),
  AGE_MODE: buildAgeModeSection({ characters }),
});
const legacyLocal = legacyPrompt1 + `\nAt least one scene must take place at one of these real local landmarks: LANDMARK A, LANDMARK B.\nSet this idea in the child's own town, at the real local places named above. A costume or theme shows in what they wear and how they play — the play is the story, never a trip somewhere else.`;
const legacyFantasy = legacyPrompt1 + `\nGenerate a DIFFERENT idea than the first one, set in a make-believe pirate world. It opens where the child really is — dressing up, or starting to play — and the make-believe follows from that; the world it enters has no real place names.`;
console.log('costume branch byte-identical to pre-gate wording:',
  pirate.local === legacyLocal && pirate.fantasy === legacyFantasy);
}
loadPromptTemplates().then(main).catch(e => { console.error(e); process.exit(1); });
