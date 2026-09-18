/**
 * MODEL_PRICING integrity — the invariants, never today's prices.
 *
 * WHY THIS EXISTS — 2026-09-18 (backlog #27). The table in
 * server/config/models.js is hand-maintained against rates that move, and it had
 * drifted three different ways at once:
 *
 *   1. deepseek-v4-pro was priced 0.435/0.87 while OpenRouter charges 1.60/3.20
 *      — 3.68x under, on the reviewer for three stages, so every per-story cost
 *      figure that included it was low. deepseek-v4-flash was 2.84x OVER and
 *      qwen2.5-vl 3.2x under, so "the table is conservative" was never true.
 *   2. TWELVE models wired up in TEXT_MODELS had no entry at all, so
 *      calculateTextCost returned $0.00 for them — including x-ai/grok-4.6, the
 *      DEFAULT reviewer on four stages.
 *   3. One model's price existed in three hand-kept copies that disagreed:
 *      gemini image was 0.03 in INPAINT_BACKENDS, 0.035 in IMAGE_BACKENDS and
 *      0.04 in MODEL_PRICING, and the vendor says 0.039.
 *
 * A test that hardcoded the 2026-09-18 numbers would fail the next time a vendor
 * moves one, which teaches people to edit the test instead of checking the
 * vendor. So this file pins only things that must be true at EVERY price level:
 * that a configured model is priced at all, that a price is well-formed, that
 * the several copies of one model's price agree, and that the prose figure in a
 * model's own description matches the number the code actually bills with.
 * Class 1 (a wrong-but-well-formed number) is not unit-testable — that is what
 * scripts/admin/check-model-pricing.js is for, against the live vendor APIs.
 */
import { describe, it, expect } from 'vitest';

const {
  TEXT_MODELS,
  MODEL_PRICING,
  IMAGE_BACKENDS,
  INPAINT_BACKENDS,
  IMAGE_MODELS,
  PRICING_VERIFIED_ON,
  calculateTextCost,
  calculateImageCost,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require('../../server/config/models');

type TokenPrice = { input: number; output: number; thinking?: number };
type ImagePrice = { perImage: number };
type Price = Partial<TokenPrice & ImagePrice>;

const tokenEntries = (): [string, TokenPrice][] =>
  Object.entries(MODEL_PRICING as Record<string, Price>)
    .filter(([, v]) => v.perImage === undefined)
    .map(([k, v]) => [k, v as TokenPrice]);

const imageEntries = (): [string, ImagePrice][] =>
  Object.entries(MODEL_PRICING as Record<string, Price>)
    .filter(([, v]) => v.perImage !== undefined)
    .map(([k, v]) => [k, v as ImagePrice]);

describe('MODEL_PRICING — every configured model is priced', () => {
  it('every TEXT_MODELS entry has a MODEL_PRICING entry for its modelId', () => {
    const missing = Object.entries(TEXT_MODELS as Record<string, { modelId: string }>)
      .filter(([, cfg]) => cfg.modelId && !MODEL_PRICING[cfg.modelId])
      .map(([key, cfg]) => `${key} -> ${cfg.modelId}`);
    // A model with no entry is billed as $0.00 by calculateTextCost. That is how
    // grok-4.6, the default reviewer on four stages, reported free for a month.
    expect(missing).toEqual([]);
  });

  it('calculateTextCost charges something for every TEXT_MODELS model', () => {
    const free: string[] = [];
    for (const [key, cfg] of Object.entries(TEXT_MODELS as Record<string, { modelId: string }>)) {
      if (!cfg.modelId) continue;
      const cost = calculateTextCost(cfg.modelId, { input_tokens: 10_000, output_tokens: 10_000 });
      if (!(cost > 0)) free.push(`${key} -> ${cfg.modelId}`);
    }
    expect(free).toEqual([]);
  });

  it('a model resolves to its OWN price, never a lookalike key it was normalised onto', () => {
    // calculateTextCost strips a trailing -<digits> and then prefix-matches, so a
    // revision id like deepseek/deepseek-v4-pro-0813 silently borrowed
    // deepseek/deepseek-v4-pro's rate until it got its own line.
    for (const [key, price] of tokenEntries()) {
      const got = calculateTextCost(key, { input_tokens: 1_000_000, output_tokens: 0 });
      expect(`${key}=${got.toFixed(6)}`).toBe(`${key}=${price.input.toFixed(6)}`);
    }
  });
});

describe('MODEL_PRICING — every entry is well-formed', () => {
  it('each entry is token-priced or per-image, never both and never neither', () => {
    for (const [key, v] of Object.entries(MODEL_PRICING as Record<string, Price>)) {
      const isToken = v.input !== undefined || v.output !== undefined;
      const isImage = v.perImage !== undefined;
      expect(`${key}:${isToken}/${isImage}`).toBe(`${key}:${!isImage}/${isImage}`);
    }
  });

  it('every price is a finite positive number', () => {
    for (const [key, p] of tokenEntries()) {
      for (const field of ['input', 'output', 'thinking'] as const) {
        const val = p[field];
        if (val === undefined) continue;
        expect(`${key}.${field}=${Number.isFinite(val) && val > 0}`).toBe(`${key}.${field}=true`);
      }
    }
    for (const [key, p] of imageEntries()) {
      expect(`${key}=${Number.isFinite(p.perImage) && p.perImage > 0}`).toBe(`${key}=true`);
    }
  });

  it('output is never cheaper than input (true of every vendor rate card so far)', () => {
    // Not a law of nature, but no provider this project has ever used prices
    // completion below prompt. If one ever does, that line deserves a comment
    // saying so before this assertion is relaxed.
    for (const [key, p] of tokenEntries()) {
      expect(`${key}:${p.output >= p.input}`).toBe(`${key}:true`);
    }
  });

  it("`thinking`, where present, equals `output`", () => {
    // Every provider here bills reasoning at the completion rate, and OpenRouter
    // already counts reasoning tokens inside completion_tokens. A `thinking` that
    // differs from `output` means someone invented a third rate.
    for (const [key, p] of tokenEntries()) {
      if (p.thinking === undefined) continue;
      expect(`${key}=${p.thinking}`).toBe(`${key}=${p.output}`);
    }
  });

  it('PRICING_VERIFIED_ON is a real date, not in the future', () => {
    expect(PRICING_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(PRICING_VERIFIED_ON)).not.toBeNaN();
    expect(Date.parse(PRICING_VERIFIED_ON)).toBeLessThanOrEqual(Date.now());
  });
});

describe('MODEL_PRICING — the copies of one price agree', () => {
  // The Gemini image price lived in three hand-kept places and all three
  // disagreed. Whichever one a caller happened to read decided the number.
  it('the Gemini image price is the same in MODEL_PRICING, IMAGE_BACKENDS and INPAINT_BACKENDS', () => {
    const table = MODEL_PRICING['gemini-2.5-flash-image']?.perImage;
    expect(IMAGE_BACKENDS.gemini.costPerImage).toBe(table);
    expect(INPAINT_BACKENDS.gemini.costPerImage).toBe(table);
  });

  it('the Grok image price is the same in MODEL_PRICING and IMAGE_BACKENDS', () => {
    expect(IMAGE_BACKENDS.grok.costPerImage).toBe(MODEL_PRICING['grok-imagine-image']?.perImage);
  });

  it('the Runware FLUX Schnell price is the same in MODEL_PRICING and IMAGE_BACKENDS', () => {
    expect(IMAGE_BACKENDS.runware.costPerImage).toBe(MODEL_PRICING['runware:5@1']?.perImage);
  });

  it('calculateImageCost agrees with the table for every IMAGE_MODELS entry that names a priced modelId', () => {
    for (const [key, cfg] of Object.entries(IMAGE_MODELS as Record<string, { modelId?: string }>)) {
      const perImage = cfg.modelId ? MODEL_PRICING[cfg.modelId]?.perImage : undefined;
      if (perImage === undefined) continue;
      expect(`${key}=${calculateImageCost(key, 3)}`).toBe(`${key}=${perImage * 3}`);
    }
  });
});

describe('MODEL_PRICING — the prose figure matches the billed figure', () => {
  // Every TEXT_MODELS description quotes its own "$in/$out". Those strings are a
  // second hand-kept copy of the table, and on 2026-09-18 fifteen of them
  // disagreed with it — including the one the reviewer-model choice was argued
  // from. Whenever a rate changes, the description must move with it.
  const PAIR = /\$(\d+(?:\.\d+)?)\s*\/\s*\$(\d+(?:\.\d+)?)/;
  const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(b * 0.1, 1e-4);

  it('no description quotes a price that contradicts MODEL_PRICING', () => {
    const bad: string[] = [];
    for (const [key, cfg] of Object.entries(
      TEXT_MODELS as Record<string, { modelId: string; description?: string }>
    )) {
      const m = cfg.description?.match(PAIR);
      if (!m) continue;                       // no price quoted — nothing to check
      const price = MODEL_PRICING[cfg.modelId] as TokenPrice | undefined;
      if (!price || price.input === undefined) continue;
      const [, sIn, sOut] = m;
      if (!near(parseFloat(sIn), price.input) || !near(parseFloat(sOut), price.output)) {
        bad.push(
          `${key}: description says $${sIn}/$${sOut}, table says $${price.input}/$${price.output}`
        );
      }
    }
    expect(bad).toEqual([]);
  });
});
