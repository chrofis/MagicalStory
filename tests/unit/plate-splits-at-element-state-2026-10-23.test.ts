/**
 * A plate is split where an element it draws changes state, and a trial page
 * keeps the cell of an element its plate did not carry (owner, 2026-10-23;
 * docs/decisions.md; bug trial-plated-vehicle-gets-no-reference).
 *
 * Evidence: prod trial job_1792772600127_tv32st82h. The handcart VEH001 is
 * intact on p1, broken on p2-p3, repaired on p4-p6; pages 2-5 shared ONE plate
 * and no page got the cart's cell.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const referenceSheets = require_('../../server/lib/referenceSheets.js');
referenceSheets.buildVisualBibleGrid = async (els: any[]) => ({ rawElements: els });
const { groupTrialPlatePagesByVantage, groupPagesByVantage } = require_('../../server/lib/sceneMetadata.js');
const { getEmptySceneElementReferences, partitionPagesByPlateState } = require_('../../server/lib/visualBible.js');
const { buildPlateStructuresText } = require_('../../server/services/prompts.js');
const pageRender = require_('../../server/lib/pageRenderCall.js');

const cart = (stateOverride?: any[]) => ({
  id: 'VEH001', name: 'wooden handcart', description: 'a two-wheeled wooden handcart', scaleClass: 'twice-adult-height',
  appearsInPages: [1, 2, 3, 4, 5, 6], referenceImageUrl: 'https://r2/veh001.png',
  states: stateOverride || [
    { id: 'VEH001.1', name: 'intact', delta: 'the drawbar is whole', pages: [1], referenceImageUrl: 'https://r2/veh001_1.png' },
    { id: 'VEH001.2', name: 'broken', delta: 'the drawbar is now snapped in two', pages: [2, 3], referenceImageUrl: 'https://r2/veh001_2.png' },
    { id: 'VEH001.3', name: 'repaired', delta: 'the drawbar is now a lashed-on branch', pages: [4, 5, 6], referenceImageUrl: 'https://r2/veh001_3.png' },
  ],
});
const vbWith = (veh: any, extra: any = {}) => ({
  mainCharacters: [], secondaryCharacters: [], animals: [], artifacts: [], clothing: [],
  locations: [{ id: 'LOC001', name: 'Lane', appearsInPages: [1, 2, 3, 4, 5, 6], pages: [1, 2, 3, 4, 5, 6] }],
  backgrounds: [{ description: 'a village lane', pages: [2, 3, 4, 5] }],
  vehicles: [veh], ...extra,
});

describe('trial plate grouping splits at a state change', () => {
  it('pages 2-5 with states broken,broken,repaired,repaired become two plates', () => {
    const groups = groupTrialPlatePagesByVantage(vbWith(cart()));
    expect(groups.map((g: any) => g.pages)).toEqual([[2, 3], [4, 5]]);
    expect(groups.map((g: any) => g.vantageId)).toEqual(['LOC001.1', 'LOC001.2']);
    expect(groups.every((g: any) => g.description === 'a village lane')).toBe(true);
  });
  it('one state throughout keeps one plate', () => {
    const one = cart([{ id: 'VEH001.1', name: 'intact', delta: 'whole', pages: [1, 2, 3, 4, 5, 6], referenceImageUrl: 'x' }]);
    expect(groupTrialPlatePagesByVantage(vbWith(one)).map((g: any) => g.pages)).toEqual([[2, 3, 4, 5]]);
  });
  it('an element with no states, or one the plate does not draw on those pages, never splits', () => {
    const plain = { ...cart(), states: undefined };
    expect(groupTrialPlatePagesByVantage(vbWith(plain)).map((g: any) => g.pages)).toEqual([[2, 3, 4, 5]]);
    const elsewhere = { ...cart(), appearsInPages: [6] };
    expect(groupTrialPlatePagesByVantage(vbWith(elsewhere)).map((g: any) => g.pages)).toEqual([[2, 3, 4, 5]]);
  });
});

describe('full-path grouping splits at a state change', () => {
  const vb: any = {
    ...vbWith(cart()),
    locations: [{
      id: 'LOC001', name: 'Lane', pages: [1, 2, 3, 4, 5, 6],
      vantages: [{ id: 'LOC001.1', name: 'lane', pages: [1, 2, 3, 4, 5, 6] }],
    }],
  };
  const named = [{ id: 'VEH001' }];
  const pages = [1, 2, 3, 4, 5, 6].map(pn => ({
    pageNumber: pn, sceneMetadata: { objects: [{ id: 'LOC001.1' }, ...named] }, emptyScenePrompt: '',
  }));
  it('keeps the vantage key for the first state and suffixes the others; one vantage object throughout', () => {
    const groups = groupPagesByVantage(pages, vb);
    const real = [...groups.entries()].filter(([k]: any) => k !== '__unassigned__');
    expect(real.length).toBeGreaterThan(0);
    expect(real.map(([, g]: any) => g.pageNumbers)).toEqual([[1], [2, 3], [4, 5, 6]]);
    expect(real[1][0]).toBe(`${real[0][0]}~2`);
    expect(new Set(real.map(([, g]: any) => g.vantage.vantageId)).size).toBe(1);
  });
  const part = (nums: number[], objectsOf: (pn: number) => any[] | null, aboardId: string | null = null) =>
    partitionPagesByPlateState(vb, nums.map(pageNumber => ({ pageNumber, aboardId, sceneObjects: objectsOf(pageNumber) })));
  it('a page whose objects[] does not name the vehicle has no say about its state: it joins the first plate it does not contradict', () => {
    // p2 (broken) and p4 (repaired) draw the cart; p3 and p5 do not name it.
    const objs = (pn: number) => ([2, 4].includes(pn) ? named : []);
    expect(part([2, 3, 4, 5], objs)).toEqual([[2, 3, 5], [4]]);
    // nobody names it: nothing to contradict, one plate
    expect(part([2, 3, 4, 5], () => [])).toEqual([[2, 3, 4, 5]]);
  });
  it('the aboard vehicle never splits a plate (the plate only names it)', () => {
    expect(part([2, 4], () => named, 'VEH001')).toEqual([[2, 4]]);
  });
});

describe('the plate tells the state of the pages it serves', () => {
  it('the STRUCTURES line carries the page state delta', () => {
    const vb = vbWith(cart());
    const broken = buildPlateStructuresText({ visualBible: vb, pageNumber: 2 });
    const repaired = buildPlateStructuresText({ visualBible: vb, pageNumber: 4 });
    expect(broken).toContain('the drawbar is now snapped in two');
    expect(broken).not.toContain('lashed-on branch');
    expect(repaired).toContain('lashed-on branch');
    expect(repaired).not.toContain('snapped in two');
  });
  it('the full plate grid cell is the page state cell', () => {
    const vb = vbWith(cart());
    const at = (pn: number) => getEmptySceneElementReferences(vb, pn).map((r: any) => r.referenceImageUrl);
    expect(at(2)).toEqual(['https://r2/veh001_2.png']);
    expect(at(4)).toEqual(['https://r2/veh001_3.png']);
    expect(at(1)).toEqual(['https://r2/veh001_1.png']);
  });
});

describe('a trial page keeps the cell its plate did not carry (bug trial-plated-vehicle-gets-no-reference)', () => {
  const vb = vbWith(cart());
  const sceneMetadata = { objects: [{ id: 'VEH001', name: 'wooden handcart' }], fullData: { objects: [{ id: 'VEH001' }] } };
  it('plate sent but carrying no element image: the vehicle cell stays, in the page state', async () => {
    const { kept } = await pageRender.buildPageVbGrid({ visualBible: vb, pageNumber: 4, sceneMetadata, hasPlate: true, plateCarriesElements: false });
    expect(kept.map((e: any) => e.id)).toEqual(['VEH001']);
    expect(kept[0].referenceImageUrl).toBe('https://r2/veh001_3.png');
  });
  it('plate sent that carried the grid (story run default): the vehicle is the plate cell', async () => {
    const { kept } = await pageRender.buildPageVbGrid({ visualBible: vb, pageNumber: 4, sceneMetadata, hasPlate: true });
    expect(kept).toEqual([]);
  });
});
