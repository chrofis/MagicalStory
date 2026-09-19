import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { checkScenes } = require_('../../server/lib/clothingCheck.js');
const { resolveWornItemsForPage, trackedWornGarments, missingWornRows } =
  require_('../../server/lib/wornItems.js');

/**
 * AN UNDECLARED GARMENT STATE MUST NOT RESOLVE TO WORN IN SILENCE.
 *
 * `resolveWornItemsForPage` has two sources. Source 1 enumerates the writer's
 * `wornAs` entries, so an undeclared LINKED garment comes back `missing: true`
 * and `clothingCheck` rule 3 reports it. Source 2 enumerates THE ROWS THAT
 * EXIST, so an undeclared UNLINKED garment produced no resolved item, no prompt
 * line, no log and no finding — while the outfit contract kept it and the
 * attached reference wore it. The state was WORN by silence.
 *
 * Measured on staging `job_1789759147125_p08djwhbl` (18 pages, three unlinked
 * `clothing` entries, rows on ten pages): p10 shipped v0 with no jacket and a
 * v1 repair wearing it — the same page, two states. Its p16 shape is the one
 * pinned below: an undeclared page sitting between two `off` pages, which
 * defaults the garment back on.
 *
 * Shapes are that story's, with archetypal names.
 */
const CAP = { id: 'CLO001', name: 'red wool cap', wornBy: 'Owner', description: 'A red knitted wool cap.' };
const JACKET = { id: 'CLO002', name: 'green fleece jacket', wornBy: 'Owner', description: 'A green zip-up fleece jacket.' };
const LINKED = { id: 'ART004', name: 'brown leather boots', type: 'footwear', wornAs: 'Owner.footwear', description: 'Scuffed brown leather boots.' };
// A row the Art Director wrote against something that is not clothing at all.
const TOY = { id: 'ART009', name: 'soft toy mouse', type: 'soft toy comfort mouse', wornBy: 'Owner', description: 'A grey soft toy mouse.' };

// Two bibles on purpose: a linked entry is reported on EVERY page that omits
// it (source 1's own default), so it would drown out the unlinked cases below.
const VB = { clothing: [CAP, JACKET], artifacts: [TOY], vehicles: [] };
const VB_LINKED = { clothing: [CAP, JACKET], artifacts: [LINKED, TOY], vehicles: [] };

const PROSE = 'Owner stands on the cobbles in the morning light, looking at the doorway.';

/** A page in the shape beatsPipeline passes to checkScenes. */
const page = (pageNumber: number, cast: string[], wornItems: any[]) => ({
  pageNumber, prose: PROSE, cast, perCharClothing: {}, wornItems,
});
const worn = (id: string, owner = 'Owner') => ({ id, owner, state: 'worn' });
const off = (id: string, owner = 'Owner') => ({ id, owner, state: 'off', location: 'on the cobblestones' });

const run = (pages: any[], vb: any = VB) => checkScenes(pages, {}, { visualBible: vb }).findings
  .filter((f: any) => f.type === 'removal_unstated');

describe('an undeclared state on an UNLINKED garment is detected', () => {
  it('reports the garment whose owner is in cast and which the page gives no row', () => {
    // CLO001 declared on p1, omitted on p2 — the measured "declared on ten
    // pages and skipped on one" shape.
    const f = run([page(1, ['Owner'], [worn('CLO001')]), page(2, ['Owner'], [])]);
    expect(f.map((x: any) => `p${x.pageNumber}/${x.artifactId}`)).toEqual(['p2/CLO001']);
    expect(f[0].character).toBe('Owner');
    expect(f[0].slot).toBe('headwear');
    expect(f[0].detail).toContain('has no wornItems entry for it');
    expect(f[0].detail).toContain('"id": "CLO001"');
  });

  it('catches the p16 shape — an undeclared page BETWEEN two `off` pages', () => {
    const f = run([
      page(15, ['Owner'], [off('CLO001')]),
      page(16, ['Owner'], []),
      page(18, ['Owner'], [off('CLO001')]),
    ]);
    expect(f.map((x: any) => x.pageNumber)).toEqual([16]);
  });

  it('reports every tracked garment the page leaves out, not just the first', () => {
    const f = run([page(1, ['Owner'], [worn('CLO001'), worn('CLO002')]), page(10, ['Owner'], [worn('CLO001')])]);
    expect(f.map((x: any) => `p${x.pageNumber}/${x.artifactId}`)).toEqual(['p10/CLO002']);
  });

  it('is silent when the owner is not in the page cast', () => {
    expect(run([page(1, ['Owner'], [worn('CLO001')]), page(2, ['Someone Else'], [])])).toEqual([]);
  });

  it('is silent on a garment NO page tracks — that is worn_link_missing`s business', () => {
    // No page declares a row at all, so nothing is tracked and nothing fires.
    expect(run([page(1, ['Owner'], []), page(2, ['Owner'], [])])).toEqual([]);
  });

  it('is silent on a declared id with no outfit slot — a prop is not a garment', () => {
    // The Art Director wrote a row against a soft toy (measured: a soft toy and
    // two map props over the stored staging stories). Demanding a wardrobe row
    // for it would ask for a row the resolver then refuses to act on.
    const f = run([page(1, ['Owner'], [worn('ART009')]), page(2, ['Owner'], [])]);
    expect(f).toEqual([]);
  });
});

describe('the linked path is unchanged', () => {
  const runL = (pages: any[]) => run(pages, VB_LINKED);

  it('still reports a linked garment with no row, exactly once', () => {
    const f = runL([page(1, ['Owner'], [])]);
    expect(f.map((x: any) => x.artifactId)).toEqual(['ART004']);
    expect(f[0].slot).toBe('footwear');
  });

  it('does not double-report a linked garment that is also tracked by a row', () => {
    const f = runL([page(1, ['Owner'], [worn('ART004')]), page(2, ['Owner'], [])]);
    expect(f.filter((x: any) => x.pageNumber === 2 && x.artifactId === 'ART004')).toHaveLength(1);
  });

  it('still reports an `off` with no place', () => {
    const f = runL([page(1, ['Owner'], [{ id: 'ART004', owner: 'Owner', state: 'off' }])]);
    expect(f.map((x: any) => x.artifactId)).toEqual(['ART004']);
    expect(f[0].detail).toContain('names no place for it');
  });

  it('a page with a proper row for every tracked garment reports nothing', () => {
    expect(runL([
      page(1, ['Owner'], [worn('CLO001'), worn('CLO002'), worn('ART004')]),
      page(2, ['Owner'], [off('CLO001'), worn('CLO002'), worn('ART004')]),
    ])).toEqual([]);
  });
});

describe('detection only — nothing is resolved, rendered or defaulted', () => {
  it('leaves resolveWornItemsForPage`s output for the undeclared page untouched', () => {
    // The gap is REPORTED, never filled: inventing a `worn` row here would be
    // the silent default this change exists to expose, and an `off` one would
    // delete a garment nobody took off.
    const meta = { pageNumber: 2, characters: ['Owner'], wornItems: [] };
    const resolved = resolveWornItemsForPage(VB_LINKED, ['Owner'], meta, { pageNumber: 2 });
    expect(resolved.map((r: any) => r.id)).toEqual(['ART004']);   // source 1 only
  });

  it('tracks a garment from the brief set and finds the page that omits it', () => {
    const tracked = trackedWornGarments(VB, [[worn('CLO002')], []]);
    expect([...tracked.keys()]).toEqual(['CLO002']);
    expect(tracked.get('CLO002').slot).toBe('outer layer');
    expect(missingWornRows(tracked, ['Owner'], { wornItems: [] }).map((t: any) => t.id)).toEqual(['CLO002']);
    expect(missingWornRows(tracked, ['Owner'], { wornItems: [worn('CLO002')] })).toEqual([]);
  });
});
