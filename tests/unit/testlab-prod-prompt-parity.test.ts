/**
 * THE TEST LAB MUST BUILD THE PROMPT PRODUCTION SENDS.
 *
 * WHY THIS EXISTS. The Lab is where a change to the Art Director or to the
 * image prompt is measured. Where it builds a DIFFERENT prompt than the
 * pipeline sends, every measurement taken there is about a situation that never
 * occurs in a real book — and nothing in the tree says the two call sites are
 * related, so the drift is invisible until someone diffs two built prompts by
 * hand. Four such gaps were closed on 2026-09-18:
 *
 *   1. `runImageStage` passed no `vbRefElementIds`, so its REQUIRED OBJECTS
 *      block claimed no attached reference for any element while production's
 *      named them. Measured on staging job_1789584708605_rts4wqupm p7: the Lab
 *      prompt was 7,970 chars, production's 8,131, and the whole difference was
 *      the line naming the two cells the call actually carried.
 *   2. the beats per-page `expandOnePage` passed neither `clothingRequirements`
 *      nor `story`, so every character's line ended at its face with no
 *      `Wearing:` clause, the season came from TODAY (a stored SUMMER story
 *      replayed in September was told "the season is Autumn on every page"), and
 *      the text-zone rule family was always on where 94 of 118 recent stories
 *      gate it off.
 *   3. `runSceneDescriptionStage` passed ten positional arguments, so the page's
 *      plan line never reached the authoritative SCENE_SUMMARY slot — the exact
 *      hazard images.js warns about — and the same prompt lost every `Wearing:`
 *      line.
 *   4. `seasonLabel(options.story || {})` silently resolved the season from
 *      `new Date()` for any caller that omitted the story, which season.js
 *      forbids in its own doc comment.
 *
 * WHAT IS PINNED: the parity and the mechanism — which inputs decide which
 * block, and that the Lab call sites pass them. Never the wording of a rule:
 * these assertions must survive any prompt edit.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const PB = nodeRequire('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = nodeRequire('../../server/services/prompts.js');
const { seasonLabel } = nodeRequire('../../server/lib/season.js');
const logger = nodeRequire('../../server/utils/logger.js');

const TESTLAB = read('server/lib/testlab.js');

/** The options object of the Nth `fn(` call in a source file, by brace depth. */
function callBody(source: string, fnName: string, occurrence = 1): string {
  let from = -1;
  for (let i = 0; i < occurrence; i++) from = source.indexOf(`${fnName}(`, from + 1);
  if (from < 0) throw new Error(`${fnName} call #${occurrence} not found`);
  let depth = 0;
  for (let i = from + fnName.length; i < source.length; i++) {
    const c = source[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return source.slice(from, i + 1); }
  }
  throw new Error(`unbalanced call for ${fnName}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const CHARACTERS = [
  { id: 'c1', name: 'Mira', age: 8, gender: 'girl', hairColor: 'brown', eyeColor: 'green' },
  { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', hairColor: 'black', eyeColor: 'brown' },
];

// The one garment string the contract owns. Asserted as DATA (this fixture's own
// value reaching the prompt), never as template wording.
const CONTRACT_GARMENT = 'a mustard-yellow oilskin cape with a storm collar';
const CLOTHING_REQUIREMENTS: any = {
  Mira: { standard: { used: true, description: CONTRACT_GARMENT } },
  Tobias: { standard: { used: true, description: 'a grey knitted tunic over cord trousers' } },
};

const VISUAL_BIBLE: any = {
  mainCharacters: CHARACTERS.map(c => ({ id: c.id, name: c.name })),
  secondaryCharacters: [],
  animals: [],
  locations: [{ id: 'LOC001', name: 'the harbour wall', description: 'a low granite sea wall', pages: [1] }],
  vehicles: [],
  clothing: [],
  artifacts: [
    { id: 'ART001', name: 'brass lantern', label: 'brass lantern', description: 'a dented brass lantern', pages: [1], appearsInPages: [1] },
    { id: 'ART002', name: 'coiled rope', label: 'coiled rope', description: 'a thick tarred rope', pages: [1], appearsInPages: [1] },
  ],
};

const SCENE_BRIEF = [
  'Mira stands on the harbour wall holding the brass lantern while Tobias crouches beside the coiled rope.',
  '',
  '---METADATA---',
  JSON.stringify({
    sceneIntent: 'Mira lights the way',
    characters: [{ name: 'Mira', position: 'centre' }, { name: 'Tobias', position: 'left' }],
    objects: ['ART001', 'ART002'],
    interactions: [],
    textPosition: 'top-left',
  }, null, 2),
].join('\n');

const storyWith = (over: any = {}) => ({
  artStyle: 'watercolor',
  language: 'en',
  languageLevel: 'standard',
  characters: CHARACTERS,
  clothingRequirements: CLOTHING_REQUIREMENTS,
  createdAt: '2026-07-15T10:00:00.000Z', // summer, whatever today is
  season: 'summer',
  layout: { mode: 'square-below', imageAspect: '1:1', textInImage: false },
  ...over,
});

beforeAll(async () => { await loadPromptTemplates(); });

// ── 1. vbRefElementIds ──────────────────────────────────────────────────────
describe('the image prompt claims a reference only for elements the call carries', () => {
  const build = (opts: any) => PB.buildImagePrompt(
    SCENE_BRIEF, storyWith(), CHARACTERS, VISUAL_BIBLE, 1,
    [{ name: 'Mira', clothingDescription: CONTRACT_GARMENT }],
    { skipVisualBible: true, ...opts });

  it('names exactly the attached elements, and nothing when none are attached', () => {
    const none = build({});
    const emptySet = build({ vbRefElementIds: [] });
    const both = build({ vbRefElementIds: ['ART001', 'ART002'] });
    const one = build({ vbRefElementIds: ['ART001'] });

    // An omitted set and an explicitly empty one are the SAME prompt: a stage
    // that attaches nothing may say so without changing what it measures.
    expect(emptySet).toBe(none);

    // The claim is keyed to the SET, not to what the brief cites: both objects
    // are in the brief either way.
    expect(both.length).toBeGreaterThan(none.length);
    expect(one.length).toBeGreaterThan(none.length);
    expect(both.length).toBeGreaterThan(one.length);

    // …and every extra character is one contiguous line. Wording-free: the
    // difference between the two prompts is a single added line.
    const added = both.split('\n').filter(l => !none.split('\n').includes(l));
    expect(added).toHaveLength(1);
  });

  it('an id in the set that the brief does not cite claims nothing', () => {
    // The claim can only ever name an element the REQUIRED OBJECTS block lists;
    // the set narrows it, it never adds an entry.
    const withGhost = build({ vbRefElementIds: ['ART001', 'ART999'] });
    const justOne = build({ vbRefElementIds: ['ART001'] });
    expect(withGhost).toBe(justOne);
  });

  it('the claim does not reach the EVAL side — the expected-objects list is unchanged', () => {
    // The critic sibling (evalPipeline.buildEvalRequiredObjects) derives what
    // the judge expects to see by parsing this very block out of the page
    // prompt. The reference claim is deliberately written WITHOUT a `* **`
    // prefix so it can never parse as an object; this pins that, because a Lab
    // prompt that gained the line must not also gain a phantom expected object.
    const { parseVisualBibleObjects } = nodeRequire('../../server/lib/bboxDetection.js');
    const none = parseVisualBibleObjects(build({}));
    const both = parseVisualBibleObjects(build({ vbRefElementIds: ['ART001', 'ART002'] }));
    expect(none.length).toBeGreaterThan(0);
    expect(both).toEqual(none);
  });
});

describe('runImageStage passes the set it actually sends', () => {
  // Since 2026-09-27 the stage builds its call with the run's own builders
  // (server/lib/pageRenderCall.js); the full call — model, prompt, references,
  // options — is compared with production's in tests/unit/lab-prod-call-parity.test.ts.
  it('derives vbRefElementIds from the cells it keeps, selected before the prompt', () => {
    const stage = TESTLAB.slice(TESTLAB.indexOf('async function runImageStage'), TESTLAB.indexOf('async function runEmptySceneStage'));
    expect(stage).toMatch(/prompt = makePrompt\(kept\.map\(e => e\.id\)\.filter\(Boolean\)\)/);
    const gridAt = stage.indexOf('keepPageGridElements(');
    const promptAt = stage.indexOf('makePrompt(kept');
    expect(gridAt).toBeGreaterThan(-1);
    expect(gridAt).toBeLessThan(promptAt);
  });

  it('renders on the production page tier unless the run names another model', () => {
    const stage = TESTLAB.slice(TESTLAB.indexOf('async function runImageStage'), TESTLAB.indexOf('async function runEmptySceneStage'));
    expect(stage).toMatch(/const pageImageModel = params\.imageModel \|\| tier\.pageImageModel;/);
    const { MODEL_DEFAULTS, IMAGE_MODELS } = nodeRequire('../../server/config/models.js');
    expect(MODEL_DEFAULTS.simplePageImage).toBe(MODEL_DEFAULTS.pageRenderImage);
    expect(IMAGE_MODELS[MODEL_DEFAULTS.pageRenderImage].modelId).toBe('grok-imagine-image-2.0');
  });

  it('the composite stage states an EMPTY set rather than omitting it', () => {
    // It hands its prompt to the blend pass, which attaches no element cells.
    const call = callBody(TESTLAB, 'buildImagePrompt', 1);
    expect(call).toMatch(/vbRefElementIds:\s*\[\]/);
  });
});

// ── 2. the per-page Art Director ────────────────────────────────────────────
describe('the per-page Art Director prompt is decided by the clothing contract and the story', () => {
  const build = (opts: any) => PB.buildSceneExpansionPrompt(
    4, 'PLAN: medium — Mira — Mira lifts the lantern', CHARACTERS, 'en',
    VISUAL_BIBLE, '', null, { maxCharactersPerScene: 3, artStyleId: 'watercolor', imageBackend: 'grok', ...opts });

  it('without the contract no character carries an outfit; with it, every one does', () => {
    // The per-page fallback attaches no referencePhotos, so the contract is the
    // ONLY outfit source there.
    expect(build({}).includes(CONTRACT_GARMENT)).toBe(false);
    expect(build({ clothingRequirements: CLOTHING_REQUIREMENTS }).includes(CONTRACT_GARMENT)).toBe(true);
  });

  it('the season comes from the story, not from the day the prompt is built', () => {
    const summer = build({ story: storyWith({ season: 'summer' }) });
    const winter = build({ story: storyWith({ season: 'winter' }) });
    expect(summer).not.toBe(winter);
    // A story whose season was never stamped still resolves from its OWN date.
    const byDate = build({ story: storyWith({ season: '', createdAt: '2026-07-15T10:00:00.000Z' }) });
    expect(byDate).toBe(summer);
  });

  it('the text-zone rule family follows the story layout', () => {
    const below = build({ story: storyWith({ layout: { textInImage: false } }) });
    const overlay = build({ story: storyWith({ layout: { textInImage: true } }) });
    expect(below).not.toBe(overlay);
    // The story is exactly equivalent to stating the gate outright — which is
    // what proves `story` is the gate's input and not some other difference.
    expect(below).toBe(build({ story: storyWith({ layout: { textInImage: false } }), textZoneRules: false }));
    expect(overlay).toBe(build({ story: storyWith({ layout: { textInImage: true } }), textZoneRules: true }));
    // …and with no story at all the rules stay on: the pre-flag behaviour, and
    // the reason a Lab that omitted `story` measured a book production does not
    // print.
    expect(build({}).includes('{TEXT_ZONE') ).toBe(false);
    expect(build({}).length).toBe(build({ textZoneRules: true }).length);
  });
});

describe('the Lab beats stage runs the run\'s own Art Director and review', () => {
  // Since 2026-09-27 beats_scenes calls beatsPipeline.runArtDirector (the
  // all-pages call, its recovery, the per-page fallback with the clothing
  // contract and the story, the bible adoption) and runSceneReview; it keeps
  // no builder call, parse or bible adoption of its own.
  it('calls the shared functions and no Art Director builder of its own', () => {
    const stage = TESTLAB.slice(TESTLAB.indexOf('async function runBeatsScenesStage'), TESTLAB.indexOf('async function runTextRefineStage'));
    expect(stage).toMatch(/await runArtDirector\(\{/);
    expect(stage).toMatch(/await runSceneReview\(\{/);
    expect(stage).not.toMatch(/buildSceneExpansionPrompt\(|buildSceneExpansionAllPrompt\(|new UnifiedStoryParser\(/);
  });
});

// ── 3. the scene-description rewrite ────────────────────────────────────────
describe('the scene-description rewrite is anchored by the page plan line', () => {
  const build = (raw: any, opts: any = {}) => PB.buildSceneDescriptionPrompt(
    4, 'Mira lifted the lantern high.', CHARACTERS, '', 'en', VISUAL_BIBLE, [], 'standard', '',
    '', raw, null, opts);

  it('a plan line reaches the prompt; a null one leaves the anchor empty', () => {
    const anchored = build({ planLine: 'PLAN: medium — Mira — Mira lifts the lantern' });
    const blind = build(null);
    expect(anchored).not.toBe(blind);
    expect(anchored.includes('Mira lifts the lantern')).toBe(true);
    expect(anchored.length).toBeGreaterThan(blind.length);
  });

  it('the clothing contract is the rewrite\'s outfit source too', () => {
    const withContract = build({ planLine: 'PLAN: x' }, { clothingRequirements: CLOTHING_REQUIREMENTS });
    const without = build({ planLine: 'PLAN: x' });
    expect(withContract.includes(CONTRACT_GARMENT)).toBe(true);
    expect(without.includes(CONTRACT_GARMENT)).toBe(false);
  });
});

describe('the Lab scene_description stage passes what /regenerate/scene-description passes', () => {
  const call = callBody(TESTLAB, 'buildSceneDescriptionPrompt', 1);
  const ROUTE = read('server/routes/regeneration.js');

  it('resolves the plan line through the same resolver the route uses', () => {
    expect(call).toMatch(/planLine \? \{ planLine \} : null/);
    expect(ROUTE).toMatch(/planLine \? \{ planLine \} : null/);
    // ONE resolver on both sides — never a second reading of outlineExtract.
    expect(TESTLAB).toMatch(/resolvePlanLine\(storedScene, storedImage\)/);
    expect(ROUTE).toMatch(/resolvePlanLine\(storedScene, storedImage\)/);
  });

  it('passes the clothing contract', () => {
    expect(call).toMatch(/clothingRequirements:/);
  });
});

// ── 4. the season fallback is loud ──────────────────────────────────────────
describe('a page-brief builder never takes the season from today in silence', () => {
  const fires: string[] = [];
  const capture = <T,>(fn: () => T): T => {
    const orig = logger.log.error;
    logger.log.error = (line: string) => { if (String(line).includes('[SEASON]')) fires.push(String(line)); };
    try { return fn(); } finally { logger.log.error = orig; }
  };

  it('returns exactly what seasonLabel returns — the value is unchanged', () => {
    for (const story of [
      storyWith({ season: 'winter' }),
      storyWith({ season: '', createdAt: '2026-01-04T00:00:00Z' }),
      {},
      null,
    ] as any[]) {
      expect(capture(() => PB.pageSeasonLabel(story, 'probe'))).toBe(seasonLabel(story || {}));
    }
  });

  it('says so, naming the builder, when there is no season and no story date', () => {
    fires.length = 0;
    capture(() => PB.pageSeasonLabel({}, 'scene-expansion P4'));
    capture(() => PB.pageSeasonLabel(null, 'scene-iteration P4'));
    capture(() => PB.pageSeasonLabel({ characters: [] }, 'scene-expansion-all'));
    expect(fires).toHaveLength(3);
    expect(fires[0]).toContain('scene-expansion P4');
    expect(fires[1]).toContain('scene-iteration P4');
  });

  it('stays quiet for a story that carries a season, or only a date', () => {
    fires.length = 0;
    capture(() => PB.pageSeasonLabel(storyWith({ season: 'summer' }), 'x'));
    capture(() => PB.pageSeasonLabel({ createdAt: '2026-07-15T10:00:00Z' }, 'x'));
    expect(fires).toHaveLength(0);
  });

  it('is the ONE construction — no builder spells the silent fallback itself', () => {
    // Code only — a comment is allowed to quote the expression it warns about.
    const PB_SRC = read('server/lib/promptBuilders.js')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    // `seasonLabel(x || {})` is the expression that swallowed this. It may
    // survive only inside pageSeasonLabel, which is where the loud check lives.
    const silent = PB_SRC.match(/seasonLabel\([A-Za-z_$][\w.$]*\s*\|\|\s*\{\}\)/g) || [];
    expect(silent).toHaveLength(1);
    expect(PB_SRC.slice(PB_SRC.indexOf('function pageSeasonLabel'))).toContain(silent[0]);
  });
});
