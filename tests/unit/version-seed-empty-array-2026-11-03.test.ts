// A trial page is stored with `imageVersions: []` beside its version-0 image. The routes that add a
// version seeded the original only when imageVersions was missing, so on [] the new version took array
// slot 0, was saved at DB version_index 0 and overwrote the original's R2 key (staging edit of
// job_1793690027654_nan1zutp1h p1, 2026-11-03).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { needsOriginalSeed, dbIndexFor } = require('../../server/lib/versionManager');

describe('needsOriginalSeed', () => {
  it('seeds a record whose version list is missing or empty', () => {
    expect(needsOriginalSeed({})).toBe(true);
    expect(needsOriginalSeed({ imageVersions: null })).toBe(true);
    expect(needsOriginalSeed({ imageVersions: [] })).toBe(true);
  });

  it('leaves a record that already lists its versions alone', () => {
    expect(needsOriginalSeed({ imageVersions: [{ type: 'original' }] })).toBe(false);
  });

  it('puts a pushed edit after the seeded original, never on version 0', () => {
    const scene: any = { imageVersions: [] };
    if (needsOriginalSeed(scene)) scene.imageVersions = [{ type: 'original' }];
    scene.imageVersions.push({ type: 'edit', imageData: 'x' });
    expect(dbIndexFor(scene.imageVersions[1], 1, 'scene')).toBe(1);
  });
});

describe('regeneration routes seed through needsOriginalSeed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../server/routes/regeneration.js'), 'utf8');

  it('has no guard that treats an empty version list as seeded', () => {
    expect(src.match(/!\s*\w+\.imageVersions\s*\)/g) || []).toEqual([]);
  });

  it('every original seed is behind needsOriginalSeed', () => {
    const seeds = (src.match(/type: 'original'/g) || []).length;
    const guards = (src.match(/needsOriginalSeed\(/g) || []).length;
    expect(seeds).toBeGreaterThan(0);
    expect(guards).toBeGreaterThanOrEqual(11);
  });
});
