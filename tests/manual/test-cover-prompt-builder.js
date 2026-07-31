// Unit test: cover image-prompt builder hygiene (deterministic pieces).
// Covers the five owner-reported defects + English-only emission:
//   1. KEY STORY ELEMENTS filtered to the cover hint's objects ∪ holds
//   2. worn-vs-held dedupe (an item is never BOTH clothing and artifact)
//   3. group-composition boilerplate conditional on cast size (3+ only)
//   4. full-bleed / no-text rules stated exactly once per template
//   5. apparent-age buckets instead of numeric ages
//   6. English-only prompts (no story-language VB names, no story-language mood)
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const {
  buildCoverSceneFromHint,
  collectCoverHintElementIds,
  applyCoverWornHeldDedupe,
  buildInitialPageComposition,
  englishEntityRef,
} = require('../../server/lib/coverIterate');
const { buildFullVisualBiblePrompt } = require('../../server/lib/visualBible');
const { loadPromptTemplates, PROMPT_TEMPLATES, fillTemplate } = require('../../server/services/prompts');

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}
const count = (text, re) => (String(text).match(re) || []).length;

// ---- Synthetic German-language story fixtures (archetypal, no real story) ----
const visualBible = {
  mainCharacters: [],
  secondaryCharacters: [],
  animals: [],
  vehicles: [],
  clothing: [],
  locations: [
    {
      id: 'LOC001',
      name: 'Sommergarten', // invented German proper noun — carries no visual info
      features: 'flowering arbors and a stone fountain',
      colors: 'soft green and cream',
      signatureElement: 'a rose-covered archway',
    },
  ],
  artifacts: [
    // STRAY — exists in the VB but the cover hint never asks for it
    { id: 'ART001', name: 'Zauberschere', description: 'a pair of silver scissors with star-shaped handles' },
    // HELD by the child per the hint — also overlaps the child's worn outfit
    { id: 'ART002', name: 'Roter Umhang', description: 'A red handmade cape with golden trim and a round clasp' },
    // WORN by the parent (listed in objects, held by nobody)
    { id: 'ART003', name: 'Blauer Schal', description: 'a blue knitted scarf with a white snowflake pattern' },
  ],
};

const hint = {
  mood: 'Abenteuer beginnt', // German, model-authored — must NOT reach the prompt
  objects: ['LOC001', 'ART002', 'ART003'],
  characters: ['Child', 'Parent'],
  characterDetails: {
    Child: { name: 'Child', position: 'center foreground', holds: 'ART002', priority: 'essential' },
    Parent: { name: 'Parent', position: 'left midground', holds: 'nothing', priority: 'normal' },
  },
  characterClothing: { Child: 'standard', Parent: 'standard' },
};

const characters = [
  { name: 'Child', age: '8', gender: 'male' },
  { name: 'Parent', age: '45', gender: 'male' },
];

// ---- 1+6. Scene prose: buckets, English holds, mood gate, location visuals ----
console.log('\n--- buildCoverSceneFromHint (language: de) ---');
const sceneDe = buildCoverSceneFromHint(hint, visualBible, characters, { language: 'de' });
console.log(sceneDe);
check(!/\d+\s*-\s*year-old|\d+-year-old/.test(sceneDe), 'no numeric age in scene prose');
check(sceneDe.includes('young school age boy'), 'child described via apparent-age bucket');
check(sceneDe.includes('middle aged man'), 'parent described via apparent-age bucket');
check(!sceneDe.includes('Roter Umhang'), 'German artifact name absent from prose');
check(/holds the red handmade cape/i.test(sceneDe), 'held item referenced via English description');
check(!/Abenteuer/.test(sceneDe), 'German mood dropped for non-English story');
check(sceneDe.includes('Sommergarten (flowering arbors and a stone fountain; soft green and cream; a rose-covered archway)'),
  'location name carries inline English features/colors');
check(!/ART\d+/.test(sceneDe), 'no raw VB id in prose');

const sceneEn = buildCoverSceneFromHint({ ...hint, mood: 'wonder and discovery' }, visualBible, characters, { language: 'en' });
check(sceneEn.startsWith('Wonder and discovery.'), 'English mood kept for English story');

// ---- 2. Worn-vs-held dedupe ----
console.log('\n--- applyCoverWornHeldDedupe ---');
const photos = [
  { name: 'Child', clothingDescription: 'red t-shirt, a red handmade cape tied at the neck, blue trousers' },
  { name: 'Parent', clothingDescription: 'green jacket, blue knitted scarf with a snowflake pattern, brown boots' },
];
const { photos: deduped, excludeElementIds } = applyCoverWornHeldDedupe(photos, hint, visualBible);
console.log(JSON.stringify(deduped.map(p => p.clothingDescription), null, 1));
console.log('excludeElementIds:', excludeElementIds);
check(!/cape/i.test(deduped[0].clothingDescription), 'held cape removed from clothing line (worst contradiction resolved)');
check(/red t-shirt/.test(deduped[0].clothingDescription) && /blue trousers/.test(deduped[0].clothingDescription),
  'unrelated clothing segments preserved');
check(/scarf/.test(deduped[1].clothingDescription), 'worn (not held) scarf stays in the clothing line');
check(excludeElementIds.includes('ART003'), 'worn-not-held artifact excluded from KEY STORY ELEMENTS');
check(!excludeElementIds.includes('ART002'), 'held artifact NOT excluded (it may appear as a reference)');
check(photos[0].clothingDescription.includes('cape'), 'input photos not mutated');

// ---- 1. KEY STORY ELEMENTS filter ----
console.log('\n--- buildFullVisualBiblePrompt filter ---');
const allowedIds = collectCoverHintElementIds(hint);
check(JSON.stringify(allowedIds.slice().sort()) === JSON.stringify(['ART002', 'ART003', 'LOC001']),
  `hint ids collected (objects ∪ holds): ${allowedIds.join(',')}`);
const vbFiltered = buildFullVisualBiblePrompt(visualBible, {
  skipMainCharacters: true,
  allowedElementIds: allowedIds,
  excludeElementIds,
});
console.log(vbFiltered);
check(!/scissors|Zauberschere/.test(vbFiltered), 'stray artifact (not in hint) excluded');
check(/red handmade cape/.test(vbFiltered), 'held artifact description present');
check(!/snowflake/.test(vbFiltered), 'worn artifact excluded (already in CLOTHING block)');
check(!/Roter Umhang/.test(vbFiltered), 'German artifact name absent — English generic lead-in used');
const vbLegacy = buildFullVisualBiblePrompt(visualBible, { skipMainCharacters: true });
check(/scissors/.test(vbLegacy), 'legacy hint-less path keeps unfiltered dump');

// ---- 6. englishEntityRef fallback ----
check(englishEntityRef({ name: 'Goldene Medaille' }, 'object') === 'object',
  'entity without description falls back to generic English noun');

// ---- 3. Conditional group composition ----
console.log('\n--- buildInitialPageComposition ---');
const g1 = buildInitialPageComposition(1);
const g2 = buildInitialPageComposition(2);
const g3 = buildInitialPageComposition(3);
check(!/GROUP scene|AROUND/.test(g2) && /EXACTLY the two/.test(g2), '2 chars: no group boilerplate, exact-count rule');
check(!/GROUP scene|AROUND/.test(g1) && /single character/.test(g1), '1 char: no group boilerplate');
check(/GROUP scene/.test(g3) && /CENTER/.test(g3) && /AROUND/.test(g3), '3 chars: group boilerplate present');

// ---- 4+5. Templates: single full-bleed/no-text statement; textless derivation ----
(async () => {
  await loadPromptTemplates();
  console.log('\n--- template dedupe + textless variants ---');
  const tpls = {
    frontCover: PROMPT_TEMPLATES.frontCover,
    backCover: PROMPT_TEMPLATES.backCover,
    initialPageNoDedication: PROMPT_TEMPLATES.initialPageNoDedication,
    initialPageWithDedication: PROMPT_TEMPLATES.initialPageWithDedication,
  };
  for (const [name, tpl] of Object.entries(tpls)) {
    check(count(tpl, /\*\*FRAMING:\*\*/g) === 0, `${name}: FRAMING section merged away`);
    check(count(tpl, /full-bleed/gi) === 1, `${name}: exactly one full-bleed statement`);
    check(count(tpl, /torn-paper/gi) === 1, `${name}: framing specifics stated once`);
  }
  check(count(tpls.initialPageNoDedication, /no title/gi) === 1, 'initial-no-dedication: no-text rule stated once');
  check(!/\*\*Notes:\*\*/.test(tpls.initialPageNoDedication), 'initial-no-dedication: Notes section merged away');
  check(tpls.initialPageNoDedication.includes('{GROUP_COMPOSITION}')
    && tpls.initialPageWithDedication.includes('{GROUP_COMPOSITION}'), 'initial templates carry GROUP_COMPOSITION placeholder');

  // Textless derivations must still strip the text-baking section (it is now
  // the LAST **section** before {VISUAL_BIBLE}).
  check(!/Paint "/.test(PROMPT_TEMPLATES.frontCoverTextless) && /\*\*NO TEXT:\*\*/.test(PROMPT_TEMPLATES.frontCoverTextless),
    'frontCoverTextless: TITLE section replaced by NO TEXT');
  check(PROMPT_TEMPLATES.frontCoverTextless.includes('{VISUAL_BIBLE}'), 'frontCoverTextless keeps VISUAL_BIBLE placeholder');
  check(!/magicalstory\.ch/.test(PROMPT_TEMPLATES.backCoverTextless) && /\*\*NO TEXT:\*\*/.test(PROMPT_TEMPLATES.backCoverTextless),
    'backCoverTextless: TEXT section replaced by NO TEXT');

  // ---- End-to-end: assembled initial-page prompt for a 2-character German cover ----
  console.log('\n--- assembled initial-page prompt (2 chars, de) ---');
  const prompt = fillTemplate(tpls.initialPageNoDedication, {
    INITIAL_PAGE_SCENE: sceneDe,
    STYLE_DESCRIPTION: 'test style',
    CHARACTER_REFERENCE_LIST: '\n**CHARACTER REFERENCE PHOTOS (one per character, labeled images attached below):** [Child], [Parent]\n',
    GROUP_COMPOSITION: g2,
    VISUAL_BIBLE: vbFiltered,
  });
  check(count(prompt, /full-bleed/gi) === 1, 'assembled prompt: one full-bleed statement');
  check(!/GROUP scene|arranged AROUND/.test(prompt), 'assembled prompt: no group boilerplate at 2 chars');
  check(!/Roter Umhang|Zauberschere|Abenteuer/.test(prompt), 'assembled prompt: no German VB name / mood');
  check(!/\d+-year-old/.test(prompt), 'assembled prompt: no numeric age');

  console.log(failures === 0 ? '\n✓ all assertions passed' : `\n✗ ${failures} assertion(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
