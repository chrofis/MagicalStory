/**
 * Fiona rerun job_1791450210539_nwi88y9lr (2026-10-08): Saira's styled head row had the crown of her head cut in all four
 * cells. cropHeadRowToShoulders shortens the head row (576 -> ~330 px), the 1280-wide stack became 1.21 (nearest preset
 * 4:3) and editWithGrok coerces its input to the preset by cropping the longer axis, about 5% off the top and bottom,
 * while the generator leaves only ~4% headroom above the hair. The stack is now built to an exact preset: the extra
 * height goes on top of the head row, so the coercion crops nothing.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';

const sheetMod = require('../../server/lib/character2x4Sheet');
const { sheetStackPad, stackRowsInto2x4 } = sheetMod._internal;

describe('sheetStackPad: the headroom that puts the stack on a preset', () => {
  it('a cropped head row (1280 wide, 327 + 12 + 720 tall) is padded to 1:1', () => {
    expect(sheetStackPad(1280, 327 + 12 + 720)).toBe(1280 - 1059);
  });

  it('the pre-crop stack (576 + 12 + 720, ~1:1) and any taller stack gain nothing', () => {
    expect(sheetStackPad(1280, 576 + 12 + 720)).toBe(0);
    expect(sheetStackPad(1280, 1280)).toBe(0);
  });

  it('a wider stack is padded to the largest preset it does not exceed (4:3, 16:9)', () => {
    expect(sheetStackPad(1280, 900)).toBe(960 - 900);
    expect(sheetStackPad(1280, 700)).toBe(720 - 700);
  });
});

async function row(width: number, height: number, headTop: number) {
  // light studio background, a black cell divider at each quarter, a dark "head" starting `headTop` px from the top
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#d9dadd"/>
    ${[1, 2, 3].map(k => `<rect x="${(width / 4) * k - 2}" y="0" width="4" height="${height}" fill="#000"/>`).join('')}
    ${[0, 1, 2, 3].map(k => `<rect x="${(width / 4) * k + 90}" y="${headTop}" width="140" height="160" fill="#3a2a20"/>`).join('')}
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

describe('stackRowsInto2x4: the sheet is an exact preset and the heads keep their headroom', () => {
  it('a cropped head row stacks to a 1:1 sheet; the divider and the head stay where the padding puts them', async () => {
    const head = await row(1280, 327, 12);
    const body = await row(1280, 720, 40);
    const { imageData, splitY } = await stackRowsInto2x4(head, body);
    const buf = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const meta = await sharp(buf).metadata();
    expect(meta.width).toBe(1280);
    expect(meta.height).toBe(1280); // exactly 1:1: the style transfer's preset coercion crops nothing
    const pad = 1280 - (327 + 12 + 720);
    expect(splitY).toBe(327 + pad + 6);
    // the head block sits at pad + 12 from the top: dark pixels there, background above it (the padding is the row's own top edge)
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => data[(y * info.width + x) * info.channels];
    expect(px(150, pad + 12 + 20)).toBeLessThan(90);
    expect(px(150, pad - 20)).toBeGreaterThan(180);
    // the cell dividers run on through the padding (the copied top edge keeps them continuous)
    expect(px(320, 10)).toBeLessThan(60);
  });

  it('an uncropped head row (576 tall) is stacked as before: no padding', async () => {
    const head = await row(1280, 576, 12);
    const body = await row(1280, 720, 40);
    const { imageData, splitY } = await stackRowsInto2x4(head, body);
    const meta = await sharp(Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64')).metadata();
    expect(meta.height).toBe(576 + 12 + 720);
    expect(splitY).toBe(576 + 6);
  });
});
