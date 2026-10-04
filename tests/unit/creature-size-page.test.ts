/**
 * A LARGE CREATURE DRAWN TOO SMALL (owner, 2026-09-26; staging
 * job_1790373080139_vnx5l8iy7, dragon run 8).
 *
 * The grown dragon (VB ANI001, `twice-adult-height`) was stated "twice the
 * height of a standing adult" on every page and rendered large on p5,
 * cat-sized on p10, child-plus on p16/p17 and boy-sized on p18. Four causes,
 * four image-side fixes — sizes stay out of the arc, plan and text:
 *   A  the VB entry states the creature's MATURITY (identity), never a size;
 *   B  the page prompt measures the creature against the people in frame;
 *      the `cute` tone lets a large creature tower gently;
 *   C  the evaluator has a `creature_scale` finding (D-34), capped at MAJOR;
 *   D  that finding routes to iterate, and every repaint carries the size.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const VB = cjs('../../server/lib/visualBible.js');
const PB = cjs('../../server/lib/promptBuilders.js');
const { deductionPoints, SEVERITY_POINTS } = cjs('../../server/lib/scoring.js');
const { BUCKETS, bucketForType, CONSOLIDATED_TYPES } = cjs('../../server/lib/evalBuckets.js');
const { decideRepairMethod, NOT_INPAINTABLE_TYPES, ITERATE_ROUTED_TYPES } = cjs('../../server/lib/repairLogic.js');
const { applyRule7SceneFixGuard } = cjs('../../server/lib/feedbackConsolidator.js');
const { loadPromptTemplates, PROMPT_TEMPLATES, buildEvaluationPrompt } = cjs('../../server/services/prompts.js');

const NL = String.fromCharCode(10);
const TWICE = VB.SCALE_PHRASES['twice-adult-height'];
const MELON = VB.SCALE_PHRASES['melon-sized'];

// The stored authored fields of the job above, verbatim.
const grown = {
  id: 'ANI001', name: 'Rubina', pages: [5, 10], scaleClass: 'twice-adult-height', species: 'dragon',
  coloring: 'autumn red and yellow scales',
  features: 'cute rounded forms, friendly warm round eyes, no teeth showing, a calm mouth, short blunt-tipped horns, a smooth back without spikes, and large folding wings',
};
const hatchling = {
  id: 'ANI002', name: 'baby dragon', pages: [17, 18], scaleClass: 'melon-sized', species: 'dragon',
  coloring: 'autumn red and yellow scales',
  features: 'cute rounded forms, a soft face, large round friendly eyes, no teeth, a tiny smooth tail, and tiny folded wings',
};
const bible = () => ({
  animals: [grown, hatchling].map(a => ({ ...a, appearsInPages: a.pages, description: VB.buildAnimalDescription(a) })),
});
// Stored heights of the four boys (explicit `height`), and one age-only child.
const LEVIN = { name: 'Levin', age: '5', gender: 'male', height: '110' };
const MAX = { name: 'Max', age: '3', gender: 'male' };
const DAD = { name: 'Dad', age: '38', gender: 'male' };

describe('A — a grown creature states its maturity, never a size', () => {
  it('a creature at or above a standing adult is "a fully grown adult" with adult proportions', () => {
    expect(VB.buildAnimalDescription(grown).startsWith('a fully grown adult dragon with adult body proportions. autumn red')).toBe(true);
  });

  it('its young, in a small band, keeps the bare species — the two entries now differ', () => {
    expect(VB.buildAnimalDescription(hatchling).startsWith('dragon. autumn red')).toBe(true);
    expect(VB.buildAnimalDescription(hatchling)).not.toContain('adult');
  });

  it('the bands are adult-height and up', () => {
    for (const b of ['adult-height', 'twice-adult-height', 'house-height', 'landmark']) expect(VB.isGrownCreatureScaleClass(b)).toBe(true);
    for (const b of ['chest-high', 'waist-high', 'knee-high', 'melon-sized', null]) expect(VB.isGrownCreatureScaleClass(b)).toBe(false);
    expect(VB.isGrownCreatureScaleClass('double'), 'legacy alias of twice-adult-height').toBe(true);
  });

  it('a species that already states an age keeps it', () => {
    expect(VB.buildAnimalDescription({ ...grown, species: 'baby giant' }).startsWith('baby giant.')).toBe(true);
  });

  it('the maturity sentence is no size: no band phrase, no human referent reaches the cell', () => {
    const d = VB.buildAnimalDescription(grown);
    for (const p of Object.values(VB.SCALE_PHRASES) as string[]) expect(d).not.toContain(p);
    expect(d).not.toMatch(/standing adult|child|person|height/);
  });
});

describe('B — the page measures the creature against the people in frame', () => {
  it('against children, by name, grouped by ratio (p10: Levin 5, Max 3)', () => {
    expect(PB.elementPageScaleNote(grown, [LEVIN, MAX]))
      .toBe(`${TWICE} — about three times the height of Levin and about four times the height of Max`);
  });

  it('against an adult it is the band phrase restated', () => {
    expect(PB.elementPageScaleNote(grown, [DAD])).toBe(`${TWICE} — about twice the height of Dad`);
  });

  it('alone, or with no readable height, it is the band phrase only', () => {
    expect(PB.elementPageScaleNote(grown, [])).toBe(TWICE);
    expect(PB.elementPageScaleNote(grown, [{ name: 'Nobody' }])).toBe(TWICE);
  });

  it('a band with no yardstick, or a pre-enum stored size, keeps its phrase', () => {
    expect(PB.elementPageScaleNote({ scaleClass: 'landmark' }, [LEVIN])).toBe(VB.SCALE_PHRASES.landmark);
    expect(PB.elementPageScaleNote({ scaleClass: 'arm-sized' }, [LEVIN])).toBe(VB.SCALE_PHRASES['arm-sized']);
    expect(PB.elementPageScaleNote({ scaleClass: null, size: 'as long as a bench' }, [LEVIN])).toBe('as long as a bench');
  });

  it('the unnamed form (repaint text) is one range over the people beside it', () => {
    expect(PB.elementPageScaleNote(grown, [LEVIN, MAX], { unnamed: true }))
      .toBe(`${TWICE} — about three to four times the height of the people beside it`);
  });

  it('reaches the REQUIRED OBJECTS line of the built page prompt', async () => {
    await loadPromptTemplates();
    const brief = ['Max waves both arms toward the tree crown.', '', '---METADATA---', JSON.stringify({
      sceneIntent: 'a shout', characters: [{ name: 'Levin', position: 'left', depth: 'midground' }, { name: 'Max', position: 'right', depth: 'midground' }],
      shot: 'medium', objects: ['ANI001'], textPosition: 'bottom-left',
    })].join(NL);
    const input: any = { characters: [LEVIN, MAX], mainCharacters: [], language: 'en', languageLevel: 'standard', pages: 4, artStyle: 'watercolor' };
    const prompt = String(PB.buildImagePrompt(brief, input, [LEVIN, MAX], bible(), 10, null, {}));
    expect(prompt).toContain(`* **Rubina** (animal) — ${TWICE} — about three times the height of Levin and about four times the height of Max`);
  });

  it('the cute tone lets a large creature tower gently, and keeps it friendly', () => {
    const t = PB.buildCreatureToneSection({ characters: [{ name: 'A', age: '3', isMain: true }] });
    expect(t).toMatch(/drawn cute/);
    expect(t).toContain('may tower gently over a child');
    expect(t).toContain('never looming, lunging or menacing');
    expect(t).not.toContain('never frame it leaning or towering over a child');
    expect(t).not.toContain('never with the child dwarfed beside it');
  });
});

