import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// editWithGrok's output aspect-drift correction: which callers get it.
//
// Grok's /images/edits endpoint does not honour `aspect_ratio` reliably — it
// frequently returns its preferred near-square frame even for a portrait
// request. editWithGrok has a centre-crop corrector for that, but for ~4.5
// months it was DEAD CODE: the `skipOutputPadding` flag defaulted to `true`
// and no production caller passed `false`.
//
// The default was set to `true` on 2026-04-13 (683cb9bf1) when the corrector
// PADDED with white bars; two days later (e050e62c9) the corrector was changed
// to CROP, which removed the reason for the default — but the flag kept both
// its padding-era name and its padding-era default. Evidence of the cost:
// capstone job_1788380714660_4p9mr11xszu pages 2 and 6 shipped empty-scene
// plates that were ~42-44% white pillarbox, failing plate QC twice.
//
// Owner ruling 2026-09-03: "Crop + keep current policy" — the corrector runs
// by default (flag renamed `skipOutputCrop`, default false); callers that
// composite / slice / re-register the output opt out explicitly.

const SQUARE_PNG_W = 1024;

let sharp: any;
let editWithGrok: any;

async function jpegOf(width: number, height: number): Promise<string> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
  }).jpeg({ quality: 80 }).toBuffer();
  return buf.toString('base64');
}

async function dimsOf(dataUri: string) {
  const b64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
  const meta = await sharp(Buffer.from(b64, 'base64')).metadata();
  return { width: meta.width as number, height: meta.height as number };
}

/** Mocks the xAI edits endpoint so it answers with an image of the given size. */
function mockGrokReturning(b64: string) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ b64_json: b64 }] }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(async () => {
  // Read at module load — must be set before the import.
  process.env.XAI_API_KEY = 'test-key-not-a-real-credential';
  sharp = (await import('sharp')).default;
  // @ts-expect-error - JS module without types
  ({ editWithGrok } = await import('../../server/lib/grok.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('editWithGrok output aspect-drift correction', () => {
  it('corrects a drifted output to the requested aspect BY DEFAULT', async () => {
    // The production page/plate/cover case: 3:4 requested, square returned.
    mockGrokReturning(await jpegOf(SQUARE_PNG_W, SQUARE_PNG_W));
    const ref = `data:image/jpeg;base64,${await jpegOf(768, 1024)}`;

    const r = await editWithGrok('a test prompt', [ref], { aspectRatio: '3:4' });

    const { width, height } = await dimsOf(r.imageData);
    expect(width / height).toBeCloseTo(0.75, 2);
    // Cover-crop never upscales: the square is wider than 3:4, so it keeps the
    // full height and trims the excess width.
    expect(height).toBe(SQUARE_PNG_W);
    expect(width).toBe(Math.round(SQUARE_PNG_W * 0.75));
  });

  it('leaves the drifted output alone when the caller opts out', async () => {
    // The repair / composite / panel-grid case: the output is registered
    // against another image, so a zoom+shift is worse than a wrong aspect.
    mockGrokReturning(await jpegOf(SQUARE_PNG_W, SQUARE_PNG_W));
    const ref = `data:image/jpeg;base64,${await jpegOf(768, 1024)}`;

    const r = await editWithGrok('a test prompt', [ref], {
      aspectRatio: '3:4',
      skipOutputCrop: true,
    });

    const { width, height } = await dimsOf(r.imageData);
    expect(width).toBe(SQUARE_PNG_W);
    expect(height).toBe(SQUARE_PNG_W);
  });

  it('does not crop for pixel-rounding differences (1% relative threshold)', async () => {
    // 1024x1025 against a 1:1 request is 0.1% drift. Re-encoding here would
    // burn a JPEG generation on every call for no visible gain.
    mockGrokReturning(await jpegOf(1024, 1025));
    const ref = `data:image/jpeg;base64,${await jpegOf(1024, 1024)}`;

    const r = await editWithGrok('a test prompt', [ref], { aspectRatio: '1:1' });

    const { width, height } = await dimsOf(r.imageData);
    expect(width).toBe(1024);
    expect(height).toBe(1025);
  });

  it('crops a too-tall output by trimming height, keeping full width', async () => {
    // 9:16 requested, 1:1 returned — the avatar-shaped drift. (Avatars opt out;
    // this asserts the geometry of the correction itself.)
    mockGrokReturning(await jpegOf(1024, 1024));
    const ref = `data:image/jpeg;base64,${await jpegOf(576, 1024)}`;

    const r = await editWithGrok('a test prompt', [ref], { aspectRatio: '9:16' });

    const { width, height } = await dimsOf(r.imageData);
    // outRatio (1.0) > targetRatio (0.5625) → keep height, crop width.
    expect(height).toBe(1024);
    expect(width).toBe(Math.round(1024 * (9 / 16)));
  });
});

describe('editWithGrok call-site opt-outs', () => {
  // The correction is safe only where Grok's output is the final full-frame
  // artwork. Every caller that composites, slices or re-registers the output
  // must pass skipOutputCrop:true — asserted against the source so a future
  // edit that drops one is caught here rather than in a smeared repair.
  // file → how many of its editWithGrok calls must carry the opt-out.
  // 'all' = every call in the file; a number = that many (the rest of the
  // file's calls produce final full-frame artwork and take the crop).
  const OPT_OUT_SITES: Array<[string, 'all' | number, string]> = [
    // pixel-exact edit round-trip (mirror-pad → edit → unpad)
    ['server/lib/imageCompositing.js', 'all', 'grokEditSceneExact registration'],
    // feather-blends each repaired region back at original scene coordinates
    ['server/lib/imageInpainting.js', 'all', 'inpaint feather at original coords'],
    // SAM re-detect + union blend in the treated crop's coordinate space
    ['server/lib/faceRepair.js', 'all', 'SAM re-detect + union blend'],
    // title strip keyed at (offX, offY) on the padded canvas
    ['server/lib/coverTitlePaint.js', 'all', 'title strip keyed by position'],
    // rendered figure composited at the phantom bbox
    ['server/lib/phantomPoseRender.js', 'all', 'figure pasted at phantom bbox'],
    // A 2×4 sheet is a panel grid (a crop eats cells); an avatar is a
    // whole-figure asset (a crop slices arms/head off). Both already pad
    // inputs for the same reason — the output must match.
    ['server/lib/character2x4Sheet.js', 'all', 'panel grid'],
    ['server/routes/avatars.js', 'all', 'whole-figure asset'],
    // Only the three PLATE producers (depopulate / anchor / front-fill) are
    // registration-sensitive; the three blend passes return the final scene
    // and take the crop.
    ['server/lib/sceneComposite.js', 3, 'plate producers only'],
  ];

  it.each(OPT_OUT_SITES)('%s opts out of the output crop (%s: %s)', async (file, expected) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../..', String(file)), 'utf8');
    // `await editWithGrok(` — not a bare mention, which also matches prose in
    // the module doc comments.
    const calls = (src.match(/await (?:require\('\.\/grok'\)\.)?editWithGrok\(/g) || []).length;
    const optOuts = (src.match(/skipOutputCrop: true/g) || []).length;
    expect(calls, `${file} has no editWithGrok call — did it move?`).toBeGreaterThan(0);
    expect(optOuts, `${file}: ${calls} editWithGrok calls`).toBe(expected === 'all' ? calls : expected);
  });

  it('the page/plate/cover dispatcher does NOT opt out — it is the fix target', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // images.js `_dispatchImageGeneration` + `editImageWithPrompt` are where
    // page images, empty-scene plates and covers are rendered. These are the
    // calls the capstone p2/p6 white-pillarbox plates came through.
    const src = fs.readFileSync(path.resolve(__dirname, '../../server/lib/images.js'), 'utf8');
    expect(src).not.toMatch(/skipOutputCrop/);
  });

  it('the old padding-era flag name is gone from all call sites', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // The stale name is what let the padding-era default survive the switch to
    // cropping. If it reappears it will be silently ignored → an unwanted crop
    // in a registration-sensitive path.
    for (const file of [
      'server/lib/grok.js', 'server/lib/imageCompositing.js', 'server/lib/imageInpainting.js',
      'server/lib/faceRepair.js', 'server/lib/coverTitlePaint.js', 'server/lib/phantomPoseRender.js',
      'server/lib/character2x4Sheet.js', 'server/lib/sceneComposite.js', 'server/lib/testlab.js',
      'server/lib/images.js', 'server/routes/avatars.js',
    ]) {
      const src = fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8');
      // grok.js keeps ONE mention: the comment recording the rename.
      const hits = (src.match(/skipOutputPadding/g) || []).length;
      expect(hits, `${file} still references skipOutputPadding`).toBe(file.endsWith('grok.js') ? 1 : 0);
    }
  });
});
