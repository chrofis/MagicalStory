/**
 * Sheet style judge ARMS (Test Lab only, server/lib/sheetJudgeArms.js) and the
 * `sheet_style` judge fixture (server/lib/judgeFixtures.js). Production runs arm
 * `current`; these pin that it still does, and that each candidate arm builds a
 * complete, fillable prompt from the CURRENT template — never silently the
 * production one — so a Lab number measures the arm it names.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const ARMS = cjs('../../server/lib/sheetJudgeArms.js');
const JF = cjs('../../server/lib/judgeFixtures.js');
const SHEET = cjs('../../server/lib/character2x4Sheet.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = cjs('../../server/services/prompts.js');

let template = '';
beforeAll(async () => { await loadPromptTemplates(); template = String(PROMPT_TEMPLATES.sheet2x4StyleEval); });

const IMG = (n: string) => `data:image/jpeg;base64,${n}`;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Run the real evaluator with fetch stubbed; return the parts it sent. */
async function sentParts(opts: Record<string, unknown>) {
  let body: any = null;
  const scores = Object.fromEntries(JF.SHEET_STYLE_AXES.map((a: string) => [`${a}Score`, 9]));
  globalThis.fetch = (async (_url: string, init: any) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(scores) }] } }] }) };
  }) as any;
  await SHEET._internal.evaluateStyledSheetWithGemini(IMG('FACE'), IMG('REF'), IMG('SHEET'), 'watercolor', 'k', null, '7', opts);
  return body.contents[0].parts as Array<{ text?: string; inline_data?: { data: string } }>;
}
const shape = (parts: any[]) => parts.map(p => (p.inline_data ? `img:${p.inline_data.data}` : 'text'));

describe('arm current is production', () => {
  it('no template override, no labels, the Pass-1 reference', () => {
    expect(ARMS.resolveArm('current', template)).toEqual({ arm: 'current', applied: 'current', reference: 'pass1', template: null, imageLabels: null });
  });

  it('production still sends three unlabelled images, then the prompt', async () => {
    expect(shape(await sentParts({}))).toEqual(['img:FACE', 'img:REF', 'img:SHEET', 'text']);
  });
});

describe('the candidate arms', () => {
  it('A labels every image and keeps the template', async () => {
    const a = ARMS.resolveArm('A', template);
    expect(a.template).toBeNull();
    const parts = await sentParts({ imageLabels: a.imageLabels });
    expect(shape(parts)).toEqual(['text', 'img:FACE', 'text', 'img:REF', 'text', 'img:SHEET', 'text']);
    expect(parts[4].text).toMatch(/^Image 3 — /);
  });

  it('AB asks for every cell\'s medium and one medium for all 8; TASK 1 untouched', () => {
    const t = ARMS.resolveArm('AB', template).template;
    expect(t).toMatch(/name the medium of each of the 8 cells of Image 3/);
    expect(t).toMatch(/All 8 cells are drawn in that one style/);
    expect(t).not.toMatch(/cut off at the bottom of the cell/);
    expect(t).toMatch(/"style":\s+\{"score": <1-10>, "reason": "cell1: <medium>/);
  });

  it('ABC also scores each cell\'s framing against Image 2', () => {
    const t = ARMS.resolveArm('ABC', template).template;
    expect(t).toMatch(/name the medium of each of the 8 cells/);
    expect(t).toMatch(/cut off at a different place than Image 2's same cell/);
  });

  it('D judges a variant against its styled base; a sheet with nothing off runs ABC', () => {
    const v = ARMS.resolveArm('D', template, { variant: true });
    expect(v.applied).toBe('D');
    expect(v.reference).toBe('styledBase');
    expect(v.template).toMatch(/Image 2: the APPROVED styled 2×4 sheet/);
    expect(v.template).not.toMatch(/Image 2: the REALISTIC/);
    expect(v.template).toMatch(/same medium as Image 2's same cell/);
    expect(v.imageLabels[1]).toMatch(/approved styled sheet/);
    const b = ARMS.resolveArm('D', template, { variant: false });
    expect(b).toMatchObject({ applied: 'ABC', reference: 'pass1' });
    expect(b.template).toBe(ARMS.resolveArm('ABC', template).template);
  });

  it('every arm keeps every placeholder and the ten-axis final line, and builds a filled prompt', async () => {
    for (const arm of ARMS.SHEET_JUDGE_ARMS) {
      for (const variant of [false, true]) {
        const r = ARMS.resolveArm(arm, template, { variant });
        const t = r.template ?? template;
        for (const ph of ['{REAR_TURN}', '{SHEET_GROUND}', '{SHEET_LETTERING}', '{GARMENT_COLOUR}', '{GARMENTS_REMOVED}', 'REQUESTED_STYLE', 'CHARACTER_AGE']) {
          expect(t, `${arm}/${variant}: ${ph}`).toContain(ph);
        }
        expect(t).toMatch(/LOWEST of layoutScore, identityScore, styleScore, cleanScore, bodyFaceScore, ageScore, soloScore, backgroundScore, garmentScore, removedScore\./);
        // The real builder fills it and the parts guard accepts it.
        const parts = await sentParts({ promptOverride: r.template, imageLabels: r.imageLabels, removedGarments: variant ? ['a coat'] : [] });
        const prompt = parts[parts.length - 1].text || '';
        expect(prompt).not.toMatch(/\{[A-Z_]+\}/);
        expect(prompt).toContain('REQUESTED_STYLE: ');
      }
    }
  });

  it('a template the arm cannot find its block in, or an unknown arm, fails loudly', () => {
    expect(() => ARMS.resolveArm('AB', template.replace('TASK 3: STYLE MATCH', 'TASK 3: SOMETHING ELSE'))).toThrow(/TASK 3: STYLE MATCH/);
    expect(() => ARMS.resolveArm('E', template)).toThrow(/unknown arm/);
    expect(() => SHEET._internal.evaluateStyledSheetWithGemini(IMG('F'), IMG('R'), IMG('S'), 'watercolor', 'k', null, '7', { imageLabels: ['one'] }))
      .rejects.toThrow(/three strings/);
  });
});

describe('the sheet_style judge fixture', () => {
  const verdict = { layoutScore: 9, identityScore: 9, styleScore: 3, style: { score: 3, reason: 'cells 1-4 are ink line art' }, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9, backgroundScore: 9, garmentScore: 9, removedScore: 10 };

  it('every axis under the ship line is one finding, typed by the axis', () => {
    expect(JF.normalizeFindings('sheet_style', { verdict })).toEqual([
      { type: 'style', severity: null, text: 'cells 1-4 are ink line art', character: null, pages: [], fields: { score: 3 } },
    ]);
    expect(JF.normalizeFindings('sheet_style', { verdict: { ...verdict, styleScore: 9, style: { score: 9 } } })).toEqual([]);
  });

  it('flag = rejected for the expected axis; a rejection for another axis is a miss', () => {
    const f = JF.normalizeFindings('sheet_style', { verdict });
    expect(JF.scoreFixture({ verdict: 'flag', types: ['style'] }, f).outcome).toBe('TP');
    expect(JF.scoreFixture({ verdict: 'flag', types: ['removed'] }, f).outcome).toBe('FN');
    expect(JF.scoreFixture({ verdict: 'pass' }, f).outcome).toBe('FP');
    expect(JF.scoreFixture({ verdict: 'pass' }, []).outcome).toBe('TN');
  });

  it('a fixture names its character, sheet, base entry, and — when a garment is off — its styled base', () => {
    const ok = { id: 'sheet-x', judge: 'sheet_style', target: { storyId: 's', character: 'A' }, input: { imageUrl: 'https://x/a.jpg', entryIndex: 0 }, expect: { verdict: 'pass' }, source: 'viewed' };
    expect(JF.validateFixtures([ok])).toEqual([]);
    expect(JF.validateFixtures([{ ...ok, input: { imageUrl: 'https://x/a.jpg' } }]).join()).toMatch(/entryIndex/);
    expect(JF.validateFixtures([{ ...ok, input: { ...ok.input, removedGarments: ['coat'] } }]).join()).toMatch(/baseImageUrl/);
    expect(JF.validateFixtures([{ ...ok, expect: { verdict: 'flag', minSeverity: 'MAJOR' } }]).join()).toMatch(/no severity/);
  });

  it('cost is measured from the usage the stage adds up', () => {
    expect(JF.estimateCostUsd('sheet_style', { usage: { input_tokens: 1e6, output_tokens: 0, thinking_tokens: 0 } })).toEqual({ usd: 0.3, basis: 'measured (input + output + thinking, every call incl. a re-ask)' });
  });
});
