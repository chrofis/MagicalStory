import { describe, it, expect } from 'vitest';

// Replay of the STORED shapes of job_1789163494908_kc2joi4ax — the story that
// motivated the resolver. Nothing here is invented: the pools, the page
// metadata, the expectedCharacters shapes and the figure name lists are the
// ones on disk. The suite fails if the resolver stops handling real data.

// @ts-expect-error - JS module without types
import {
  buildCastIndex,
  resolveEntity,
  sameEntity,
  dedupeByEntity,
} from '../../server/lib/castResolver.js';

const STORY = {
  characters: [
    { id: 1789163000001, name: 'Levin' },
    { id: 1789163000002, name: 'Julian' },
    { id: 1789163000003, name: 'Kiaan' },
    { id: 1789163000004, name: 'Max' },
  ],
};
const VB = {
  secondaryCharacters: [
    { id: 'CHR001', name: 'Mother' },
    { id: 'CHR002', name: 'Marroni Vendor' },
  ],
  animals: [
    { id: 'ANI001', name: 'Grey Tomcat', species: 'cat' },
    { id: 'ANI002', name: 'Mother Dragon', species: 'dragon' },
    { id: 'ANI003', name: 'Fünkli', species: 'dragon' },
  ],
};

const P2 = {
  sceneMetadata: { characters: ['Mother', 'Levin', 'Julian'] },
  expectedCharacters: [
    { name: 'Levin', clothing: 'blue jacket', position: 'left', description: 'a boy of six' },
    { name: 'Julian', clothing: 'green hoodie', position: 'centre', description: 'a boy of eight' },
    { name: 'Mother', description: 'a woman in her thirties' },
  ],
  figures: ['Mother', 'UNKNOWN', 'Levin', 'Julian', 'UNKNOWN'],
};
const P9 = {
  sceneMetadata: { characters: ['Julian', 'Kiaan', 'Max', 'Vendor'] },
  retryRoster: ['Julian', 'Max', 'Kiaan', 'Vendor', 'Marroni Vendor'],
  figures: ['Julian', 'Marroni Vendor', 'Kiaan', 'Max'],
};

const idx = () => buildCastIndex(STORY, VB);

describe('job_1789163494908_kc2joi4ax replay', () => {
  it('every non-UNKNOWN stored figure name resolves', () => {
    const i = idx();
    const names = [...P2.figures, ...P9.figures].filter(n => n !== 'UNKNOWN');
    for (const n of names) expect(resolveEntity(n, i), n).not.toBeNull();
    expect(i.stats.unresolved).toEqual([]);
    expect(i.stats.ambiguous).toEqual([]);
  });

  it('every stored metadata and expectedCharacters name resolves', () => {
    const i = idx();
    const refs = [
      ...P2.sceneMetadata.characters,
      ...P2.expectedCharacters.map(e => e.name),
      ...P9.sceneMetadata.characters,
    ];
    for (const r of refs) expect(resolveEntity(r, i), r).not.toBeNull();
  });

  it('p2 "Mother" is the secondary, not the dragon', () => {
    const hit = resolveEntity('Mother', idx());
    expect(hit.id).toBe('CHR001');
    expect(hit.kind).toBe('secondary');
  });

  it('the p9 retry roster held one person twice — dedupeByEntity makes it four', () => {
    // Stored: retryHistory[0].bboxDetection.expectedCharacters.
    expect(dedupeByEntity(P9.retryRoster, idx()))
      .toEqual(['Julian', 'Max', 'Kiaan', 'Vendor']);
  });

  it('"Vendor" and "Marroni Vendor" are one entity', () => {
    expect(sameEntity('Vendor', 'Marroni Vendor', idx())).toBe(true);
    expect(resolveEntity('Vendor', idx()).id).toBe('CHR002');
  });

  it('the umlauted dragon resolves from an unaccented reference', () => {
    expect(resolveEntity('Funkli', idx()).id).toBe('ANI003');
  });
});
