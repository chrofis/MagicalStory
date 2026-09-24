/**
 * CELLS GET NO SIZE (owner, 2026-09-23; decisions.md 2026-09-24).
 *
 * A Visual Bible reference cell paints ONE element alone, so it has exactly
 * one size — its own — and a phrase measuring it against an adult names a
 * figure the cell must not draw (feedback: no scale referent in a VB cell).
 * The animal builder used to bake the `scaleClass` phrase into `description`,
 * which is the cell's prose: staging job_1790100385959_1nitlympp ANI001
 * "terrier-mix dog. stands knee-high to an adult. …".
 *
 * The scale now lives only in `scaleClass` (or a pre-enum stored `size`), and
 * every PAGE-side reader of a creature's description states it through
 * `withScaleNote`. These cases pin both halves on the parser the pipeline runs
 * (UnifiedStoryParser.extractVisualBible), and the permanent pre-enum fallback.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const { UnifiedStoryParser } = cjs('../../server/lib/outlineParser/unified.js');
const VB = cjs('../../server/lib/visualBible.js');
const RS = cjs('../../server/lib/referenceSheets.js');
const PB = cjs('../../server/lib/promptBuilders.js');

const NL = String.fromCharCode(10);
const parse = (data: any) => new UnifiedStoryParser(
  ['---VISUAL BIBLE---', '```json', JSON.stringify(data), '```'].join(NL)
).extractVisualBible();

const PHRASES: string[] = Object.values(VB.SCALE_PHRASES);
const KNEE = VB.SCALE_PHRASES['knee-high'];
const FOREARM = VB.SCALE_PHRASES['forearm-sized'];
const LEGACY_SIZE = 'about as long as a garden bench';

const dog = { id: 'ANI001', name: 'Wuschel', pages: [1, 2], scaleClass: 'knee-high', species: 'terrier-mix dog', coloring: 'scruffy light brown and white coat', features: 'floppy ears, short tail' };
const baby = { id: 'ANI002', name: 'Funki', pages: [1, 2], scaleClass: 'forearm-sized', species: 'baby dragon', coloring: 'bright orange smooth scales', features: 'tiny blunt horns' };
const egg = { id: 'ART001', label: 'grey dragon egg', name: 'grey dragon egg', pages: [1, 2], scaleClass: 'melon-sized', type: 'egg', description: 'an oval egg with a smooth slate-grey surface' };
// A pre-enum stored animal: `size` present, `scaleClass` absent.
const legacyGoat = { id: 'ANI003', name: 'Meck', pages: [1, 2], species: 'goat', coloring: 'white', size: LEGACY_SIZE };

const vb = () => parse({ animals: [dog, baby, legacyGoat], artifacts: [egg] });

const noPhrase = (text: string) => {
  for (const p of PHRASES) expect(text, p).not.toContain(p);
  expect(text).not.toContain(LEGACY_SIZE);
};

describe('the reference cell states no size', () => {
  beforeAll(async () => {
    await cjs('../../server/services/prompts.js').loadPromptTemplates();
  });

  it('the computed animal description carries no scale phrase', () => {
    const bible = vb();
    for (const a of bible.animals) noPhrase(a.description);
    expect(bible.animals[0].description).toBe('terrier-mix dog. scruffy light brown and white coat. floppy ears, short tail');
  });

  it('the built reference-sheet prompt carries no scale phrase for any element', () => {
    const elements = VB.getElementsNeedingReferenceImages(vb());
    expect(elements.map((e: any) => e.id).sort()).toEqual(['ANI001', 'ANI002', 'ANI003', 'ART001']);
    const prompt = RS.buildReferenceSheetPrompt(elements, 'watercolor');
    expect(prompt).toContain('terrier-mix dog');
    noPhrase(prompt);
  });

  it('the element-cell gate question carries no scale phrase', () => {
    for (const el of VB.getElementsNeedingReferenceImages(vb())) {
      noPhrase(RS.elementCellGatePrompt(el, 'watercolor'));
    }
  });
});

describe('every page-side reader of a creature still states its scale', () => {
  const inputData: any = {
    title: 'The Yard', characters: [{ id: 'c1', name: 'Mira', age: 8, gender: 'girl' }],
    mainCharacters: ['c1'], language: 'en', languageLevel: 'medium', pages: 4,
    artStyle: 'watercolor', relationships: {}, relationshipTexts: {},
  };
  const brief = (objects: string[]) => ['The main character walks across the yard.', '', '---METADATA---', JSON.stringify({
    sceneIntent: 'a walk', characters: [{ name: 'Mira', position: 'center', depth: 'midground' }],
    shot: 'wide', objects, textPosition: 'bottom-left',
  })].join(NL);

  it('REQUIRED OBJECTS (page prompt)', () => {
    const prompt = String(PB.buildImagePrompt(brief(['ANI001', 'ANI003']), inputData, null, vb(), 1, null, {}));
    expect(prompt).toContain(KNEE);
    expect(prompt).toContain(LEGACY_SIZE);
  });

  it('the VISUAL REFERENCE ELEMENTS fallback (page prompt with no cited objects)', () => {
    const block = VB.buildVisualBiblePrompt(vb(), 1);
    expect(block).toContain(`floppy ears, short tail. Size: ${KNEE}`);
    expect(block).toContain(`Size: ${FOREARM}`);
    expect(block).toContain(`Size: ${LEGACY_SIZE}`);
  });

  it('the cover KEY STORY ELEMENTS', () => {
    const block = VB.buildFullVisualBiblePrompt(vb(), { skipMainCharacters: true, allowedElementIds: ['ANI001', 'ANI003'] });
    expect(block).toContain(`Size: ${KNEE}`);
    expect(block).toContain(`Size: ${LEGACY_SIZE}`);
  });

  it('the plate creature block (resolveSceneCreatures)', () => {
    const creatures = VB.resolveSceneCreatures(vb(), ['ANI001', 'ANI003']);
    expect(creatures.find((c: any) => c.id === 'ANI001').description).toContain(`Size: ${KNEE}`);
    expect(creatures.find((c: any) => c.id === 'ANI003').description).toContain(`Size: ${LEGACY_SIZE}`);
  });

  it('the Art Director recurring-elements block', () => {
    const text = PB.buildRecurringElementsText(vb());
    expect(text).toContain(`Size: ${KNEE}`);
    expect(text).toContain(`Size: ${LEGACY_SIZE}`);
  });

  it('the detector roster (buildSecondaryCharacterDescriptions, animals included)', () => {
    const out = PB.buildSecondaryCharacterDescriptions(vb(), ['ANI001', 'ANI003'], [], '', { includeAnimals: true });
    expect(out.ANI001.richDescription).toContain(`Size: ${KNEE}`);
    expect(out.ANI003.richDescription).toContain(`Size: ${LEGACY_SIZE}`);
  });

  it('the brief rewriter staged-figures pool (iterateBeat.figurePool)', () => {
    const { figurePool } = cjs('../../server/lib/iterateBeat.js');
    const pool = figurePool(vb());
    expect(pool.find((f: any) => f.id === 'ANI001').description).toContain(`Size: ${KNEE}`);
    expect(pool.find((f: any) => f.id === 'ANI003').description).toContain(`Size: ${LEGACY_SIZE}`);
  });

  it('withScaleNote adds nothing when an element states no scale', () => {
    expect(VB.withScaleNote('a goat', { scaleClass: null })).toBe('a goat');
    expect(VB.withScaleNote('a goat.', { scaleClass: 'knee-high' })).toBe(`a goat. Size: ${KNEE}`);
  });
});
