/**
 * BOOK PREVIEW (docs/decisions.md 2026-10-28 "Book preview"). Pins:
 *  - the Grok-painted text strip is stored by content in R2 and reused: a second preview AND the later order paint
 *    nothing again (Grok mocked, called once)
 *  - requestPreview: a second request reuses the stored preview, concurrent requests join one job (one build = no double
 *    spend, also across users), a non-owner gets 404, admins may read, an error is kept and `retry` starts again
 *  - the returned page order IS the PDF page order (rasterised from a real PDF whose pages have distinct widths)
 *  - buildSpreads pairs the pages the way the printed book lies open
 * No paid call, no network: Grok, R2, the database and the Gelato/PDF build are stand-ins.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { buildSpreads } from '../../client/src/utils/bookSpreads';

const cjs = createRequire(import.meta.url);
const r2 = cjs('../../server/lib/r2.js');
const pdf = cjs('../../server/lib/pdf.js');
const BP = cjs('../../server/lib/bookPreview.js');
const { rasterisePdfPages } = cjs('../../server/lib/pdfRaster.js');
const PDFDocument = cjs('pdfkit');
const { loadPromptTemplates } = cjs('../../server/services/prompts.js');

// In-memory R2.
function fakeR2() {
  const store = new Map<string, Buffer>();
  return {
    store,
    contentKey: r2.contentKey,
    isConfigured: () => true,
    objectExists: async (k: string) => store.has(k),
    publicUrlForKey: (k: string) => `https://r2.test/${k}`,
    fetchImageBytes: async (u: string) => store.get(u.replace('https://r2.test/', '')) ?? null,
    uploadImage: async (b: Buffer, k: string) => { store.set(k, Buffer.from(b)); return `https://r2.test/${k}`; },
  };
}
const R2_METHODS = ['isConfigured', 'objectExists', 'publicUrlForKey', 'fetchImageBytes', 'uploadImage'] as const;

describe('Grok strip fill is stored and reused (pdf.js buildStripBackground)', () => {
  beforeAll(() => { loadPromptTemplates(); });
  afterEach(() => vi.restoreAllMocks());

  it('paints once; the second preview and the order read the stored page', async () => {
    const fake = fakeR2();
    for (const k of R2_METHODS) vi.spyOn(r2, k).mockImplementation(fake[k] as never);
    const picture = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 90, g: 140, b: 200 } } }).jpeg().toBuffer();
    const image = { imageData: 'data:image/jpeg;base64,' + picture.toString('base64') };
    const answer = await sharp({ create: { width: 1536, height: 2048, channels: 3, background: { r: 120, g: 170, b: 220 } } }).jpeg().toBuffer();
    const editFn = vi.fn(async () => ({ imageData: 'data:image/jpeg;base64,' + answer.toString('base64') }));
    const geometry = { interiorW: 612, interiorH: 792, imageBottom: 560, pageNumber: 1, fillMethod: 'grok', editFn };

    const previewStats: any = { grokCalls: 0 };
    const first = await pdf.buildStripBackground(image, geometry, previewStats);
    expect(editFn).toHaveBeenCalledTimes(1);
    expect(previewStats.grokCalls).toBe(1);
    expect([...fake.store.keys()].filter(k => k.startsWith('printStripFill/')).length).toBe(1);

    const orderStats: any = { grokCalls: 0 };
    const again = await pdf.buildStripBackground(image, geometry, orderStats);
    expect(editFn).toHaveBeenCalledTimes(1);          // the order paid nothing
    expect(orderStats.grokCalls).toBe(0);
    expect(orderStats.reused).toBe(1);
    expect(again.edge).toBe(first.edge);
    expect(again.buffer.equals(first.buffer)).toBe(true);

    // A different picture is a different key: painted again.
    const other = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 200, g: 50, b: 50 } } }).jpeg().toBuffer();
    await pdf.buildStripBackground({ imageData: 'data:image/jpeg;base64,' + other.toString('base64') }, geometry, orderStats);
    expect(editFn).toHaveBeenCalledTimes(2);
  });

  it('the mirror fill is never stored', async () => {
    const fake = fakeR2();
    for (const k of R2_METHODS) vi.spyOn(r2, k).mockImplementation(fake[k] as never);
    const picture = await sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 90, g: 140, b: 200 } } }).jpeg().toBuffer();
    await pdf.buildStripBackground({ imageData: 'data:image/jpeg;base64,' + picture.toString('base64') },
      { interiorW: 612, interiorH: 792, imageBottom: 560, pageNumber: 1, fillMethod: 'mirror' }, {});
    expect(fake.store.size).toBe(0);
  });
});

// A real PDF: page 1 wide (the cover spread), the rest square-ish, each a distinct width so the order is checkable.
function makePdf(widths: number[]): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const bufs: Buffer[] = [];
    doc.on('data', (b: Buffer) => bufs.push(b));
    doc.on('end', () => resolve(Buffer.concat(bufs)));
    for (const w of widths) { doc.addPage({ size: [w, 400] }); doc.rect(0, 0, w, 400).fill('#cc8844'); }
    doc.end();
  });
}

describe('requestPreview', () => {
  const widths = [800, 400, 410, 420, 430, 440];
  function setup(opts: { owner?: string; failBuild?: boolean } = {}) {
    const fake = fakeR2();
    const owner = opts.owner ?? 'u1';
    const dbPool = {
      query: vi.fn(async (sql: string) => (sql.includes('FROM stories')
        ? { rows: [{ id: 's1', user_id: owner, data: { title: 'A' } }] }
        : { rows: [] })),
    };
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const buildBookPrintPdf = vi.fn(async (_p: unknown, _ids: string[], _cover: string, _layout: string, o: any) => {
      o.onStage('pdf');
      await gate;
      if (opts.failBuild) throw new Error('Grok failed');
      o.fillStats.grokCalls = 4;
      return { pdfBuffer: await makePdf(widths), targetPageCount: 4, pageInfo: { bookFormat: 'portrait' } };
    });
    const deps = { dbPool, buildBookPrintPdf, rasterisePdfPages, r2: fake, codeVersion: 'abc' };
    return { deps, buildBookPrintPdf, release, fake, dbPool };
  }
  const base = { userId: 'u1', isAdmin: false, storyIds: ['s1'], layout: 'single', coverType: 'softcover' };
  async function until(deps: any, req: any, state: string) {
    for (let i = 0; i < 200; i++) {
      const s = await BP.requestPreview(req, deps);
      if (s.state === state) return s;
      await new Promise(r => setTimeout(r, 30));
    }
    throw new Error('never reached ' + state);
  }
  afterEach(() => { BP._jobsForTest.jobsByKey.clear(); BP._jobsForTest.keyBySignature.clear(); });

  it('returns pages in PDF order, stores them, and a second request reuses the stored preview', async () => {
    const { deps, buildBookPrintPdf, release } = setup();
    const first = await BP.requestPreview(base, deps);
    expect(first.state).toBe('running');
    release();
    const ready: any = await until(deps, base, 'ready');
    expect(ready.manifest.pages.length).toBe(widths.length);
    // Page i of the manifest is PDF page i + 1: compare stored widths with the PDF page widths (all rendered 1200 high).
    const expected = widths.map(w => Math.round(w / 400 * 1200));
    ready.manifest.pages.forEach((p: any, i: number) => expect(Math.abs(p.width - expected[i])).toBeLessThanOrEqual(1));
    expect(ready.manifest.pages.every((p: any) => p.height === 1200)).toBe(true);
    expect(ready.manifest.grokPainted).toBe(4);
    const urls = ready.manifest.pages.map((p: any) => p.url);
    expect(urls).toEqual([...urls].sort());                      // keys are zero-padded: storage order == page order

    const second: any = await BP.requestPreview(base, deps);
    expect(second.state).toBe('ready');
    expect(buildBookPrintPdf).toHaveBeenCalledTimes(1);          // no rebuild, no Grok
  });

  it('concurrent requests join one job (no double spend), also from an admin', async () => {
    const { deps, buildBookPrintPdf, release } = setup();
    const [a, b, c] = await Promise.all([
      BP.requestPreview(base, deps), BP.requestPreview(base, deps),
      BP.requestPreview({ ...base, userId: 'admin1', isAdmin: true }, deps),
    ]);
    expect([a.state, b.state, c.state]).toEqual(['running', 'running', 'running']);
    release();
    await until(deps, base, 'ready');
    expect(buildBookPrintPdf).toHaveBeenCalledTimes(1);
  });

  it('is owner only (admins may read any)', async () => {
    const { deps } = setup({ owner: 'someone-else' });
    await expect(BP.requestPreview(base, deps)).rejects.toMatchObject({ status: 404 });
    await expect(BP.requestPreview({ ...base, userId: 'admin1', isAdmin: true }, deps)).resolves.toMatchObject({ state: 'running' });
  });

  it('rejects bad input', async () => {
    const { deps } = setup();
    await expect(BP.requestPreview({ ...base, layout: 'both' }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(BP.requestPreview({ ...base, coverType: 'paper' }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(BP.requestPreview({ ...base, storyIds: [] }, deps)).rejects.toMatchObject({ status: 400 });
  });

  it('a failed build is an error (no fallback), kept for polling, and retry starts again', async () => {
    const { deps, buildBookPrintPdf, release } = setup({ failBuild: true });
    await BP.requestPreview(base, deps);
    release();
    const err: any = await until(deps, base, 'error');
    expect(err.error).toMatch(/Grok failed/);
    expect(buildBookPrintPdf).toHaveBeenCalledTimes(1);
    expect((await BP.requestPreview(base, deps)).state).toBe('error');   // still the error, no silent restart
    expect(buildBookPrintPdf).toHaveBeenCalledTimes(1);
    await BP.requestPreview({ ...base, retry: true }, deps);
    expect(buildBookPrintPdf).toHaveBeenCalledTimes(2);
  });

  it('a changed story or layout is a new key (no stale preview)', async () => {
    const { deps } = setup();
    const k1 = await BP.resolvePreviewKey(deps, base);
    deps.dbPool.query.mockImplementation(async (sql: string) => (sql.includes('FROM stories')
      ? { rows: [{ id: 's1', user_id: 'u1', data: { title: 'A edited' } }] } : { rows: [] }));
    expect(await BP.resolvePreviewKey(deps, base)).not.toBe(k1);
    expect(await BP.resolvePreviewKey(deps, { ...base, layout: 'spread' })).not.toBe(k1);
  });
});

describe('one implementation: order and preview build the PDF through the same function', () => {
  it('processBookOrder and the preview both call gelato.buildBookPrintPdf with fillMethod grok', () => {
    const fs = cjs('node:fs');
    const gelato = fs.readFileSync(new URL('../../server/lib/gelato.js', import.meta.url), 'utf8');
    const preview = fs.readFileSync(new URL('../../server/lib/bookPreview.js', import.meta.url), 'utf8');
    expect(gelato).toMatch(/await buildBookPrintPdf\(\s*dbPool, allStoryIds, coverType, layout, \{ fillMethod: 'grok'/);
    expect(preview).toMatch(/deps\.buildBookPrintPdf\(deps\.dbPool, job\.storyIds, job\.coverType, job\.layout, \{\s*fillMethod: 'grok'/);
    expect(typeof cjs('../../server/lib/gelato.js').buildBookPrintPdf).toBe('function');
  });
});

describe('buildSpreads', () => {
  it('cover alone, then pairs (2,3), (4,5)... as the book lies open', () => {
    expect(buildSpreads(8)).toEqual([[0], [1, 2], [3, 4], [5, 6], [7]]);
    expect(buildSpreads(7)).toEqual([[0], [1, 2], [3, 4], [5, 6]]);
    expect(buildSpreads(1)).toEqual([[0]]);
  });
  it('rejects an empty book', () => { expect(() => buildSpreads(0)).toThrow(); });
});
