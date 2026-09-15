/**
 * GAP 1 + GAP 2 of the removable-worn-item design, measured on staging
 * job_1789420511893_zly5rcdej ("navy-blue captain's cap", ART002, `type:
 * "headwear"`, owned by Sarah, worn by Emma for most of the book, returned at
 * the end):
 *
 *   GAP 1 — the Art Director wrote no `wornAs` on either hat, so the whole
 *           per-page worn path was inert. `worn_link_missing` now reports it.
 *   GAP 2 — `wornAs` names ONE owner, so the second wearer had no worn state
 *           at all. A `wornItems` row now names the page's `wearer`.
 *
 * The Visual Bible values below are the story's real ones (read-only DB pull).
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore - CommonJS module
const { checkPage } = require('../../server/lib/clothingCheck');
// @ts-ignore
const {
  resolveWornItemsForPage, unlinkedWornCandidates, buildWornStateLines,
  stripOffItemsFromOutfit, isOffForCharacter,
} = require('../../server/lib/wornItems');

const CAP_UNLINKED = {
  id: 'ART002', name: "navy-blue captain's cap", type: 'headwear',
  appearsInPages: [5, 6, 7, 9, 10, 11, 13, 14, 15],
  description: "a navy-blue wool captain's cap with a stiff black visor and a gold anchor emblem.",
};
const CAP = { ...CAP_UNLINKED, wornAs: 'Sarah.headwear' };
const TRICORN = { id: 'ART001', name: 'black tricorn hat', type: 'headwear', appearsInPages: [1, 2, 3, 6] };
const ROPE = { id: 'ART003', name: 'heavy mooring rope', type: 'nautical rope', appearsInPages: [12, 13, 14] };

const SARAH_OUTFIT = "A long navy-blue wool captain's coat, black trousers, black leather boots, a navy-blue wool captain's cap with a gold anchor emblem";
const reqs = {
  Sarah: { costumed: { used: true, costume: 'pirate', description: SARAH_OUTFIT } },
  Emma: { costumed: { used: true, costume: 'pirate', description: 'A red cotton pirate shirt, black cotton breeches, black buckle shoes' } },
};
const page = (extra: any = {}) => ({
  pageNumber: 14,
  prose: "Sarah leans over the railing in her long navy-blue wool captain's coat and black leather boots. Emma stands proudly beside the bollard, wearing the navy-blue wool captain's cap with the gold anchor on her head, in her red cotton pirate shirt and black cotton breeches.",
  cast: [{ name: 'Sarah' }, { name: 'Emma' }],
  perCharClothing: { Sarah: 'costumed', Emma: 'costumed' },
  ...extra,
});
const handover = [{ id: 'ART002', owner: 'Sarah', state: 'worn', wearer: 'Emma' }];

describe('GAP 1 — a worn element with no wornAs link is reported', () => {
  it('reports an element whose type is an outfit slot', () => {
    const f = checkPage(page(), reqs, { visualBible: { artifacts: [CAP_UNLINKED] } });
    const miss = f.filter((x: any) => x.type === 'worn_link_missing');
    expect(miss).toHaveLength(1);
    expect(miss[0].artifactId).toBe('ART002');
    expect(miss[0].slot).toBe('headwear');
    // Sarah's outfit names the same cap, so the fault can name the owner.
    expect(miss[0].character).toBe('Sarah');
    expect(miss[0].detail).toContain('"wornAs": "Sarah.headwear"');
  });

  it('is silent once the link exists', () => {
    const f = checkPage(page({ wornItems: handover }), reqs, { visualBible: { artifacts: [CAP] } });
    expect(f.filter((x: any) => x.type === 'worn_link_missing')).toHaveLength(0);
  });

  it('never fires on an element that is not a garment', () => {
    expect(unlinkedWornCandidates({ artifacts: [ROPE] }, new Map())).toHaveLength(0);
  });

  it('reports a slot-typed element whose owner no outfit names', () => {
    const c = unlinkedWornCandidates({ artifacts: [TRICORN] }, new Map(Object.entries({ Sarah: SARAH_OUTFIT })));
    expect(c).toHaveLength(1);
    expect(c[0].owner).toBeNull();
    expect(c[0].reason).toBe('type');
  });
});

describe('GAP 2 — the item changes hands', () => {
  it('resolves the declared wearer, keeping the owner as its home', () => {
    const [r] = resolveWornItemsForPage({ artifacts: [CAP] }, [{ name: 'Sarah' }, { name: 'Emma' }],
      { wornItems: handover }, { pageNumber: 14 });
    expect(r.owner).toBe('Sarah');
    expect(r.wearer).toBe('Emma');
    expect(r.handedOver).toBe(true);
    expect(r.state).toBe('worn');
    expect(r.missing).toBe(false);
  });

  it('takes the item off the owner and puts it on the wearer', () => {
    const [r] = resolveWornItemsForPage({ artifacts: [CAP] }, [{ name: 'Sarah' }, { name: 'Emma' }],
      { wornItems: handover }, { pageNumber: 14 });
    expect(isOffForCharacter(r, 'Sarah')).toBe(true);
    expect(isOffForCharacter(r, 'Emma')).toBe(false);
    const lines = buildWornStateLines([r]).join('\n');
    expect(lines).toContain('Emma IS wearing this on this page, and Sarah is NOT');
    expect(lines).toContain('Draw it on Emma only');
    const { text } = stripOffItemsFromOutfit(SARAH_OUTFIT, [r], 'Sarah');
    expect(text).not.toMatch(/cap/i);
    expect(text).toMatch(/coat/i);
  });

  it('does not flag the true wearer as outfit_misattributed', () => {
    const f = checkPage(page({ wornItems: handover }), reqs, { visualBible: { artifacts: [CAP] } });
    expect(f.filter((x: any) => x.type === 'outfit_misattributed')).toHaveLength(0);
  });

  // MEASURED, not assumed. With this story's own words the misattribution rule
  // is silent either way: its evidence tokens are ≥4 characters, and the
  // garment noun here is "cap". Pinned so a future widening of that vocabulary
  // cannot start faulting the correct render unnoticed.
  it('is silent on this story either way — the garment noun is too short to be evidence', () => {
    expect(checkPage(page(), reqs, { visualBible: { artifacts: [CAP] } })
      .filter((x: any) => x.type === 'outfit_misattributed')).toHaveLength(0);
  });

  // The same handover with a garment noun the rule CAN see: without the row it
  // reads as Sarah's jacket on Emma; with the row it is the correct render.
  const JACKET = { id: 'ART005', name: "navy-blue wool captain's jacket", type: 'outerwear', wornAs: 'Sarah.outer layer', appearsInPages: [14] };
  const jacketPage = (extra: any = {}) => page({
    prose: "Sarah leans over the railing in her black leather boots. Emma stands beside the bollard, wearing the long navy-blue wool captain's jacket with its gold anchor buttons.",
    ...extra,
  });
  const jacketReqs = {
    ...reqs,
    Sarah: { costumed: { used: true, costume: 'pirate', description: "A long navy-blue wool captain's jacket with gold anchor buttons, black trousers, black leather boots" } },
  };

  it('WOULD flag the true wearer without a handover row', () => {
    const mis = checkPage(jacketPage(), jacketReqs, { visualBible: { artifacts: [JACKET] } })
      .filter((x: any) => x.type === 'outfit_misattributed');
    expect(mis.length).toBeGreaterThan(0);
    expect(mis[0].character).toBe('Emma');
  });

  it('does NOT flag the true wearer once the row names her', () => {
    const mis = checkPage(
      jacketPage({ wornItems: [{ id: 'ART005', owner: 'Sarah', state: 'worn', wearer: 'Emma' }] }),
      jacketReqs, { visualBible: { artifacts: [JACKET] } },
    ).filter((x: any) => x.type === 'outfit_misattributed');
    expect(mis).toHaveLength(0);
  });

  it('still faults the owner with no state at all', () => {
    const f = checkPage(page(), reqs, { visualBible: { artifacts: [CAP] } });
    const rm = f.filter((x: any) => x.type === 'removal_unstated');
    expect(rm).toHaveLength(1);
    expect(rm[0].character).toBe('Sarah');
    expect(rm[0].detail).toContain('"wearer"');
  });

  it('ignores a wearer who is not on the page', () => {
    const [r] = resolveWornItemsForPage({ artifacts: [CAP] }, [{ name: 'Sarah' }],
      { wornItems: [{ id: 'ART002', owner: 'Sarah', state: 'worn', wearer: 'Emma' }] }, { pageNumber: 9 });
    expect(r.wearer).toBe('Sarah');
    expect(r.handedOver).toBe(false);
  });

  it('BACKWARD COMPATIBLE: a row with no wearer resolves exactly as before', () => {
    const rows = resolveWornItemsForPage({ artifacts: [CAP] }, [{ name: 'Sarah' }],
      { wornItems: [{ id: 'ART002', owner: 'Sarah', state: 'off', location: 'on the cobbles' }] }, { pageNumber: 4 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner: 'Sarah', wearer: 'Sarah', handedOver: false, state: 'off', location: 'on the cobbles', missing: false });
    expect(isOffForCharacter(rows[0], 'Sarah')).toBe(true);
  });
});

describe('the worked case — ART002 across the book', () => {
  // Owner Sarah; Emma wears it from the square to the quay; returned at the end.
  const pages = [
    { n: 5, cast: ['Emma'], worn: [] as any[] },
    { n: 9, cast: ['Sarah', 'Emma'], worn: handover },
    { n: 14, cast: ['Sarah', 'Emma'], worn: handover },
    { n: 15, cast: ['Sarah', 'Emma'], worn: [{ id: 'ART002', owner: 'Sarah', state: 'worn' }] },
  ];
  it('resolves the right wearer on every page', () => {
    const got = pages.map((p) => {
      const rows = resolveWornItemsForPage({ artifacts: [CAP] }, p.cast.map(name => ({ name })),
        { wornItems: p.worn }, { pageNumber: p.n });
      return rows.map((r: any) => `${p.n}:${r.wearer}`).join(',');
    });
    // p5 has no Sarah, so no row is enumerated at all (the owner is not in cast).
    expect(got).toEqual(['', '9:Emma', '14:Emma', '15:Sarah']);
  });
});
