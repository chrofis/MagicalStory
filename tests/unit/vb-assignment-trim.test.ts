/**
 * NOTE (2026-09-11): `trimVbAssignments` has NO call site in production.
 * The bible-time trim was removed (cdb334904 — usage is derived from the
 * final briefs instead), and the function is kept only for these tests.
 * Every call below pins `budget: 3`, the size these fixtures were built
 * for, so they keep testing the function's own logic and do NOT claim 3 is
 * the production budget — that is 4 since 2026-09-11 (VB_ELEMENT_BUDGET).
 */
/**
 * VB ASSIGNMENT TRIM — the element budget enforced where the bible ASSIGNS
 * pages, before the Art Director sees it.
 *
 * `story-bible-from-beats.txt` says `pages` is earned by the plan line; the
 * model does not obey it (staging job_1788816451791_25b31uqlp: a worn backpack
 * on 11-15 pages, named in no plan line; 10-12 of 18 pages over the budget at
 * birth). Nothing checked it, and the scene review downstream could not fix it
 * (`briefFixable:false` — a brief cannot withdraw a bible placement).
 *
 * The trim is deterministic: per over-budget page, entries whose name tokens
 * occur in that page's plan line keep it, the rest yield in rankPageElements
 * order; a stripped page leaves the entry's states too; a state with no page
 * is dropped; real landmarks are never counted, so never stripped.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { trimVbAssignments, rankPageElements, VB_ELEMENT_BUDGET } = require_('../../server/lib/vbElementBudget');
const { objectStateForPage, normaliseObjectStates, getElementReferenceImagesForPage } = require_('../../server/lib/visualBible');
const { VB_SLOT_MAX_ELEMENTS } = require_('../../server/lib/grok');

const PLAN = [
  { pageNumber: 1, planLine: 'wide — the girl — she crosses the bridge, the tower behind her — she leaves town' },
  { pageNumber: 2, planLine: 'medium — the girl — she crouches at the cave mouth holding up a warm chip — the chip is warm' },
  { pageNumber: 3, planLine: 'medium — the girl and the ferryman — the ferryman lifts the lantern over the rope coil — the way is lit' },
  { pageNumber: 4, planLine: 'close-up — the girl — her hand on the cold gate — the gate is locked' },
];

/** A bible with a worn satchel on EVERY page and an invented hall on a range. */
function bible() {
  return {
    secondaryCharacters: [
      { id: 'CHR001', name: 'the ferryman', appearsInPages: [3], pages: [3] },
    ],
    animals: [],
    artifacts: [
      { id: 'ART001', name: 'the warm chip', appearsInPages: [2, 3], pages: [2, 3],
        states: normaliseObjectStates([
          { name: 'resting', delta: 'lying flat on a palm', pages: [2], held: true },
          { name: 'pocketed', delta: 'half out of a pocket', pages: [3], held: false },
        ], 'ART001') },
      { id: 'ART002', name: 'the brass lantern', appearsInPages: [3], pages: [3] },
      { id: 'ART003', name: 'the rope coil', appearsInPages: [3], pages: [3] },
      { id: 'ART004', name: "the girl's canvas satchel", appearsInPages: [1, 2, 3, 4], pages: [1, 2, 3, 4],
        states: normaliseObjectStates([
          { name: 'closed', delta: 'flap buckled', pages: [1, 2], held: false },
          { name: 'open', delta: 'flap thrown back', pages: [3, 4], held: false },
        ], 'ART004') },
    ],
    vehicles: [],
    locations: [
      { id: 'LOC001', name: 'the old stone bridge', isRealLandmark: true, appearsInPages: [1], pages: [1] },
      { id: 'LOC002', name: 'the echoing hall', appearsInPages: [1, 2, 3, 4], pages: [1, 2, 3, 4] },
    ],
  };
}

const count = (vb: any, page: number) => rankPageElements(page, {}, vb).length;
const ids = (vb: any, page: number) => rankPageElements(page, {}, vb).map((e: any) => e.id);

describe('trimVbAssignments', () => {
  it('brings every over-budget page down to the budget, plan-line-named entries first', () => {
    const vb = bible();
    // Page 3 at birth: ferryman, chip, lantern, rope coil, satchel = 5 elements
    // (the hall is a location — the plate — and is not counted).
    expect(count(vb, 3)).toBe(5);
    const report = trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    expect(report.pagesOverBudgetBefore).toBe(1);
    expect(report.pagesOverBudgetAfter).toBe(0);
    expect(count(vb, 3)).toBe(3); // the budget this call was given, not the production one
    // The three the plan line names — ferryman, lantern, rope coil — stay; the
    // chip (not named on p3) and the satchel leave the page.
    expect(ids(vb, 3)).toEqual(['CHR001', 'ART002', 'ART003']);
    expect(report.stripped.map((s: any) => `${s.id}@${s.page}`).sort()).toEqual(['ART001@3', 'ART004@3']);
  });

  it('never counts or strips a location, real or invented, even on a full range (owner, 2026-09-08)', () => {
    const vb = bible();
    const report = trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    const hall = vb.locations.find((l: any) => l.id === 'LOC002');
    expect(hall.appearsInPages).toEqual([1, 2, 3, 4]);
    expect(hall.pages).toEqual([1, 2, 3, 4]);
    expect(report.stripped.some((s: any) => s.id.startsWith('LOC'))).toBe(false);
    // A page holding nothing but its location and one prop never trips the budget.
    const solo = { artifacts: [{ id: 'ART001', name: 'a bucket', appearsInPages: [1] }],
      locations: [{ id: 'LOC001', name: 'the hall', appearsInPages: [1] }, { id: 'LOC002', name: 'the yard', appearsInPages: [1] }] };
    expect(trimVbAssignments(solo, PLAN, { budget: 3 }).pagesOverBudgetBefore).toBe(0);
  });

  it('hands the page its location cell LAST, and it is the cell the Grok slot cap drops', () => {
    const ref = (o: any) => ({ ...o, referenceImageUrl: `https://x/${o.id}.jpg` });
    const vb = {
      secondaryCharacters: [ref({ id: 'CHR001', name: 'the ferryman', appearsInPages: [3] })],
      animals: [],
      artifacts: [
        ref({ id: 'ART001', name: 'the lantern', appearsInPages: [3] }),
        ref({ id: 'ART002', name: 'the rope coil', appearsInPages: [3] }),
        ref({ id: 'ART003', name: 'the key', appearsInPages: [3] }),
      ],
      vehicles: [],
      locations: [ref({ id: 'LOC002', name: 'the echoing hall', appearsInPages: [3] })],
    };
    // The location rides LAST, on top of the elements. Until 2026-09-11 the
    // budget was 3 and budget + 1 fitted Grok's slot exactly; at budget 4 a page
    // using every element WANTS 5 cells and the slot holds 4, so the location is
    // the cell that gives way — deliberately, because five cells would put every
    // crowded page on the 200px identity floor (server/lib/vbElementBudget.js).
    const refs = getElementReferenceImagesForPage(vb, 3, VB_ELEMENT_BUDGET);
    expect(refs.map((r: any) => r.id)).toEqual(['CHR001', 'ART001', 'ART002', 'ART003', 'LOC002']);
    expect(refs).toHaveLength(VB_ELEMENT_BUDGET + 1);
    expect(refs[refs.length - 1].type).toBe('location');
    // That is one MORE than the slot holds, and grok.js applies the cap. The
    // cell that gives way is the last one — the location.
    expect(VB_ELEMENT_BUDGET).toBeGreaterThan(3);
    expect(VB_ELEMENT_BUDGET + 1).toBeGreaterThan(VB_SLOT_MAX_ELEMENTS);
  });

  it('never strips an entry the plan line names in favour of an unnamed one', () => {
    const vb = bible();
    trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    const kept = ids(vb, 3);
    for (const named of ['CHR001', 'ART002', 'ART003']) expect(kept).toContain(named);
    expect(kept).not.toContain('ART004');
  });

  it("does not count the owner's name as naming the worn item", () => {
    // "the girl's canvas satchel" — "girl" is on every plan line; "satchel" on none.
    const vb = bible();
    const report = trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    const satchel = vb.artifacts.find((a: any) => a.id === 'ART004');
    expect(satchel.appearsInPages).not.toContain(3);
    expect(report.stripped.find((s: any) => s.id === 'ART004').reason).toMatch(/not named/);
  });

  it('leaves a page that fits untouched, even for an ambient element on it', () => {
    const vb = bible();
    trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    // Pages 1, 2, 4 were within budget: the satchel and the hall keep them.
    const satchel = vb.artifacts.find((a: any) => a.id === 'ART004');
    expect(satchel.appearsInPages).toEqual([1, 2, 4]);
    expect(satchel.pages).toEqual([1, 2, 4]);
  });

  it("trims the entry's states in step and keeps the one-state-per-page contract", () => {
    const vb = bible();
    trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    const satchel = vb.artifacts.find((a: any) => a.id === 'ART004');
    expect(satchel.states.map((s: any) => s.pages)).toEqual([[1, 2], [4]]);
    for (const p of satchel.appearsInPages) expect(objectStateForPage(satchel, p)).not.toBeNull();
    expect(objectStateForPage(satchel, 3)).toBeNull();
  });

  it('drops a state left with no page, re-mints the dotted ids, and reports it', () => {
    const vb = bible();
    const report = trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    // The chip lost p3, which was its whole second state.
    const chip = vb.artifacts.find((a: any) => a.id === 'ART001');
    expect(chip.appearsInPages).toEqual([2]);
    expect(chip.states).toHaveLength(1);
    expect(chip.states[0].id).toBe('ART001.1');
    expect(chip.states[0].pages).toEqual([2]);
    expect(report.droppedStates).toEqual([{ id: 'ART001.2', parent: 'ART001' }]);
  });

  it('never touches a real landmark', () => {
    const vb = bible();
    // Crowd page 1 with artifacts so it overflows; the landmark is not counted.
    vb.artifacts.push(
      { id: 'ART010', name: 'a bucket', appearsInPages: [1], pages: [1] },
      { id: 'ART011', name: 'a broom', appearsInPages: [1], pages: [1] },
      { id: 'ART012', name: 'a ladder', appearsInPages: [1], pages: [1] },
    );
    const report = trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    const bridge = vb.locations.find((l: any) => l.id === 'LOC001');
    expect(bridge.appearsInPages).toEqual([1]);
    expect(report.stripped.some((s: any) => s.id === 'LOC001')).toBe(false);
    expect(count(vb, 1)).toBe(3); // as above — this call was given budget 3
  });

  it('counts exactly what rankPageElements counts: clothing is never trimmed', () => {
    const vb: any = bible();
    vb.clothing = [{ id: 'CLO001', name: 'a red scarf', appearsInPages: [1, 2, 3, 4] }];
    trimVbAssignments(vb, PLAN, { castNames: ['the girl'], budget: 3 });
    expect(vb.clothing[0].appearsInPages).toEqual([1, 2, 3, 4]);
  });

  it('is a no-op on an empty or missing bible and never throws', () => {
    expect(trimVbAssignments(null, PLAN, { budget: 3 })).toEqual({ pagesOverBudgetBefore: 0, pagesOverBudgetAfter: 0, stripped: [], droppedStates: [] });
    expect(trimVbAssignments({}, PLAN).stripped).toEqual([]);
    const vb = bible();
    // No plan lines at all: still enforces the budget, nothing is "named".
    const report = trimVbAssignments(vb, []);
    expect(report.pagesOverBudgetAfter).toBe(0);
    expect(report.stripped.every((s: any) => /no plan line/.test(s.reason))).toBe(true);
  });
});
