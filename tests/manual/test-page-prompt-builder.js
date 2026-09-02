// Unit test: PAGE image-prompt builder hygiene — siblings of the cover-prompt
// fixes (see tests/manual/test-cover-prompt-builder.js and docs/decisions.md
// 2026-07-31 entries). Covers the owner-reported defects on a real German
// story's page prompt:
//   1. worn-vs-held guard on the injected CLOTHING wears-lines (an item the
//      scene holds/drops is never ALSO described as worn)
//   2. English-only entity refs (no story-language VB names, no internal
//      entry names with "(WearerName)" parentheticals, English-only
//      REQUIRED OBJECTS header)
//   3. facing boilerplate subordinated to the scene's declared facing
//   4. state-aware REQUIRED OBJECTS descriptions (no "tied at the neck" for
//      an item the scene holds overhead)
const path = require('path');
process.chdir(path.join(__dirname, '..', '..'));

const {
  buildImagePrompt,
  textDeclaresNonWornPlacement,
  sceneDeclaresNonWornState,
  stripWornStateFromDescription,
  sanitizeVbIdsInPrompt,
} = require('../../server/lib/storyHelpers');
const { buildVisualBiblePrompt } = require('../../server/lib/visualBible');
const { loadPromptTemplates } = require('../../server/services/prompts');

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
}

// ---- Synthetic German-named story fixtures (archetypal, no real story) ----
const visualBible = {
  mainCharacters: [],
  secondaryCharacters: [],
  animals: [
    { id: 'ANI001', name: 'Flocke', description: 'a small white rabbit with one grey ear' },
  ],
  vehicles: [],
  clothing: [
    {
      id: 'CLO001',
      // German internal entry name INCLUDING the wearer parenthetical (the VB
      // clothing name convention appends the character name).
      name: 'Roter Superhelden-Umhang (Hero)',
      description: 'A red superhero cape with golden trim, tied at the neck',
      wornBy: 'Hero',
    },
  ],
  artifacts: [
    { id: 'ART001', name: 'Schere', description: 'a pair of silver scissors with star-shaped handles' },
  ],
  locations: [
    {
      id: 'LOC001',
      name: 'Sommergarten',
      description: 'a sunlit garden with flowering arbors and a stone fountain',
      signatureElement: 'a rose-covered archway',
    },
  ],
};

// Scene: the worn-category cape is HELD OVERHEAD (off-body), and the hero
// explicitly faces the camera.
const prose = 'Hero — a slim school-age boy with short brown hair — stands in the centre foreground of LOC001, '
  + 'facing the camera, holding his red superhero cape overhead in both hands as it catches the wind. '
  + 'Beside him lies a pair of silver scissors with star-shaped handles on the grass.';
const metadataJson = JSON.stringify({
  characters: [
    { name: 'Hero', position: 'center foreground', clothing: 'costumed', depth: 'foreground', expression: 'delighted, broad smile' },
  ],
  objects: ['LOC001', 'CLO001', 'ART001'],
  interactions: [
    { character: 'Hero', object: 'the red superhero cape', where: 'held overhead in both hands', storyRelevant: true, priority: 'essential' },
  ],
  background: 'sunlit garden, gentle breeze',
  setting: 'outdoor',
  shot: 'medium',
  textPosition: 'bottom-left',
});
const sceneDescription = `${prose}\n\n---METADATA---\n${metadataJson}`;

const inputData = {
  language: 'de',
  artStyle: 'pixar',
  characters: [{ name: 'Hero', age: '8', gender: 'male' }],
};
const sceneCharacters = [{ name: 'Hero', age: '8', gender: 'male' }];
const referencePhotos = [{
  name: 'Hero',
  clothingCategory: 'costumed',
  // Clothing augmentation pasted the worn CLO entry raw, incl. the German
  // name + parenthetical — exactly the observed defect.
  clothingDescription: 'blue t-shirt, Roter Superhelden-Umhang (Hero) tied around his neck, dark trousers',
}];

// ---- Low-level guards ----
console.log('\n--- textDeclaresNonWornPlacement ---');
check(textDeclaresNonWornPlacement('held overhead in both hands'), 'held overhead = off-body');
check(textDeclaresNonWornPlacement('the cape lies crumpled on the ground'), 'lying on the ground = off-body');
check(textDeclaresNonWornPlacement('the cape draped over the chair'), 'draped over furniture = off-body');
check(!textDeclaresNonWornPlacement('the cape draped over his shoulders'), 'draped over shoulders = still worn');
check(!textDeclaresNonWornPlacement('a red cape tied at the neck'), 'plain worn description = not off-body');

console.log('\n--- sceneDeclaresNonWornState ---');
const meta = JSON.parse(metadataJson);
check(sceneDeclaresNonWornState(visualBible.clothing[0], prose, meta.interactions),
  'cape (CLO001) detected as scene-placed off-body');
check(!sceneDeclaresNonWornState(visualBible.artifacts[0], 'Hero wears the scissors charm on a cord', []),
  'unrelated worn phrasing does not flag off-body');

console.log('\n--- stripWornStateFromDescription ---');
const stripped = stripWornStateFromDescription(visualBible.clothing[0].description);
console.log(`  "${stripped}"`);
check(!/tied|neck/i.test(stripped), 'attachment clause removed');
check(/red superhero cape with golden trim/i.test(stripped), 'physical features preserved');

// (filterWornClothingAgainstScene was deleted 2026-08-09, commit 5f174cba5 —
// worn-vs-held faults route to the scene review now. Its section is gone;
// the test file had kept importing it and was broken from that commit on.)

// ---- sanitizeVbIdsInPrompt: English-only substitutions ----
console.log('\n--- sanitizeVbIdsInPrompt ---');
const sanitized = sanitizeVbIdsInPrompt('Hero holds CLO001 while Flocke (ANI001) hops past ART001 near LOC001.', visualBible, 7);
console.log(`  "${sanitized}"`);
check(!/CLO001|ART001|LOC001|ANI001/.test(sanitized), 'all VB ids resolved');
check(!/Roter Superhelden-Umhang|Schere(?!nschnitt)/.test(sanitized), 'German artifact/clothing names not substituted');
check(/red superhero cape/i.test(sanitized), 'CLO id resolved to English ref');
check(/silver scissors/i.test(sanitized), 'ART id resolved to English ref');
check(/Flocke/.test(sanitized), 'animal keeps its given name');
check(/Sommergarten \(/.test(sanitized), 'location name only appears WITH inlined English visuals');

// ---- Fallback VB section: English-only ----
console.log('\n--- buildVisualBiblePrompt (fallback section) ---');
const vbSection = buildVisualBiblePrompt(visualBible, 3, null, 'de');
console.log(vbSection);
check(!/VISUELLE|REFERENZELEMENTE/.test(vbSection), 'no German intro text');
check(!/\*\*Roter Superhelden-Umhang|\*\*Schere\*\*/.test(vbSection), 'no German entity lead-ins');
check(/Flocke/.test(vbSection), 'animal keeps its given name in fallback section');

// ---- Full page prompt (template path) ----
(async () => {
  await loadPromptTemplates();
  console.log('\n--- buildImagePrompt (assembled page prompt, de story) ---');
  const prompt = buildImagePrompt(sceneDescription, inputData, sceneCharacters, visualBible, 7, referencePhotos, {});
  console.log(prompt);

  // (2) English-only: no raw German VB names, no parenthetical entry names
  check(!/Roter Superhelden-Umhang/.test(prompt), 'German clothing entry name absent from page prompt');
  check(!/\bSchere\b/.test(prompt), 'German artifact name absent from page prompt');
  check(!/Sommergarten(?!\s*\()/.test(prompt), 'location name never appears without inlined English visuals');
  check(!/\(Hero\)(?!:)/.test(prompt.replace(/\[Hero\]/g, '')), 'no "(WearerName)" parenthetical entry name');
  check(/\*\*REQUIRED OBJECTS IN THIS SCENE/.test(prompt), 'REQUIRED OBJECTS header is English for a German story');
  check(!/ERFORDERLICHE OBJEKTE/.test(prompt), 'no German REQUIRED OBJECTS header');

  // (1) worn-vs-held: the held cape is never re-attached by a wears-line
  const wearsLine = (prompt.match(/- Hero wears: .*/i) || [''])[0];
  console.log(`  wears-line: "${wearsLine}"`);
  check(wearsLine.length > 0, 'wears-line backstop still fires for garments the prose omits');
  check(!/cape|Umhang|tied|neck/i.test(wearsLine), 'wears-line does not re-attach the held cape');
  check(/blue t-shirt/.test(wearsLine), 'wears-line keeps the genuinely worn garments');

  // (4) state-aware REQUIRED OBJECTS: no worn-state contradiction
  const reqSection = (prompt.match(/\*\*REQUIRED OBJECTS[\s\S]*?(?=\n\n)/) || [''])[0];
  console.log(`  required objects:\n${reqSection}`);
  check(!/tied at the neck|tied around/i.test(reqSection), 'REQUIRED OBJECTS omit the attachment clause for the held cape');
  check(!/worn by/i.test(reqSection), 'no "(worn by …)" suffix for an off-body item');
  check(/red superhero cape/i.test(reqSection), 'cape still listed (as English ref) in REQUIRED OBJECTS');
  check(/silver scissors/i.test(reqSection), 'artifact listed via English ref');

  // Scene's declared facing survives in the prose
  check(/facing the camera/.test(prompt), 'scene-declared facing retained in prose');

  // (3) template subordination text
  const { PROMPT_TEMPLATES } = require('../../server/services/prompts');
  check(/UNLESS the scene description explicitly declares a facing/.test(PROMPT_TEMPLATES.imageGeneration),
    'image-generation.txt subordinates the facing boilerplate to declared facings');
  check(/declared facing always wins/.test(PROMPT_TEMPLATES.imageGeneration),
    'image-generation.txt states the declared facing wins');

  // Root fix: unified templates mandate English VB fields
  const fs = require('fs');
  for (const tpl of ['prompts/story-unified.txt', 'prompts/story-unified-imagefirst.txt']) {
    const text = fs.readFileSync(tpl, 'utf8');
    check(/ENGLISH `name` and `description` for artifacts, locations, vehicles, and clothing/.test(text),
      `${tpl} mandates English VB name/description fields`);
  }

  // Control: a page where the cape is WORN keeps the worn description
  console.log('\n--- control: worn cape page ---');
  const wornProse = 'Hero — a slim school-age boy — walks through the garden, his red superhero cape tied at the neck fluttering behind him.';
  const wornMeta = JSON.stringify({
    characters: [{ name: 'Hero', position: 'center', clothing: 'costumed', depth: 'foreground' }],
    objects: ['CLO001'],
    interactions: [],
    textPosition: 'bottom-right',
  });
  const wornPrompt = buildImagePrompt(`${wornProse}\n\n---METADATA---\n${wornMeta}`, inputData, sceneCharacters, visualBible, 8, referencePhotos, {});
  const wornReq = (wornPrompt.match(/\*\*REQUIRED OBJECTS[\s\S]*?(?=\n\n)/) || [''])[0];
  // REQUIRED OBJECTS is a name-only checklist since 2026-09-02 — no VB
  // description reaches the image prompt, so there is no attachment clause
  // to keep. The (worn by …) suffix survives: it binds the garment to a
  // wearer, which the checklist still has to say.
  check(!/tied at the neck/i.test(wornReq), 'worn page carries no VB description in the checklist');
  check(/worn by Hero/.test(wornReq), 'worn page keeps the (worn by …) suffix');
  check(!/Roter Superhelden-Umhang/.test(wornPrompt), 'worn page still uses English entity ref');
  const wornWears = (wornPrompt.match(/- Hero wears: .*/i) || [''])[0];
  console.log(`  worn wears-line: "${wornWears}"`);
  check((wornWears.match(/\btied\b/gi) || []).length <= 1, 'worn wears-line does not duplicate the attachment clause');
  check(!/\(Hero\)/.test(wornWears), 'worn wears-line has no wearer parenthetical');

  console.log(failures === 0 ? '\n✓ all assertions passed' : `\n✗ ${failures} assertion(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
