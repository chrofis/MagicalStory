/**
 * A face-hidden figure gets the rear cell, never a front face card
 * (staging job_1790373080139_vnx5l8iy7 p7).
 *
 * The `over-the-shoulder` near figure was sent `cell-threeQuarter-headbody` —
 * a front-facing head card for a figure whose face the page hides — and the
 * image model put that face on another child. resolveCellPose is the ONE pose
 * resolver for every cell-ref call site (applyStoryCellRefs, the iterate path
 * in images.js, the regeneration route), so the fix lives there and the call
 * sites are pinned to keep reading it. Offline, no paid call.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const sharp = require('sharp');
const { resolveCellPose, isFaceAwayPerspective, applyStoryCellRefs } = require('../../server/lib/storyAvatars');

describe('resolveCellPose sends a face-away figure the rear cell', () => {
  it.each([
    'over-the-shoulder', 'Over the shoulder', 'back view', 'back view, head turned toward right shoulder',
    'rear three-quarter', 'three-quarter rear view', 'facing away', 'seen from behind',
  ])('%s -> back', (perspective) => {
    expect(isFaceAwayPerspective(perspective)).toBe(true);
    expect(resolveCellPose({ name: 'A', perspective }).pose).toBe('back');
  });

  it.each([
    ['facing right', 'threeQuarter'], ['facing left', 'threeQuarter'], ['side profile', 'profile'],
    ['facing the camera', 'front'], ['three-quarter view', 'threeQuarter'], ['facing the egg', 'threeQuarter'],
  ])('%s keeps a face (%s)', (perspective, pose) => {
    expect(isFaceAwayPerspective(perspective)).toBe(false);
    expect(resolveCellPose({ name: 'A', perspective }).pose).toBe(pose);
  });

  it('an explicit pose still wins over the perspective', () => {
    expect(resolveCellPose({ name: 'A', pose: 'front', perspective: 'over-the-shoulder' }).pose).toBe('front');
  });
});

describe('applyStoryCellRefs crops the rear cells for an over-the-shoulder figure', () => {
  it('the ref is the back cell stacked with the back-of-head card', async () => {
    // A 4x2 sheet (each cell 40x40) of flat, distinct colours: row 1 heads,
    // row 2 bodies — enough to prove which cells were cut.
    const W = 160, H = 80, cell = 40;
    const composites = [];
    for (let i = 0; i < 8; i++) {
      const tile = await sharp({ create: { width: cell, height: cell, channels: 3, background: { r: i * 30, g: 10, b: 10 } } }).png().toBuffer();
      composites.push({ input: tile, left: (i % 4) * cell, top: Math.floor(i / 4) * cell });
    }
    const sheet = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite(composites).png().toBuffer();
    const refs: any[] = [{ name: 'Kiaan', clothingCategory: 'standard', photoUrl: 'x' }];
    await applyStoryCellRefs(refs, { Kiaan: { 'styled-standard': `data:image/png;base64,${sheet.toString('base64')}` } },
      [{ name: 'Kiaan', perspective: 'over-the-shoulder', depth: 'foreground' }]);
    expect(refs[0].cellPose).toBe('back');
    expect(refs[0].photoType).toBe('cell-back-headbody');
  });
});

describe('every cell-ref call site reads the one resolver', () => {
  const root = path.resolve(__dirname, '../..');
  it.each(['server/lib/images.js', 'server/routes/regeneration.js'])('%s', (rel) => {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(src).toMatch(/resolveCellPose\(sc\)/);
    // No inline copy of the perspective → pose mapping.
    expect(src).not.toMatch(/\bback\b\|behind/);
  });
});
