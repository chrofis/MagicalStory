/**
 * Image-first prompt variant — parser compatibility test.
 *
 * The image-first variant (prompts/story-unified-imagefirst.txt) reorders the
 * model's AUTHORING work (arc → scene designs → text) but must emit a response
 * whose parsed result is IDENTICAL to the original story-unified.txt format.
 * New work sections (---SCENE SEQUENCE---, ---SCENE SEQUENCE CRITIQUE---,
 * PAGE BEATS inside PLOT STRUCTURE) sit BEFORE
 * ---STORY DRAFT--- and must be invisible to every parser.
 *
 * Verifies, with synthetic model outputs (2-page story, minimal VB):
 *   1. UnifiedStoryParser extracts identical pages / title / clothing / VB /
 *      cover hints from an original-format response and a variant-format
 *      response that share the same payload sections.
 *   2. ProgressiveUnifiedParser (streaming) emits the same pages from the
 *      variant response, and its FIXES REQUIRED patched-page detection is
 *      unaffected by the new sections.
 *   3. Template-level marker diff: the variant template contains every
 *      ---MARKER--- the original template has, in the same relative order;
 *      the only additions are the three new work sections.
 *   4. Seam: buildUnifiedStoryPrompt returns the variant template only for
 *      storyPromptVariant === 'imageFirst'; absent/other values fall through
 *      to the production template.
 *
 * Deterministic, no network / DB. Run:
 *   node tests/manual/test-imagefirst-parser-compat.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Stub bare modules that may be missing in a bare checkout (p-limit, sharp, …).
// Repo-relative requires resolve normally. Same pattern as
// tests/manual/test-pt8-secondary-references.js.
const Module = require('module');
const origLoad = Module._load;
const makeStub = () => new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'default' ? makeStub() : makeStub()),
  apply: () => makeStub(),
  construct: () => makeStub(),
});
Module._load = function (request, parent, isMain) {
  const isBare = !request.startsWith('.') && !request.startsWith('/');
  try {
    return origLoad.call(this, request, parent, isMain);
  } catch (err) {
    if (isBare && err.code === 'MODULE_NOT_FOUND') return makeStub();
    throw err;
  }
};

const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
const { ProgressiveUnifiedParser } = require('../../server/lib/outlineParser/progressive');

let passed = 0;
const check = (label, cond) => {
  assert.ok(cond, `FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
};

// ─── Shared payload sections (identical in both formats) ────────────────────

const DRAFT = `---STORY DRAFT---
**Draft 1**
The main character ran to the window. Snow was falling outside.

"Come and see!" she called down the stairs.
*(Word count: 18)*
SCENE:
The main character — a slim grade-school girl with shoulder-length brown hair — stands in the foreground at a tall frosted bedroom window, both hands pressed flat against the cold glass, facing the window. Beyond the pane, large snowflakes drift past a pale grey dawn sky. Close-up shot, warm soft morning light, quiet wondering atmosphere.
METADATA:
{"sceneIntent":"The main character presses both hands on the bedroom window and watches falling snow. She leans close to the glass. Dawn light, quiet mood.","characters":[{"name":"Mira","position":"at the window","clothing":"standard","depth":"foreground","expression":"delighted, mouth open, eyes wide"}],"objects":["LOC001"],"interactions":[{"character":"Mira","object":"window","where":"presses both hands on the window","storyRelevant":true,"priority":"essential"}],"background":"empty bedroom, falling snow through window","setting":"indoor","time":"morning","weather":"snowy","shot":"close-up","textPosition":"top-left","textZoneDescription":"shadowed deep blue wall tone in the upper left","emptyScenePrompt":"Simple bedroom interior at dawn, a tall frosted window on the right, shadowed wall in the upper left, soft warm morning light."}

**Draft 2**
Outside, the garden had turned white. The main character pulled her friend onto the path.
*(Word count: 15)*
SCENE:
Mira — the same slim grade-school girl — walks a few paces ahead of Jonas along a snow-covered garden path in the midground, glancing back toward him, facing Jonas. Jonas — a short kindergartner with curly black hair — follows behind her, arms out for balance. Wide shot, pale midday light, fresh snow blanketing hedges.
METADATA:
{"sceneIntent":"Mira leads Jonas along the snowy garden path. She glances back at him while he balances. Pale midday light, playful mood.","characters":[{"name":"Mira","position":"a few paces ahead of Jonas on the path","clothing":"winter","depth":"midground","expression":"playful, broad smile"},{"name":"Jonas","position":"behind Mira on the path","clothing":"winter","depth":"midground","expression":"concentrating, tongue out"}],"objects":["LOC002"],"interactions":[{"character":"Mira","object":"Jonas","where":"reaches back toward Jonas a few paces apart","storyRelevant":true,"priority":"essential"}],"background":"snow-covered hedges","setting":"outdoor","time":"midday","weather":"snowy","shot":"wide","textPosition":"bottom-full","textZoneDescription":"unbroken fresh snow band across the lower frame","emptyScenePrompt":"Snow-covered garden path curving from lower-left foreground to upper-right background, hedges under fresh snow, unbroken snow band across the lower frame."}
`;

const ANALYSIS = `---ANALYSIS---
**A. NARRATIVE:** 1. Plot holes: weakest link page 1→2, no trigger. Fix: add a call to action.
**B. CHARACTERS:** - **Mira**: consistency ✓, voice ✓, show-not-tell ✗, motivation ✓, growth ✓. Weakest moment: Page 2. Fix: show it.
**C. PROSE:** none found.
**D. SCENE HINTS:** all within limit.
**E. DO-NOT-WRITE LIST VERIFICATION:** clean — verified DO-NOT-WRITE LIST honored.

FIXES REQUIRED:
- Pages 2: TEXT: "pulled her friend" is a restraint-adjacent gesture → rewrite as an invitation.
`;

const TAIL = `---TITLE---
TITLE_CANDIDATES:
1. **Mira and the First Snow** — character-focused
2. **The Garden Under White** — setting-focused
3. **Two Sets of Footprints** — object-focused
4. **Jonas Follows** — relationship-focused
5. **The Morning the Sky Fell Softly** — pivotal-moment

---CLOTHING REQUIREMENTS---
\`\`\`json
{ "clothingRequirements": { "Mira": { "standard": { "used": true, "description": "navy striped jumper, dark jeans, white sneakers" }, "winter": { "used": true, "description": "red wool coat, dark jeans tucked into brown boots, red scarf" }, "costumed": { "used": false } }, "Jonas": { "winter": { "used": true, "description": "green puffer jacket, grey snow trousers, black boots" }, "costumed": { "used": false } } } }
\`\`\`

---VISUAL BIBLE---
\`\`\`json
{ "secondaryCharacters": [], "animals": [], "artifacts": [], "locations": [ { "id": "LOC001", "name": "Bedroom", "pages": [1], "setting": "indoor", "colors": "warm wood, pale blue walls", "features": "tall frosted window", "signatureElement": "frost stars on the glass", "isRealLandmark": false, "landmarkQuery": null }, { "id": "LOC002", "name": "Garden path", "pages": [2], "setting": "outdoor", "colors": "white snow, dark green hedges", "features": "curving gravel path", "signatureElement": "snow-capped hedge arch", "isRealLandmark": false, "landmarkQuery": null } ], "vehicles": [], "clothing": [] }
\`\`\`

---COVER SCENE HINTS---

**Title Page**
Mood: wonder and discovery
Objects: LOC002
Characters:
- Mira (center foreground): winter, holds: nothing, priority: essential

**Initial Page**
Mood: warm reunion
Objects: LOC002
Characters:
- Mira (center-left foreground): winter, holds: nothing, priority: essential
- Jonas (center-right foreground): winter, holds: nothing, priority: normal

**Back Cover**
Mood: quiet triumph
Objects: LOC002
Characters:
- Mira (center-left foreground): winter, holds: nothing, priority: essential
- Jonas (center-right foreground): winter, holds: nothing, priority: normal

---STORY PAGES---
--- Page 2 ---
TEXT:
Outside, the garden had turned white. "Race you to the arch!" the main character laughed, and her friend hurried after her.

# FINAL CHECKLIST
- [x] done
`;

// ─── Format-specific front sections ─────────────────────────────────────────

const ORIGINAL_FRONT = `---CHARACTER ARCS---
### Mira
**Starting Point**: cautious
**Key Moments**: Pages 1, 2

---PLOT STRUCTURE---
**Inciting Incident**: first snow
**Themes**: wonder
**Tone**: playful

---SCENE PLAN---
Page 1: close-up — 1 char — Mira at the window
Page 2: wide — 2 chars — garden path, Mira leading

`;

const VARIANT_FRONT = `---CHARACTER ARCS---
### Mira
**Starting Point**: cautious
**Key Moments**: Pages 1, 2

---PLOT STRUCTURE---
**Inciting Incident**: first snow
**Themes**: wonder
**Tone**: playful

**PAGE BEATS**
Page 1: Mira spots the first snow from her window — wonder
Page 2: Mira leads Jonas into the white garden — shared joy

---SCENE SEQUENCE---
**Scene 1**
Setting: Mira's bedroom — dawn — snowy
Cast: Mira (foreground, hands on the window)
Action: leaning close to the cold glass, snow falling outside
Shot: close-up — front
Arc note: quiet establishing image

**Scene 2**
Setting: garden path — midday — snowy
Cast: Mira (midground, leading), Jonas (midground, following)
Action: Mira glances back mid-stride, Jonas balances
Shot: wide — side
Arc note: opens up from interior close-up to exterior wide

---SCENE SEQUENCE CRITIQUE---
1. Picturability: Scene 2 originally had three friends — cut to two.
2. Variety: close-up then wide — good alternation.
3. Cast rotation: Jonas enters in Scene 2 — fine.
4. Visual arc: builds correctly.
REVISIONS:
Scene 2: three figures → Cast: Mira (midground, leading), Jonas (midground, following)

`;

const originalResponse = ORIGINAL_FRONT + DRAFT + '\n' + ANALYSIS + '\n' + TAIL;
const variantResponse = VARIANT_FRONT + DRAFT + '\n' + ANALYSIS + '\n' + TAIL;

// ─── 1. UnifiedStoryParser equivalence ──────────────────────────────────────

console.log('UnifiedStoryParser: original vs variant format');
const pOrig = new UnifiedStoryParser(originalResponse);
const pVar = new UnifiedStoryParser(variantResponse);

const pagesOrig = pOrig.extractPages();
const pagesVar = pVar.extractPages();

check('both parse 2 pages', pagesOrig.length === 2 && pagesVar.length === 2);
for (let i = 0; i < 2; i++) {
  const a = pagesOrig[i], b = pagesVar[i];
  check(`page ${a.pageNumber}: text identical`, a.text === b.text && a.text.length > 0);
  check(`page ${a.pageNumber}: sceneProse identical`, a.sceneProse === b.sceneProse && a.sceneProse.length > 0);
  check(`page ${a.pageNumber}: sceneHint (METADATA JSON) identical`, a.sceneHint === b.sceneHint && a.sceneHint.length > 0);
  check(`page ${a.pageNumber}: characterClothing identical`,
    JSON.stringify(a.characterClothing) === JSON.stringify(b.characterClothing));
}
check('page 2 patch applied in both (TEXT fix wins over draft)',
  pagesVar[1].text.includes('Race you to the arch') && pagesOrig[1].text.includes('Race you to the arch'));
check('page 2 sceneHint valid JSON with textPosition',
  JSON.parse(pagesVar[1].sceneHint).textPosition === 'bottom-full');

check('title identical', pOrig.extractTitle() === pVar.extractTitle() && !!pVar.extractTitle());
check('titleCandidates identical (5)',
  JSON.stringify(pOrig.extractTitleCandidates()) === JSON.stringify(pVar.extractTitleCandidates())
  && pVar.extractTitleCandidates().length === 5);
check('clothingRequirements identical',
  JSON.stringify(pOrig.extractClothingRequirements()) === JSON.stringify(pVar.extractClothingRequirements())
  && !!pVar.extractClothingRequirements().Mira);
check('visualBible identical (2 locations)',
  JSON.stringify(pOrig.extractVisualBible()) === JSON.stringify(pVar.extractVisualBible())
  && pVar.extractVisualBible().locations.length === 2);
check('coverHints identical (3 covers, chars parsed)',
  JSON.stringify(pOrig.extractCoverHints()) === JSON.stringify(pVar.extractCoverHints())
  && pVar.extractCoverHints().titlePage.characters.length === 1
  && pVar.extractCoverHints().backCover.characters.length === 2);

// ─── 2. ProgressiveUnifiedParser on the variant format ──────────────────────

console.log('ProgressiveUnifiedParser: streaming the variant format');
const emitted = { pages: [], title: null, clothing: null, vb: null };
const prog = new ProgressiveUnifiedParser({
  onPageComplete: (p) => emitted.pages.push(p),
  onTitle: (t) => { emitted.title = t; },
  onClothingRequirements: (c) => { emitted.clothing = c; },
  onVisualBible: (v) => { emitted.vb = v; },
});
// Feed in chunks to exercise the streaming gates, then finalize.
const CHUNK = 700;
let buf = '';
for (let i = 0; i < variantResponse.length; i += CHUNK) {
  buf += variantResponse.substring(i, i + CHUNK);
  prog.processChunk(variantResponse.substring(i, i + CHUNK), buf);
}
const finalState = prog.finalize();

check('streaming emits 2 pages', finalState.pageCount === 2 && emitted.pages.length === 2);
const sp1 = emitted.pages.find(p => p.pageNumber === 1);
const sp2 = emitted.pages.find(p => p.pageNumber === 2);
check('streaming page 1 text matches final parser', sp1.text === pagesVar[0].text);
check('streaming page 1 sceneProse matches final parser', sp1.sceneProse === pagesVar[0].sceneProse);
check('streaming page 2 patched text matches final parser', sp2.text === pagesVar[1].text);
check('streaming FIXES REQUIRED detected only page 2 as patched',
  prog._ensurePatchedPageNumbers().size === 1 && prog._ensurePatchedPageNumbers().has(2));
check('streaming title matches final parser', emitted.title === pVar.extractTitle());
check('streaming clothing detected', !!emitted.clothing && !!emitted.clothing.Mira);
check('streaming visual bible detected (2 locations)', !!emitted.vb && emitted.vb.locations.length === 2);

// ─── 3. Template marker diff ────────────────────────────────────────────────

console.log('Template marker diff: story-unified.txt vs story-unified-imagefirst.txt');
const promptsDir = path.join(__dirname, '..', '..', 'prompts');
const tplOrig = fs.readFileSync(path.join(promptsDir, 'story-unified.txt'), 'utf-8');
const tplVar = fs.readFileSync(path.join(promptsDir, 'story-unified-imagefirst.txt'), 'utf-8');

const markerSeq = (tpl) => {
  // First occurrence of each ---MARKER--- (the OUTPUT FORMAT slot; later hits
  // are the brief example). Dedupe preserving first-seen order.
  const seen = new Map();
  for (const m of tpl.matchAll(/^---([A-Z][A-Z ]+)---$/gm)) {
    if (!seen.has(m[1])) seen.set(m[1], m.index);
  }
  return [...seen.keys()];
};
const seqOrig = markerSeq(tplOrig);
const seqVar = markerSeq(tplVar);

const missing = seqOrig.filter(m => !seqVar.includes(m));
// SCENE PLAN is DELIBERATELY absent from the variant (2026-07-31 de-dup: it was a
// vestigial summary of SCENE SEQUENCE, consumed by nothing — see decisions.md).
check(`variant contains every original marker except SCENE PLAN (missing: ${missing.join(',') || 'none'})`,
  JSON.stringify(missing) === JSON.stringify(['SCENE PLAN']));

const extra = seqVar.filter(m => !seqOrig.includes(m));
check('only additions are the 2 new work sections',
  JSON.stringify(extra) === JSON.stringify(['SCENE SEQUENCE', 'SCENE SEQUENCE CRITIQUE']));

// Relative order of the ORIGINAL markers must be preserved in the variant.
// Compare on the COMMON marker set (SCENE PLAN is deliberately variant-absent).
const commonOrig = seqOrig.filter(m => seqVar.includes(m));
const varFiltered = seqVar.filter(m => seqOrig.includes(m));
check('common markers keep their relative order in the variant',
  JSON.stringify(varFiltered) === JSON.stringify(commonOrig));

// New sections must all sit BEFORE ---STORY DRAFT--- (parsers bound the draft
// at STORY DRAFT → ANALYSIS and the fixes block at FIXES REQUIRED → TITLE).
const draftIdx = tplVar.indexOf('---STORY DRAFT---');
for (const s of ['---SCENE SEQUENCE---', '---SCENE SEQUENCE CRITIQUE---']) {
  check(`${s} sits before ---STORY DRAFT---`, tplVar.indexOf(s) !== -1 && tplVar.indexOf(s) < draftIdx);
}
// New sections must never instruct headers that collide with draft/page parsers.
check('variant instructs **Scene N** / **Text N** headers, never Draft/Page headers, in new sections', (() => {
  const seq = tplVar.substring(tplVar.indexOf('---SCENE SEQUENCE---'), draftIdx);
  return !/\*\*Draft\s/.test(seq) && !/---\s*Page\s+\d/.test(seq);
})());
// Both templates keep the TEXT_OVERLAY gating markers balanced.
const count = (s, re) => (s.match(re) || []).length;
check('TEXT_OVERLAY_BEGIN/END balanced and equal across templates',
  count(tplVar, /<!-- TEXT_OVERLAY_BEGIN -->/g) === count(tplVar, /<!-- TEXT_OVERLAY_END -->/g)
  && count(tplVar, /<!-- TEXT_OVERLAY_BEGIN -->/g) === count(tplOrig, /<!-- TEXT_OVERLAY_BEGIN -->/g));
// Same fillTemplate placeholders in both.
const placeholders = (tpl) => [...new Set([...tpl.matchAll(/\{([A-Z_]+)\}/g)].map(m => m[1]))].sort();
check('identical {PLACEHOLDER} set in both templates',
  JSON.stringify(placeholders(tplOrig)) === JSON.stringify(placeholders(tplVar)));

// ─── 4. Seam: buildUnifiedStoryPrompt variant selection ─────────────────────

console.log('Seam: buildUnifiedStoryPrompt flag selection');
const promptsSvc = require('../../server/services/prompts');
(async () => {
  await promptsSvc.loadPromptTemplates();
  const { buildUnifiedStoryPrompt } = require('../../server/lib/storyHelpers');
  Module._load = origLoad;

  const baseInput = {
    characters: [{ name: 'Mira', isMain: true }],
    language: 'en',
    pages: 2,
    readingLevel: 'First Reader',
    storyCategory: 'adventure',
    storyTheme: 'winter',
    layout: { textInImage: true },
  };

  // Default flipped 2026-07-31 (owner): image-first IS the default; 'textFirst'
  // opts back into the legacy template. Anything else → image-first.
  const defPrompt = buildUnifiedStoryPrompt({ ...baseInput }, 2);
  const varPrompt = buildUnifiedStoryPrompt({ ...baseInput, storyPromptVariant: 'imageFirst' }, 2);
  const legacyPrompt = buildUnifiedStoryPrompt({ ...baseInput, storyPromptVariant: 'textFirst' }, 2);
  const otherPrompt = buildUnifiedStoryPrompt({ ...baseInput, storyPromptVariant: 'somethingElse' }, 2);

  check('default (flag absent) uses the IMAGE-FIRST template',
    defPrompt.includes('---SCENE SEQUENCE---') && defPrompt.includes('---SCENE SEQUENCE CRITIQUE---'));
  check('imageFirst flag selects the variant template',
    varPrompt.includes('---SCENE SEQUENCE---') && varPrompt.includes('---SCENE SEQUENCE CRITIQUE---')
    && varPrompt.includes('Image-First Variant'));
  check('textFirst flag opts back into the legacy template',
    !legacyPrompt.includes('---SCENE SEQUENCE---') && legacyPrompt.includes('Draft the story with scene output'));
  check('unknown flag value falls through to the default (image-first)',
    otherPrompt === defPrompt);
  check('variant keeps all output markers the pipeline parses',
    ['---STORY DRAFT---', '---ANALYSIS---', '---TITLE---', '---CLOTHING REQUIREMENTS---',
     '---VISUAL BIBLE---', '---COVER SCENE HINTS---', '---STORY PAGES---']
      .every(m => varPrompt.includes(m)));

  console.log(`\nPASS: ${passed} checks — image-first variant is parser-compatible; default path unchanged.`);
  process.exit(0); // required: transitively-loaded modules hold open handles
})().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
