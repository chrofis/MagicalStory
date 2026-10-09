/**
 * A FIGURE SHOWN IN PART IS IN THE PICTURE, and a story page cites the Visual
 * Bible figures its who column names (2026-09-27).
 *
 * Staging job_1790508305061_dka3jpog9 p11: the plan line's instant stood the
 * children before the creature's wing, the who column listed only the
 * children, and the Art Director — told to stage what such a clause shows
 * "without the person" — wrote the wing and never cited the creature. The page
 * prompt carried no reference image and no size line, and no creature was
 * drawn.
 *
 * Pinned (behaviour, not wording):
 *   - ONE sentence reaches the planner's field contract and the readers' cast
 *     rule (which both Art Director templates, both iterate templates and
 *     scene-review 5a already embed — plan-line-cast-and-multi-picture-prop);
 *   - checkPlanCastCited reads the who column as a comma list and compares each
 *     item WHOLE to a figure's authored name or label; it never reads the
 *     instant, so the p11 shape (creature named only there) is the prompt's job.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { checkPage, checkPlanCastCited } from '../helpers/cast-index';
const nodeRequire = createRequire(import.meta.url);

const PB = nodeRequire('../../server/lib/promptBuilders.js');
const SBC = nodeRequire('../../server/lib/sceneBriefCheck.js');
const { extractSceneMetadata } = nodeRequire('../../server/lib/sceneMetadata.js');
const { INTRODUCED_TYPES } = nodeRequire('../../server/lib/iterateBeat.js');

const vb = {
  animals: [{ id: 'ANI001', name: 'Mira', label: 'grey dragon', pages: [5, 9, 12] }],
  secondaryCharacters: [{ id: 'CHR001', name: 'Old Keeper', pages: [3] }],
  artifacts: [{ id: 'ART001', name: 'warm scale', pages: [2, 11] }],
};
const brief = (objects: string[], characters: string[] = ['Ada', 'Ben']) =>
  `The children stand on the summit.\n\n---METADATA---\n${JSON.stringify({
    characters: characters.map(name => ({ name, clothing: 'standard' })),
    shot: 'wide', objects,
  })}`;
const check = (planLine: string, objects: string[], characters?: string[]) =>
  checkPlanCastCited({ pageNumber: 11, planLine }, extractSceneMetadata(brief(objects, characters)), vb);

describe('one sentence: a figure shown in part is in the picture', () => {
  it('reaches the planner field contract and the reader cast rule', () => {
    expect(typeof PB.FIGURE_PART_IN_FRAME_RULE).toBe('string');
    expect(PB.FIGURE_PART_IN_FRAME_RULE.length).toBeGreaterThan(40);
    expect(PB.PLAN_LINE_FIELD_CONTRACT.includes(PB.FIGURE_PART_IN_FRAME_RULE)).toBe(true);
    expect(PB.PLAN_LINE_CAST_RULE.includes(PB.FIGURE_PART_IN_FRAME_RULE)).toBe(true);
  });
});

describe('checkPlanCastCited', () => {
  it('a bible figure the who column names and objects[] omits is plan_cast_uncited', () => {
    const f = check('wide — Ada, Ben, Mira — the two stand before the wing — stopped', ['LOC004.3', 'ART001']);
    expect(f.map((x: any) => x.type)).toEqual(['plan_cast_uncited']);
    expect(f[0].detail).toContain('ANI001');
  });

  it('matches the authored label as well as the name, whole and case-insensitive', () => {
    expect(check('wide — Ada, Grey Dragon — x — y', ['LOC004.3']).map((x: any) => x.type)).toEqual(['plan_cast_uncited']);
    expect(check('wide — Ada, Mirabel — x — y', ['LOC004.3'])).toEqual([]);
  });

  it('a cited figure, dotted or bare, is clean; so is one on characters[]', () => {
    expect(check('wide — Ada, Mira — x — y', ['ANI001.2'])).toEqual([]);
    expect(check('wide — Ada, Old Keeper — x — y', ['LOC001'], ['Ada', 'Old Keeper'])).toEqual([]);
  });

  it('never reads the instant: a figure named only there is not its finding', () => {
    expect(check("wide — Ada, Ben — the two stand before Mira's great wing — stopped", ['LOC004.3'])).toEqual([]);
  });

  it('a cover page is checkCoverCast\'s, not this', () => {
    expect(checkPlanCastCited({ pageNumber: -1, planLine: 'wide — Ada, Mira — x — y' },
      extractSceneMetadata(brief(['LOC001'])), vb)).toEqual([]);
  });

  it('runs inside checkPage, is sent to the scene review, and a rewrite that introduces it is caught', () => {
    const types = checkPage({ pageNumber: 11, brief: brief(['LOC004.3']), planLine: 'wide — Ada, Ben, Mira — x — y' },
      ['Ada', 'Ben'], vb).map((x: any) => x.type);
    expect(types).toContain('plan_cast_uncited');
    expect(SBC.REVIEWABLE.has('plan_cast_uncited')).toBe(true);
    expect(INTRODUCED_TYPES.has('plan_cast_uncited')).toBe(true);
  });
});
