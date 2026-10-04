/**
 * Pass 2 of the avatar 2×4 sheet keeps every garment's colour from the pass-1
 * sheet, and its style judge scores exactly that.
 *
 * Staging job_1791040103540_atbttop6w (dragon run 9): Kiaan's outfit was a
 * purple jacket; pass 1 drew it purple and its judges saw purple, then the
 * watercolour style transfer repainted it navy. The restyle prompt protected
 * only hair and skin, the style swatch was offered as a "palette" source, and
 * the style judge was told the outfit is not scored — so nothing caught it.
 *
 * One rule (garmentColourRule) is stated to the restyler about Image 1 and to
 * the judge about Image 2 (the same pass-1 sheet in each call). A recoloured
 * garment fails the verdict and goes through the existing retry path; it is
 * a quality axis, not an identity one, so it ships with a warning on the
 * final strike like the other quality axes.
 *
 * Behaviour is pinned (built prompts, computed verdicts), not template wording.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const { loadPromptTemplates } = require('../../server/services/prompts');
const sheetMod = require('../../server/lib/character2x4Sheet');
const sheet = { ...sheetMod, ...sheetMod._internal };
const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/character2x4Sheet.js'), 'utf8');

const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';
const GOOD = { layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9, backgroundScore: 9, garmentScore: 9 };

describe('generator: the restyler keeps garment colours from the pass-1 sheet', () => {
  it('both prompt variants state the garment-colour rule about Image 1', () => {
    for (const hasAnchor of [true, false]) {
      expect(sheet.buildStyleTransferPrompt('watercolor', { hasAnchor })).toContain(sheet.garmentColourRule('Image 1'));
    }
  });

  it('the style swatch is no longer a colour source', () => {
    const p = sheet.buildStyleTransferPrompt('watercolor', { hasAnchor: true });
    const anchorLine = p.split('\n').find((l: string) => l.startsWith('Image 2 is a swatch'))!;
    expect(anchorLine).toBeTruthy();
    expect(anchorLine).not.toMatch(/palette/);
    expect(anchorLine).toMatch(/garment colour in the output comes from Image 1/);
  });
});

describe('critic: the style judge is sent the same rule and scores it', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  beforeAll(async () => { await loadPromptTemplates(); });

  const capture = (verdict: object) => {
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      sent.push(body.contents[0].parts.map((p: any) => p.text || '').join('\n'));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }], usageMetadata: {} }), text: async () => '' };
    }) as any;
    return sent;
  };

  it('the built judge prompt carries the rule about Image 2 (the pass-1 sheet), no raw placeholder', async () => {
    const sent = capture({ ...GOOD, garment: { score: 9, reason: 'jacket: purple / purple' } });
    const { promptUsed } = await sheet.evaluateStyledSheetWithGemini(ROW, ROW, ROW, 'watercolor', 'k', null, 7);
    expect(promptUsed).toContain(sheet.garmentColourRule('Image 2'));
    expect(sent[0]).toContain(sheet.garmentColourRule('Image 2'));
    expect(sent[0]).not.toContain('{GARMENT_COLOUR}');
    expect(sent[0]).toMatch(/garmentScore/);
  });

  it('a recoloured garment sinks a verdict the model scored 9', async () => {
    capture({ ...GOOD, garmentScore: undefined, garment: { score: 3, reason: 'jacket: purple in Image 2, navy in Image 3' }, finalScore: 9, valid: true, failureReasons: [] });
    const { report } = await sheet.evaluateStyledSheetWithGemini(ROW, ROW, ROW, 'watercolor', 'k', null, 7);
    expect(report.garmentScore).toBe(3);
    expect(report.finalScore).toBe(3);
    expect(report.valid).toBe(false);
    expect(report.failureReasons.join(' ')).toMatch(/garment: jacket: purple in Image 2, navy/);
  });
});

// ── The retry path, with the REAL runStyleTransferPass sliced into a vm ──────
function extractFunction(src: string, name: string): string {
  const start = src.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`could not find function ${name}`);
  let p = src.indexOf('(', start);
  let pdepth = 0;
  for (; p < src.length; p++) {
    if (src[p] === '(') pdepth++;
    else if (src[p] === ')') { pdepth--; if (pdepth === 0) { p++; break; } }
  }
  let i = src.indexOf('{', p);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const CONSTS = [/const SHEET_VALID_MIN = [^;]+;/, /const STYLED_IDENTITY_AXES = [^;]+;/]
  .map(re => { const m = SRC.match(re); if (!m) throw new Error(`constant not found: ${re}`); return m[0]; })
  .join('\n');

async function runPass2(attempts: Record<string, number>[]) {
  let gens = 0;
  const ctx: any = {
    module: { exports: {} },
    log: { info() {}, debug() {}, error() {}, warn() {} },
    MAX_SHEET_RETRIES: attempts.length - 1,
    MODEL_DEFAULTS: { avatarStyleTransferBackend: 'grok' },
    process: { env: { GEMINI_API_KEY: 'k' } },
    loadStyleAnchor: () => null,
    buildStyleTransferPrompt: () => 'P',
    quickLayoutCheck: async () => ({ valid: true }),
    styleTransferGenerate: async () => { gens++; return { imageData: `STYLED_${gens}`, provider: 'grok', modelId: 'm', usage: null }; },
    // The verdict goes through the REAL scorer, so the garment axis is counted
    // exactly as production counts it.
    evaluateAvatarSheet: async () => ({ verdict: sheet.scoreStyleReport({ ...attempts[gens - 1] }), promptUsed: 'J' }),
    require: (id: string) => (id === '../config/models' ? { MODEL_PRICING: {} } : {}),
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${CONSTS}\n${extractFunction(SRC, 'runStyleTransferPass')}\nmodule.exports = runStyleTransferPass;`, ctx);
  const out = await ctx.module.exports({ pass1ImageData: 'PASS1', facePhoto: 'FACE', artStyle: 'watercolor', characterName: 'Kid', usageTracker: null });
  return { out, gens };
}

describe('a garment recolour goes through the existing retry path', () => {
  it('attempt 1 recolours a garment → retried, the faithful attempt 2 ships valid', async () => {
    const { out, gens } = await runPass2([{ ...GOOD, garmentScore: 3 }, GOOD]);
    expect(gens).toBe(2);
    expect(out.valid).toBe(true);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.attempts[0].garmentScore).toBe(3);
  });

  it('a recolour on every attempt is a quality failure: ships with a warning, not identity-rejected', async () => {
    const { out } = await runPass2([{ ...GOOD, garmentScore: 3 }, { ...GOOD, garmentScore: 4 }]);
    expect(out.valid).toBe(false);
    expect(out.shippable).toBe(true);
    expect(out.imageData).toBe('STYLED_2');
    expect(out.attempts.every((a: any) => !a.identityRejected)).toBe(true);
  });
});
