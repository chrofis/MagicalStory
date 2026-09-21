/**
 * The IRON RULE, pinned: no image bytes may reach a JSONB column. R2 is the
 * only byte store, and `extractInlineImagesToR2()` is the offload path.
 *
 * This rule has been restated more often than it has been checked, and it has
 * been re-broken every time a NEW field started carrying bytes — a field the
 * walker in extractInlineImagesToR2 did not know about slipped past and was
 * only discovered by a sweep of the live corpus months later
 * (`scripts/admin/check-inline-images.js` is that sweep, now on the daily
 * housekeeping routine).
 *
 * So this test does not enumerate what the walker handles. It builds a story
 * blob that puts bytes in every field that has ever leaked or plausibly could
 * — page and cover imageData, retry history, per-version repair intermediates,
 * the per-page cast, the top-level roster's avatars and photos — runs the save
 * path, and then asks the SWEEP whether anything is left. A new leak therefore
 * fails here, at the commit that adds it, instead of on a database months on.
 *
 * Both byte shapes are covered: `data:` URIs (what the client and Gemini hand
 * us) and raw headered base64 (`/9j/…`, what Grok returns).
 *
 * r2 is stubbed; nothing touches the network or a database.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require_ = createRequire(import.meta.url);
const r2 = require_('../../server/lib/r2');
const { extractInlineImagesToR2 } = require_('../../server/services/database');
const { findInlineImages, collapsePath, looksLikeHeaderlessBytes } =
  require_('../../server/lib/dbHousekeeping');

const realIsConfigured = r2.isConfigured;
const realUploadImage = r2.uploadImage;

const uri = (seed = 'A') => `data:image/jpeg;base64,${seed.repeat(4000)}`;
const raw = (seed = 'B') => `/9j/${seed.repeat(4000)}`;

beforeEach(() => {
  r2.isConfigured = vi.fn(() => true);
  r2.uploadImage = vi.fn(async (_input: string, key: string) => `https://r2.example/${key}`);
});
afterEach(() => {
  r2.isConfigured = realIsConfigured;
  r2.uploadImage = realUploadImage;
});

/** A story blob with bytes in every at-risk slot. */
const storyWithBytesEverywhere = () => ({
  sceneImages: [{
    pageNumber: 1,
    imageData: uri('a'),
    bboxOverlayImage: raw('b'),
    visualBibleGrid: uri('c'),
    grokRefImages: [raw('d')],
    emptySceneGrokRefImages: [uri('e')],
    retryHistory: [{ imageData: raw('f') }, { imageData: uri('g') }],
    imageVersions: [{
      imageData: uri('h'),
      bboxOverlayImage: raw('i'),
      grokRefImages: [uri('j')],
      inpaintReferenceImages: [raw('k')],
      charRepairGrokRaw: uri('l'),
      charRepairWhiteout: raw('m'),
      charRepairBlendMask: uri('n'),
    }],
    sceneCharacters: [{
      name: 'Main',
      avatars: { standard: uri('o'), costumed: { default: raw('p') } },
      photos: { face: uri('q'), body: raw('r') },
    }],
    referencePhotos: [{ name: 'Main', photoData: raw('s') }],
    landmarkPhotos: [{ photoData: uri('t') }],
  }],
  coverImages: {
    frontCover: { imageData: uri('u'), imageVersions: [{ imageData: raw('v') }] },
    initialPage: { imageData: raw('w') },
    backCover: { imageData: uri('x') },
  },
  characters: [{
    name: 'Main',
    previewAvatar: raw('y'),
    photos: { face: uri('z'), body: raw('A'), bodyNoBg: uri('B') },
    avatars: {
      standard: uri('C'),
      styledAvatars: { watercolor: { standard: raw('D'), costumed: { default: uri('E') } } },
      storyHistory: [{ sheetUrl: uri('F') }],
    },
  }],
});

describe('the save path leaves no image bytes in the blob', () => {
  it('the fixture really does start full of bytes (the test can fail)', () => {
    const found = findInlineImages(storyWithBytesEverywhere());
    // One per seeded slot — if this drops, the fixture stopped testing anything.
    expect(found.length).toBeGreaterThanOrEqual(30);
  });

  it('offloads every one of them and leaves URLs behind', async () => {
    const data: any = storyWithBytesEverywhere();
    await extractInlineImagesToR2('story_pin', data);

    const left = findInlineImages(data);
    const paths = [...new Set(left.map((f: any) => collapsePath(f.keyPath)))];
    // The message names the offending paths, so a failure is actionable without
    // a debugger: "this field started carrying bytes and nothing offloads it".
    expect(paths, `image bytes survived the save path at: ${paths.join(', ')}`).toEqual([]);

    // And the slots hold R2 URLs, not nothing: an offload that deletes the
    // artefact is not an offload (memory: diagnostics are a research asset).
    expect(data.sceneImages[0].imageVersions[0].charRepairGrokRaw).toMatch(/^https:\/\/r2\.example\//);
    expect(data.coverImages.frontCover.imageData).toMatch(/^https:\/\/r2\.example\//);
    expect(data.characters[0].avatars.storyHistory[0].sheetUrl).toMatch(/^https:\/\/r2\.example\//);
    expect(data.sceneImages[0].sceneCharacters[0].photos.face).toMatch(/^https:\/\/r2\.example\//);
  });

  it('the sweep that pins this also catches headerless base64', () => {
    // The walker's own test is prefix-based; the corpus sweep must not be, or a
    // provider that stops sending a header walks straight past the guard.
    expect(looksLikeHeaderlessBytes('Zm9v'.repeat(400))).toBe(true);
    expect(looksLikeHeaderlessBytes('a short token')).toBe(false);
    expect(looksLikeHeaderlessBytes('some ordinary prose '.repeat(200))).toBe(false);
  });
});
