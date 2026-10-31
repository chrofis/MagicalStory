import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { buildTouchupPlan } = require('../../server/lib/bookReview');
const { typesAreInpaintable } = require('../../server/lib/repairLogic');

// OPUS DECIDES, THE TOOL OBEYS (owner, 2026-10-31). In book_review mode the
// reviewer routes each fault. A TOUCHUP route on a pose / state fault used to
// reach the inpaint planner's per-page-judge type filter, which dropped it:
// Lab #1768 exps 1770 (wrong_state), 1771 (wrong_action), 1773 (wrong_state)
// made no image call at all.

const fault = (type: string, detail: string) => ({
  type, detail, severity: 'major', route: { kind: 'TOUCHUP' },
});

describe('book-review TOUCHUP plan vs the inpaint type filter', () => {
  for (const type of ['wrong_state', 'wrong_action', 'clothing', 'hair', 'scale']) {
    it(`a reviewer-routed ${type} fix is not filtered out`, () => {
      const plan = buildTouchupPlan([fault(type, 'Make the lantern lit.')], null);
      expect(plan.scene_fix.types).toEqual([type]);
      expect(typesAreInpaintable(plan.scene_fix.types, plan)).toBe(true);
    });
  }

  it('the production path keeps its filter (no plan, or a plan the reviewer did not decide)', () => {
    expect(typesAreInpaintable(['wrong_state'])).toBe(false);
    expect(typesAreInpaintable(['wrong_action'], { source: 'consolidator' })).toBe(false);
    expect(typesAreInpaintable(['wrong_state'], null)).toBe(false);
  });

  it('inpaintPage applies the override at all three filter sites', () => {
    const src = readFileSync(fileURLToPath(new URL('../../server/lib/images.js', import.meta.url)), 'utf8');
    expect(src).toContain('const reviewerDecided = isReviewerDecidedPlan(');
    expect(src).toContain('if (!reviewerDecided && NOT_INPAINTABLE_TYPES.has(t))');
    expect(src).toContain('typesAreInpaintable(sceneTypes, reviewerPlan)');
    expect(src).toContain('typesAreInpaintable(types, reviewerPlan)');
  });
});
