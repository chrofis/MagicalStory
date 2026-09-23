import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const { collectEntityAppearances, groupAppearancesByClothing } = require_('../../server/lib/entityConsistency.js');
const { wornItemsBibleOf } = require_('../../server/lib/wornItems.js');

/**
 * A GARMENT OFF BY DESIGN IS NEVER JUDGED AGAINST THE SHEET THAT WEARS IT.
 *
 * Measured fault (staging job_1790100385959_1nitlympp, p11/p12): the brief
 * declared `{id: ART004, owner: Kiaan, state: "off"}` and the entity grid still
 * charged "Kiaan is missing the gilet" (MAJOR) on both pages. The pipeline's
 * entity-check input carries the Visual Bible as `wornItemsVisualBible`; the
 * collection-time worn resolution read `visualBible` alone, so no page's off
 * rows resolved, every off page landed in the plain `standard` grid, and the
 * judge compared it to the reference that wears the garment.
 *
 * These pin the BEHAVIOUR (which grid an off page lands in), never wording.
 */

const visualBible = {
  artifacts: [
    { id: 'ART004', name: 'rust-brown quilted gilet', type: 'outerwear', wornAs: 'Kiaan.outer layer', wornBy: 'Kiaan' },
  ],
};

const brief = (pageNumber: number, state: 'worn' | 'off') => ({
  pageNumber,
  description: 'A scene.\n\n---METADATA---\n' + JSON.stringify({
    characters: [{ name: 'Kiaan', clothing: 'standard', position: 'center', depth: 'foreground' }],
    wornItems: [{ id: 'ART004', owner: 'Kiaan', state, ...(state === 'off' ? { location: 'lies beside the wall' } : {}) }],
  }),
});

const image = (pageNumber: number) => ({
  pageNumber,
  imageData: `data:image/png;base64,page${pageNumber}`,
  bboxDetection: { figures: [{ name: 'Kiaan', confidence: 'high', faceBox: [0.1, 0.1, 0.3, 0.3], bodyBox: [0.1, 0.1, 0.9, 0.5] }] },
});

const sceneImages = [image(4), image(5), image(11), image(12)];
const sceneDescriptions = [brief(4, 'worn'), brief(5, 'worn'), brief(11, 'off'), brief(12, 'off')];

async function kiaanGroups(options: any) {
  const apps = await collectEntityAppearances(sceneImages, [{ name: 'Kiaan' }], sceneDescriptions, {
    skipMinAppearancesFilter: true, ...options,
  });
  const byKey = groupAppearancesByClothing(apps.get('Kiaan'));
  return Object.fromEntries([...byKey].map(([k, v]: any) => [k, v.map((a: any) => a.pageNumber)]));
}

describe('the worn-state bible is read under either key', () => {
  it('a stored story carries it as visualBible, the pipeline entity input as wornItemsVisualBible', () => {
    expect(wornItemsBibleOf({ visualBible })).toBe(visualBible);
    expect(wornItemsBibleOf({ wornItemsVisualBible: visualBible })).toBe(visualBible);
    expect(wornItemsBibleOf({})).toBeNull();
    expect(wornItemsBibleOf(null)).toBeNull();
  });
});

describe('an off page lands in its own wardrobe-state grid', () => {
  it('pages that take the garment off leave the grid judged against the wearing sheet', async () => {
    expect(await kiaanGroups({ wornItemsVisualBible: visualBible })).toEqual({
      standard: [4, 5],
      'standard--off:ART004': [11, 12],
    });
  });

  it('a page that WEARS the garment stays in the wearing grid, so a missing garment there is still judged', async () => {
    const groups = await kiaanGroups({ wornItemsVisualBible: visualBible });
    expect(groups.standard).toEqual([4, 5]);
  });

  it('the off page names the removed garment for the judge', async () => {
    const apps = await collectEntityAppearances(sceneImages, [{ name: 'Kiaan' }], sceneDescriptions, {
      skipMinAppearancesFilter: true, wornItemsVisualBible: visualBible,
    });
    const p11 = apps.get('Kiaan').find((a: any) => a.pageNumber === 11);
    expect(p11.offIds).toEqual(['ART004']);
    expect(p11.offItemNames).toEqual(['rust-brown quilted gilet']);
  });
});

describe('the entity check hands collection the pipeline key', () => {
  // runEntityConsistencyChecks makes paid grid calls, so the wire from its
  // storyData to collectEntityAppearances is pinned at the call site.
  it('runEntityConsistencyChecks passes wornItemsBibleOf(storyData) to collectEntityAppearances', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../server/lib/entityConsistency.js'), 'utf8');
    const fnStart = src.indexOf('async function runEntityConsistencyChecks(');
    const call = src.indexOf('await collectEntityAppearances(', fnStart);
    const callEnd = src.indexOf('});', call);
    expect(src.slice(call, callEnd)).toMatch(/wornItemsVisualBible:\s*require\('\.\/wornItems'\)\.wornItemsBibleOf\(storyData\)/);
  });
});
