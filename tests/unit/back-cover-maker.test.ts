/**
 * PRINTED BOOKS HAVE A BACK COVER (bug book-blank-cover-without-back-cover; docs/decisions.md 2026-11-12). Pins:
 *  - pdf.js: a print PDF without a back cover throws; a download PDF opens WITHOUT one but still draws the front cover
 *    (it drew a blank cover spread); an unreadable cover picture throws instead of warning (single, combined, story 2+)
 *  - gelato.buildBookPrintPdf: the maker runs once for a story without a back cover, for story 1 when no story of the book
 *    has one, never when one has, and BEFORE the square covers
 *  - backCoverMaker: the one rule (backCoverTarget), the outfit read from the avatar, a weak first picture gets one more
 *    attempt and the better is kept, a failed stamp throws, a deleted character throws, the whole make runs on stand-ins
 *  - the print route and the order pages: generate-book-pdf goes through buildBookPrintPdf; the order button waits for the
 *    back cover on both order pages
 * No paid call, no network: the Art Director, the render, the vision read and the database are stand-ins.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const cjs = createRequire(import.meta.url);
const sharp = cjs('sharp');
const pdfLib = cjs('../../server/lib/pdf.js');
const maker = cjs('../../server/lib/backCoverMaker.js');
const gelato = cjs('../../server/lib/gelato.js');
const { loadPromptTemplates } = cjs('../../server/services/prompts.js');
const read = (rel: string) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

afterEach(() => vi.restoreAllMocks());

async function jpeg(width: number, height: number, color: string) {
  const buf = await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
const imageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;

async function storyWith(covers: Record<string, string | undefined>) {
  const page = await jpeg(400, 400, '#7a9a60');
  const coverImages: Record<string, { imageData: string }> = {};
  for (const [k, v] of Object.entries(covers)) if (v) coverImages[k] = { imageData: v };
  return {
    title: 'T', languageLevel: 'standard', storyText: '--- Page 1 ---\nEin kurzer Satz.\n--- Page 2 ---\nNoch ein Satz.',
    sceneImages: [1, 2].map(n => ({ pageNumber: n, imageData: page })), coverImages,
  };
}

const COVER_DIMS = {
  coverPageWidth: 430, coverPageHeight: 216, spineWidth: 6,
  contentBack: { left: 3, top: 3, width: 210, height: 210 }, contentFront: { left: 219, top: 3, width: 210, height: 210 },
};

describe('pdf.js: a back cover is for the printed book, the front cover is for every PDF', () => {
  it('a print PDF without a back cover throws', async () => {
    const s = await storyWith({ frontCover: await jpeg(300, 300, '#3355aa') });
    await expect(pdfLib.generatePrintPdf(s, 'A4', { fillMethod: 'mirror', gelatoCoverDims: COVER_DIMS, requireBackCover: true }))
      .rejects.toThrow(/no back cover/);
  }, 60000);

  it('a download PDF without a back cover opens with the front cover drawn (it drew a blank cover spread)', async () => {
    const front = await jpeg(300, 300, '#3355aa');
    const withFront = await pdfLib.generatePrintPdf(await storyWith({ frontCover: front }), 'A4', { fillMethod: 'mirror', gelatoCoverDims: COVER_DIMS });
    const without = await pdfLib.generatePrintPdf(await storyWith({}), 'A4', { fillMethod: 'mirror', gelatoCoverDims: COVER_DIMS });
    expect(imageCount(withFront.pdfBuffer)).toBe(imageCount(without.pdfBuffer) + 1);
  }, 60000);

  it('an unreadable cover picture throws, in the single-story PDF', async () => {
    const s = await storyWith({ frontCover: 'not a picture at all', backCover: await jpeg(300, 300, '#aa5533') });
    await expect(pdfLib.generatePrintPdf(s, 'A4', { fillMethod: 'mirror', gelatoCoverDims: COVER_DIMS }))
      .rejects.toThrow(/front cover picture could not be read/);
  }, 60000);

  it('the combined book: an unreadable story 2 back cover throws, and a print book with no back cover anywhere throws', async () => {
    const a = await storyWith({ frontCover: await jpeg(300, 300, '#3355aa'), backCover: await jpeg(300, 300, '#aa5533') });
    const bBad = await storyWith({ frontCover: await jpeg(300, 300, '#33aa55'), backCover: 'not a picture at all' });
    await expect(pdfLib.generateCombinedBookPdf([{ id: 'a', data: a }, { id: 'b', data: bBad }], 'A4', { fillMethod: 'mirror', gelatoCoverDims: COVER_DIMS }))
      .rejects.toThrow(/story 2 back cover picture could not be read/);
    const n1 = await storyWith({ frontCover: await jpeg(300, 300, '#3355aa') });
    const n2 = await storyWith({ frontCover: await jpeg(300, 300, '#33aa55') });
    await expect(pdfLib.generateCombinedBookPdf([{ id: 'a', data: n1 }, { id: 'b', data: n2 }], 'A4', { fillMethod: 'mirror', gelatoCoverDims: COVER_DIMS, requireBackCover: true }))
      .rejects.toThrow(/no story in the book has a back cover/);
  }, 90000);
});

describe('backCoverTarget: the ONE rule', () => {
  const withBack = { id: 'a', data: { coverImages: { frontCover: {}, backCover: {} } } };
  const without = (id: string) => ({ id, data: { coverImages: { frontCover: {} } } });
  it('a single story without one is the target; with one, nobody', () => {
    expect(maker.backCoverTarget([without('a')])).toMatchObject({ id: 'a', index: 0 });
    expect(maker.backCoverTarget([withBack])).toBeNull();
  });
  it('a book of several: story 1 only when no story has a back cover', () => {
    expect(maker.backCoverTarget([without('a'), without('b')])).toMatchObject({ id: 'a' });
    expect(maker.backCoverTarget([without('a'), withBack])).toBeNull();
    expect(maker.backCoverTarget([])).toBeNull();
  });
});

describe('gelato.buildBookPrintPdf makes the missing back cover once, before the square covers', () => {
  const pageInfo = (format: string) => ({
    estimatedPageCount: 10, printedPages: 10, bookFormat: format, productUid: 'uid', product: { product_name: 'P' },
    layout: format === 'square' ? 'spread' : 'single', blankPages: 0, contentPages: 10,
  });
  function run(storiesData: Record<string, any>, format = 'A4') {
    process.env.GELATO_API_KEY = process.env.GELATO_API_KEY || 'test';
    const ids = Object.keys(storiesData);
    const order: string[] = [];
    const dbPool = { query: vi.fn(async () => ({ rows: ids.map(id => ({ id, data: storiesData[id] })) })) };
    const deps = {
      rehydrateStoryImages: async (_id: string, d: any) => d,
      computeBookPageInfo: async () => pageInfo(format),
      getCoverDimensions: async () => COVER_DIMS,
      makeMissingBackCover: vi.fn(async (id: string) => { order.push(`maker:${id}`); return { made: true }; }),
      attachSquareCovers: vi.fn(async (id: string) => { order.push(`square:${id}`); }),
      generatePrintPdf: vi.fn(async (_d: any, _f: string, o: any) => { order.push('pdf'); return { pdfBuffer: Buffer.from('x'), pageCount: 10, o }; }),
      generateCombinedBookPdf: vi.fn(async (_s: any, _f: string, o: any) => { order.push('pdf'); return { pdfBuffer: Buffer.from('x'), pageCount: 10, o }; }),
    };
    const done = gelato.buildBookPrintPdf(dbPool, ids, 'softcover', undefined, { fillMethod: 'mirror', deps });
    return { done, deps, order };
  }
  const bare = () => ({ coverImages: { frontCover: { imageData: 'x' } } });
  const full = () => ({ coverImages: { frontCover: { imageData: 'x' }, backCover: { imageData: 'y' } } });

  it('a single story without a back cover: the maker runs once, before the square covers, and the PDF requires a back cover', async () => {
    const { done, deps, order } = run({ s1: bare() }, 'square');
    await done;
    expect(deps.makeMissingBackCover).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['maker:s1', 'square:s1', 'pdf']);
    expect(deps.generatePrintPdf.mock.calls[0][2].requireBackCover).toBe(true);
  });
  it('a book where no story has one: story 1 only', async () => {
    const { done, deps } = run({ s1: bare(), s2: bare() });
    await done;
    expect(deps.makeMissingBackCover).toHaveBeenCalledTimes(1);
    expect(deps.makeMissingBackCover.mock.calls[0][0]).toBe('s1');
    expect(deps.generateCombinedBookPdf.mock.calls[0][2].requireBackCover).toBe(true);
  });
  it('a story with a back cover: the maker is not called', async () => {
    const { done, deps } = run({ s1: full() });
    await done;
    expect(deps.makeMissingBackCover).not.toHaveBeenCalled();
  });
});

describe('backCoverMaker', () => {
  beforeAll(() => { loadPromptTemplates(); });

  it('renderBetterOfTwo: a good first picture is kept with one render; a weak one gets one more and the better wins', async () => {
    const good = vi.fn(async () => ({ score: 85 }));
    expect((await maker.renderBetterOfTwo(good)).attempts).toBe(1);
    expect(good).toHaveBeenCalledTimes(1);

    const seq = [{ score: 40, id: 'first' }, { score: 72, id: 'second' }];
    const weakThenBetter = vi.fn(async () => seq.shift());
    const r = await maker.renderBetterOfTwo(weakThenBetter);
    expect(weakThenBetter).toHaveBeenCalledTimes(2);
    expect(r.result.id).toBe('second');

    const seq2 = [{ score: 55, id: 'first' }, { score: 30, id: 'second' }];
    const r2 = await maker.renderBetterOfTwo(async () => seq2.shift());
    expect(r2.result.id).toBe('first');                       // a worse second attempt does not replace it; nothing throws
    const unscored = await maker.renderBetterOfTwo(async () => ({ score: null }));
    expect(unscored.attempts).toBe(2);                         // not scored counts as weak, and still returns a picture
  });

  it('fillStandardOutfits reads the outfit from the avatar into the wardrobe, only where it is missing', async () => {
    const avatar = await jpeg(64, 64, '#cc8844');
    const story: any = {
      artStyle: 'watercolor',
      characters: [
        { name: 'Liana', avatars: { styledAvatars: { watercolor: { standard: avatar } } } },
        { name: 'Ben', avatars: { styledAvatars: { watercolor: { standard: avatar } } } },
      ],
      clothingRequirements: {
        Liana: { costumed: { used: false }, standard: { used: true, signature: 'none' } },
        Ben: { standard: { used: true, description: 'blue jeans and a red jumper' } },
      },
    };
    const readOutfit = vi.fn(async () => ({ outfit: 'a pink tutu, white tights, ballet shoes' }));
    const filled = await maker.fillStandardOutfits(story, ['Liana', 'Ben'], { readOutfit });
    expect(filled).toEqual(['Liana']);
    expect(readOutfit).toHaveBeenCalledTimes(1);
    expect(story.clothingRequirements.Liana.standard).toMatchObject({ used: true, signature: 'none', description: 'a pink tutu, white tights, ballet shoes' });
    expect(story.clothingRequirements.Ben.standard.description).toBe('blue jeans and a red jumper');
  });

  it('a character with no avatar and no character of today throws a clear error', async () => {
    const story: any = { artStyle: 'watercolor', characters: [{ name: 'Liana', avatars: {} }] };
    await expect(maker.charactersForCover('s1', story, ['Liana'], { loadFreshCharacters: async () => [] }))
      .rejects.toThrow(/Liana has no avatar stored with the story and no character of today/);
    const fresh = [{ name: 'Liana', avatars: { standard: 'https://images.example/a.jpg' } }];
    const merged = await maker.charactersForCover('s1', story, ['Liana'], { loadFreshCharacters: async () => fresh });
    expect(merged[0].avatars.standard).toContain('a.jpg');
  });

  // The whole make, with stand-ins for every model call and the database.
  async function makeStory() {
    const avatar = await jpeg(64, 64, '#cc8844');
    return {
      id: 'job_x', title: 'Liana', artStyle: 'watercolor', language: 'de', mainCharacters: [1],
      characters: [{ id: 1, name: 'Liana', isMainCharacter: true, avatars: { styledAvatars: { watercolor: { standard: avatar } } } }],
      clothingRequirements: { Liana: { costumed: { used: false }, standard: { used: true, signature: 'none' } } },
      visualBible: { era: 'present day', locations: [] },
      coverImages: { frontCover: { description: 'front' } },
    } as any;
  }
  const BRIEF = `Liana waves goodbye on the quay.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'Liana waves goodbye.', characters: [{ name: 'Liana', clothing: 'standard', position: 'center', depth: 'foreground' }],
    objects: [], textPosition: 'top-full',
  })}`;
  const deps = (over: any = {}) => ({
    readOutfit: vi.fn(async () => ({ outfit: 'a pink tutu, white tights, ballet shoes' })),
    loadFreshCharacters: vi.fn(async () => []),
    writeBrief: vi.fn(async (beat: any) => ({ pageNumber: beat.pageNumber, brief: BRIEF, prompt: 'p', modelId: 'm' })),
    checkBriefs: vi.fn(async () => ({})),
    labelRound: vi.fn(async () => ({ round: 0, findings: 0 })),
    render: vi.fn(async () => ({ imageData: 'data:image/jpeg;base64,AAAA', score: 82, promptSent: 'sent' })),
    stamp: vi.fn(async () => ({ servedImageData: 'data:image/jpeg;base64,BBBB', artImageData: 'data:image/jpeg;base64,CCCC', typographySpec: { fontId: 'f' } })),
    save: vi.fn(async () => {}),
    ...over,
  });

  it('makes the cover: outfit from the avatar, the brief for the back cover beat, one render, the stamp, the save', async () => {
    const story = await makeStory();
    const d = deps();
    const out = await maker.makeMissingBackCover('job_x', story, d);
    expect(out).toMatchObject({ made: true, score: 82, attempts: 1 });
    expect(d.readOutfit).toHaveBeenCalledTimes(1);
    const beat = d.writeBrief.mock.calls[0][0];
    expect(beat.pageNumber).toBe(-3);
    expect(beat.planLine).toContain('Liana wears: a pink tutu, white tights, ballet shoes');
    expect(d.render).toHaveBeenCalledTimes(1);
    expect(d.stamp).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(d.save.mock.calls[0][2].version.imageData).toContain('BBBB');
  }, 30000);

  it('a weak first picture: a second render, the better one is stored', async () => {
    const story = await makeStory();
    const scores = [{ score: 35, imageData: 'data:image/jpeg;base64,AAAA' }, { score: 66, imageData: 'data:image/jpeg;base64,DDDD' }];
    const d = deps({ render: vi.fn(async () => scores.shift()) });
    const out = await maker.makeMissingBackCover('job_x', story, d);
    expect(d.render).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ made: true, score: 66, attempts: 2 });
    expect(d.stamp.mock.calls[0][2].imageData).toContain('DDDD');
  }, 30000);

  it('a failed stamp throws and stores nothing', async () => {
    const story = await makeStory();
    const d = deps({ stamp: vi.fn(async () => ({ servedImageData: 'x', artImageData: null, typographySpec: null })) });
    await expect(maker.makeMissingBackCover('job_x', story, d)).rejects.toThrow(/text stamp/);
    expect(d.save).not.toHaveBeenCalled();
  }, 30000);

  it('a story with no front cover fails loudly; a story that already has a back cover is left alone', async () => {
    const noFront = await makeStory(); delete noFront.coverImages.frontCover;
    await expect(maker.makeMissingBackCover('job_y', noFront, deps())).rejects.toThrow(/no front cover/);
    const has = await makeStory(); has.coverImages.backCover = { imageData: 'x' };
    const d = deps();
    expect(await maker.makeMissingBackCover('job_z', has, d)).toEqual({ made: false });
    expect(d.writeBrief).not.toHaveBeenCalled();
  }, 30000);

  it('element labels are authored BEFORE the brief and the render, on the working copy bible (bug back-cover-maker-wrong-age-and-object-label)', async () => {
    const story = await makeStory();
    const order: string[] = [];
    const d = deps({
      labelRound: vi.fn(async (vb: any) => { order.push('labels'); expect(vb).toBe(story.visualBible); return { round: 1, findings: 2 }; }),
      writeBrief: vi.fn(async (beat: any) => { order.push('brief'); return { pageNumber: beat.pageNumber, brief: BRIEF, prompt: 'p', modelId: 'm' }; }),
    });
    await maker.makeMissingBackCover('job_x', story, d);
    expect(order).toEqual(['labels', 'brief']);
    expect(d.labelRound.mock.calls[0][1].language).toBe('de');
  }, 30000);

  it('a label round that did not run throws: the code repair would name the element by its old-language type', async () => {
    const story = await makeStory();
    const d = deps({ labelRound: vi.fn(async () => ({ round: 0, findings: 3 })) });
    await expect(maker.makeMissingBackCover('job_lbl', story, d)).rejects.toThrow(/labels could not be authored/);
    expect(d.render).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  }, 30000);

  it('two requests for one story make one cover', async () => {
    const story = await makeStory();
    const d = deps();
    const [a, b] = await Promise.all([maker.makeMissingBackCover('job_x', story, d), maker.makeMissingBackCover('job_x', story, d)]);
    expect(a).toBe(b);
    expect(d.render).toHaveBeenCalledTimes(1);
  }, 30000);
});

describe('the print route and the order pages', () => {
  it('generate-book-pdf goes through buildBookPrintPdf and keeps its ownership check', () => {
    const src = read('server/routes/print.js');
    const route = src.slice(src.indexOf("router.post('/generate-book-pdf'"), src.indexOf("router.post('/admin/orders/:orderId/retry-print-order'"));
    expect(route).toContain('buildBookPrintPdf(');
    expect(route).toContain("fillMethod: 'mirror'");
    expect(route).toContain('user_id = $2');
    expect(route).not.toContain('generatePrintPdf(');
    expect(route).not.toContain('generateCombinedBookPdf(');
    expect(route).not.toContain('attachSquareCovers(');
  });
  it('the download and admin PDFs ask for no back cover', () => {
    const src = read('server/routes/print.js');
    expect(src).not.toContain('requireBackCover');
    expect(read('server/lib/gelato.js').match(/requireBackCover: true/g)).toHaveLength(2);
  });
  it('both order pages wait for the back cover before the square covers and before the order button', () => {
    for (const page of ['client/src/pages/BookBuilder.tsx', 'client/src/pages/VoucherBookCheckout.tsx']) {
      const src = read(page);
      expect(src, page).toContain('<BookBackCover');
      expect(src, page).toContain("pageInfo.layout === 'spread' && backCoverReady");
      expect(src, page).toMatch(/backCoverReady/);
    }
    expect(read('client/src/pages/BookBuilder.tsx')).toContain('!squareCoversReady || !backCoverReady');
    expect(read('client/src/pages/VoucherBookCheckout.tsx')).toContain('squareCoversReady && backCoverReady');
  });
  it('the endpoint asks the one server rule and is owner-only', () => {
    const src = read('server/routes/stories.js');
    const route = src.slice(src.indexOf("router.post('/:id/ensure-back-cover'"), src.indexOf("router.get('/:id/title-paint'"));
    expect(route).toContain('backCoverTarget(stories)');
    expect(route).toContain('user_id = $2');
    expect(read('client/src/components/book/BookBackCover.tsx')).not.toMatch(/backCover(Target)?\(/);
  });
});
