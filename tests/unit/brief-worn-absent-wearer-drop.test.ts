import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { dropAbsentWearerGarments, garmentWearerAbsent } = nodeRequire('../../server/lib/wornItems.js');
const { assembleBriefs } = nodeRequire('../../server/lib/jevBriefFields.js');
const { extractSceneMetadata } = nodeRequire('../../server/lib/sceneMetadata.js');

// Stored shapes: staging job_1791531449494_o0kaatvmq. CLO001 is Kiaan's worn
// beanie (wornItems owner Kiaan, "on Kiaan's head"). The Art Director cited it
// in objects[] on p2 (cast: Max only) and p3 (cast: Julian, Funka) -- pages its
// wearer is not on -- and on p4, where Kiaan is in the cast and carries the
// worn row. (The stored story's visualBible.clothing is empty, so the bible
// entry below is the minimal shape visualBible.js writes: id, name, wornBy.)
const VB = { clothing: [{ id: 'CLO001', name: 'purple knitted wool beanie', wornBy: 'Kiaan', type: 'clothing' }], artifacts: [{ id: 'ART001', name: 'dark stone-like egg' }] };
const brief = (meta: any) => `The scene prose.\n\n---METADATA---\n${JSON.stringify(meta, null, 2)}`;
const p2 = brief({ objects: ['LOC001.2', 'ART001.1', 'CLO001'], characters: [{ name: 'Max', depth: 'foreground' }], wornItems: [], shot: 'medium' });
const p3 = brief({ objects: ['LOC002', 'ART001.1', 'ANI001', 'CLO001'], characters: [{ name: 'Julian' }, { name: 'Funka' }], wornItems: [], shot: 'close-up' });
const p4 = brief({ objects: ['LOC001.3', 'ANI001', 'ART003.2', 'CLO001'], characters: [{ name: 'Levin' }, { name: 'Kiaan' }], wornItems: [{ id: 'CLO001', owner: 'Kiaan', state: 'worn', location: "on Kiaan's head" }], shot: 'wide' });
const objectsOf = (b: string) => (extractSceneMetadata(b).fullData || extractSceneMetadata(b)).objects;

describe('a worn garment is not cited on a page its wearer is not on', () => {
  it('drops CLO001 from p2 and p3 objects[], keeps everything else', () => {
    expect(dropAbsentWearerGarments(p2, VB).dropped).toEqual([{ id: 'CLO001', wearer: 'Kiaan' }]);
    expect(objectsOf(dropAbsentWearerGarments(p2, VB).brief)).toEqual(['LOC001.2', 'ART001.1']);
    expect(objectsOf(dropAbsentWearerGarments(p3, VB).brief)).toEqual(['LOC002', 'ART001.1', 'ANI001']);
  });
  it('keeps it where the wearer is in the cast (p4) and says nothing', () => {
    const r = dropAbsentWearerGarments(p4, VB);
    expect(r.dropped).toEqual([]);
    expect(r.brief).toBe(p4);
  });
  it('leaves a brief alone with no clothing in the bible, or unparseable metadata', () => {
    expect(dropAbsentWearerGarments(p2, { clothing: [] }).brief).toBe(p2);
    expect(dropAbsentWearerGarments('no metadata here', VB).brief).toBe('no metadata here');
  });
  it('assembleBriefs applies it to every page, with or without decided fields', () => {
    const expansions = [{ pageNumber: 2, brief: p2 }, { pageNumber: 3, brief: p3 }, { pageNumber: 4, brief: p4 }];
    assembleBriefs(expansions, [], { error() {}, warn() {}, info() {} }, VB);
    expect(objectsOf(expansions[0].brief)).not.toContain('CLO001');
    expect(objectsOf(expansions[1].brief)).not.toContain('CLO001');
    expect(objectsOf(expansions[2].brief)).toContain('CLO001');
  });
  it('is the same question the image-prompt side asks', () => {
    expect(garmentWearerAbsent(VB.clothing[0], ['Max'], false)).toBe(true);
    expect(garmentWearerAbsent(VB.clothing[0], ['kiaan'], false)).toBe(false);
    expect(garmentWearerAbsent(VB.clothing[0], ['Max'], true)).toBe(false);
  });
});
