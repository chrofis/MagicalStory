import { describe, it, expect } from 'vitest';

// The gap this file locks down: the index classifies every landmark photo
// (photo_type: exterior | distant | close | interior | view-from),
// pickVariantForView SELECTS on that classification — and then every consumer
// dropped it. resolveLandmarkPhotoForLocation returned {name, photoData,
// attribution, source, variantNumber} and buildLandmarkFidelityBlock therefore
// had only a name to work with, so a village-panorama reference was still
// handed to the image model as "this exact real-world landmark… preserve the
// silhouette… never a tiny speck against a wide cityscape" — an instruction a
// panorama has no coherent answer for.
//
// Two contracts here: the KIND reaches the resolver's return value, and the
// builder takes a different branch for a wide-view reference. The wording of
// either branch is deliberately not asserted.

import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

// storyHelpers destructures loadLandmarkPhotoVariant from landmarkPhotos at
// load time (CJS), so the stub has to be in place before storyHelpers loads.
const landmarkPhotos: any = nodeRequire('../../server/lib/landmarkPhotos.js');
let servedSlot = 1;
landmarkPhotos.loadLandmarkPhotoVariant = async () => ({
  photoData: 'data:image/jpeg;base64,AAA',
  attribution: 'Someone, CC BY-SA',
  variantNumber: servedSlot,
});

const { resolveLandmarkPhotoForLocation } = nodeRequire('../../server/lib/storyHelpers.js');
const { buildLandmarkFidelityBlock } = nodeRequire('../../server/lib/promptBuilders.js');

const location = {
  id: 'LOC001',
  name: 'A Village',
  isRealLandmark: true,
  photoVariants: [
    { variantNumber: 1, kind: 'exterior', url: 'https://x/1.jpg', description: 'the parish church from the square' },
    { variantNumber: 2, kind: 'distant', url: 'https://x/2.jpg', description: 'the village seen from the hillside' },
  ],
};

describe('resolveLandmarkPhotoForLocation — photo kind reaches the caller', () => {
  it('carries the kind of the slot that was actually served', async () => {
    servedSlot = 2;
    const photo = await resolveLandmarkPhotoForLocation({}, location, { explicitVariant: 2 });
    expect(photo.variantNumber).toBe(2);
    expect(photo.photoType).toBe('distant');
    // The photo's own description is NOT carried: nothing downstream read it.
    expect(photo).not.toHaveProperty('photoDescription');
  });

  it('reads the kind off the SERVED slot, not the requested one', async () => {
    // The loader is allowed to fall back to another slot; the prompt must
    // describe the photo that was attached, not the one that was asked for.
    servedSlot = 1;
    const photo = await resolveLandmarkPhotoForLocation({}, location, { explicitVariant: 2 });
    expect(photo.variantNumber).toBe(1);
    expect(photo.photoType).toBe('exterior');
  });
});

describe('buildLandmarkFidelityBlock — branches on the photo kind', () => {
  const single = buildLandmarkFidelityBlock({ name: 'A Village', photoType: 'exterior' });

  it('a close/exterior reference is unchanged from the name-only call', () => {
    expect(single).toBe(buildLandmarkFidelityBlock('A Village'));
    expect(buildLandmarkFidelityBlock({ name: 'A Village' })).toBe(single);
    expect(buildLandmarkFidelityBlock({ name: 'A Village', photoType: 'close' })).toBe(single);
    expect(buildLandmarkFidelityBlock({ name: 'A Village', photoType: 'interior' })).toBe(single);
  });

  it('a distant or view-from reference takes the wide-view branch', () => {
    for (const kind of ['distant', 'view-from']) {
      const wide = buildLandmarkFidelityBlock({ name: 'A Village', photoType: kind });
      expect(wide).not.toBe(single);
      expect(wide).toContain('A Village');
    }
  });

  it('still returns nothing without a name', () => {
    expect(buildLandmarkFidelityBlock({ photoType: 'distant' })).toBe('');
    expect(buildLandmarkFidelityBlock(null)).toBe('');
  });
});
