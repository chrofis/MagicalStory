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
import { decideLandmarkPhotoSource, trialPlateLandmarkPromisesByPage } from '../../server/lib/storyHelpers.js';

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

// The SECOND way the same plate lost its landmark, measured on staging
// job_1789337873076_qf2at21ui p6 (Kirche Rohrdorf, 3 indexed variants): the
// trial plate block called the resolver in the SAME TICK that
// loadLandmarkPhotoDescriptions was started. decideLandmarkPhotoSource runs
// before the resolver's first await, so it judged a location whose
// photoVariants had not been written yet → null → a plate rendered with no
// landmark photo, and therefore (since both derive from the same variable) no
// REFERENCE line and no fidelity block. The page itself awaits that promise and
// so DID get the photo — which is why only the plate came out vague.
//
// Contract pinned here, not prompt wording: when a vantage's location has a
// resolvable landmark, the promise the plate awaits yields that photo.
describe('trialPlateLandmarkPromisesByPage — the plate gets the landmark', () => {
  // Populated only when descriptionsPromise resolves — exactly how
  // loadLandmarkPhotoDescriptions mutates the streaming VB in production.
  const lateLoadingBible = () => {
    const loc: any = {
      id: 'LOC002', name: 'A Church', isRealLandmark: true, pages: [6],
      isSwissPreIndexed: true, photoFetchStatus: 'pending_lazy',
    };
    const vb: any = { locations: [loc] };
    const descriptionsPromise = Promise.resolve().then(() => {
      // Legacy shape on purpose: resolves with no DB/network I/O.
      loc.referencePhotoData = 'data:image/jpeg;base64,AAAA';
      loc.referencePhotoUrl = 'https://x/church.jpg';
      loc.photoFetchStatus = 'success';
    });
    return { vb, descriptionsPromise };
  };

  it('REGRESSION: waits for the photo descriptions before deciding', async () => {
    const { vb, descriptionsPromise } = lateLoadingBible();
    const byPage = trialPlateLandmarkPromisesByPage(vb, { descriptionsPromise });
    const photo = await byPage[6];
    expect(photo).toBeTruthy();
    expect(photo.name).toBe('A Church');
    expect(photo.photoData).toBeTruthy();
  });

  it('every page of the location awaits the same resolution', async () => {
    const { vb, descriptionsPromise } = lateLoadingBible();
    vb.locations[0].pages = [4, 5, 6];
    const byPage = trialPlateLandmarkPromisesByPage(vb, { descriptionsPromise });
    expect(Object.keys(byPage).sort()).toEqual(['4', '5', '6']);
    expect(byPage[4]).toBe(byPage[6]);
    expect((await byPage[4]).photoData).toBeTruthy();
  });

  it('registers synchronously — the stream callback is never left awaiting', () => {
    const { vb, descriptionsPromise } = lateLoadingBible();
    const byPage = trialPlateLandmarkPromisesByPage(vb, { descriptionsPromise });
    expect(typeof byPage[6].then).toBe('function');
  });

  it('a non-landmark location and a landmark staged on no page get nothing', () => {
    const byPage = trialPlateLandmarkPromisesByPage({
      locations: [
        { id: 'LOC001', name: 'A meadow', isRealLandmark: false, pages: [1, 2] },
        { id: 'LOC003', name: 'Unstaged', isRealLandmark: true, pages: [] },
      ],
    }, {});
    expect(Object.keys(byPage)).toEqual([]);
  });

  it('yields null instead of rejecting when the descriptions load fails', async () => {
    const vb: any = {
      locations: [{ id: 'LOC002', name: 'A Church', isRealLandmark: true, pages: [6] }],
    };
    const byPage = trialPlateLandmarkPromisesByPage(vb, {
      descriptionsPromise: Promise.reject(new Error('index query failed')),
    });
    await expect(byPage[6]).resolves.toBeNull();
  });
});
