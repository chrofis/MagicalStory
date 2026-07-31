/**
 * Split outline review — parser compatibility + builder seam test.
 *
 * With MODEL_DEFAULTS.splitOutlineReview ON, the unified story call (writer)
 * skips its self-critique (ANALYSIS stub, no FIXES REQUIRED, bare
 * ---STORY PAGES--- marker) and a second model (reviewer) emits
 * ---ANALYSIS--- + FIXES REQUIRED + ---STORY PAGES--- patches. server.js
 * CONCATENATES writer output + reviewer output and feeds it to the unchanged
 * parsers. This test proves, with synthetic outputs:
 *
 *   1. UnifiedStoryParser on the concatenation yields IDENTICAL results to a
 *      single-call synthetic response carrying the same draft + critique.
 *   2. ProgressiveUnifiedParser under the production flow (stream call 1,
 *      then ONE chunk with the appended review, then finalize) emits the same
 *      pages — and emits NO pages before the review lands (the FIXES REQUIRED
 *      list decides draft-final vs patched).
 *   3. A zero-fix review (empty FIXES REQUIRED, bare STORY PAGES) leaves the
 *      draft untouched — the existing 0-fix tolerance.
 *   4. Reviewer failure path: the writer-only response alone still parses
 *      (unpatched draft ships).
 *   5. Builder seam: split ON injects the reviewed-externally stub; split OFF
 *      injects the full analysis instructions; buildOutlineReviewPrompt
 *      carries the same instructions + the writer output + REVIEW HINTS, and
 *      honours the text-overlay gate.
 *
 * Deterministic, no network / DB. Run:
 *   node tests/manual/test-split-outline-review.js
 */
const assert = require('assert');

// Stub bare modules that may be missing in a bare checkout (same pattern as
// tests/manual/test-imagefirst-parser-compat.js).
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

// ─── Shared synthetic sections ──────────────────────────────────────────────

const FRONT = `---CHARACTER ARCS---
### Mira
**Starting Point**: cautious
**Key Moments**: Pages 1, 2

---PLOT STRUCTURE---
**Inciting Incident**: first snow
**Themes**: wonder
**Tone**: playful

---SCENE SEQUENCE---
**Scene 1**
Setting: Mira's bedroom — dawn — snowy
Cast: Mira (foreground, hands on the window)
Action: leaning close to the cold glass
Shot: close-up — front
Arc note: quiet establishing image

**Scene 2**
Setting: garden path — midday — snowy
Cast: Mira (midground, leading), Jonas (midground, following)
Action: Mira glances back mid-stride
Shot: wide — side
Arc note: interior close-up opens to exterior wide

---SCENE SEQUENCE CRITIQUE---
1. Picturability: fine.
REVISIONS:
(none)

`;

const DRAFT = `---STORY DRAFT---
**Draft 1**
The main character ran to the window. Snow was falling outside.
*(Word count: 11)*
SCENE:
Mira — a slim grade-school girl with shoulder-length brown hair — stands in the foreground at a tall frosted bedroom window, both hands pressed flat against the cold glass. Close-up shot, warm soft morning light.
METADATA:
{"sceneIntent":"Mira presses both hands on the bedroom window and watches falling snow.","characters":[{"name":"Mira","position":"right foreground","clothing":"standard","depth":"foreground"}],"objects":[],"interactions":[{"character":"Mira","object":"window","where":"presses both hands on the window","storyRelevant":true,"priority":"essential"}],"background":"empty bedroom, falling snow through window","setting":"indoor","time":"morning","weather":"snowy","shot":"close-up","textPosition":"top-left","textZoneDescription":"shadowed deep blue wall tone in the upper left","emptyScenePrompt":"Simple bedroom interior at dawn, a tall frosted window on the right, shadowed wall in the upper left."}

**Draft 2**
Outside, the garden had turned white. The main character pulled her friend onto the path.
*(Word count: 15)*
SCENE:
Mira walks a few paces ahead of Jonas along a snow-covered garden path in the midground, glancing back toward him. Jonas — a short kindergartner with curly black hair — follows behind her. Wide shot, pale midday light.
METADATA:
{"sceneIntent":"Mira leads Jonas along the snowy garden path.","characters":[{"name":"Mira","position":"a few paces ahead on the path","clothing":"winter","depth":"midground"},{"name":"Jonas","position":"behind Mira on the path","clothing":"winter","depth":"midground"}],"objects":[],"interactions":[{"character":"Mira","object":"Jonas","where":"reaches back toward Jonas","storyRelevant":true,"priority":"essential"}],"background":"snow-covered hedges","setting":"outdoor","time":"midday","weather":"snowy","shot":"wide","textPosition":"bottom-full","textZoneDescription":"unbroken fresh snow band across the lower frame","emptyScenePrompt":"Snow-covered garden path, hedges under fresh snow, unbroken snow band across the lower frame."}
`;

// Full self-critique (single-call mode)
const SELF_ANALYSIS = `---ANALYSIS---
**A. NARRATIVE:** 1. Plot holes: weakest link page 1→2, no trigger.
**B. CHARACTERS:** - **Mira**: consistency ✓, voice ✓, show-not-tell ✗, motivation ✓, growth ✓.
**C. PROSE:** none found.
**D. SCENE HINTS:** all within limit.
**E. DO-NOT-WRITE LIST VERIFICATION:** clean — verified DO-NOT-WRITE LIST honored.

FIXES REQUIRED:
- Pages 2: TEXT: "pulled her friend" is a restraint-adjacent gesture → rewrite as an invitation.
`;

// Split-mode writer stub (what the SPLIT_REVIEW_ANALYSIS_STUB instructs)
const STUB_ANALYSIS = `---ANALYSIS---
Reviewed externally.
`;

const TAIL_COMMON = `---TITLE---
TITLE_CANDIDATES:
1. **Mira and the First Snow** — character-focused
2. **The Garden Under White** — setting-focused
3. **Two Sets of Footprints** — object-focused
4. **Jonas Follows** — relationship-focused
5. **The Morning the Sky Fell Softly** — pivotal-moment

---CLOTHING REQUIREMENTS---
\`\`\`json
{ "clothingRequirements": { "Mira": { "standard": { "used": true, "description": "navy striped jumper, dark jeans, white sneakers" }, "winter": { "used": true, "description": "red wool coat, dark jeans, brown boots" }, "costumed": { "used": false } }, "Jonas": { "winter": { "used": true, "description": "green puffer jacket, grey snow trousers, black boots" }, "costumed": { "used": false } } } }
\`\`\`

---VISUAL BIBLE---
\`\`\`json
{ "secondaryCharacters": [], "animals": [], "artifacts": [], "locations": [ { "id": "LOC001", "name": "Bedroom", "pages": [1], "setting": "indoor", "colors": "warm wood, pale blue walls", "features": "tall frosted window", "signatureElement": "frost stars on the glass", "isRealLandmark": false, "landmarkQuery": null } ], "vehicles": [], "clothing": [] }
\`\`\`

---COVER SCENE HINTS---

**Title Page**
Mood: wonder and discovery
Objects: LOC001
Characters:
- Mira (center foreground): winter, holds: nothing, priority: essential

**Initial Page**
Mood: warm reunion
Objects: LOC001
Characters:
- Mira (center-left foreground): winter, holds: nothing, priority: essential
- Jonas (center-right foreground): winter, holds: nothing, priority: normal

**Back Cover**
Mood: quiet triumph
Objects: LOC001
Characters:
- Mira (center-left foreground): winter, holds: nothing, priority: essential
- Jonas (center-right foreground): winter, holds: nothing, priority: normal

`;

const PATCH_BLOCK = `--- Page 2 ---
TEXT:
Outside, the garden had turned white. "Race you to the arch!" the main character laughed, and her friend hurried after her.
`;

// Single-call shape: critique inline, patches in STORY PAGES.
const singleCallResponse = FRONT + DRAFT + '\n' + SELF_ANALYSIS + '\n' + TAIL_COMMON + '---STORY PAGES---\n' + PATCH_BLOCK;

// Split shape call 1: stub critique, bare STORY PAGES marker, nothing after.
const writerOnlyResponse = FRONT + DRAFT + '\n' + STUB_ANALYSIS + '\n' + TAIL_COMMON + '---STORY PAGES---\n';

// Split shape call 2: reviewer output (same critique substance + same patch).
const reviewerOutput = `---ANALYSIS---
**A. NARRATIVE:** 1. Plot holes: weakest link page 1→2, no trigger.
**B. CHARACTERS:** - **Mira**: consistency ✓, voice ✓, show-not-tell ✗, motivation ✓, growth ✓.
**C. PROSE:** none found.
**D. SCENE HINTS:** all within limit.
**E. DO-NOT-WRITE LIST VERIFICATION:** clean — verified DO-NOT-WRITE LIST honored.

FIXES REQUIRED:
- Pages 2: TEXT: "pulled her friend" is a restraint-adjacent gesture → rewrite as an invitation.

---STORY PAGES---
` + PATCH_BLOCK;

const concatenated = writerOnlyResponse + '\n\n' + reviewerOutput;

// ─── 1. Final parser: concatenation ≡ single-call ───────────────────────────

console.log('UnifiedStoryParser: split concatenation vs single-call');
const pSingle = new UnifiedStoryParser(singleCallResponse);
const pSplit = new UnifiedStoryParser(concatenated);

const pagesSingle = pSingle.extractPages();
const pagesSplit = pSplit.extractPages();

check('both parse 2 pages', pagesSingle.length === 2 && pagesSplit.length === 2);
for (let i = 0; i < 2; i++) {
  const a = pagesSingle[i], b = pagesSplit[i];
  check(`page ${a.pageNumber}: text identical`, a.text === b.text && a.text.length > 0);
  check(`page ${a.pageNumber}: sceneProse identical`, a.sceneProse === b.sceneProse && a.sceneProse.length > 0);
  check(`page ${a.pageNumber}: sceneHint identical`, a.sceneHint === b.sceneHint && a.sceneHint.length > 0);
  check(`page ${a.pageNumber}: characterClothing identical`,
    JSON.stringify(a.characterClothing) === JSON.stringify(b.characterClothing));
}
check('reviewer patch applied on page 2 in split mode', pagesSplit[1].text.includes('Race you to the arch'));
check('page 1 remains the unpatched draft', pagesSplit[0].text.includes('Snow was falling outside'));
check('title identical', pSingle.extractTitle() === pSplit.extractTitle() && !!pSplit.extractTitle());
check('clothingRequirements identical',
  JSON.stringify(pSingle.extractClothingRequirements()) === JSON.stringify(pSplit.extractClothingRequirements())
  && !!pSplit.extractClothingRequirements().Mira);
check('visualBible identical', JSON.stringify(pSingle.extractVisualBible()) === JSON.stringify(pSplit.extractVisualBible()));
check('coverHints identical — reviewer ANALYSIS text did NOT leak into the cover section',
  JSON.stringify(pSingle.extractCoverHints()) === JSON.stringify(pSplit.extractCoverHints())
  && pSplit.extractCoverHints().backCover.characters.length === 2);

// ─── 2. Progressive parser under the production split flow ─────────────────

console.log('ProgressiveUnifiedParser: production split flow');
const emitted = { pages: [], title: null, clothing: null, vb: null };
const prog = new ProgressiveUnifiedParser({
  onPageComplete: (p) => emitted.pages.push(p),
  onTitle: (t) => { emitted.title = t; },
  onClothingRequirements: (c) => { emitted.clothing = c; },
  onVisualBible: (v) => { emitted.vb = v; },
});
// Phase 1: stream call 1 in chunks (as callTextModelStreaming does).
const CHUNK = 700;
let buf = '';
for (let i = 0; i < writerOnlyResponse.length; i += CHUNK) {
  buf += writerOnlyResponse.substring(i, i + CHUNK);
  prog.processChunk(writerOnlyResponse.substring(i, i + CHUNK), buf);
}
check('no pages emitted during call 1 (page emission waits for the review)', emitted.pages.length === 0);
check('title already emitted during call 1', emitted.title === pSplit.extractTitle());
check('clothing already emitted during call 1', !!emitted.clothing && !!emitted.clothing.Mira);
check('visual bible already emitted during call 1', !!emitted.vb && emitted.vb.locations.length === 1);
// Phase 2: server.js appends the COMPLETE review in one chunk, then finalizes.
prog.processChunk('', concatenated);
const finalState = prog.finalize();
check('streaming emits 2 pages after the review chunk', finalState.pageCount === 2 && emitted.pages.length === 2);
const sp1 = emitted.pages.find(p => p.pageNumber === 1);
const sp2 = emitted.pages.find(p => p.pageNumber === 2);
check('streaming page 1 matches final parser (draft-only)', sp1.text === pagesSplit[0].text && sp1.sceneProse === pagesSplit[0].sceneProse);
check('streaming page 2 matches final parser (patched)', sp2.text === pagesSplit[1].text);
check('patched-page detection saw exactly page 2',
  prog._ensurePatchedPageNumbers().size === 1 && prog._ensurePatchedPageNumbers().has(2));

// ─── 3. Zero-fix review → draft ships verbatim ──────────────────────────────

console.log('Zero-fix review');
const zeroFixReview = `---ANALYSIS---
**A. NARRATIVE:** solid causal chain.
**E. DO-NOT-WRITE LIST VERIFICATION:** clean — verified DO-NOT-WRITE LIST honored.

FIXES REQUIRED:
(none — draft is final)

---STORY PAGES---
`;
const pZero = new UnifiedStoryParser(writerOnlyResponse + '\n\n' + zeroFixReview);
const pagesZero = pZero.extractPages();
check('zero-fix concatenation parses 2 draft pages', pagesZero.length === 2);
check('zero-fix page 2 is the unpatched draft', pagesZero[1].text.includes('pulled her friend'));

// ─── 4. Reviewer-failure path: writer-only response alone parses ────────────

console.log('Reviewer failure containment');
const pWriterOnly = new UnifiedStoryParser(writerOnlyResponse);
const pagesWriterOnly = pWriterOnly.extractPages();
check('writer-only response (no review) parses 2 draft pages', pagesWriterOnly.length === 2);
check('writer-only title/clothing/VB/coverHints intact',
  !!pWriterOnly.extractTitle() && !!pWriterOnly.extractClothingRequirements().Mira
  && pWriterOnly.extractVisualBible().locations.length === 1
  && pWriterOnly.extractCoverHints().backCover.characters.length === 2);

// ─── 5. Builder seam ────────────────────────────────────────────────────────

console.log('Builder seam: stub vs full instructions, reviewer prompt');
const promptsSvc = require('../../server/services/prompts');
(async () => {
  await promptsSvc.loadPromptTemplates();
  const { MODEL_DEFAULTS } = require('../../server/config/models');
  const { buildUnifiedStoryPrompt, buildOutlineReviewPrompt } = require('../../server/lib/storyHelpers');
  Module._load = origLoad;

  const baseInput = {
    characters: [{ name: 'Mira', isMain: true }, { name: 'Jonas' }],
    language: 'de',
    pages: 2,
    readingLevel: 'First Reader',
    storyCategory: 'adventure',
    storyTheme: 'winter',
    layout: { textInImage: true },
  };

  // A probe string that exists ONLY in the analysis instruction body.
  const ANALYSIS_PROBE = 'Name the weakest causal link in the draft';

  const prevSplit = MODEL_DEFAULTS.splitOutlineReview;
  try {
    MODEL_DEFAULTS.splitOutlineReview = true;
    const splitPrompt = buildUnifiedStoryPrompt({ ...baseInput }, 2);
    check('split ON: writer prompt carries the reviewed-externally stub', splitPrompt.includes('Reviewed externally.'));
    check('split ON: writer prompt has NO self-critique instructions', !splitPrompt.includes(ANALYSIS_PROBE));
    check('split ON: writer prompt keeps the ---ANALYSIS--- and ---STORY PAGES--- markers',
      splitPrompt.includes('---ANALYSIS---') && splitPrompt.includes('---STORY PAGES---'));
    check('split ON: no unfilled {ANALYSIS_INSTRUCTIONS} placeholder left', !splitPrompt.includes('{ANALYSIS_INSTRUCTIONS}'));

    // Per-job override (rerun-text harness A/B seam) beats the global default.
    const perJobOff = buildUnifiedStoryPrompt({ ...baseInput, splitOutlineReview: false }, 2);
    check('per-job splitOutlineReview:false overrides the global ON default', perJobOff.includes(ANALYSIS_PROBE) && !perJobOff.includes('Reviewed externally.'));

    MODEL_DEFAULTS.splitOutlineReview = false;
    const perJobOn = buildUnifiedStoryPrompt({ ...baseInput, splitOutlineReview: true }, 2);
    check('per-job splitOutlineReview:true overrides the global OFF default', perJobOn.includes('Reviewed externally.'));
    const singlePrompt = buildUnifiedStoryPrompt({ ...baseInput }, 2);
    check('split OFF: writer prompt carries the full self-critique instructions', singlePrompt.includes(ANALYSIS_PROBE));
    check('split OFF: no reviewed-externally stub', !singlePrompt.includes('Reviewed externally.'));
    check('split OFF: analysis placeholders filled ({CHARACTER_NAMES} → names)',
      !singlePrompt.includes('{CHARACTER_NAMES}') && singlePrompt.includes('Mira, Jonas'));

    // Reviewer prompt
    const hints = [{ page: 2, issues: [{ type: 'metadata_char_absent_from_prose', detail: "metadata char 'Jonas' absent from prose" }] }];
    const reviewPrompt = buildOutlineReviewPrompt({ ...baseInput }, writerOnlyResponse, hints);
    check('review prompt carries the SAME analysis instructions', reviewPrompt.includes(ANALYSIS_PROBE));
    check('review prompt embeds the writer output verbatim', reviewPrompt.includes('Snow was falling outside'));
    check('review prompt carries the REVIEW HINTS block', reviewPrompt.includes("metadata char 'Jonas' absent from prose"));
    check('review prompt carries the semantic scene-consistency section (reviewer-owned)',
      reviewPrompt.includes('Shared-action facing coherence'));
    check('review prompt names the story language', reviewPrompt.includes('German'));
    check('review prompt: overlay checks present when textInImage=true', reviewPrompt.includes('Text position distribution'));

    const reviewPromptNoOverlay = buildOutlineReviewPrompt({ ...baseInput, layout: { textInImage: false } }, writerOnlyResponse, []);
    check('review prompt: overlay checks stripped when textInImage=false', !reviewPromptNoOverlay.includes('Text position distribution'));
    check('review prompt without hints omits the REVIEW HINTS block', !reviewPromptNoOverlay.includes('# REVIEW HINTS'));
  } finally {
    MODEL_DEFAULTS.splitOutlineReview = prevSplit;
  }

  console.log(`\nPASS: ${passed} checks — split outline review is parser-compatible end to end.`);
  process.exit(0);
})().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
