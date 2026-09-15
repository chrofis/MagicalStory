/**
 * The load-bearing assumption of the "describe the plot object in the outfit"
 * design: when a page takes a normally-worn item off its owner, the mechanical
 * check must SAY SO, or the avatar keeps wearing it and nobody notices.
 *
 * These pin what the path does AND where it stops — see the last two cases.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore - CommonJS module
const { checkPage } = require('../../server/lib/clothingCheck');
// @ts-ignore
const { resolveWornItemsForPage } = require('../../server/lib/wornItems');

const CAP = {
  id: 'ART002', name: "navy-blue captain's cap", label: "captain's cap", type: 'headwear',
  wornAs: 'Sarah.headwear', pages: [1, 5, 9],
  description: "a navy-blue wool captain's cap with a stiff black visor and a gold anchor emblem.",
};
const reqs = {
  Sarah: { costumed: { used: true, costume: 'pirate', description: "A long navy-blue wool captain’s coat; black leather boots; a navy-blue wool captain's cap with a stiff black visor and a gold anchor emblem" } },
  Emma: { costumed: { used: true, costume: 'pirate', description: 'A red cotton pirate shirt; black cotton breeches; black buckle shoes' } },
};
const page = (extra: any = {}) => ({
  pageNumber: 5,
  prose: 'Sarah stands at the rail in her long navy-blue wool captain’s coat and black leather boots while Emma looks out over the water in her red cotton pirate shirt and black cotton breeches.',
  cast: [{ name: 'Sarah' }, { name: 'Emma' }],
  perCharClothing: { Sarah: 'costumed', Emma: 'costumed' },
  ...extra,
});

describe('a worn plot object that changes hands', () => {
  it('faults the page when the owner appears and no wornItems state is declared', () => {
    const f = checkPage(page(), reqs, { visualBible: { artifacts: [CAP] } });
    const removal = f.filter((x: any) => x.type === 'removal_unstated');
    expect(removal).toHaveLength(1);
    expect(removal[0].character).toBe('Sarah');
    expect(removal[0].slot).toBe('headwear');
  });

  it('faults an "off" state that names no place for it', () => {
    const f = checkPage(page({ wornItems: [{ id: 'ART002', owner: 'Sarah', state: 'off' }] }), reqs, { visualBible: { artifacts: [CAP] } });
    expect(f.filter((x: any) => x.type === 'removal_unstated')).toHaveLength(1);
  });

  it('is satisfied by an "off" state with a place', () => {
    const f = checkPage(
      page({ wornItems: [{ id: 'ART002', owner: 'Sarah', state: 'off', location: "in Emma's hands" }] }),
      reqs, { visualBible: { artifacts: [CAP] } });
    expect(f.filter((x: any) => x.type === 'removal_unstated')).toHaveLength(0);
  });

  it('the off-state guard still needs a wornAs link — the unlinked item is reported instead', () => {
    // Measured on staging job_1789420511893_zly5rcdej: the Art Director wrote
    // neither hat's `wornAs`, so nothing guarded the cap on any page. The
    // removal check's scope is unchanged (it governs linked items only); the
    // missing link itself is now its own finding — worn-item-handover.test.ts.
    const unlinked = { ...CAP, wornAs: undefined };
    const f = checkPage(page(), reqs, { visualBible: { artifacts: [unlinked] } });
    expect(f.filter((x: any) => x.type === 'removal_unstated')).toHaveLength(0);
    expect(f.filter((x: any) => x.type === 'worn_link_missing')).toHaveLength(1);
  });

  it("`wornAs` stays the item's home — the page row names who wears it", () => {
    const rows = resolveWornItemsForPage(
      { artifacts: [CAP] }, [{ name: 'Sarah' }, { name: 'Emma' }],
      { wornItems: [{ id: 'ART002', owner: 'Sarah', state: 'worn', wearer: 'Emma' }] }, { pageNumber: 5 });
    expect(rows.map((r: any) => r.owner)).toEqual(['Sarah']);
    expect(rows.map((r: any) => r.wearer)).toEqual(['Emma']);
  });
});
