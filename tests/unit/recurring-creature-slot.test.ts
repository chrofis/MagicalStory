import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const nodeRequire = createRequire(import.meta.url);
const vb: any = nodeRequire('../../server/lib/visualBible.js');
const grok: any = nodeRequire('../../server/lib/grok.js');

// A named creature on 15 of 18 pages (staging job_1788614817116_vxnu60yjg,
// ANI001 "Fünkli") is recurring; a raven on 5 of 18 is not.
function makeVb() {
  return {
    animals: [
      { id: 'ANI001', name: 'Fünkli', referenceImageUrl: 'https://x/ani1.jpg', appearsInPages: [4,5,6,7,8,9,10,11,12,13,14,15,16,17,18] },
      { id: 'ANI002', name: 'Rabe', referenceImageUrl: 'https://x/ani2.jpg', appearsInPages: [6,11,12,14,17] },
    ],
    secondaryCharacters: [
      { id: 'CHR010', name: 'Baker', referenceImageUrl: 'https://x/c.jpg', appearsInPages: [16] },
    ],
    artifacts: [
      { id: 'ART002', name: 'eggshell fragment', referenceImageUrl: 'https://x/a.jpg', appearsInPages: [16] },
      { id: 'ART005', name: "raven's nest", referenceImageUrl: 'https://x/a5.jpg', appearsInPages: [16] },
    ],
    vehicles: [
      { id: 'VEH001', name: 'bicycle', referenceImageUrl: 'https://x/v.jpg', appearsInPages: [16] },
    ],
    locations: [
      { id: 'LOC007', name: 'Alps Horizon', referenceImageUrl: 'https://x/l.jpg', appearsInPages: [1,14,15,16,17,18] },
    ],
  };
}

describe('recurring creature — definition', () => {
  it('promotes an animal on >= half the pages and >= 4 pages', () => {
    const v = makeVb();
    expect(vb.vbStoryPageCount(v)).toBe(18);
    expect(vb.isRecurringCreature(v, v.animals[0])).toBe(true);
    expect(vb.isRecurringCreature(v, v.animals[1])).toBe(false);
    expect(vb.getRecurringCreatureIds(v)).toEqual(['ANI001']);
  });

  it('requires a reference image', () => {
    const v = makeVb();
    delete v.animals[0].referenceImageUrl;
    expect(vb.isRecurringCreature(v, v.animals[0])).toBe(false);
  });

  it('does not promote a 2-of-4-page animal in a short story (absolute floor)', () => {
    const v = { animals: [{ id: 'ANI001', name: 'Cat', referenceImageUrl: 'x', appearsInPages: [2, 3] }] };
    expect(vb.isRecurringCreature(v as any, (v as any).animals[0])).toBe(false);
  });
});

describe('recurring creature — element reference selection', () => {
  it('survives the cap-4 element budget on a cast-heavy page and is flagged', () => {
    const v = makeVb();
    const refs = vb.getElementReferenceImagesForPage(v, 16, 4);
    expect(refs).toHaveLength(4);
    expect(refs[0].id).toBe('ANI001');
    expect(refs[0].recurring).toBe(true);
    // cap is not raised to make room
    expect(refs.filter((r: any) => r.recurring)).toHaveLength(1);
  });

  it('leaves a non-recurring animal packing normally, behind characters', () => {
    const v = makeVb();
    const refs = vb.getElementReferenceImagesForPage(v, 6, 4);
    const rabe = refs.find((r: any) => r.id === 'ANI002');
    expect(rabe).toBeTruthy();
    expect(rabe.recurring).toBe(false);
  });
});

async function solidPng(w: number, h: number, colour: any) {
  return sharp({ create: { width: w, height: h, channels: 3, background: colour } }).jpeg().toBuffer();
}

async function packWith(recurring: boolean, maxSlots?: number) {
  const charBuf = await solidPng(512, 1024, { r: 40, g: 80, b: 200 });
  const elBuf = await solidPng(512, 512, { r: 220, g: 160, b: 40 });
  const charPhoto = `data:image/jpeg;base64,${charBuf.toString('base64')}`;
  const grid: any = Buffer.from('x');
  grid.rawElements = [
    { id: 'ANI001', name: 'Fünkli', type: 'animal', recurring, imageData: `data:image/jpeg;base64,${elBuf.toString('base64')}` },
    { id: 'ART002', name: 'shell', type: 'artifact', recurring: false, imageData: `data:image/jpeg;base64,${elBuf.toString('base64')}` },
  ];
  return grok.packReferences(
    {
      visualBibleGrid: grid,
      characterPhotos: ['A', 'B', 'C', 'D'].map(name => ({ name, photoUrl: charPhoto, photoType: 'cell-front-headbody' })),
    },
    { aspectRatio: '3:4', pageLabel: '16', ...(maxSlots ? { maxSlots } : {}) },
  );
}

describe('recurring creature — Grok slot assembly (4 characters)', () => {
  it('never exceeds the slot cap', async () => {
    const slots = await packWith(true);
    expect(slots.length).toBeLessThanOrEqual(3);
  }, 30000);

  it('gives the creature its own slot when a slot is free under a raised cap', async () => {
    const slots = await packWith(true, 5);
    // 4 characters, each in its own slot, plus the VB slot = 5
    expect(slots).toHaveLength(5);
  }, 30000);

  it('floors the creature cell to the character card width when slots are full', async () => {
    const charBuf = await solidPng(512, 1024, { r: 40, g: 80, b: 200 });
    const elBuf = await solidPng(512, 512, { r: 220, g: 160, b: 40 });
    const el = (recurring: boolean) => ({ id: 'ANI001', name: 'Fünkli', type: 'animal', recurring, imageData: `data:image/jpeg;base64,${elBuf.toString('base64')}` });
    const before: any = await grok.composeCharWithVbRow(charBuf, [el(false)], '3:4', { charsInSlot: 2 });
    const after: any = await grok.composeCharWithVbRow(charBuf, [el(true)], '3:4', { charsInSlot: 2 });
    const cardW = Math.floor(512 / 2);
    expect(after.cellW).toBe(cardW);
    expect(after.cellH).toBe(cardW);
    expect(after.floored).toBe(true);
    expect(before.floored).toBe(false);
    // The unfloored cell `contain`s a square reference into a wide, short cell,
    // so its usable edge is the height — strictly smaller than the floor.
    expect(before.cellH).toBeLessThan(after.cellH);
  }, 30000);

  it('drops lower-priority cells rather than shrinking the creature', async () => {
    const charBuf = await solidPng(512, 1024, { r: 40, g: 80, b: 200 });
    const elBuf = await solidPng(512, 512, { r: 220, g: 160, b: 40 });
    const mk = (id: string, recurring: boolean) => ({ id, name: id, type: 'artifact', recurring, imageData: `data:image/jpeg;base64,${elBuf.toString('base64')}` });
    const res: any = await grok.composeCharWithVbRow(
      charBuf,
      [{ ...mk('ANI001', true), type: 'animal' }, mk('ART002', false), mk('ART005', false), mk('VEH001', false)],
      '3:4',
      { charsInSlot: 2 },
    );
    // 512 wide / 256 floor edge = 2 cells fit; the other two are dropped.
    expect(res.cellCount).toBe(2);
    expect(res.cellW).toBe(256);
  }, 30000);
});
