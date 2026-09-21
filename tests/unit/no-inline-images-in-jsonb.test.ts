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
const { extractInlineImagesToR2, offloadJsonbImages } = require_('../../server/services/database');
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

/**
 * The rule is about COLUMNS, not about stories. Measured 2026-09-21, four
 * columns that no offload path covered held 133 MB of image bytes across the
 * two databases — `characters.metadata`, `story_jobs.input_data`,
 * `users.trial_data` and `testlab_experiments.results`/`.params` — every one of
 * them built from values that HAD been offloaded elsewhere and then copied the
 * inline fallbacks forward. These pin the payload SHAPES those write paths
 * persist, so a new field on any of them fails here.
 */
describe('the other JSONB write paths leave no image bytes either', () => {
  const cases: Array<[string, () => any]> = [
    ['story_jobs.input_data (wizard state, written verbatim)', () => ({
      pages: 12,
      characters: [{
        name: 'Main',
        previewAvatar: raw('a'),
        photos: { face: uri('b'), body: raw('c'), bodyNoBg: uri('d') },
        // Named *Url, holding a data URI — the shape that has leaked twice.
        photoUrl: uri('e'), bodyPhotoUrl: raw('f'), bodyNoBgUrl: uri('g'),
        preGeneratedAvatarSlides: [raw('h'), uri('i')],
        preGeneratedStyledAvatars: { Main: { standard: uri('j'), costumed: { default: raw('k') } } },
        avatars: {
          standard: uri('l'),
          styledAvatars: { watercolor: { standard: raw('m'), costumed: { default: uri('n') } } },
          storyHistory: [{ sheetUrl: raw('o') }],
        },
      }],
    })],
    ["users.trial_data (a real person's only uploaded photo)", () => ({
      photos: { face: uri('p'), body: raw('q'), bodyNoBg: uri('r') },
      _previewAvatar: raw('s'),
      _preGeneratedStyledAvatars: { Main: { standard: uri('t'), costumed: { default: raw('u') } } },
    })],
    ['testlab_experiments.results (a diagnostics entry, offloaded not stripped)', () => ({
      ok: true,
      passes: {
        pass1: {
          imageData: uri('v'),
          attempts: [{ imageData: raw('w'), sentToGrok: { referenceImages: [{ dataUri: uri('x') }] } }],
          sentToGrok: { referenceImages: [{ dataUri: raw('y') }] },
        },
        pass2: { imageData: raw('z') },
      },
    })],
    ['testlab_experiments.params (client-supplied, reuseModelOutput takes a data URI)', () => ({
      autoEval: true,
      reuseModelOutput: uri('A'),
    })],
  ];

  it.each(cases)('%s', async (_name, build) => {
    const data: any = build();
    expect(findInlineImages(data).length).toBeGreaterThan(0);   // the fixture can fail

    await offloadJsonbImages('pinned/prefix', 'pinned', data);

    const left = findInlineImages(data);
    const paths = [...new Set(left.map((f: any) => collapsePath(f.keyPath)))];
    expect(paths, `image bytes survived at: ${paths.join(', ')}`).toEqual([]);
  });

  it('keeps the artefact — every offloaded slot holds an R2 URL, never null', async () => {
    const data: any = {
      photos: { face: uri('B') },
      passes: { pass1: { sentToGrok: { referenceImages: [{ dataUri: raw('C') }] } } },
    };
    await offloadJsonbImages('pinned/prefix', 'pinned', data);
    expect(data.photos.face).toMatch(/^https:\/\/r2\.example\//);
    expect(data.passes.pass1.sentToGrok.referenceImages[0].dataUri).toMatch(/^https:\/\/r2\.example\//);
  });
});

/**
 * A payload guard only helps where it is CALLED. These four columns each have
 * several writers in different files, and the 2026-09-21 sweep found bytes in
 * all of them precisely because a writer was added without one. So: any file
 * that writes one of these columns must also import an offload helper. A new
 * writer in a new file fails here, naming itself.
 */
describe('every file that writes an at-risk JSONB column imports an offload helper', () => {
  const fs = require_('fs');
  const path = require_('path');
  const ROOT = path.join(__dirname, '..', '..', 'server');

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };

  // A write that only sets a status/flag or NULLs the column carries no bytes.
  const WRITES = [
    /INSERT INTO story_jobs\s*\([^)]*input_data/i,
    /UPDATE\s+story_jobs\s+SET[^;]*input_data\s*=/i,
    /UPDATE\s+users\s+SET\s+trial_data\s*=\s*\$/i,
    /UPDATE\s+testlab_experiments\s+SET\s+results\s*=\s*results\s*\|\|/i,
    /INSERT INTO testlab_experiments\s*\([^)]*params/i,
  ];
  const IMPORTS_HELPER = /offloadJsonbImages|offloadCharacterImages|extractInlineImagesToR2|extractJsonbInlineImagesToR2/;

  it('no unguarded writer', () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (!WRITES.some(re => re.test(src))) continue;
      if (!IMPORTS_HELPER.test(src)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders, `these files write an at-risk JSONB column with no offload helper in sight: ${offenders.join(', ')}`).toEqual([]);
  });
});
