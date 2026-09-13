import { describe, it, expect } from 'vitest';

// The page cast is the roster the presence arithmetic is measured against.
// It is a UNION of the outline hint and the brief prose because each source
// drops cast the other keeps. Evidence: job_1789207854566_l43qgl34w.
const { unionPageCast, getCharactersInScene } = require('../../server/lib/sceneMetadata');

const CAST = [
  { name: 'Sarah' },
  { name: 'Saira' },
  { name: 'Facundo' },
  { name: 'Fiona' },
  { name: 'Lorena' },
];

const names = (arr: any[]) => arr.map((c) => c.name);

describe('unionPageCast', () => {
  it('keeps a hint-commissioned character the prose never names', () => {
    // p1 shape: the prose names three, the hint commissions all five.
    const prose = 'Sarah runs ahead of Facundo while Fiona shields her eyes. '
      + 'Behind them a dark-haired girl and a wavy-haired girl follow.';
    const out = unionPageCast(prose, ['Saira', 'Lorena'], CAST);
    expect(names(out).sort()).toEqual(['Facundo', 'Fiona', 'Lorena', 'Saira', 'Sarah']);
  });

  it('keeps a prose-named character the hint never commissions', () => {
    // p7 shape: the hint's `characters[]` is EMPTY and the only names in its
    // JSON are garment owners; the prose names the real cast.
    const prose = 'Fiona stands at the rim. Sarah, Facundo and Saira face her across the shaft.';
    const out = unionPageCast(prose, [], CAST);
    expect(names(out).sort()).toEqual(['Facundo', 'Fiona', 'Saira', 'Sarah']);
  });

  it('is a union, not a replacement — neither side can delete the other', () => {
    const prose = 'Fiona stands alone in the rain.';
    const hintOnly = unionPageCast('', ['Sarah', 'Facundo'], CAST);
    const proseOnly = unionPageCast(prose, [], CAST);
    const both = unionPageCast(prose, ['Sarah', 'Facundo'], CAST);
    expect(names(hintOnly).sort()).toEqual(['Facundo', 'Sarah']);
    expect(names(proseOnly)).toEqual(['Fiona']);
    expect(names(both).sort()).toEqual(['Facundo', 'Fiona', 'Sarah']);
  });

  it('never returns a character the story does not have', () => {
    const out = unionPageCast('Frau Amrein watches.', ['Frau Amrein', 'Nobody'], CAST);
    expect(out).toEqual([]);
  });

  it('strips a parenthetical qualifier and matches on first name', () => {
    const out = unionPageCast('', ['Sarah (background)', 'facundo'], CAST);
    expect(names(out).sort()).toEqual(['Facundo', 'Sarah']);
  });

  it('deduplicates and returns story order, not discovery order', () => {
    const out = unionPageCast('Lorena and Sarah.', ['Sarah', 'Lorena', 'Sarah'], CAST);
    expect(names(out)).toEqual(['Sarah', 'Lorena']);
  });

  it('accepts hint entries as records as well as plain names', () => {
    const out = unionPageCast('', [{ name: 'Saira' }], CAST);
    expect(names(out)).toEqual(['Saira']);
  });

  it('is a superset of the prose scan for every input', () => {
    const prose = 'Sarah and Facundo stand together.';
    const proseScan = getCharactersInScene(prose, CAST).map((c: any) => c.name);
    const union = names(unionPageCast(prose, ['Fiona'], CAST));
    for (const n of proseScan) expect(union).toContain(n);
  });

  it('tolerates an empty story cast', () => {
    expect(unionPageCast('Sarah runs.', ['Sarah'], [])).toEqual([]);
    expect(unionPageCast('Sarah runs.', ['Sarah'], null as any)).toEqual([]);
  });

  it('per-page clothing keys are NOT a cast signal at the call sites', () => {
    // Measured: on job_1789207854566_l43qgl34w p3 and p11 the outline
    // commissioned nobody and still emitted a clothing entry for all five
    // characters. Reading those keys as cast put five people on two empty
    // pages. The hint side of the union is `characters[]` only.
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(process.cwd(), 'storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/unionPageCast\([^)]*Object\.keys\([^)]*[Cc]lothing/s);
    expect(src).toMatch(/unionPageCast\(\s+scene\.sceneDescription,\s+scene\.characters \|\| \[\],/);
  });
});
