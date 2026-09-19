import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const sharp = require_('sharp');
const { secondOpinionIdentity, SECOND_OPINION_START_TIER } = require_('../../server/lib/figureDetection.js');

// THE SECOND WITNESS COMES OUT OF WIRING THAT ALREADY EXISTS (2026-09-18).
//
// `_somIdentifyFigures` runs gemini-full → qwen-vl-full → haiku-full →
// gemini-sanitized as a fallback chain that STOPS AT THE FIRST SUCCESS. On all
// 19 stored staging versions where the identity vote fires, the stored answer
// came from `gemini-full` — so tiers 1..3 have never been asked about any of
// them, and starting the chain at tier 1 asks a genuinely different model the
// same question.
//
// What is pinned here is the plumbing, because the accuracy cannot be pinned
// without paid calls: WHICH vendor is called first, that the model which
// already answered is excluded, and that the answer comes back keyed by FIGURE
// index — not by the badge's own index, which is not the same number once a
// figure carries no usable box.
//
// Every vendor call is stubbed. This test never reaches a network.

const CHARS = [
  { name: 'Levin', description: 'a seven-year-old boy with short brown hair', clothing: 'a red hooded jacket', position: 'left foreground' },
  { name: 'Julian', description: 'a seven-year-old boy with blonde hair', clothing: 'a blue striped shirt', position: 'right foreground' },
];
/** Normalised detector boxes are [ymin, xmin, ymax, xmax]. */
const FIGURES = [
  { name: 'Levin', bodyBox: [0.10, 0.05, 0.90, 0.35], faceBoxRaw: [0.12, 0.13, 0.26, 0.27], score: 0.71 },
  { name: 'Julian', bodyBox: [0.10, 0.60, 0.90, 0.92], faceBoxRaw: [0.12, 0.70, 0.26, 0.84], score: 0.68 },
];

let PAGE: string;
beforeAll(async () => {
  const buf = await sharp({ create: { width: 512, height: 640, channels: 3, background: { r: 210, g: 205, b: 195 } } })
    .jpeg({ quality: 70 }).toBuffer();
  PAGE = `data:image/jpeg;base64,${buf.toString('base64')}`;
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key-not-used';
  process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-key-not-used';
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-used';
});

afterEach(() => { vi.unstubAllGlobals(); });

/** Record every URL called; answer the first call with `answer`, fail the rest. */
function stubVendors(answer: Record<string, string> | null, opts: { failFirst?: number } = {}) {
  const urls: string[] = [];
  let n = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(String(url));
    n++;
    if (opts.failFirst && n <= opts.failFirst) return { ok: false, status: 503, json: async () => ({}) };
    if (!answer) return { ok: false, status: 500, json: async () => ({}) };
    const text = JSON.stringify(answer);
    if (String(url).includes('openrouter')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) };
    if (String(url).includes('anthropic')) return { ok: true, status: 200, json: async () => ({ content: [{ text }] }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
  });
  return urls;
}

const host = (u: string) => new URL(u).host;

describe('secondOpinionIdentity — which witness is asked', () => {
  it('starts at the tier below the one that answers the primary pass, so Gemini is not re-asked', async () => {
    expect(SECOND_OPINION_START_TIER).toBe(1);
    const urls = stubVendors({ A: 'Levin', B: 'Julian' });
    const r = await secondOpinionIdentity(PAGE, FIGURES, CHARS, 'p1: ');
    expect(urls.length).toBe(1);
    expect(host(urls[0])).toBe('openrouter.ai');
    expect(r.model).toBe('qwen-vl-full');
  });

  it('excludes the model that already answered — a first witness asked twice is not a second one', async () => {
    const urls = stubVendors({ A: 'Levin', B: 'Julian' });
    const r = await secondOpinionIdentity(PAGE, FIGURES, CHARS, 'p1: ', { excludeModel: 'qwen-vl-full' });
    expect(urls.length).toBe(1);
    expect(host(urls[0])).toBe('api.anthropic.com');
    expect(r.model).toBe('haiku-full');
  });

  it('keeps the chain’s own fallback: a failed witness advances to the next tier', async () => {
    const urls = stubVendors({ A: 'Levin', B: 'Julian' }, { failFirst: 1 });
    const r = await secondOpinionIdentity(PAGE, FIGURES, CHARS, 'p1: ');
    expect(urls.map(host)).toEqual(['openrouter.ai', 'api.anthropic.com']);
    expect(r.model).toBe('haiku-full');
  });

  it('returns null — never a guess — when no tier answers', async () => {
    stubVendors(null);
    expect(await secondOpinionIdentity(PAGE, FIGURES, CHARS, 'p1: ')).toBe(null);
  });

  it('asks nobody when the page cannot be asked about', async () => {
    const urls = stubVendors({ A: 'Levin' });
    expect(await secondOpinionIdentity(PAGE, [], CHARS)).toBe(null);
    expect(await secondOpinionIdentity(PAGE, FIGURES, [])).toBe(null);
    expect(await secondOpinionIdentity('', FIGURES, CHARS)).toBe(null);
    expect(await secondOpinionIdentity('data:image/jpeg;base64,bm90YW5pbWFnZQ==', FIGURES, CHARS)).toBe(null);
    expect(urls.length).toBe(0);
  });
});

describe('secondOpinionIdentity — the answer is keyed by FIGURE, not by badge', () => {
  it('a plain two-figure page maps badge A/B onto figure 0/1', async () => {
    stubVendors({ A: 'Julian', B: 'Levin' });   // the witness disagrees with the detector
    const r = await secondOpinionIdentity(PAGE, FIGURES, CHARS, 'p1: ');
    expect([...r.nameByFigure.entries()]).toEqual([[0, 'Julian'], [1, 'Levin']]);
  });

  it('a figure with no usable box is skipped WITHOUT shifting the figures after it', async () => {
    // This is the whole reason the second opinion re-badges from the stored
    // figures rather than reusing the detector's badge indices: a badge index
    // and a figure index are different numbers the moment one figure drops out.
    const withBoxless = [
      FIGURES[0],
      { name: 'Ghost', score: 0.3 },          // no bodyBox, no gdinoBox
      FIGURES[1],
    ];
    stubVendors({ A: 'Levin', B: 'Julian' });
    const r = await secondOpinionIdentity(PAGE, withBoxless, CHARS, 'p1: ');
    expect([...r.nameByFigure.entries()]).toEqual([[0, 'Levin'], [2, 'Julian']]);
  });

  it('a figure the witness calls "unknown" simply gets no vote', async () => {
    stubVendors({ A: 'unknown', B: 'Julian' });
    const r = await secondOpinionIdentity(PAGE, FIGURES, CHARS, 'p1: ');
    expect([...r.nameByFigure.entries()]).toEqual([[1, 'Julian']]);
  });

  it('falls back to the padded face box, then to the body box, for the badge anchor', async () => {
    // Figures from the non-DINO paths carry faceBox but no raw box; figures
    // with neither still get badged at a quarter of their body height.
    const mixed = [
      { name: 'Levin', bodyBox: FIGURES[0].bodyBox, faceBox: [0.11, 0.12, 0.27, 0.28], score: 0.7 },
      { name: 'Julian', bodyBox: FIGURES[1].bodyBox, score: 0.6 },
    ];
    stubVendors({ A: 'Levin', B: 'Julian' });
    const r = await secondOpinionIdentity(PAGE, mixed, CHARS, 'p1: ');
    expect([...r.nameByFigure.entries()]).toEqual([[0, 'Levin'], [1, 'Julian']]);
  });
});

describe('secondOpinionIdentity — it asks the SAME question', () => {
  it('sends the badged image and the full identity lines, position hint included', async () => {
    let body: any = null;
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"A":"Levin","B":"Julian"}' } }] }) };
    });
    await secondOpinionIdentity(PAGE, FIGURES, CHARS, 'p1: ');
    const parts = body.messages[0].content;
    expect(parts[0].type).toBe('image_url');
    expect(parts[0].image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const prompt: string = parts[1].text;
    // The unabridged identity line — description, wardrobe and position hint —
    // is the `full` variant, the same one the primary pass sends.
    expect(prompt).toContain('a seven-year-old boy with short brown hair');
    expect(prompt).toContain('Wearing: a red hooded jacket');
    expect(prompt).toContain('left foreground');
    expect(prompt).toContain('black letter badges (A, B)');
    // AND THIS IS THE LIMIT OF THE MECHANISM: the question ranks clothing among
    // the first cues and demotes position to a hint. A second model reading a
    // page whose CLOTHING is the corrupted channel may reproduce the first
    // model's answer. Pinned so the caveat is visible in the test, not only in
    // a comment.
    expect(prompt).toContain('use the expected position/action as a supporting hint only');
  });
});
