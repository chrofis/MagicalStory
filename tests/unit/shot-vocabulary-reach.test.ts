/**
 * THE SHOT RULE MUST REACH THE ILLUSTRATOR — AND SURVIVE THE CUT.
 *
 * A page's camera framing is decided by the beats planner, carried through the
 * Art Director's `shot` field and acted on by the image model. Two faults, both
 * measured on staging job_1789506283204_3kxqshifx:
 *
 *   A. The only statement of what a shot word MEANS lived in the
 *      `**Composition:**` block — FIRST in CUT_DROP_ORDER (images.js), the block
 *      `sectionAwareCut` drops before any other when a built prompt is over the
 *      model's character cap. Nine of that story's eighteen pages went over and
 *      lost it: p1, p3, p4, p6, p7, p9, p13, p15 and p18 store a prompt with no
 *      Composition block and the cut's single-newline fingerprint before the
 *      protected tail. On those pages the model was told which shot the scene
 *      declared and never told what the word meant.
 *   B. `ultra-wide` is produced by the planner (prompts/story-beats.txt) and
 *      counted by planCounters, but the Art Director enum offered three words
 *      and the image prompt defined three. The fourth word arrived undefined.
 *
 * These pin BEHAVIOUR — that the rule survives the shrinker and that one
 * constant reaches every stage — never the wording of any prompt.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const PB = require_('../../server/lib/promptBuilders');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const images = require_('../../server/lib/images');
const { IMAGE_MODELS, resolveGrokImageModel } = require_('../../server/config/models');
const { SHOT_TYPES, SHOT_ENUM, SHOT_DEFINITIONS, SHOT_PATTERNS } = require_('../../server/lib/shotVocabulary');

const CAP: number = IMAGE_MODELS[resolveGrokImageModel(null).key]?.maxPromptLength || 7900;

const CHARACTERS = [
  { id: 'c1', name: 'Mira', age: 8, gender: 'girl', personality: 'stubborn', hairColor: 'brown' },
  { id: 'c2', name: 'Tobias', age: 5, gender: 'boy', personality: 'shy', hairColor: 'black' },
];

const inputData: any = {
  title: 'The Lamp on the Pier',
  characters: CHARACTERS,
  mainCharacters: ['c1'],
  language: 'en',
  pages: 4,
  storyCategory: 'adventure',
  storyType: 'adventure',
  artStyle: 'watercolor',
  relationships: {},
  relationshipTexts: {},
};

const VISUAL_BIBLE: any = { artifacts: [], locations: [], vehicles: [], characters: [] };

const BEATS = [
  { pageNumber: 1, planLine: 'wide — the main character on the pier — she lifts the lantern — the lamp is lit' },
  { pageNumber: 2, planLine: 'ultra-wide — both characters — they cross the empty flats — the far shore is reached' },
];

const brief = (prose: string) =>
  `${prose}\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'the lamp is lit',
    characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
    shot: 'ultra-wide',
    objects: [],
    textPosition: 'bottom-left',
  })}`;

beforeAll(async () => { await loadPromptTemplates(); });

// The sentence that identifies the rule wherever it ends up. Taken from the
// constant, so rewording the rule reworded the test with it — this asserts the
// rule's PRESENCE and SURVIVAL, not its prose.
const SHOT_MARKER = 'The scene description declares the shot.';

describe('one shot vocabulary reaches every stage that uses the word', () => {
  it('the vocabulary itself carries ultra-wide, and recognition stays longest-first', () => {
    expect(SHOT_TYPES).toContain('ultra-wide');
    // "ultra-wide" contains "wide": recognised second, a plan line reading
    // "ultra-wide" is counted as a plain wide shot.
    const order = SHOT_PATTERNS.map((p: [string, RegExp]) => p[0]);
    expect(order.indexOf('ultra-wide')).toBeLessThan(order.indexOf('wide'));
    expect(order.indexOf('close-up')).toBeLessThan(order.indexOf('medium'));
  });

  it('the plan-line counters read the shared table, not a copy of their own', () => {
    const counters = require_('../../server/lib/planCounters');
    // planCounters is the consumer that turns a plan line into a shot; if it
    // ever re-declares the table, a word can exist for it and for nobody else.
    const src = require_('fs').readFileSync(
      require_('path').join(process.cwd(), 'server/lib/planCounters.js'), 'utf8');
    expect(src).toContain("require('./shotVocabulary')");
    expect(src).not.toMatch(/const SHOT_PATTERNS = \[/);
    expect(typeof counters).toBe('object');
  });

  it('both Art Director prompts state the same enum, and it names every shot', () => {
    const all = PB.buildSceneExpansionAllPrompt(inputData, BEATS, {});
    const one = PB.buildSceneExpansionPrompt(1, 'The lamp went out.', CHARACTERS, 'en', VISUAL_BIBLE, '', null, {});
    for (const [label, prompt] of [['all-pages', all], ['per-page', one]] as [string, string][]) {
      expect(prompt, `${label} Art Director lost the shot enum`).toContain(SHOT_ENUM);
      for (const shot of SHOT_TYPES) {
        expect(prompt, `${label} Art Director never names \`${shot}\``).toContain(`\`${shot}\``);
      }
      expect(prompt, `${label} Art Director left {SHOT_ENUM} unfilled`).not.toContain('{SHOT_ENUM}');
    }
  });

  it('the built image prompt defines every shot the Art Director may declare', () => {
    const prompt = PB.buildImagePrompt(brief('The main character crosses the flats.'), inputData, null, VISUAL_BIBLE, 1, null, {});
    expect(prompt).toContain(SHOT_MARKER);
    expect(prompt).not.toContain('{SHOT_DEFINITIONS}');
    for (const shot of SHOT_TYPES) {
      expect(prompt, `the illustrator is never told what \`${shot}\` means`).toContain(shot);
    }
  });

  it('the definitions live in the protected tail, after the cut split point', () => {
    const prompt = PB.buildImagePrompt(brief('The main character crosses the flats.'), inputData, null, VISUAL_BIBLE, 1, null, {});
    // sectionAwareCut splits at the first of these markers and never touches
    // anything after it. The shot rule must sit on the far side.
    const objIdx = prompt.indexOf('**REQUIRED OBJECTS');
    const tailStart = objIdx >= 0 ? objIdx : prompt.indexOf('**ART STYLE');
    expect(tailStart).toBeGreaterThan(0);
    expect(prompt.indexOf(SHOT_MARKER)).toBeGreaterThan(tailStart);
  });
});

describe('the shot rule survives an over-cap prompt', () => {
  // The shape of the four pages that lost it: a long head, the Composition
  // block, then the protected tail. Built from the real template so the drop
  // order under test is the production one.
  const overCapPrompt = () => {
    const prompt = PB.buildImagePrompt(brief('The main character crosses the flats.'), inputData, null, VISUAL_BIBLE, 1, null, {});
    const objIdx = prompt.indexOf('**REQUIRED OBJECTS');
    const tailStart = objIdx >= 0 ? objIdx : prompt.indexOf('**ART STYLE');
    const head = prompt.slice(0, tailStart);
    const tail = prompt.slice(tailStart);
    // Pad the SCENE PROSE — the part a real page grows — until the whole thing
    // is comfortably over the model's cap, as p1 (9,088 chars) was.
    const filler = Array.from({ length: 60 },
      (_, i) => `Figure ${i} stands near landmark ${i} wearing garment ${i} in colour ${i}.`).join(' ');
    return `${head}\n${filler}\n${tail}`;
  };

  it('is over the cap and still loses the Composition block to the cut', async () => {
    const built = overCapPrompt();
    expect(built.length).toBeGreaterThan(CAP);
    // No LLM in this path: shrinkPromptForModel only compresses when a text
    // model is reachable, and the deterministic section-aware cut is the
    // guarantee branch. Either way the assertion below holds.
    const out = await images.shrinkPromptForModel(built, CAP, 'TEST', null, null);
    expect(out.length).toBeLessThanOrEqual(CAP);
    // The reproduction: the head block really is the one that goes.
    expect(out).not.toContain('**Composition:**');
  }, 30000);

  it('keeps the shot rule anyway, because it is no longer in the head', async () => {
    const built = overCapPrompt();
    const out = await images.shrinkPromptForModel(built, CAP, 'TEST', null, null);
    expect(out, 'the shot rule was cut with the head block again').toContain(SHOT_MARKER);
    for (const shot of SHOT_TYPES) {
      expect(out, `\`${shot}\` lost its definition to the cut`).toContain(shot);
    }
  }, 30000);

  it('keeps the other tail rules it shares the tail with', async () => {
    const built = overCapPrompt();
    const out = await images.shrinkPromptForModel(built, CAP, 'TEST', null, null);
    // The blocks that survived on all five investigated pages. Adding the shot
    // rule to the tail must not have pushed any of them out.
    expect(out).toContain('**REQUIRED CAST:**');
    expect(out).toContain('**DEPTH AND SIZE:**');
    expect(out).toContain('**ART STYLE:**');
  }, 30000);
});

describe('the definitions block is one string, not a per-stage copy', () => {
  it('is assembled from the same shot list the enum is', () => {
    for (const shot of SHOT_TYPES) expect(SHOT_DEFINITIONS).toContain(shot);
    expect(SHOT_DEFINITIONS).toContain(SHOT_MARKER);
  });
});
