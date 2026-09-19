import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * An iterate round must not undress a page.
 *
 * Measured on staging job_1789506283204_3kxqshifx p16: `sceneMetadata.wornItems`
 * was `[]` while every neighbouring page from p8 on carried the owner's cap as
 * `state: "off"`, with a location inside the fountain wall. scene-iteration.txt
 * and scene-iteration-free.txt do not emit `wornItems`, and the metadata parser
 * turns an absent field into `[]` — so the rewrite silently erased the OFF row.
 * resolveWornItemsForPage then defaults an undeclared `wornAs` item to `worn`,
 * and buildWornStateLines emitted the affirmative "IS wearing this … Draw it on
 * <owner> even if the attached reference shows <owner> without it". The item was
 * in a wall at that point in the plot.
 *
 * Pinned here: the CARRY-FORWARD behaviour, plus the resolver consequence that
 * makes it matter. Not the wording of any prompt line.
 */
const { carryForwardWornItems, resolveWornItemsForPage, buildWornStateLines } =
  require('../../server/lib/wornItems');

const ROW = { id: 'ART004', owner: 'Mira', state: 'off', wearer: null, location: 'inside the wall' };

describe('a brief rewrite carries the page’s declared worn states forward', () => {
  it('a saved row survives an emission that declares none', () => {
    expect(carryForwardWornItems({ wornItems: [] }, { wornItems: [ROW] })).toEqual([ROW]);
  });

  it('an absent field on the rewrite is the same as an empty one', () => {
    expect(carryForwardWornItems({}, { wornItems: [ROW] })).toEqual([ROW]);
  });

  it('the saved rows may live under fullData', () => {
    expect(carryForwardWornItems({ wornItems: [] }, { fullData: { wornItems: [ROW] } })).toEqual([ROW]);
  });

  it('a non-empty emission is NOT clobbered by the saved rows', () => {
    const emitted = [{ ...ROW, state: 'worn', location: null }];
    expect(carryForwardWornItems({ wornItems: emitted }, { wornItems: [ROW] })).toEqual(emitted);
  });

  it('nothing anywhere resolves to an empty list, never undefined', () => {
    expect(carryForwardWornItems({}, {})).toEqual([]);
    expect(carryForwardWornItems(null, null)).toEqual([]);
  });
});

describe('why the carry-forward matters: an undeclared item is drawn worn', () => {
  const vb = { artifacts: [{ id: 'ART004', name: 'red cap', wornAs: 'Mira.headwear', description: 'a red cap' }] };

  it('no row → the prompt orders the item ON the owner', () => {
    const lines = buildWornStateLines(resolveWornItemsForPage(vb, ['Mira'], { wornItems: [] }, { pageNumber: 16 }));
    expect(lines.join('\n')).toMatch(/Mira IS wearing this/);
  });

  it('the carried row → the prompt keeps the item OFF the owner', () => {
    const carried = carryForwardWornItems({ wornItems: [] }, { wornItems: [ROW] });
    const lines = buildWornStateLines(resolveWornItemsForPage(vb, ['Mira'], { wornItems: carried }, { pageNumber: 16 }));
    expect(lines.join('\n')).toMatch(/Mira is NOT wearing this/);
    expect(lines.join('\n')).toMatch(/inside the wall/);
  });
});

describe('the iterate call site uses the one carry-forward rule', () => {
  const IMG = fs.readFileSync(path.join(process.cwd(), 'server/lib/images.js'), 'utf8');
  it('iteratePageCore builds wornItems through the helper', () => {
    expect(IMG).toMatch(/wornItems: require\('\.\/wornItems'\)\.carryForwardWornItems\(newSceneMetadata, savedMeta\)/);
  });
});
