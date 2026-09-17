/**
 * VB USAGE FROM THE BRIEFS — `appearsInPages` rebuilt from what the FINAL scene
 * briefs cite, replacing the bible-time guess.
 *
 * Bug (staging job_1789147573901_m3uam0nxi, 2026-09-11): the bible is written
 * before the briefs, and the plan-line assignment trim decided page ownership
 * from prose that never cites ids. It stripped 19 (element, page) claims and
 * left six entries at `appearsInPages: []` — the story's central prop and the
 * signpost carrying its plot-critical text among them — so
 * `getElementsNeedingReferenceImages` rendered no cell for any of them, while
 * the final briefs asked for exactly those ids (p10 objects: ["LOC004",
 * "ART006"]).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { applyBriefUsage } = require_('../../server/lib/vbElementBudget');
const { normaliseObjectStates, getElementsNeedingReferenceImages } = require_('../../server/lib/visualBible');

function bible(): any {
  return {
    secondaryCharacters: [
      { id: 'CHR001', name: 'the ferryman', appearsInPages: [3, 4], pages: [3, 4] },
      { id: 'CHR002', name: 'the gatekeeper', appearsInPages: [2], pages: [2] },
    ],
    animals: [
      { id: 'ANI001', name: 'Pip', appearsInPages: [1], pages: [1] },
    ],
    artifacts: [
      // The dead entry: the bible guessed no page for it, a brief asks for it.
      { id: 'ART001', name: 'the lettered signpost', appearsInPages: [], pages: [] },
      // Two states; the briefs cite the dotted handles.
      { id: 'ART002', name: 'the folded chart', appearsInPages: [5], pages: [5],
        states: normaliseObjectStates([
          { name: 'turned away', delta: 'back of the sheet toward us', pages: [5] },
          { name: 'face to camera', delta: 'printed face toward us', pages: [] },
        ], 'ART002') },
      // Cited by no brief at all.
      { id: 'ART003', name: 'the spare wheel', appearsInPages: [2, 3], pages: [2, 3] },
    ],
    vehicles: [],
    locations: [
      { id: 'LOC001', name: 'the market square', appearsInPages: [9], pages: [9],
        vantages: [
          { id: 'LOC001.1', name: 'wide over the stalls', pages: [9] },
          { id: 'LOC001.2', name: 'close on the fountain', pages: [] },
        ] },
    ],
    clothing: [
      { id: 'CLO001', name: 'the red coat', appearsInPages: [1, 2, 3], pages: [1, 2, 3] },
    ],
  };
}

const BRIEFS = [
  { pageNumber: 1, metadata: { objects: ['ART001'], characters: [{ name: 'the ferryman' }] } },
  { pageNumber: 2, metadata: { objects: ['ART002.2'] } },
  { pageNumber: 3, metadata: { objects: ['LOC001.2', 'ART002'] } },
];

const byId = (vb: any, id: string) =>
  [...vb.secondaryCharacters, ...vb.animals, ...vb.artifacts, ...vb.locations].find((e: any) => e.id === id);

describe('applyBriefUsage', () => {
  it('credits a bare id to the entry the brief names', () => {
    const vb = bible();
    const report = applyBriefUsage(vb, BRIEFS);
    expect(report.applied).toBe(true);
    expect(byId(vb, 'ART001').appearsInPages).toEqual([1]);
    expect(report.revived).toContain('ART001');
  });

  it('renders a cell for an entry the bible had emptied but a brief asks for', () => {
    const vb = bible();
    const before = getElementsNeedingReferenceImages(vb, 2, 1, 1).map((e: any) => e.id);
    expect(before).not.toContain('ART001');
    applyBriefUsage(vb, BRIEFS);
    expect(getElementsNeedingReferenceImages(vb, 2, 1, 1).map((e: any) => e.id)).toContain('ART001');
  });

  it('credits a dotted state ref to both the parent and the matching state', () => {
    const vb = bible();
    applyBriefUsage(vb, BRIEFS);
    const art2 = byId(vb, 'ART002');
    expect(art2.appearsInPages).toEqual([2, 3]);
    // p2 cited ART002.2, p3 cited the bare parent → the default (first) state.
    expect(art2.states.find((s: any) => s.id === 'ART002.2').pages).toEqual([2]);
    expect(art2.states.find((s: any) => s.id === 'ART002.1').pages).toEqual([3]);
  });

  it('credits a location vantage ref to the vantage and the location', () => {
    const vb = bible();
    applyBriefUsage(vb, BRIEFS);
    const loc = byId(vb, 'LOC001');
    expect(loc.appearsInPages).toEqual([3]);
    expect(loc.vantages.find((v: any) => v.id === 'LOC001.2').pages).toEqual([3]);
    expect(loc.vantages.find((v: any) => v.id === 'LOC001.1').pages).toEqual([]);
  });

  it('credits a secondary character a page names without an id, and empties what no brief cites', () => {
    const vb = bible();
    const report = applyBriefUsage(vb, BRIEFS);
    expect(byId(vb, 'CHR001').appearsInPages).toEqual([1]);
    expect(byId(vb, 'ART003').appearsInPages).toEqual([]);
    expect(byId(vb, 'CHR002').appearsInPages).toEqual([]);
    expect(report.emptied).toEqual(expect.arrayContaining(['ART003', 'CHR002', 'ANI001']));
  });

  it('never touches clothing — no brief cites a CLO id', () => {
    const vb = bible();
    applyBriefUsage(vb, BRIEFS);
    expect(vb.clothing[0].appearsInPages).toEqual([1, 2, 3]);
  });

  it('is idempotent', () => {
    const vb = bible();
    applyBriefUsage(vb, BRIEFS);
    const snapshot = JSON.stringify(vb);
    const second = applyBriefUsage(vb, BRIEFS);
    expect(second.changed).toBe(0);
    expect(JSON.stringify(vb)).toBe(snapshot);
  });

  it('is a no-op with no briefs, and never throws on junk', () => {
    const vb = bible();
    const snapshot = JSON.stringify(vb);
    expect(applyBriefUsage(vb, []).applied).toBe(false);
    expect(applyBriefUsage(vb, [{ pageNumber: 1 } as any]).applied).toBe(false);
    expect(JSON.stringify(vb)).toBe(snapshot);
    expect(applyBriefUsage(null, BRIEFS).applied).toBe(false);
    expect(applyBriefUsage({}, BRIEFS).entries).toEqual([]);
  });

  it('reads the METADATA block of a brief when no parsed metadata is handed in', () => {
    const vb = bible();
    const brief = `A wide shot of the square.\n\n---METADATA---\n${JSON.stringify({ objects: ['ART001'], characters: [] }, null, 2)}`;
    applyBriefUsage(vb, [{ pageNumber: 7, brief }]);
    expect(byId(vb, 'ART001').appearsInPages).toEqual([7]);
  });
});

/**
 * A BARE CITATION RESOLVES THE WAY THE PROMPT RESOLVES IT.
 *
 * Staging job_1789584708605_rts4wqupm. The Art Director authored ART001's
 * states as unaltered [3-13], cold [14,15], cracked [18] — correct against the
 * plan lines, and the scene review saw exactly that table and left it alone
 * (sceneReviewReport.bibleCorrections corrected a different entry that run).
 * Its briefs then cite the dotted handle on p3-p13 and the BARE parent from p11
 * on. The old rebuild gave every bare-cited page to states[0], which moved
 * [14,15] onto the unaltered row and emptied the other two; the page prompt and
 * the reference cell both follow the bible, so p14/p15 were built with the
 * unaltered delta and the unaltered cell on the pages whose own text has gone
 * cold. `objectStateForPage` exists so a bare citation lands on the right cell
 * — this rebuild now uses it instead of a second, disagreeing rule.
 */
describe('applyBriefUsage — bare citations and the states the book never reaches', () => {
  const eggBible = (): any => ({
    secondaryCharacters: [],
    animals: [],
    artifacts: [
      {
        id: 'ART001', name: 'smooth egg', appearsInPages: [3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 18],
        pages: [3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 18],
        states: normaliseObjectStates([
          { name: 'unaltered', delta: 'pale orange, smooth, glowing faintly from within', pages: [3, 4, 5, 6, 7, 9, 11, 12, 13] },
          { name: 'cold', delta: 'pale orange, smooth, matte and dark', pages: [14, 15] },
          { name: 'cracked', delta: 'pale orange shell broken in half, hollow empty interior', pages: [18] },
        ], 'ART001'),
      },
      // Authored on two pages; both briefs cite an id no collection carries.
      { id: 'ART003', name: 'push scooter', appearsInPages: [11, 17], pages: [11, 17] },
    ],
    vehicles: [],
    locations: [],
    clothing: [],
  });
  // What the run's briefs actually cite: dotted up to p13, bare from p11 on.
  const eggBriefs = [
    ...[3, 4, 5, 6, 7, 9].map(p => ({ pageNumber: p, metadata: { objects: ['ART001.1', 'LOC001'] } })),
    { pageNumber: 11, metadata: { objects: ['LOC002', 'ART001', 'VEH001', 'CHR001'] } },
    { pageNumber: 12, metadata: { objects: ['LOC003', 'ART001'] } },
    { pageNumber: 13, metadata: { objects: ['LOC003', 'ART001'] } },
    { pageNumber: 14, metadata: { objects: ['LOC003', 'ART001'] } },
    { pageNumber: 15, metadata: { objects: ['LOC003', 'ART001'] } },
    { pageNumber: 16, metadata: { objects: ['LOC002', 'ART001'] } },
    { pageNumber: 17, metadata: { objects: ['LOC001', 'VEH001', 'CHR001'] } },
  ];
  const st = (vb: any, id: string) => vb.artifacts[0].states.find((s: any) => s.id === id);

  it('gives a bare-cited page to the state the bible assigns it, not to states[0]', () => {
    const vb = eggBible();
    applyBriefUsage(vb, eggBriefs);
    expect(st(vb, 'ART001.2').pages).toEqual([14, 15]);
    expect(st(vb, 'ART001.1').pages).toEqual([3, 4, 5, 6, 7, 9, 11, 12, 13, 16]);
  });

  it('names a state that ended with no page, and what it used to claim', () => {
    const vb = eggBible();
    const report = applyBriefUsage(vb, eggBriefs);
    expect(st(vb, 'ART001.3').pages).toEqual([]);
    expect(report.emptiedStates).toEqual([
      { id: 'ART001.3', name: 'cracked', oldPages: [18] },
    ]);
  });

  it('still empties an entry whose only citations are an id no collection carries', () => {
    const vb = eggBible();
    const report = applyBriefUsage(vb, eggBriefs);
    expect(vb.artifacts[1].appearsInPages).toEqual([]);
    expect(report.emptied).toEqual(['ART003']);
  });

  it('is idempotent on the rebuilt table', () => {
    const vb = eggBible();
    applyBriefUsage(vb, eggBriefs);
    const snapshot = JSON.stringify(vb);
    const second = applyBriefUsage(vb, eggBriefs);
    expect(JSON.stringify(vb)).toBe(snapshot);
    expect(second.emptiedStates).toEqual([]);
  });
});
