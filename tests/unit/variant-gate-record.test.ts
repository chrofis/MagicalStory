/**
 * THE VARIANT GATE'S ANSWER IS STORED (2026-10-05).
 *
 * Staging job_1791145238223_50osg2osm: two off-garment variants were made and
 * served, the garment-gone check ran twice and was billed, and its answer was
 * stored nowhere. Pinned: every attempt carries its gate answer (style verdict,
 * each per-garment question and answer, accept/reject), a rejected redress still
 * returns that record, and the log entry built from it holds text only.
 * The model is stubbed (fetch for the judges, the Grok edit for the generator).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const { loadPromptTemplates } = cjs('../../server/services/prompts.js');

const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const STYLE_OK = { layoutScore: 9, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9, backgroundScore: 9 };

let SHEET: any;
let SA: any;
const realFetch = globalThis.fetch;
let editCalls = 0;

// garmentAnswers[i] = what the i-th garment-gone question answers (visible?)
function stubJudges(garmentAnswers: boolean[]) {
  let q = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    const text = JSON.parse(init.body).contents[0].parts.map((p: any) => p.text || '').join('\n');
    const verdict = /is .+ visible on the figure/.test(text)
      ? { cells: 'cell1: red coat; cell2: red coat', visible: garmentAnswers[q++], reason: garmentAnswers[q - 1] ? 'cell 3 shows a mitten' : 'no cell shows it' }
      : STYLE_OK;
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }], usageMetadata: {} }), text: async () => '' };
  }) as any;
}

beforeAll(async () => {
  await loadPromptTemplates();
  // The generator: swap the Grok edit before the sheet module captures it.
  const grok = cjs('../../server/lib/grok.js');
  grok.editWithGrok = async () => { editCalls++; return { imageData: PIXEL, usage: { cost: 0 }, modelId: 'stub' }; };
  delete cjs.cache[cjs.resolve('../../server/lib/character2x4Sheet.js')];
  SHEET = cjs('../../server/lib/character2x4Sheet.js');
  SA = cjs('../../server/lib/styledAvatars.js');
});
afterEach(() => { globalThis.fetch = realFetch; editCalls = 0; });

const OPTS = {
  characterName: 'Daniel', authoredWardrobe: 'The bolt is off; the tunic stays.', removedItems: ['bolt'],
  facePhoto: PIXEL, realisticSheet: PIXEL, artStyle: 'watercolor', characterAge: 8,
};

describe('redressSheetVariant stores the gate answer', () => {
  it('a rejected first attempt and an accepted second both carry their style verdict and per-garment answer', async () => {
    process.env.GEMINI_API_KEY ||= 'test-key';
    stubJudges([true, false]); // attempt 1: bolt still visible; attempt 2: gone
    const out = await SHEET.redressSheetVariant(PIXEL, OPTS);
    expect(out.accepted).toBe(true);
    expect(out.attempts).toHaveLength(2);
    const [a1, a2] = out.attempts;
    expect(a1.accepted).toBe(false);
    expect(a1.gate.style).toMatchObject({ score: 9, valid: true });
    expect(a1.gate.garmentChecks).toHaveLength(1);
    expect(a1.gate.garmentChecks[0]).toMatchObject({ garment: 'bolt', visible: true, reason: 'cell 3 shows a mitten' });
    expect(a1.gate.garmentChecks[0].question).toContain('is bolt visible');
    expect(a1.gate.removedScore).toBe(1);
    expect(a1.gate.valid).toBe(false);
    expect(a2.accepted).toBe(true);
    expect(a2.gate.garmentChecks[0].visible).toBe(false);
    expect(a2.gate.removedScore).toBe(10);
  });

  it('every attempt rejected: no image, but the record is returned (it used to be null)', async () => {
    process.env.GEMINI_API_KEY ||= 'test-key';
    stubJudges([true, true]);
    const out = await SHEET.redressSheetVariant(PIXEL, OPTS);
    expect(out.imageData).toBeNull();
    expect(out.accepted).toBe(false);
    expect(out.attempts.map((a: any) => a.accepted)).toEqual([false, false]);
    expect(out.attempts.every((a: any) => a.gate.garmentChecks[0].visible)).toBe(true);
  });
});

describe('the variant log entry (styledAvatarGeneration)', () => {
  const job = { charName: 'Daniel', row: { clothingCategory: 'costumed--off:ART004', removedItemNames: ['bolt'] }, off: { offIds: ['ART004'] } };

  it('holds the verdicts and no image bytes, accepted or rejected', async () => {
    process.env.GEMINI_API_KEY ||= 'test-key';
    for (const answers of [[true, false], [true, true]]) {
      stubJudges(answers);
      const out = await SHEET.redressSheetVariant(PIXEL, OPTS);
      const entry = SA.variantLogEntry(job, 'watercolor', out, 1234);
      expect(entry.success).toBe(out.accepted);
      expect(entry.clothingCategory).toBe('costumed--off:ART004');
      expect(entry.variant.attempts).toHaveLength(2);
      expect(entry.variant.attempts[0].gate.garmentChecks[0].garment).toBe('bolt');
      expect(entry.variant.accepted).toBe(out.accepted);
      expect(JSON.stringify(entry)).not.toMatch(/data:image|base64/);
      if (!out.accepted) expect(entry.warning).toMatch(/every attempt rejected/);
    }
  });

  it('a redress that refused before any edit still yields an entry that says so', () => {
    const entry = SA.variantLogEntry(job, 'watercolor', null, 5);
    expect(entry.success).toBe(false);
    expect(entry.variant.attempts).toEqual([]);
    expect(entry.warning).toMatch(/refused before any edit/);
  });
});
