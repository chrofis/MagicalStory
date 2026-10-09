/**
 * Owner, iPhone /try, 2026-10-09: avatar slides cut badly and only heads showed, the funny lines
 * repeated, and a finished story kept "the picture is being painted" on its title page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FUNNY_MESSAGES, NAMELESS_FUNNY_MESSAGES, funnyDeck, funnyLine } from '../../client/src/utils/funnyMessages';

const sharp = require('sharp');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-waiting-page';

// A styled 2x4 sheet as the pipeline stacks it: a SHORT head row over a TALLER body row, white gutter between.
const W = 1024, HEAD_H = 440, SEAM = 8, BODY_H = 576;
async function sheet() {
  const cells = [];
  for (let c = 0; c < 4; c++) {
    cells.push({ input: await sharp({ create: { width: 200, height: 396, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer(), left: c * 256 + 28, top: 40 });
    cells.push({ input: await sharp({ create: { width: 140, height: 480, channels: 3, background: { r: 60, g: 90, b: 200 } } }).png().toBuffer(), left: c * 256 + 58, top: HEAD_H + SEAM + 40 });
  }
  const buf = await sharp({ create: { width: W, height: HEAD_H + SEAM + BODY_H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite(cells).jpeg({ quality: 92 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

describe('avatar slides are whole cells (not 1:4 column strips)', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }))); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('one standard sheet gives six cells, head and body alternating, each a whole cell', async () => {
    const { slidesFromSheet } = require('../../server/lib/avatarSlides');
    const slides = await slidesFromSheet(await sheet());
    expect(slides).toHaveLength(6);
    const dims: any[] = [];
    for (const s of slides) dims.push(await sharp(Buffer.from(s.split(',')[1], 'base64')).metadata());
    for (const m of dims) expect(m.width).toBe(256);                       // one column wide, never a strip of columns
    dims.forEach((m, i) => {
      const isHead = i % 2 === 0;
      expect(m.height).toBeGreaterThan(isHead ? 380 : 520);                 // head cell ~440 tall, body cell ~570
      expect(m.height).toBeLessThan(isHead ? 470 : 600);
      expect(m.height / m.width).toBeLessThan(2.5);                         // the old strip was 4:1
    });
  });

  it('refuses an image that is not a sheet (a portrait is one figure)', async () => {
    const { slidesFromSheet } = require('../../server/lib/avatarSlides');
    const portrait = (await sharp({ create: { width: 400, height: 900, channels: 3, background: '#fff' } }).jpeg().toBuffer()).toString('base64');
    await expect(slidesFromSheet(`data:image/jpeg;base64,${portrait}`)).rejects.toThrow(/not a 2x4 sheet/);
  });

  it('costumed AND standard sheets both reach the slides, alternating pair by pair', async () => {
    const { buildAvatarSlides, sheetSourcesOf, interleaveSheetSlides } = require('../../server/lib/avatarSlides');
    expect(sheetSourcesOf({ standard: 'S', costumed: { default: 'C' } })).toEqual(['C', 'S']);
    expect(interleaveSheetSlides([['c0', 'c1', 'c2', 'c3'], ['s0', 's1', 's2', 's3']])).toEqual(['c0', 'c1', 's0', 's1', 'c2', 'c3', 's2', 's3']);
    const both = await buildAvatarSlides({ standard: await sheet(), costumed: { default: await sheet() } }, { error: () => {} });
    expect(both).toHaveLength(12);
  });

  it('a broken sheet is skipped and logged, the other still shows', async () => {
    const { buildAvatarSlides } = require('../../server/lib/avatarSlides');
    const errors: string[] = [];
    const slides = await buildAvatarSlides({ standard: 'data:image/jpeg;base64,AAAA', costumed: { default: await sheet() } }, { error: (m: string) => errors.push(m) });
    expect(slides).toHaveLength(6);
    expect(errors).toHaveLength(1);
  });
});

describe('funny messages never repeat within a pass', () => {
  it('the pool covers a 4 minute wait at 6 s a slot and has every language', () => {
    expect(FUNNY_MESSAGES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(FUNNY_MESSAGES.map(m => m.en)).size).toBe(FUNNY_MESSAGES.length);
    for (const m of FUNNY_MESSAGES) for (const l of ['en', 'de', 'fr', 'it'] as const) expect(m[l].length).toBeGreaterThan(5);
  });
  it('Swiss spelling: no eszett anywhere', () => {
    expect(JSON.stringify(FUNNY_MESSAGES)).not.toContain('ß');
  });
  it('a deck is a permutation, so every line comes once before any repeats', () => {
    const deck = funnyDeck(FUNNY_MESSAGES.length);
    expect(new Set(deck).size).toBe(FUNNY_MESSAGES.length);
    const shown = deck.map((_, slot) => funnyLine(FUNNY_MESSAGES, deck, slot, 'de', 'Mia'));
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.every(l => !l.includes('{name}'))).toBe(true);
  });
  it('the deck is drawn once: the same slot gives the same line however often the list is rebuilt', () => {
    const deck = funnyDeck(FUNNY_MESSAGES.length);
    expect(funnyLine(FUNNY_MESSAGES, deck, 7, 'en', 'Mia')).toBe(funnyLine(FUNNY_MESSAGES, deck, 7, 'en', 'Mia'));
  });
  it('lines without a name exist for a resumed page that has none', () => {
    expect(NAMELESS_FUNNY_MESSAGES.length).toBeGreaterThanOrEqual(8);
    expect(NAMELESS_FUNNY_MESSAGES.every(m => !m.en.includes('{name}') && !m.de.includes('{name}'))).toBe(true);
  });
});

describe('job-status title page once the job is completed', () => {
  const trial = require('../../server/routes/trial.js');
  const db = require('../../server/services/database');
  const original = db.getActiveStoryImages;
  afterEach(() => { db.getActiveStoryImages = original; });

  it('completed job: the stored front cover is served (the partial_cover checkpoint is gone by then)', async () => {
    db.getActiveStoryImages = async () => [
      { image_type: 'scene', page_number: 1, image_url: 'https://r2/p1.jpg' },
      { image_type: 'frontCover', page_number: null, image_url: 'https://r2/cover.jpg' },
    ];
    const pool = { query: vi.fn(async () => ({ rows: [{ title: 'Serafin und die Guertel' }] })) };
    const res = await trial.loadTrialTitlePage(pool, 'job_1', 'completed');
    expect(res).toEqual({ image: 'https://r2/cover.jpg', title: 'Serafin und die Guertel' });
  });
  it('running job: still the partial_cover checkpoint', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ step_data: { imageUrl: 'https://r2/preview/frontCover-1.jpg', storyTitle: 'T' } }] })) };
    expect(await trial.loadTrialTitlePage(pool, 'job_1', 'processing')).toEqual({ image: 'https://r2/preview/frontCover-1.jpg', title: 'T' });
  });
  it('completed job without a stored cover answers null, not a made-up image', async () => {
    db.getActiveStoryImages = async () => [{ image_type: 'scene', page_number: 1, image_url: 'https://r2/p1.jpg' }];
    expect(await trial.loadTrialTitlePage({ query: vi.fn() }, 'job_1', 'completed')).toBeNull();
  });
});

describe('the poll carries URLs, never image bytes (iPhone memory, owner 2026-10-09)', () => {
  const fsx = require('fs');
  const pathx = require('path');
  const ROOT = pathx.resolve(__dirname, '../..');

  it('uploads one rendered image under the story prefix and hands back the URL only', async () => {
    const r2 = require('../../server/lib/r2');
    const calls: any[] = [];
    const orig = r2.uploadImage;
    r2.uploadImage = async (buf: Buffer, key: string, type: string) => { calls.push({ len: buf.length, key, type }); return `https://cdn/${key}`; };
    try {
      const { uploadCheckpointImage } = require('../../server/lib/checkpointImages');
      const jpeg = (await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().toBuffer()).toString('base64');
      const url = await uploadCheckpointImage('job_9', 'p3', `data:image/jpeg;base64,${jpeg}`);
      expect(url).toMatch(/^https:\/\/cdn\/stories\/job_9\/preview\/p3-[0-9a-f]{10}\.jpg$/);
      expect(calls[0].type).toBe('image/jpeg');
    } finally { r2.uploadImage = orig; }
  });

  it('a failed upload throws: no base64 is stored in its place', async () => {
    const r2 = require('../../server/lib/r2');
    const orig = r2.uploadImage;
    r2.uploadImage = async () => null;
    try {
      const { uploadCheckpointImage } = require('../../server/lib/checkpointImages');
      await expect(uploadCheckpointImage('job_9', 'p3', 'data:image/jpeg;base64,AAAA')).rejects.toThrow(/R2/);
    } finally { r2.uploadImage = orig; }
  });

  it('every partial_page / partial_cover save goes through the R2 wrapper', () => {
    const src = fsx.readFileSync(pathx.join(ROOT, 'storyJobPipeline.js'), 'utf8');
    expect(src).not.toMatch(/saveCheckpoint\(jobId, 'partial_(page|cover)'/);
    expect([...src.matchAll(/saveImageCheckpoint\(jobId, 'partial_/g)].length).toBe(5);
  });

  it('a running trial poll of six rendered pages plus the cover is a few KB, not megabytes', async () => {
    const trial = require('../../server/routes/trial.js');
    const url = (n: number) => `https://images.magicalstory.ch/stories/job_1/preview/p${n}-0123456789.jpg`;
    const pool = { query: vi.fn(async (sql: string) => {
      if (/step_name = 'story_text'/.test(sql)) return { rows: [{ step_data: { title: 'T', totalScenes: 6, pageTexts: Object.fromEntries([1, 2, 3, 4, 5, 6].map(n => [n, 'Text '.repeat(60)])) } }] };
      return { rows: [1, 2, 3, 4, 5, 6].map(n => ({ step_index: n, step_data: { pageNumber: n, imageUrl: url(n) } })) };
    }) };
    const src = await trial.loadTrialStorySource(pool, 'job_1', 'u', 'processing');
    const pages = trial.buildTrialStoryPages(src.records, { unlocked: false, freePages: 3 });
    expect(pages.every((p: any) => /^https:\/\//.test(p.imageData))).toBe(true);
    expect(JSON.stringify({ storyTitle: src.title, pages }).length).toBeLessThan(6000);
  });

  it('the full-story poll serves the preview URL under its old imageData name', () => {
    const { previewImageField } = require('../../server/lib/checkpointImages');
    expect(previewImageField({ pageNumber: 2, imageUrl: 'https://x/p2.jpg', modelId: 'm' })).toEqual({ pageNumber: 2, modelId: 'm', imageData: 'https://x/p2.jpg' });
    const legacy = { pageNumber: 1, imageData: 'data:old' };
    expect(previewImageField(legacy)).toBe(legacy);
  });
});

describe('the finished-story redirect to /stories', () => {
  it('never fires for an anonymous trial visitor, nor one who only typed an email', async () => {
    const { shouldRedirectToStories } = await import('../../client/src/utils/trialPoll');
    expect(shouldRedirectToStories('completed', false, false)).toBe(false);
    expect(shouldRedirectToStories('generating', true, true)).toBe(false);
    expect(shouldRedirectToStories('completed', true, false)).toBe(true);
    expect(shouldRedirectToStories('completed', false, true)).toBe(true);
  });
});
