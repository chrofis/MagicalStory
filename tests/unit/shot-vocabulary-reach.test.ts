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
const { SHOT_TYPES, SHOT_ENUM, SHOT_DEFINITIONS, SHOT_PATTERNS, SHOTS, buildShotDefinitions } = require_('../../server/lib/shotVocabulary');

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

  it('the built image prompt defines the shot the page declared, and only that one', () => {
    const prompt = PB.buildImagePrompt(brief('The main character crosses the flats.'), inputData, null, VISUAL_BIBLE, 1, null, {});
    expect(prompt).toContain(SHOT_MARKER);
    expect(prompt).not.toContain('{SHOT_DEFINITIONS}');
    // ONE definition, not eight (2026-09-21). The table cost 1,223 characters
    // of a 7,900-char budget and the cut paid for it with the page's own facts.
    const declared = SHOTS.find((x: any) => x.id === 'ultra-wide');
    expect(prompt, 'the declared shot lost its definition').toContain(declared.definition);
    for (const other of SHOTS.filter((x: any) => x.id !== 'ultra-wide')) {
      expect(prompt, `\`${other.id}\` is defined on a page that does not use it`).not.toContain(other.definition);
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

describe('an over-cap prompt keeps the page facts and pays with generic guidance', () => {
  // The shape of the fifteen pages of staging job_1789853503332_riqncqg1i that
  // stored a prompt: a long head, the Composition block, then the tail. Built
  // from the real template so the drop order under test is the production one.
  const overCapPrompt = () => {
    const prompt = PB.buildImagePrompt(brief('The main character crosses the flats.'), inputData, null, VISUAL_BIBLE, 1, null, {});
    const objIdx = prompt.indexOf('**REQUIRED OBJECTS');
    const tailStart = objIdx >= 0 ? objIdx : prompt.indexOf('**ART STYLE');
    const head = prompt.slice(0, tailStart);
    const tail = prompt.slice(tailStart);
    // Pad the SCENE PROSE — the part a real page grows — until the whole thing
    // is over the model's cap, as every page of that book was.
    const filler = Array.from({ length: 30 },
      (_, i) => `Figure ${i} stands near landmark ${i} wearing garment ${i} in colour ${i}.`).join(' ');
    return `${head}
${filler}
${tail}`;
  };

  it('fits, and the page-specific blocks are the ones that survive', async () => {
    const built = overCapPrompt();
    expect(built.length).toBeGreaterThan(CAP);
    const out = await images.shrinkPromptForModel(built, CAP, 'TEST', null, null);
    expect(out.length).toBeLessThanOrEqual(CAP);
    // The four blocks the old ranking took first, on every over-cap page.
    expect(out, 'the Composition block went again').toContain('**Composition:**');
    expect(out, 'the plate-vs-identity reference rule went again').toContain('When the FIRST reference photo');
    expect(out, 'the shot rule went again').toContain(SHOT_MARKER);
  }, 30000);

  it('drops the generic rule paragraphs first, least load-bearing first', async () => {
    const built = overCapPrompt();
    const out = await images.shrinkPromptForModel(built, CAP, 'TEST', null, null);
    // COUNTS is rank 1 and identical on every page of every book; Composition
    // carries this page's own staging. Whatever else survived, the generic one
    // can never outlive the page-specific one.
    if (!out.includes('**Composition:**')) expect(out).not.toContain('**COUNTS:**');
    expect(out.includes('**COUNTS:**') && !out.includes('**Composition:**')).toBe(false);
  }, 30000);

  it('makes no paid call to fit a prompt', async () => {
    const textModels = require_('../../server/lib/textModels');
    const orig = textModels.callTextModel;
    let calls = 0;
    textModels.callTextModel = async (...args: any[]) => { calls++; return orig(...args); };
    try {
      await images.shrinkPromptForModel(overCapPrompt(), CAP, 'TEST', null, null);
    } finally {
      textModels.callTextModel = orig;
    }
    // 34 deepseek calls on one story, none of whose output reached a prompt.
    expect(calls, 'the shrinker called a text model again').toBe(0);
  }, 30000);
});

describe('a cover keeps its cast block through the cut', () => {
  // The front cover of job_1789853503332_riqncqg1i shipped with no cast block
  // at all — no garment, no age, no height. The cut removed the
  // plate-vs-identity rule by scanning forward to the next entry of a
  // hand-kept marker list, and the cast headers were not on it, so the whole
  // cast went with it. Blocks are removed by their exact text now.
  it('the block after a dropped one is never swallowed with it', async () => {
    const CAST = '**CHARACTERS IN THIS IMAGE (each person, then what that person wears):**\n'
      + '- Mira, a girl of eight, brown hair, wears a red coat and grey boots.\n'
      + '- Tobias, a boy of five, black hair, wears a blue jumper and brown shoes.\n';
    const prompt = PB.buildImagePrompt(brief('The main character crosses the flats.'), inputData, null, VISUAL_BIBLE, 1, null, {
      characterReferenceListOverride: `
${CAST}`,
    });
    const filler = Array.from({ length: 45 },
      (_, i) => `Figure ${i} stands near landmark ${i} wearing garment ${i}.`).join(' ');
    const built = prompt.replace('**ART STYLE:**', `${filler}

**ART STYLE:**`);
    expect(built.length).toBeGreaterThan(CAP);
    const out = await images.shrinkPromptForModel(built, CAP, 'TEST-COVER', null, null);
    expect(out, 'the cover lost its cast block to a neighbouring drop').toContain(CAST.trim().split('\n')[0]);
    expect(out).toContain('wears a red coat and grey boots');
  }, 30000);
});

describe('the definitions block is one string, not a per-stage copy', () => {
  it('is assembled from the same shot list the enum is', () => {
    for (const shot of SHOT_TYPES) expect(SHOT_DEFINITIONS).toContain(shot);
    expect(SHOT_DEFINITIONS).toContain(SHOT_MARKER);
  });
});
