/**
 * Owner 2026-10-07 ("fail loudly too"), extended from the illustration face
 * pass to EVERY Node call into the Python analyzer: a client never maps "the
 * analyzer could not answer" onto the value a real answer produces. The shared
 * client (photoAnalyzerClient.analyzerJson) throws an AnalyzerError on every
 * failure shape; each caller reports it (reportAnalyzerFailure → ERROR +
 * failure_log under a stable kind) and either stops or keeps a result that is
 * explicitly marked as degraded. Decided fallbacks (DINO→Gemini, SAM→rembg,
 * rembg→white-threshold/chroma-key, edge split→fixed grid, pose→Gemini) stay —
 * they are now reported, not silent.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const pac = require('../../server/lib/photoAnalyzerClient.js');
const failureLog = require('../../server/lib/failureLog.js');
const realFetch = globalThis.fetch;
const reply = (status: number, body: any) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const down = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

let recorded: any[] = [];
beforeEach(() => {
  recorded = [];
  vi.spyOn(failureLog, 'recordFailure').mockImplementation((f: any) => { recorded.push(f); });
});
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe('analyzerJson — the one client every call goes through', () => {
  it('returns the parsed answer on success', async () => {
    globalThis.fetch = reply(200, { success: true, figures: [] }) as any;
    await expect(pac.analyzerJson('/detect-figures-text', { image: 'x', prompts: [] })).resolves.toEqual({ success: true, figures: [] });
  });
  it('throws an AnalyzerError (kind per endpoint) when unreachable', async () => {
    globalThis.fetch = down as any;
    const err = await pac.analyzerJson('/figure-mask', {}).catch((e: any) => e);
    expect(err).toBeInstanceOf(pac.AnalyzerError);
    expect(err.kind).toBe('analyzer_figure_mask_failed');
    expect(err.message).toMatch(/unavailable: ECONNREFUSED/);
  });
  it('throws on a non-2xx answer, with the status', async () => {
    globalThis.fetch = reply(503, { success: false, error: 'model loading' }) as any;
    const err = await pac.analyzerJson('/detect-figures-text', {}).catch((e: any) => e);
    expect(err).toBeInstanceOf(pac.AnalyzerError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/HTTP 503/);
  });
  it('throws on success:false', async () => {
    globalThis.fetch = reply(200, { success: false, error: 'Failed to decode image' }) as any;
    await expect(pac.analyzerJson('/pose-heads', {})).rejects.toThrow(/Failed to decode image/);
  });
  it('survives a minimal stubbed response without .text()', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    await expect(pac.analyzerJson('/split-reference-sheet', {})).rejects.toBeInstanceOf(pac.AnalyzerError);
  });
  it('analyzerFailureKind is a stable slug', () => {
    expect(pac.analyzerFailureKind('/detect-figures-text')).toBe('analyzer_detect_figures_text_failed');
    expect(pac.analyzerFailureKind('/remove-bg')).toBe('analyzer_remove_bg_failed');
  });
  it('reportAnalyzerFailure files the row under the error kind and never throws', () => {
    const err = new pac.AnalyzerError('/silhouette-edge', 'HTTP 500');
    pac.reportAnalyzerFailure('[TEST]', err, { pageLabel: 'Page 3: ', severity: 'customer' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: 'analyzer_silhouette_edge_failed', severity: 'customer' });
    expect(recorded[0].summary).toMatch(/\[TEST\] Page 3: analyzer \/silhouette-edge failed: HTTP 500/);
    (failureLog.recordFailure as any).mockImplementation(() => { throw new Error('db gone'); });
    expect(() => pac.reportAnalyzerFailure('[TEST]', err)).not.toThrow();
  });
});

describe('GroundingDINO / MobileSAM clients (figureDetection)', () => {
  const fd = require('../../server/lib/figureDetection.js');
  it('_gdinoDetect throws on HTTP 503 instead of returning null', async () => {
    globalThis.fetch = reply(503, { success: false, error: 'cold' }) as any;
    await expect(fd._gdinoDetect('data:image/jpeg;base64,AA', [{ name: 'person', text: 'person' }])).rejects.toBeInstanceOf(pac.AnalyzerError);
  });
  it('_gdinoDetect throws when unreachable', async () => {
    globalThis.fetch = down as any;
    await expect(fd._gdinoDetect('x', [])).rejects.toThrow(/analyzer \/detect-figures-text failed/);
  });
  it('_mobilesamMaskFull throws on failure, and returns null ONLY for a real empty mask', async () => {
    globalThis.fetch = reply(500, { success: false, error: 'boom' }) as any;
    await expect(fd._mobilesamMaskFull('x', [0, 0, 10, 10], 10, 10)).rejects.toBeInstanceOf(pac.AnalyzerError);
    globalThis.fetch = reply(200, { success: true, image: 'data:image/png;base64,AA', fill_pixels: 0 }) as any;
    await expect(fd._mobilesamMaskFull('x', [0, 0, 10, 10], 10, 10)).resolves.toBeNull();
  });
  it('detectPersonBoxInCrop keeps the documented null (copied box) but REPORTS the outage', async () => {
    globalThis.fetch = down as any;
    const r = await fd.detectPersonBoxInCrop(Buffer.from('nope'), null, 'P1: ');
    expect(r).toBeNull();
    expect(recorded.map(r => r.kind)).toContain('analyzer_detect_figures_text_failed');
  });
});

describe('figure mask / silhouette (imageCompositing) and rembg', () => {
  const ic = require('../../server/lib/imageCompositing.js');
  const { rembgRemoveBackground } = require('../../server/lib/rembg.js');
  it('fetchSilhouettePng returns null AND reports on an analyzer failure', async () => {
    globalThis.fetch = reply(500, { success: false }) as any;
    await expect(ic.fetchSilhouettePng(Buffer.from('jpg'))).resolves.toBeNull();
    expect(recorded.map(r => r.kind)).toContain('analyzer_silhouette_edge_failed');
  });
  it('fetchFigureMaskPng (caller requires SAM) returns null AND reports — no rembg fallback', async () => {
    const { MODEL_DEFAULTS } = require('../../server/config/models.js');
    const prev = MODEL_DEFAULTS.figureMaskBackend;
    MODEL_DEFAULTS.figureMaskBackend = 'mobilesam';
    try {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; throw new Error('ECONNRESET'); }) as any;
      await expect(ic.fetchFigureMaskPng(Buffer.from('jpg'), [0, 0, 8, 8], { requireMobilesam: true })).resolves.toBeNull();
      expect(calls).toBe(1);
      expect(recorded.map(r => r.kind)).toContain('analyzer_figure_mask_failed');
    } finally { MODEL_DEFAULTS.figureMaskBackend = prev; }
  });
  it('rembgRemoveBackground retries once, then returns null AND reports', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ success: false, error: 'oom' }), { status: 500 }); }) as any;
    await expect(rembgRemoveBackground(Buffer.from('png'))).resolves.toBeNull();
    expect(calls).toBe(2);
    expect(recorded.map(r => r.kind)).toContain('analyzer_remove_bg_failed');
  });
});

describe('2×4 sheet helpers (character2x4Sheet)', () => {
  const { _internal } = require('../../server/lib/character2x4Sheet.js');
  it('detectBodyRowHeads returns the explicit null (Gemini fallback, stamped by applyPoseHeadGate) AND reports', async () => {
    globalThis.fetch = reply(503, { success: false, error: 'yolo loading' }) as any;
    await expect(_internal.detectBodyRowHeads('data:image/jpeg;base64,AA')).resolves.toBeNull();
    expect(recorded.map(r => r.kind)).toContain('analyzer_pose_heads_failed');
    const bodies = _internal.applyPoseHeadGate({ fullBody: { headScore: 9, feetScore: 10 } }, null);
    expect(bodies.fullBody.headSource).toBe('gemini-fallback');
  });
  it('detectSheetRowDivider marks the variance fallback as such AND reports', async () => {
    const sharp = require('sharp');
    const buf = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 200, b: 200 } } }).png().toBuffer();
    globalThis.fetch = down as any;
    const r = await _internal.detectSheetRowDivider('data:image/png;base64,' + buf.toString('base64'), buf, 40, 40);
    expect(r.source).toBe('variance-fallback');
    expect(typeof r.mid).toBe('number');
    expect(recorded.map(r => r.kind)).toContain('analyzer_split_reference_sheet_failed');
  });
});

describe('callers report through reportAnalyzerFailure (source pins)', () => {
  it('bbox detection marks a Gemini fallback caused by the analyzer', () => {
    const s = src('server/lib/bboxDetection.js');
    expect(s).toMatch(/reportAnalyzerFailure\('\[BBOX-DETECT\] GroundingDINO backend → Gemini fallback', gdErr/);
    expect(s).toMatch(/analyzerError: gdErr\.message/);
  });
  it('the SAM pass marks a figure whose mask call failed', () => {
    const s = src('server/lib/figureDetection.js');
    expect(s).toMatch(/verdict: 'analyzer-failed', maskError/);
    expect(s).toMatch(/analyzerError: err\.message/);           // object grounding
    expect(s).not.toMatch(/count\('dino_detect_fail'\); return null/);
  });
  it('sheet split callers, garment fix, ArcFace, the scene composite and the routes report', () => {
    for (const [f, re] of [
      ['server/lib/sceneComposite.js', /reportAnalyzerFailure\('\[SCENE COMPOSITE\] edge-detection split → fixed-math crop'/],
      ['server/lib/sceneComposite.js', /rembg unavailable — cut-out DEGRADED/],
      ['server/lib/coverComposite.js', /rembg unavailable — cut-out DEGRADED/],
      ['server/lib/referenceSheets.js', /reportAnalyzerFailure\('\[REF-SHEET\] split-reference-sheet/],
      ['server/lib/garmentColourFix.js', /reportAnalyzerFailure\('\[GARMENT-COLOUR\] page segmentation/],
      ['server/lib/faceIdentity.js', /reportAnalyzerFailure\('\[ARCFACE\] likeness scoring unavailable'/],
      ['server/routes/avatars.js', /reportAnalyzerFailure\('📸 \[PHOTO\]'/],
      ['server/routes/avatars.js', /reportAnalyzerFailure\('\[SPLIT-GRID\]'/],
      ['server/routes/avatars.js', /reportAnalyzerFailure\('📸 \[PHOTO\] analyzer service error'/],
      ['server/routes/trial.js', /reportAnalyzerFailure\('\[TRIAL\] \[PHOTO\]'/],
      ['server/routes/trial.js', /reportAnalyzerFailure\('\[TRIAL\] \[PHOTO\] analyzer service error'/],
      ['server/routes/photos.js', /reportAnalyzerFailure\('📸 \[REMOVE-BG\]'/],
    ] as const) expect(src(f), f).toMatch(re);
    expect(src('server/lib/referenceSheets.js')).not.toMatch(/log\.debug\(`\[REF-SHEET\] Python service unreachable/);
  });
  it('no module bypasses the shared client with its own analyzer fetch', () => {
    for (const f of ['figureDetection', 'imageCompositing', 'garmentColourFix', 'character2x4Sheet', 'referenceSheets', 'sceneComposite', 'faceIdentity', 'rembg']) {
      expect(src(`server/lib/${f}.js`), f).not.toMatch(/fetch\(`\$\{(_?photoAnalyzerUrl\(\)|PHOTO_ANALYZER_URL|analyzerBase|BASE\(\))\}/);
    }
  });
});
