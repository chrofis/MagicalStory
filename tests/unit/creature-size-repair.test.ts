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

describe('D — a creature drawn too small is a page redo, and every repaint keeps its size', () => {
  const SCORES = { scoreBreakdown: { visual: { score: 50 }, semantic: { score: 70 } }, finalScore: 50 };
  const SMALL = { type: 'creature_scale', severity: 'MAJOR', character: 'Rubina', description: 'Rubina is drawn no taller than Julian' };

  it('routes to iterate, never char-fix or inpaint', () => {
    const d = decideRepairMethod(16, { ...SCORES, fixableIssues: [SMALL] }, null, { characters: [{ name: 'Julian' }] });
    expect(d.method).toBe('iterate');
    expect(NOT_INPAINTABLE_TYPES.has('creature_scale')).toBe(true);
    expect(ITERATE_ROUTED_TYPES.has('creature_scale')).toBe(true);
  });

  it('a lesser inpaintable finding does not hold the redo back', () => {
    const d = decideRepairMethod(16, { ...SCORES, fixableIssues: [SMALL, { type: 'emotion', severity: 'MINOR', character: 'Julian', fix: 'smile' }] }, null, {});
    expect(d.method).toBe('iterate');
  });

  it('a CRITICAL an inpaint can execute takes the round first', () => {
    const d = decideRepairMethod(16, { ...SCORES, fixableIssues: [SMALL, { type: 'rendered_text', severity: 'CRITICAL', description: 'caption' }] }, null, {});
    expect(d.method).not.toBe('iterate');
  });

  it('a plan that carries it drops it as a redo, not a character repair', () => {
    const plan = applyRule7SceneFixGuard({ scene_fix: { instruction: 'Enlarge the dragon', types: ['creature_scale'], severity: 'MAJOR' } }, 16);
    expect(plan.scene_fix.instruction).toBe('');
    expect(plan.dropped_issues[0].reason).toBe('requires_iterate_not_inpaint');
    const other = applyRule7SceneFixGuard({ scene_fix: { instruction: 'Recolour the coat', types: ['clothing'], severity: 'MAJOR' } }, 16);
    expect(other.dropped_issues[0].reason).toBe('requires_char_fix_not_inpaint');
  });

  it('the repaint instruction states every cited creature\'s size, with no names', () => {
    const { buildRepairNameMap } = cjs('../../server/lib/repairLogic.js');
    const { buildCreatureSizeClauseForRepair, buildInpaintInstruction } = cjs('../../server/lib/images.js');
    const vb = bible();
    const nameMap = buildRepairNameMap({ characters: [LEVIN, MAX], visualBible: vb, pageNumber: 10 });
    const clause = buildCreatureSizeClauseForRepair({
      visualBible: vb, sceneMetadata: { objects: ['ANI001'], characters: ['Levin', 'Max'] }, characters: [LEVIN, MAX], nameMap,
    });
    expect(clause).toContain('Sizes that hold after the edit: the grown dragon');
    expect(clause).toContain(`${TWICE} — about three to four times the height of the people beside it`);
    expect(clause).not.toMatch(/Rubina|Levin|Max/);
    const sent = buildInpaintInstruction({ editInstruction: '1. Turn the dragon toward the boy.', creatureSizeClause: clause });
    expect(sent).toContain(clause);
  });
});
