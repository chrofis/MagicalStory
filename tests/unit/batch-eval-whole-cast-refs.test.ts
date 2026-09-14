import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// BEHAVIOUR PINNED: the batch quality judge gets real references.
// Since character storage normalised to photos[]/avatars.styledAvatars, the
// whole-cast list was built by a filter on `photoUrl || avatars.styled` that
// matches nothing — every batch eval ran with zero reference images and no
// clothing contract (staging job_1789343124794_z2c779f7i: N-16 on all 36
// evals, every main-cast token unresolved).

const { buildWholeCastReferencePhotos } = require_('../../server/lib/clothingResolve.js');

// A character in the STORED shape: no photoUrl, no avatars.styled.
const storedCharacter = (name: string) => ({
  id: `id-${name}`,
  name,
  photos: { primary: `data:image/jpeg;base64,${name}-primary` },
  avatars: {
    standard: `data:image/jpeg;base64,${name}-standard`,
    clothing: { standard: 'blue jumper, grey trousers, brown shoes' },
    styledAvatars: {
      watercolor: { standard: { imageUrl: `https://r2.example/${name}-wc-standard.jpg` } },
    },
  },
});

describe('whole-cast reference photos come from the real resolver', () => {
  const cast = [storedCharacter('Levin'), storedCharacter('Julian')];

  it('a stored-shape character yields a reference with a photo and a clothing contract line', () => {
    const refs = buildWholeCastReferencePhotos(cast, 'watercolor', null);
    expect(refs).toHaveLength(2);
    for (const ref of refs) {
      expect(ref.photoUrl).toBeTruthy();
      expect(ref.clothingDescription).toBeTruthy();
    }
    expect(refs.map((r: any) => r.name).sort()).toEqual(['Julian', 'Levin']);
  });

  it('the regressed filter really does match nothing on that shape', () => {
    // Guards the test itself against a fixture that would have passed before.
    const old = cast.filter((c: any) => c.photoUrl || c.avatars?.styled);
    expect(old).toHaveLength(0);
  });

  it('the per-story clothing requirements win over the stored outfit', () => {
    const refs = buildWholeCastReferencePhotos(cast, 'watercolor', {
      Levin: { standard: { used: true, signature: 'red raincoat, yellow boots' } },
    });
    const levin = refs.find((r: any) => r.name === 'Levin');
    expect(levin.clothingDescription).toContain('red raincoat');
  });
});

describe('composeEvalReferencePhotos: page outfit first, whole cast fills the rest', () => {
  const { composeEvalReferencePhotos } = require_('../../server/lib/images.js');

  const pagePhotos = [{ name: 'Levin', photoUrl: 'p1', clothingDescription: 'pirate coat, tricorne hat' }];
  const castPhotos = [
    { name: 'levin', photoUrl: 'c1', clothingDescription: 'blue jumper, grey trousers' },
    { name: 'Julian', photoUrl: 'c2', clothingDescription: 'green shirt' },
  ];

  it('the page outfit beats the story-level outfit for the same character', () => {
    const refs = composeEvalReferencePhotos(pagePhotos, castPhotos);
    const levin = refs.filter((r: any) => String(r.name).toLowerCase() === 'levin');
    expect(levin).toHaveLength(1);
    expect(levin[0].clothingDescription).toContain('pirate coat');
  });

  it('a cast member absent from the page is appended', () => {
    const refs = composeEvalReferencePhotos(pagePhotos, castPhotos);
    expect(refs.map((r: any) => r.name)).toContain('Julian');
  });

  it('an empty whole-cast list never empties a non-empty page list', () => {
    expect(composeEvalReferencePhotos(pagePhotos, [])).toHaveLength(1);
    expect(composeEvalReferencePhotos(pagePhotos, null)).toHaveLength(1);
  });

  it('an empty page list falls back to the whole cast', () => {
    expect(composeEvalReferencePhotos([], castPhotos)).toHaveLength(2);
  });
});
