/**
 * BUG scene-review-removes-who-column-cast (2026-09-28): the scene review
 * removed a character the page's who column names. Staging
 * job_1790539784661_6mjcny1c7 p7 (and p2): the who column names Mama, a Visual
 * Bible secondary the brief cites as CHR001. The brief check `cast_unlisted`
 * matched names only, read the id-cited Mama as unlisted ("The prose names
 * Mama; characters[] lists Julian, Max, Kiaan"), and the review answered by
 * declaring "REMOVED CAST: page 7 = CHR001: plan line names Mama in a clause
 * that places her as context". The page was drawn with a woman from no
 * reference.
 *
 * Pins, on the p7 inputs: (1) the check resolves a cited id to its bible name;
 * (2) a declared removal of a who-column name is refused and the page keeps its
 * pre-review brief; (3) the cast rule says a who-column name is never context.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const { checkScenes } = req('../../server/lib/sceneBriefCheck');
const { parseCastRemovals, whoColumnRemovals, revertUndeclaredRemovals } = req('../../server/lib/sceneReviewGuard');
const PB = req('../../server/lib/promptBuilders');

const VB = { secondaryCharacters: [{ id: 'CHR001', name: 'Mama', appearsInPages: [2, 7] }] };
const PLAN_7 = 'wide — Mama, Julian, Max, Kiaan — Mama sits on the bench by the flamingo pond and raises one finger in warning as the three boys face her — Mama\'s warning is given; the boys are on their own from here';
const meta7 = (withMama: boolean) => ({
  sceneIntent: 'A woman on a bench warns three boys.',
  characters: [{ name: 'Julian' }, { name: 'Max' }, { name: 'Kiaan' }],
  shot: 'wide',
  objects: withMama ? ['LOC004.1', 'CHR001'] : ['LOC004.1'],
});
const BEFORE_7 = `Beside the pond, Mama sits on a wooden park bench, holding one hand up flat toward the three boys. Julian, Max and Kiaan stand facing her.\n\n---METADATA---\n${JSON.stringify(meta7(true))}`;
const AFTER_7 = `Beside the pond the boys face the wooden bench where a raised hand gives them a warning. Julian, Max and Kiaan stand facing it.\n\n---METADATA---\n${JSON.stringify(meta7(false))}`;
const CAST = ['Levin', 'Julian', 'Max', 'Kiaan', 'Mama'];

describe('cast_unlisted reads a bible figure cited by id as listed', () => {
  it('p7: Mama cited as CHR001 is not unlisted', () => {
    const f = checkScenes([{ pageNumber: 7, brief: BEFORE_7, planLine: PLAN_7 }], CAST, VB).findings;
    expect(f.filter((x: any) => x.type === 'cast_unlisted')).toEqual([]);
  });
  it('a figure named in the prose and cited nowhere is still unlisted', () => {
    const uncited = BEFORE_7.replace('"CHR001"', '"LOC009"');
    const f = checkScenes([{ pageNumber: 7, brief: uncited, planLine: PLAN_7 }], CAST, VB).findings;
    expect(f.find((x: any) => x.type === 'cast_unlisted')?.names).toEqual(['Mama']);
  });
  it('a characters[] row carrying the id counts as the figure too', () => {
    const asRow = `Mama waves.\n\n---METADATA---\n${JSON.stringify({ characters: [{ name: 'CHR001' }], objects: ['LOC004.1'] })}`;
    const f = checkScenes([{ pageNumber: 2, brief: asRow, planLine: 'ultra-wide — Mama — Mama waits — she waits' }], CAST, VB).findings;
    expect(f.filter((x: any) => x.type === 'cast_unlisted')).toEqual([]);
  });
});

describe('a declared removal of a who-column name is refused', () => {
  const declared = parseCastRemovals('REMOVED CAST: page 2 = CHR001: plan line names only Mama but not as a character; page 7 = CHR001: plan line names Mama in a clause that places her as context, not as a character in the frame; page 9 = Levin: not in this picture');
  const planLineOf = (n: number) => ({ 2: 'ultra-wide — Mama — Mama stands waiting by the spire — she waits', 7: PLAN_7, 9: 'medium — Max, Julian — Max catches the scale — it is caught' } as any)[n] || '';

  it('the p2 / p7 declarations are the who column\'s; a figure the who column does not name may go', () => {
    expect(whoColumnRemovals(declared, planLineOf, VB)).toEqual([
      { pageNumber: 2, names: ['CHR001'] },
      { pageNumber: 7, names: ['CHR001'] },
    ]);
  });

  it('p7 ships its pre-review brief, which stages Mama', () => {
    const expansions = [{ pageNumber: 7, brief: AFTER_7, reviewRewrote: true }];
    const sceneDiffs = [{ pageNumber: 7, before: BEFORE_7, after: AFTER_7 }];
    const changed = [7];
    const rows = whoColumnRemovals(declared, planLineOf, VB).filter((r: any) => r.pageNumber === 7);
    const undone = revertUndeclaredRemovals(expansions, sceneDiffs, changed, rows.map((r: any) => ({ pageNumber: r.pageNumber, undeclared: r.names })));
    expect(undone.map((u: any) => u.pageNumber)).toEqual([7]);
    expect(expansions[0].brief).toBe(BEFORE_7);
    expect(changed).toEqual([]);
  });
});

describe('the cast rule: a who-column name is never context', () => {
  it('says every second-field name is in the picture and no rewrite removes one', () => {
    expect(PB.PLAN_LINE_CAST_RULE).toMatch(/Every name in it is in the picture, whatever the rest of the line says about them/);
    expect(PB.PLAN_LINE_CAST_RULE).toMatch(/no rewrite removes one/);
    expect(PB.PLAN_LINE_CAST_RULE).toMatch(/absent from the second field/);
  });
});
