import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Owner, 2026-09-27: "Face should get the face ref in big. Body repair should
// get just the body." A face repair used to send the face cell STACKED over the
// body cell (256x1024 from a 1024² sheet); Grok crops every input to the call's
// aspect (1:1 for a face), so what arrived was a ~14KB 256x256 strip from the
// middle of the stack (Lab 1561, staging job_1790446348343_z3fw660ie initialPage).
// These tests pin: face target → the face cell alone, big; body target → the
// body cell alone; both padded, never cropped, to the call's aspect.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharp = require('sharp');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ref = require('../../server/lib/charRepairReference');

// A 2x4 sheet: top row = four head cells, bottom row = four body cells, each a
// distinct flat colour on a white ground, the way the styled sheets are laid out.
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

async function centreColour(buf: Buffer): Promise<string> {
  const meta = await sharp(buf).metadata();
  const { data } = await sharp(buf)
    .extract({ left: Math.floor(meta.width / 2), top: Math.floor(meta.height / 2), width: 1, height: 1 })
    .raw().toBuffer({ resolveWithObject: true });
  return '#' + [data[0], data[1], data[2]].map((v: number) => v.toString(16).padStart(2, '0')).join('');
}
const near = (hex: string, want: string) => {
  const a = hex.match(/\w\w/g)!.map(h => parseInt(h, 16));
  const b = want.slice(1).match(/\w\w/g)!.map(h => parseInt(h, 16));
  return a.every((v, i) => Math.abs(v - b[i]) <= 12);
};

describe('char repair reference by target', () => {
  it('face target → the pose\'s face cell ALONE, at the big size', async () => {
    const s = await sheet();
    for (const [i, pose] of ['front', 'threeQuarter', 'profile', 'back'].entries()) {
      const r = await ref.buildRepairReference(s, { target: 'face', isSheet: true, pose });
      expect(r.kind).toBe(`face-cell-${pose}`);
      expect(Math.max(r.width, r.height)).toBeGreaterThanOrEqual(ref.REPAIR_REFERENCE_LONG_SIDE);
      // One cell, not a stack: a cell is taller than wide but nowhere near 1:4.
      expect(r.height / r.width).toBeLessThan(3);
      expect(near(await centreColour(r.buf), FACE[i])).toBe(true);
    }
  });

  it('body target → the pose\'s body cell ALONE — no face row', async () => {
    const s = await sheet();
    const r = await ref.buildRepairReference(s, { target: 'body', isSheet: true, pose: 'profile' });
    expect(r.kind).toBe('body-cell-profile');
    expect(Math.max(r.width, r.height)).toBeGreaterThanOrEqual(ref.REPAIR_REFERENCE_LONG_SIDE);
    expect(near(await centreColour(r.buf), BODY[2])).toBe(true);
    // No face-row colour anywhere in it.
    const { data, info } = await sharp(r.buf).raw().toBuffer({ resolveWithObject: true });
    let faceRed = 0;
    for (let p = 0; p < info.width * info.height; p++) {
      const o = p * info.channels;
      if (near('#' + [data[o], data[o + 1], data[o + 2]].map((v: number) => v.toString(16).padStart(2, '0')).join(''), FACE[2])) faceRed++;
    }
    expect(faceRed).toBe(0);
  });

  it('a sheet with no pose fails loudly instead of sending a guessed cell', async () => {
    await expect(ref.buildRepairReference(await sheet(), { target: 'face', isSheet: true })).rejects.toThrow(/pose/);
  });

  it('padding to the call aspect keeps every pixel (the old path CROPPED the reference)', async () => {
    const r = await ref.buildRepairReference(await sheet(), { target: 'face', isSheet: true, pose: 'front' });
    const padded = await ref.fitReferenceToAspect(r.buf, '1:1');
    const m = await sharp(padded).metadata();
    expect(m.width).toBe(m.height);
    expect(m.height).toBe(r.height);             // long side kept, short side padded
    expect(near(await centreColour(padded), FACE[0])).toBe(true);
    // Grok's own normalisation skips an input within 1% of the target aspect.
    const tall = await ref.fitReferenceToAspect(r.buf, '3:4');
    const t = await sharp(tall).metadata();
    expect(Math.abs(t.width / t.height - 0.75) / 0.75).toBeLessThan(0.01);
  });

  it('every repair caller hands over the pose and no caller crops a cell itself', () => {
    const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
    // The repair round's call is built in charFixCall.js (shared with the Lab stage).
    // The Lab char_repair stage builds through charFixCall.js as well.
    const callers = ['server/lib/charFixCall.js', 'server/routes/regeneration.js', 'server/lib/entityConsistency.js'];
    expect(read('server/lib/testlab.js')).toContain("require('./charFixCall')");
    for (const f of callers) expect(read(f), f).toMatch(/referencePose[:,]/);
    // The spine picks the cell from the FINAL face/body axis.
    expect(read('server/lib/faceRepair.js')).toMatch(/normalizeAvatar\(avatarInput, opts, faceOnly \? 'face' : 'body'\)/);
    expect(read('server/lib/repairPipeline.js')).not.toMatch(/-stacked/);
    expect(read('server/lib/testlab.js')).not.toMatch(/referenceCells/);
  });
});
