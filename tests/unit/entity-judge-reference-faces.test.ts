import { describe, it, expect } from 'vitest';

// Owner, 2026-09-27: the entity identity judge gets the character's reference
// face large and legible. Cell R showed the front face at ~70 px inside a head
// grid, and gemini-2.5-flash sees every image as one fixed 258-token tile
// (countTokens: 256² … 3000×1000 all 258), so a bigger cell inside the grid
// buys nothing. Each reference face is its OWN image, built by the same builder
// a face repair sends (charRepairReference), front first plus the face of each
// other pose the grid's cells were rendered from.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ref = require('../../server/lib/charRepairReference');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { entityCheckParts } = require('../../server/lib/entityConsistency');

const FACE = ['#c00000', '#00a000', '#0000c0', '#c0c000'];   // front, threeQuarter, profile, back
const BODY = ['#800080', '#008080', '#804000', '#404040'];
async function sheet(): Promise<Buffer> {
  const cells: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let col = 0; col < 4; col++) {
    for (const [row, colours] of [[0, FACE], [1, BODY]] as Array<[number, string[]]>) {
      const block = await sharp({ create: { width: 200, height: 440, channels: 3, background: colours[col] } }).png().toBuffer();
      cells.push({ input: block, left: col * 256 + 28, top: row * 512 + 36 });
    }
  }
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' } })
    .composite(cells).png().toBuffer();
}
async function centreColour(buf: Buffer): Promise<number[]> {
  const meta = await sharp(buf).metadata();
  const { data } = await sharp(buf)
    .extract({ left: Math.floor(meta.width / 2), top: Math.floor(meta.height / 2), width: 1, height: 1 })
    .raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
}
const near = (rgb: number[], hex: string) => {
  const b = hex.slice(1).match(/\w\w/g)!.map(h => parseInt(h, 16));
  return rgb.every((v, i) => Math.abs(v - b[i]) <= 12);
};

describe('entity judge reference faces', () => {
  it('front face always, then each other pose the cells show — once each, big', async () => {
    const faces = await ref.buildJudgeReferenceFaces(await sheet(), {
      isSheet: true, poses: ['threeQuarter', 'threeQuarter', 'profile', 'front'],
    });
    expect(faces.map((f: { pose: string }) => f.pose)).toEqual(['front', 'threeQuarter', 'profile']);
    for (const f of faces) {
      const meta = await sharp(f.buf).metadata();
      expect(Math.max(meta.width, meta.height)).toBeGreaterThanOrEqual(768);
      expect(near(await centreColour(f.buf), FACE[['front', 'threeQuarter', 'profile', 'back'].indexOf(f.pose)])).toBe(true);
    }
  });

  it('no resolved poses → the front face alone', async () => {
    const faces = await ref.buildJudgeReferenceFaces(await sheet(), { isSheet: true, poses: [] });
    expect(faces.map((f: { pose: string }) => f.pose)).toEqual(['front']);
  });

  it('a non-sheet reference is sent whole, once, big', async () => {
    const photo = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#336699' } }).png().toBuffer();
    const faces = await ref.buildJudgeReferenceFaces(photo, { isSheet: false, poses: ['profile'] });
    expect(faces).toHaveLength(1);
    expect(faces[0].pose).toBeNull();
    const meta = await sharp(faces[0].buf).metadata();
    expect(meta.height).toBe(1024);
  });

  it('each reference face goes to the judge as its own labelled image after the grid', () => {
    const grid = Buffer.from('grid');
    const parts = entityCheckParts('PROMPT', grid, null, [
      { pose: 'front', buf: Buffer.from('f') },
      { pose: 'profile', buf: Buffer.from('p') },
    ]);
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('PROMPT');
    expect(parts[1].inlineData.data).toBe(grid.toString('base64'));
    expect(parts[2]).toMatch(/Reference face, front view/);
    expect(parts[3].inlineData.data).toBe(Buffer.from('f').toString('base64'));
    expect(parts[4]).toMatch(/Reference face, profile/);
    expect(parts[5].inlineData.data).toBe(Buffer.from('p').toString('base64'));
  });

  it('without reference faces the request is the grid alone, as before', () => {
    const parts = entityCheckParts('PROMPT', Buffer.from('g'));
    expect(parts).toHaveLength(2);
  });
});
