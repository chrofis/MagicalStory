/**
 * Owner decision 2026-10-15 (docs/decisions.md): a MAJOR-or-worse READER finding admits
 * its page to repair, and a `wrong_action` finding (a different action than the brief
 * states) is a page redo, not an inpaint. Facing / gaze / pose stay action_interaction
 * and stay on inpaint (SETTLED).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const rl = require_('../../server/lib/repairLogic.js');
const eb = require_('../../server/lib/evalBuckets.js');
const sc = require_('../../server/lib/scoring.js');

// p5-shaped: finalScore 83, one consolidated reader-only MAJOR, nothing else.
const p5 = (type: string, sources: string[] = ['reader'], severity = 'MAJOR') => ({
  evaluated: true,
  finalScore: 83,
  fixableIssues: [],
  consolidatedPlan: {
    deduped_issues: [{ type, severity, sources, character: 'Spaghetti', description: 'x' }],
    scene_fix: { requires_regeneration: false },
  },
});

describe('reader rescue in findBadPages', () => {
  it('admits a page at 83 carrying a reader-only MAJOR action finding', () => {
    expect(rl.findBadPages({ 5: p5('wrong_action'), 6: p5('action_interaction') })).toEqual([5, 6]);
  });
  it('admits a MAJOR reader finding of ANY type', () => {
    expect(rl.findBadPages({ 2: p5('setting') })).toEqual([2]);
  });
  it('does not admit a MINOR reader finding, nor a MAJOR from another judge', () => {
    expect(rl.findBadPages({ 1: p5('wrong_action', ['reader'], 'MINOR'), 2: p5('action_interaction', ['semantic']) })).toEqual([]);
  });
  it('a clean page stays out', () => {
    expect(rl.findBadPages({ 1: { evaluated: true, finalScore: 90, fixableIssues: [], consolidatedPlan: { deduped_issues: [] } } })).toEqual([]);
  });
});

describe('final-audit admission', () => {
  it('a MAJOR IMG fault buys the page a round', () => {
    expect(rl.admitPagesFromAudit([{ page: 5, severity: 'MAJOR', line: 'x' }])).toEqual([5]);
  });
});

describe('wrong_action routing', () => {
  it('is its own bucket, regen, and capped at MAJOR', () => {
    expect(eb.TYPE_TO_BUCKET.wrong_action).toBe('wrong_action');
    expect(eb.CONSOLIDATED_TYPES).toContain('wrong_action');
    expect(sc.deductionPoints({ type: 'wrong_action', severity: 'CRITICAL' })).toBe(sc.deductionPoints({ type: 'wrong_action', severity: 'MAJOR' }));
  });
  it('is page-redo only; action_interaction (facing/gaze/pose) is not', () => {
    expect(rl.ITERATE_ROUTED_TYPES.has('wrong_action')).toBe(true);
    expect(rl.NOT_INPAINTABLE_TYPES.has('wrong_action')).toBe(true);
    expect(rl.ITERATE_ROUTED_TYPES.has('action_interaction')).toBe(false);
    expect(rl.NOT_INPAINTABLE_TYPES.has('action_interaction')).toBe(false);
    for (const a of ['facing', 'gaze', 'pose', 'orientation', 'camera_facing']) {
      expect(eb.TYPE_TO_BUCKET[a]).toBe('action_interaction');
    }
  });
  it('decideRepairMethod sends a MAJOR wrong_action page to iterate, a MAJOR action_interaction to inpaint', () => {
    const d = rl.decideRepairMethod(5, p5('wrong_action'), null, {});
    expect(d.method).toBe('iterate');
    const e = rl.decideRepairMethod(5, p5('action_interaction'), null, {});
    expect(e.method).toBe('inpaint');
  });
});
