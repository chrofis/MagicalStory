/**
 * MEASURED EVIDENCE PIN — what the landmark removal guard actually catches and
 * what it lets through. Asserts CURRENT behaviour; it changes nothing.
 *
 * Swept 2026-09-18 over every stored page carrying a landmark reference photo:
 * 429 on staging, 413 on production. Fires reconstructed exactly — the only
 * step between `threeStageResult.complianceResult.fixable_issues` (raw) and the
 * stored `threeStageResult.fixableIssues` (kept) is `filter(i => i.description)`
 * and this guard, so the difference IS the guard.
 *
 *   staging  15 fires, 11 false, 12 of them actually dropped a stored finding
 *   prod      0 fires from the compliance judge — it has never once emitted the
 *             type `object_presence` (0 of 113 findings over 413 landmark pages)
 *
 * The scope problem is visible on ONE page. Staging
 * `job_1789681157795_wkt20ckod` p11 (landmark "Lindenhof plaza with linden
 * trees", era "present day") produced two findings about the same background:
 *
 *   type `object_presence`  fix "Remove windows and white frames from stone
 *                               wall …"                       → DROPPED
 *   type `setting`          fix "Replace urban background with natural
 *                               hillside or wooded area …"    → KEPT
 *
 * The guard dropped the narrow one and passed the one that would repaint the
 * real Zürich cityscape seen from the Lindenhof out of the frame — the exact
 * operation the guard exists to stop (docs/decisions.md 2026-09-05, the
 * Uetliberg Fernsehturm). The trigger is one type out of the ~20 in
 * image-prompt-compliance.txt's closed list, and the landmark-destroying
 * findings arrive as `setting`, `object`, `extra_object` and `background`.
 *
 * Widening the trigger, or moving the rule to the prompt, is a prompt-vs-code
 * decision for the owner (CLAUDE.md: classification belongs to the PROMPT).
 * These tests only stop the current scope from being mistaken for intent.
 */
import { describe, it, expect } from 'vitest';

const {
  computeLandmarkProtection,
  filterProtectedRemovals,
  isRemovalShapedFix,
} = require('../../server/lib/landmarkProtection');

const LINDENHOF = [{ name: 'Lindenhof plaza with linden trees' }];
const protectedPage = () => computeLandmarkProtection({ landmarkPhotos: LINDENHOF, era: 'present day' });

/** Both findings as stored on job_1789681157795_wkt20ckod p11. */
const OBJECT_PRESENCE_FINDING = {
  type: 'object_presence',
  severity: 'MAJOR',
  description: "Stone wall includes 'small windows' and 'white window frames' not mentioned in prompt or contract",
  fix: "Remove windows and white frames from stone wall to match prompt's 'old retaining wall' without architectural features",
};
const SETTING_FINDING = {
  type: 'setting',
  severity: 'MAJOR',
  description: 'Background includes cityscape, buildings, cranes not present in prompt; contradicts Lindenhof plaza setting description',
  fix: "Replace urban background with natural hillside or wooded area consistent with Lindenhof plaza's actual layout",
};

describe('landmark guard scope — measured on job_1789681157795_wkt20ckod p11', () => {
  it('both fixes read as removals; the type alone decides which one is guarded', () => {
    expect(isRemovalShapedFix(OBJECT_PRESENCE_FINDING)).toBe(true);
    expect(isRemovalShapedFix(SETTING_FINDING)).toBe(true);
  });

  it('the guard drops the object_presence one and KEEPS the background replacement', () => {
    const { kept, dropped } = filterProtectedRemovals(
      [OBJECT_PRESENCE_FINDING, SETTING_FINDING], protectedPage(), { pageNumber: 11, quiet: true });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].type).toBe('object_presence');
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('setting');
    expect(kept[0].fix).toMatch(/Replace urban background/);
  });

  /**
   * The other side of the same scope. `object_presence` is the compliance
   * template's type for "present but wrong, misplaced or unrequested" AND for a
   * named object rendered in the wrong colour — so a held prop whose fix says
   * "replace X with Y" is guarded exactly like a landmark removal. 8 of the 11
   * false fires were this: a plot object substituted for another object.
   */
  const HELD_PROP_FINDINGS = [
    { // job_1789348171785_9oxos7dwv p2 — the page then scored 100 with zero findings left
      type: 'object_presence', severity: 'CRITICAL',
      description: "The object Julian is lifting is described in the inventory as a 'large red-and-grey ball' rather than the specified 'rusty-red mottled egg'.",
      fix: 'Replace the red-and-grey ball with a large, football-sized, rusty-red mottled egg partially dusted with soil, consistent with the prompt and story.',
    },
    { // job_1788903616404_iqvhj4l8m p1 — likewise 100, and no other evaluator flagged it
      type: 'object_presence', severity: 'MAJOR',
      description: 'The compact rectangular plastic handlebar lamp intended for a bicycle is depicted as a generic black flashlight.',
      fix: "Replace the black flashlight in Levin's right hand with a small, compact, rectangular plastic handlebar lamp that matches bike-light proportions and styling.",
    },
    { // job_1789420511893_zly5rcdej p12 — the ship the pirate story turns on
      type: 'object_presence', severity: 'MAJOR',
      description: "The prompt specifies a massive old sailing ship with a dark wooden hull, but the inventory identifies only 'a wooden boat'.",
      fix: 'Replace the generic wooden boat in center-midground with a tall, multi-masted old sailing ship featuring a dark wooden hull, closed railings, and visible rigging.',
    },
  ];

  it('a held-prop substitution on a landmark page is dropped as if it were the landmark', () => {
    const { kept, dropped } = filterProtectedRemovals(HELD_PROP_FINDINGS, protectedPage(), { quiet: true });
    expect(dropped).toHaveLength(3);
    expect(kept).toHaveLength(0);
    // Nothing about these findings touches the real place; only the page does.
    for (const d of dropped) expect(d.description).not.toMatch(/Lindenhof|landmark|background|skyline/i);
  });

  it('the same three findings survive on a page with no landmark attached', () => {
    const noLandmark = computeLandmarkProtection({ landmarkPhotos: [], era: 'present day' });
    const { kept, dropped } = filterProtectedRemovals(HELD_PROP_FINDINGS, noLandmark, { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(3);
  });

  /**
   * Production's compliance judge has never emitted `object_presence` — 0 of
   * 113 stored findings across 413 landmark pages, against 25 of 572 on
   * staging. Its findings arrive as `object`, `extra_figure`, `background`,
   * `object_anachronism`. Pinned because "the guard protects production" is
   * the assumption this sweep disproved.
   */
  it('the production type vocabulary slips past the trigger entirely', () => {
    const prodShaped = [
      { type: 'object', severity: 'MODERATE', description: 'An unrequested red flag with a white cross is present on the tower.', fix: 'Remove the red flag with a white cross from the tower.' },
      { type: 'extra_object', severity: 'MINOR', description: 'A large yellow construction crane is visible in the background behind the Stadtturm clock tower.', fix: 'Inpaint the yellow construction crane out of the background, replacing it with clear blue sky.' },
      { type: 'background', severity: 'MAJOR', description: 'Giant steampunk clockwork mechanism dominates the sky.', fix: 'Remove the clockwork sky structure and replace with a clear bright blue midday sky. Retain European guild-house facades and river.' },
    ];
    const { kept, dropped } = filterProtectedRemovals(prodShaped, protectedPage(), { quiet: true });
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(3);
  });
});
