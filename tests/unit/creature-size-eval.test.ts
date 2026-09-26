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

describe('C — creature_scale is a scored type, capped at MAJOR', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('costs MAJOR, and an escalation is capped on both shapes', () => {
    expect(deductionPoints({ type: 'creature_scale', severity: 'MAJOR' })).toBe(SEVERITY_POINTS.major);
    expect(deductionPoints({ type: 'creature_scale', severity: 'CRITICAL' })).toBe(SEVERITY_POINTS.major);
    expect(deductionPoints({ type: 'consistency', subType: 'creature_scale', severity: 'CRITICAL' })).toBe(SEVERITY_POINTS.major);
    expect(deductionPoints({ type: 'creature_scale', severity: 'MINOR' })).toBe(SEVERITY_POINTS.minor);
  });

  it('has its own bucket and is on the closed consolidated list', () => {
    expect(BUCKETS.creature_scale).toMatchObject({ owner: 'quality', repair: 'regen' });
    expect(bucketForType('creature_scale')).toBe('creature_scale');
    expect(CONSOLIDATED_TYPES).toContain('creature_scale');
  });

  it('the evaluator carries D-34 and the CREATURE SIZES input, and the consolidator keeps the type', () => {
    const t = String(PROMPT_TEMPLATES.imageEvaluation || '');
    expect(t).toMatch(/D-34 `creature_scale` → MAJOR/);
    expect(t).toContain('{CREATURE_SIZES}');
    const c = String(PROMPT_TEMPLATES.feedbackConsolidator || '');
    expect(c).toContain('`creature_scale`');
    expect(c).toContain('requires_iterate_not_inpaint');
  });

  it('the judge is fed the sentence the page prompt was given', () => {
    const block = PB.buildCreatureSizesBlock(bible(), ['LOC001.4', 'ANI001'], [LEVIN, MAX]);
    expect(block).toBe(`- Rubina: ${PB.creaturePageScaleNote(grown, [LEVIN, MAX])}`);
    const built = buildEvaluationPrompt({ originalPrompt: 'x', creatureSizes: block });
    expect(built).toContain(`12. CREATURE SIZES`);
    expect(built).toContain(block);
    expect(PB.buildCreatureSizesBlock(bible(), ['LOC001'], [LEVIN])).toBe('');
  });
});

