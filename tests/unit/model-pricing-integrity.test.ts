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
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const {
  TEXT_MODELS,
  MODEL_PRICING,
  IMAGE_BACKENDS,
  INPAINT_BACKENDS,
  IMAGE_MODELS,
  GROK_VISION_FALLBACK,
  MODEL_DEFAULTS,
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

/**
 * RETIRED MODELS — the offline half of the dead-id guard.
 *
 * WHY THIS EXISTS — 2026-09-18. Six call sites (evalJudges, evalPipeline x3,
 * bboxDetection x2, sceneValidator, textModels) each hardcoded the string
 * 'grok-4-fast' as the Grok vision fallback. xAI retired that whole tier; not
 * one of the six moved, and nothing noticed for months, because:
 *
 *   1. A FALLBACK IS INVISIBLE BY CONSTRUCTION. It runs only after the primary
 *      has already failed, so a withdrawn id costs nothing on a normal day and
 *      shows up only in the moment it is most needed.
 *   2. THE GUARD MEASURED THE WRONG THING. Every site tested
 *      `TEXT_MODELS[id]?.provider === 'xai'` before calling — which asks
 *      whether the REPO has a config entry, not whether the VENDOR has a model.
 *      It passed happily on a dead id.
 *   3. IT DID NOT EVEN FAIL LOUDLY. xAI answers a retired id with a redirect to
 *      grok-4.3, so the call succeeded — at 6.25x the input price the code
 *      believed it was paying, recorded under a model id that no longer exists.
 *
 * Liveness itself cannot be asserted here: a unit test must not depend on the
 * network, and a hardcoded vendor catalogue would go stale and teach people to
 * edit the test instead of checking the vendor — the same reasoning that keeps
 * today's prices out of this file. scripts/admin/check-model-pricing.js does
 * the live half against the vendors' own APIs.
 *
 * What IS assertable offline is the consequence: once a model is known dead and
 * marked `retired`, no live code path may still resolve to it.
 */
describe('retired models — nothing live may resolve to one', () => {
  type Cfg = { provider: string; modelId: string; retired?: string; redirectsTo?: string };
  const entries = Object.entries(TEXT_MODELS as Record<string, Cfg>);
  const retiredKeys = entries.filter(([, c]) => c.retired).map(([k]) => k);

  it('every `retired` marker is an ISO date, not a truthy flag', () => {
    // A bare `retired: true` loses the one fact that matters later: when it was
    // checked, and therefore how much to trust it.
    for (const [key, cfg] of entries) {
      if (cfg.retired === undefined) continue;
      expect(`${key}=${cfg.retired}`).toMatch(/^[^=]+=\d{4}-\d{2}-\d{2}$/);
      expect(Date.parse(cfg.retired)).not.toBeNaN();
    }
  });

  it('a retired entry keeps its price, so historical usage rows still cost out', () => {
    // These entries are deliberately NOT deleted: stories generated while the
    // model was alive still name it in tokenUsage, and dropping the row would
    // silently re-price months of history at $0.00.
    for (const key of retiredKeys) {
      const cfg = TEXT_MODELS[key] as Cfg;
      expect(`${key}:priced=${!!MODEL_PRICING[cfg.modelId]}`).toBe(`${key}:priced=true`);
    }
  });

  it('`redirectsTo`, where present, names a live TEXT_MODELS entry', () => {
    for (const [key, cfg] of entries) {
      if (!cfg.redirectsTo) continue;
      const target = TEXT_MODELS[cfg.redirectsTo] as Cfg | undefined;
      expect(`${key}->${cfg.redirectsTo}: exists=${!!target}, retired=${!!target?.retired}`)
        .toBe(`${key}->${cfg.redirectsTo}: exists=true, retired=false`);
    }
  });

  it('no MODEL_DEFAULTS slot points at a retired model', () => {
    const bad = Object.entries(MODEL_DEFAULTS as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && (TEXT_MODELS[v as string] as Cfg | undefined)?.retired)
      .map(([slot, v]) => `${slot} -> ${v}`);
    expect(bad).toEqual([]);
  });

  it('GROK_VISION_FALLBACK names a live xAI entry', () => {
    // The specific slot this whole class of bug lived in. It must be xAI —
    // every call site hands it to callGrokVisionAPI, which posts to api.x.ai
    // regardless of what `provider` says — and it must not be retired.
    const cfg = TEXT_MODELS[GROK_VISION_FALLBACK] as Cfg | undefined;
    expect(`${GROK_VISION_FALLBACK}: exists=${!!cfg}, provider=${cfg?.provider}, retired=${cfg?.retired ?? 'no'}`)
      .toBe(`${GROK_VISION_FALLBACK}: exists=true, provider=xai, retired=no`);
  });

  it('no server source file hardcodes a retired model key', () => {
    // The actual reintroduction path. Not "does a dead id exist in the repo" —
    // the retired entries and their prices are supposed to exist, and so are
    // the comments explaining them. This asks the narrower question: does any
    // file OUTSIDE the config hand a retired key to code as a live value?
    const ROOT = join(__dirname, '..', '..');
    const SEARCH = ['server'];
    const SKIP_FILES = new Set([join(ROOT, 'server', 'config', 'models.js')]);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.js') && !SKIP_FILES.has(full)) files.push(full);
      }
    };
    for (const d of SEARCH) walk(join(ROOT, d));

    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        // Comments are where a retirement gets EXPLAINED, so they are allowed;
        // a quoted key in executable code is not.
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (!code.trim() || /^\s*\*/.test(line)) return;
        for (const key of retiredKeys) {
          if (code.includes(`'${key}'`) || code.includes(`"${key}"`)) {
            offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1} uses retired '${key}' — ${line.trim().slice(0, 90)}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
