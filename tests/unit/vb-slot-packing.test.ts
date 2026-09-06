import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const nodeRequire = createRequire(import.meta.url);
const grok: any = nodeRequire('../../server/lib/grok.js');

// VB elements that have to share a slot with the character cards go in a
// vertical COLUMN beside the cards, not a strip below them (owner, 2026-09-06 —
// staging job_1788641639919_mpjwlzkf1 p14, where the rescued girl's reference
// rode in a 134x86 cell beside a character card and rendered with the lead
// child's hair). Cap 4, floor VB_CELL_FLOOR_PX, drop before shrinking.

async function solid(w: number, h: number, colour: any) {
  return sharp({ create: { width: w, height: h, channels: 3, background: colour } }).jpeg().toBuffer();
}

async function elements(n: number, opts: { recurringFirst?: boolean; type?: string } = {}) {
  const buf = await solid(512, 512, { r: 200, g: 160, b: 60 });
  const imageData = `data:image/jpeg;base64,${buf.toString('base64')}`;
  return Array.from({ length: n }, (_, i) => ({
    id: `EL${i}`,
    name: `el${i}`,
    type: opts.type || 'artifact',
    recurring: !!opts.recurringFirst && i === 0,
    imageData,
  }));
}

describe('VB slot packing — column beside the cards', () => {
  it('one character + 3 VB elements: cells sit in a column at or above the floor', async () => {
    // Card 512x1024 in a 3:4 slot -> canvas 768x1024, cards 512 wide,
    // column 256 wide, three cells 256x341 each.
    const card = await solid(512, 1024, { r: 40, g: 80, b: 200 });
    const res: any = await grok.composeCharWithVbRow(card, await elements(3), '3:4');
    expect(res.cellCount).toBe(3);
    expect(res.cardsW).toBe(512);
    expect(res.cellW).toBe(256);
    expect(res.cellH).toBe(341);
    expect(Math.min(res.cellW, res.cellH)).toBeGreaterThanOrEqual(grok.VB_CELL_FLOOR_PX);
    expect(res.floored).toBe(false);
    const meta = await sharp(res.buffer).metadata();
    // Output is exactly at the target aspect, so the later aspect-pad is a no-op.
    expect(meta.width).toBe(768);
    expect(meta.height).toBe(1024);
    // The column is to the RIGHT of the cards, never below them.
    expect(res.cardsW + res.cellW).toBe(meta.width);
    expect(res.cellH * res.cellCount).toBeLessThanOrEqual(meta.height!);
  }, 30000);

  it('caps at 4 elements and drops the rest', async () => {
    const card = await solid(512, 1024, { r: 40, g: 80, b: 200 });
    const res: any = await grok.composeCharWithVbRow(card, await elements(6), '3:4');
    expect(grok.VB_SLOT_MAX_ELEMENTS).toBe(4);
    expect(res.cellCount).toBe(4);
    expect(res.cellH).toBe(256);
    expect(Math.min(res.cellW, res.cellH)).toBeGreaterThanOrEqual(grok.VB_CELL_FLOOR_PX);
  }, 30000);

  it('drops to 3 when 4 cells would fall below the floor, and never below 3', async () => {
    // A 16:9 slot is only 576 tall: four stacked cells would be 144px.
    const card = await solid(512, 1024, { r: 40, g: 80, b: 200 });
    const res: any = await grok.composeCharWithVbRow(card, await elements(5), '16:9');
    expect(res.cellCount).toBe(grok.VB_SLOT_MIN_ELEMENTS);
    expect(res.cellCount).toBe(3);
    // Still short of the floor at the minimum count — reported, not fixed by
    // dropping further (3 is the owner's floor on the count itself).
    expect(res.floored).toBe(true);
  }, 30000);

  it('takes column width back from the cards when they fill the slot', async () => {
    // Four cards side by side make a wide composite with no free width.
    const cards = await solid(2048, 512, { r: 40, g: 80, b: 200 });
    const res: any = await grok.composeCharWithVbRow(cards, await elements(4), '1:1');
    expect(res.cellW).toBeGreaterThanOrEqual(grok.VB_CELL_FLOOR_PX);
    expect(res.cardsW).toBe(1024 - res.cellW);
  }, 30000);

  it('is a no-op with no elements', async () => {
    const card = await solid(512, 1024, { r: 40, g: 80, b: 200 });
    const res: any = await grok.composeCharWithVbRow(card, [], '3:4');
    expect(res.cellCount).toBe(0);
    expect(res.buffer).toBe(card);
  }, 30000);
});

describe('VB slot packing — priority order survives the cap', () => {
  it('sorts by VB priority, recurring first, regardless of arrival order', async () => {
    // buildVisualBibleGrid pushes rawElements in Promise.all COMPLETION order,
    // so the packer must re-establish the priority order before it slices.
    const list = [
      { id: 'ART001', name: 'hat', type: 'artifact' },
      { id: 'LOC001', name: 'square', type: 'location' },
      { id: 'CHR002', name: 'girl', type: 'character' },
      { id: 'ANI001', name: 'dragon', type: 'animal', recurring: true },
      { id: 'VEH001', name: 'cart', type: 'vehicle' },
    ];
    expect(grok.sortVbElements(list).map((e: any) => e.id))
      .toEqual(['ANI001', 'CHR002', 'ART001', 'VEH001', 'LOC001']);
  });

  it('cap keeps the four highest-priority elements', async () => {
    const list = [
      { id: 'ART001', type: 'artifact' },
      { id: 'LOC001', type: 'location' },
      { id: 'CHR002', type: 'character' },
      { id: 'ANI001', type: 'animal', recurring: true },
      { id: 'VEH001', type: 'vehicle' },
    ];
    expect(grok.capVbElements(list, '[T]').map((e: any) => e.id))
      .toEqual(['ANI001', 'CHR002', 'ART001', 'VEH001']);
  });
});
