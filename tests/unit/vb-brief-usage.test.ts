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
