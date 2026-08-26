import { describe, it, expect } from 'vitest';

// The bug this file locks down: the trial empty-scene path gated its landmark
// photo on `photoFetchStatus === 'success'`. Variant-backed Swiss landmarks are
// EXCLUDED from prefetchLandmarkPhotos (its call site filters
// `!l.photoVariants?.length`), so they keep 'pending_lazy' forever and that gate
// could never pass — no background plate was built, and the page then edited
// the RAW landmark photograph instead of rendering in the story's art style.
// Measured on prod job_1787647410717_5dvfqu8jg p1 (photographic page in a
// watercolour book) and staging job_1787696601288_bfgznq960.
//
// decideLandmarkPhotoSource is the policy half, deliberately free of I/O so the
// rule is testable without the DB-backed variant loader.

// @ts-expect-error - JS module without types
import { decideLandmarkPhotoSource } from '../../server/lib/storyHelpers.js';

const variantLandmark = (over: Record<string, any> = {}) => ({
  id: 'LOC001',
  name: 'A Station',
  isRealLandmark: true,
  isSwissPreIndexed: true,
  // Production shape: photos ARE available, but the status flag the old gate
  // checked is never set for this kind of landmark.
  photoFetchStatus: 'pending_lazy',
  photoVariants: [
    { url: 'https://x/1.jpg', kind: 'exterior', variantNumber: 1 },
    { url: 'https://x/2.jpg', kind: 'interior', variantNumber: 2 },
  ],
  referencePhotoUrl: 'https://x/1.jpg',
  ...over,
});

describe('decideLandmarkPhotoSource — variant landmarks', () => {
  it('REGRESSION: decides on variants even though photoFetchStatus is pending_lazy', () => {
    const d = decideLandmarkPhotoSource(variantLandmark(), { sceneView: null });
    expect(d).toBeTruthy();
    expect(d.mode).toBe('variant');
    expect(d.variantNumber).toBe(1);
  });

  it('still decides on variants when the status is explicitly not success', () => {
    const d = decideLandmarkPhotoSource(variantLandmark({ photoFetchStatus: 'failed' }), {});
    expect(d?.mode).toBe('variant');
  });

  it('honours an explicit variant from the brief', () => {
    const d = decideLandmarkPhotoSource(variantLandmark(), { explicitVariant: 2 });
    expect(d).toEqual({ mode: 'variant', variantNumber: 2 });
  });

  it('attaches nothing when the brief writes .0', () => {
    expect(decideLandmarkPhotoSource(variantLandmark(), { explicitVariant: 0 })).toBeNull();
  });

  it('picks an interior variant for an interior view', () => {
    const d = decideLandmarkPhotoSource(variantLandmark(), { sceneView: 'interior' });
    expect(d).toEqual({ mode: 'variant', variantNumber: 2 });
  });

  it('attaches nothing for a view the index has no photo for', () => {
    // 'underwater' means "no photo matches this vantage" — falling back to an
    // exterior shot is how a surface photo once anchored underwater scenes.
    expect(decideLandmarkPhotoSource(variantLandmark(), { sceneView: 'underwater' })).toBeNull();
  });

  it('attaches nothing when every variant is marked bad', () => {
    const loc = variantLandmark({
      photoVariants: [{ url: 'https://x/1.jpg', kind: 'bad', variantNumber: 1 }],
    });
    expect(decideLandmarkPhotoSource(loc, {})).toBeNull();
  });
});

describe('decideLandmarkPhotoSource — legacy single-photo landmarks', () => {
  const legacy = (status: string) => ({
    id: 'LOC009',
    name: 'A Castle',
    isRealLandmark: true,
    photoVariants: [],
    referencePhotoUrl: 'https://x/castle.jpg',
    photoFetchStatus: status,
  });

  it('uses the reference photo once the prefetch has stamped success', () => {
    expect(decideLandmarkPhotoSource(legacy('success'), {})).toEqual({ mode: 'legacy' });
  });

  it('attaches nothing while the prefetch has not completed', () => {
    // For THIS shape the status check is correct — the prefetch does stamp it.
    expect(decideLandmarkPhotoSource(legacy('pending'), {})).toBeNull();
  });

  it('returns null for a location with no photo at all', () => {
    expect(decideLandmarkPhotoSource({
      id: 'LOC010', name: 'Nowhere', isRealLandmark: true, photoVariants: [],
    }, {})).toBeNull();
  });

  it('returns null rather than throwing on a missing location', () => {
    expect(decideLandmarkPhotoSource(null, {})).toBeNull();
    expect(decideLandmarkPhotoSource(undefined)).toBeNull();
  });
});
