/**
 * A creature drawn too small is a PAGE REDO finding whichever judge files it
 * (2026-10-09, job_1791497309909_6quecrr9t p1/p1-v1). The semantic judge's type
 * list had `scale` and no `creature_scale`, so "Funka still too small" came back
 * typed `scale`, was dropped as a character repair that no creature has, and the
 * page passed at 70 with a dog-sized dragon. And a mixed scene_fix (scale +
 * creature_scale) was reported as "a character repair" though the creature half
 * belongs to the redo.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const cjs = createRequire(import.meta.url);
const { applyRule7SceneFixGuard } = cjs('../../server/lib/feedbackConsolidator.js');
const fs = cjs('fs');

describe('creature size reaches the page redo from every judge', () => {
  it('the semantic judge may file creature_scale, and keeps scale for people and objects', () => {
    const src = fs.readFileSync('prompts/image-semantic.txt', 'utf8');
    expect(src).toMatch(/`creature_scale` \(an animal or creature drawn far from the size/);
    expect(src).toMatch(/`scale` \(an everyday object oversized/);
  });
  it('a scene_fix mixing scale and creature_scale is dropped as a page redo, not a character repair', () => {
    const plan = applyRule7SceneFixGuard({ scene_fix: { instruction: 'Redraw the egg and the dragon larger', types: ['scale', 'creature_scale'], severity: 'MAJOR' } }, 1);
    expect(plan.dropped_issues[0].reason).toBe('requires_iterate_not_inpaint');
  });
  it('a pure person-scale scene_fix is still a character repair', () => {
    const plan = applyRule7SceneFixGuard({ scene_fix: { instruction: 'Make the boy smaller', types: ['scale'], severity: 'MAJOR' } }, 1);
    expect(plan.dropped_issues[0].reason).toBe('requires_char_fix_not_inpaint');
  });
});
