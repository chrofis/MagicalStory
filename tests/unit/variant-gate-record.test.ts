/**
 * THE VARIANT GATE'S ANSWER IS STORED (2026-10-05).
 *
 * Staging job_1791145238223_50osg2osm: two off-garment variants were made and
 * served, the garment-gone check ran twice and was billed, and its answer was
 * stored nowhere. Pinned: every attempt carries its gate answer (the sheet judge's flags,
 * each per-garment question and answer, accept/reject), a rejected redress still
 * returns that record, and the log entry built from it holds text only.
 * The model is stubbed (fetch for the judges, the Grok edit for the generator).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const cjs = createRequire(import.meta.url);
const { loadPromptTemplates } = cjs('../../server/services/prompts.js');

// Big enough to split into its two rows (the styled judge asks its per-cell checks of each row).
const PIXEL = 'data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z';
// The ONE sheet judge's clean answer (every type ok, 8 cells without a defect); stored sheet flags are [] for it.
const JUDGE_OK = {
  cells: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ cell: n, headgear: 'none', hairVisible: 'full', hairColour: 'brown', hairStyle: 'down', head: 'present', top: 'grey tunic', extras: 'none', heldObject: 'none' })),
  hat: { verdict: 'ok', cells: [] }, hair: { verdict: 'ok', cells: [] }, bald: { verdict: 'ok', cells: [] }, costume: { verdict: 'ok', cells: [] },
  rowMatch: { verdict: 'ok', cells: [] }, held: { verdict: 'ok', cells: [] }, tail: { verdict: 'ok', cells: [] }, layout: { verdict: 'ok', cells: [] },
  identity: { verdict: 'ok', cells: [] }, age: { verdict: 'ok', cells: [] }, evidence: 'none',
};

let SHEET: any;
let SA: any;
const realFetch = globalThis.fetch;
let editCalls = 0;

// garmentAnswers[i] = what the i-th garment-gone question answers (visible?)
// keptAnswers[i] = what the i-th kept-garment question answers (visible in body cells 5-8?)
const sentQuestions: string[] = [];
function stubJudges(garmentAnswers: boolean[], keptAnswers: boolean[] = [true, true, true, true]) {
  let q = 0;
  let k = 0;
  sentQuestions.length = 0;
  globalThis.fetch = (async (_u: any, init: any) => {
    const text = JSON.parse(init.body).contents[0].parts.map((p: any) => p.text || '').join('\n');
    if (/is .+ visible on the figure in cells 5 to 8/.test(text)) sentQuestions.push(text);
    const keptAns = /is .+ visible on the figure in cells 5 to 8/.test(text) ? keptAnswers[k++] : null;
    const verdict = keptAns !== null
      ? { cells: 'cell5: yes; cell6: yes; cell7: yes; cell8: yes', visible: keptAns, reason: keptAns ? 'all four show it' : 'cells 5-8 show no strap' }
      : /is .+ visible on the figure/.test(text)
      ? { cells: 'cell1: red coat; cell2: red coat', visible: garmentAnswers[q++], reason: garmentAnswers[q - 1] ? 'cell 3 shows a mitten' : 'no cell shows it' }
      : JUDGE_OK;
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
  keptGarments: [{ type: 'baldric', colour: 'brown', details: 'leather, wide' }, { type: 'tunic', colour: 'grey', details: 'wool' }],
};

describe('redressSheetVariant stores the gate answer', () => {
  it('a rejected first attempt and an accepted second both carry the sheet-judge flags and the per-garment answer', async () => {
    process.env.GEMINI_API_KEY ||= 'test-key';
    stubJudges([true, false]); // attempt 1: bolt still visible; attempt 2: gone
    const out = await SHEET.redressSheetVariant(PIXEL, OPTS);
    expect(out.accepted).toBe(true);
    expect(out.attempts).toHaveLength(2);
    const [a1, a2] = out.attempts;
    expect(a1.accepted).toBe(false);
    expect(a1.gate.sheetFlags).toEqual([]);
    expect(a1.gate.garmentChecks).toHaveLength(1);
    expect(a1.gate.garmentChecks[0]).toMatchObject({ garment: 'bolt', visible: true, reason: 'cell 3 shows a mitten' });
    expect(a1.gate.garmentChecks[0].question).toContain('is bolt visible');
    expect(a1.gate.removedScore).toBe(1);
    expect(a1.gate.valid).toBe(false);
    expect(a2.accepted).toBe(true);
    expect(a2.gate.garmentChecks[0].visible).toBe(false);
    expect(a2.gate.removedScore).toBe(10);
    // the kept questions ride in the same record
    expect(a2.gate.keptChecks.map((c: any) => [c.garment, c.visible])).toEqual([['brown baldric', true], ['grey tunic', true]]);
    expect(a2.gate.keptScore).toBe(10);
  });

  it('a kept garment missing from the body cells rejects the attempt and says which; details never reach the question', async () => {
    process.env.GEMINI_API_KEY ||= 'test-key';
    stubJudges([false, false], [false, true, true, true]); // attempt 1: baldric absent; attempt 2: all present
    const out = await SHEET.redressSheetVariant(PIXEL, OPTS);
    expect(out.accepted).toBe(true);
    const [a1, a2] = out.attempts;
    expect(a1.accepted).toBe(false);
    expect(a1.gate.keptScore).toBe(1);
    expect(a1.gate.keptChecks[0]).toMatchObject({ garment: 'brown baldric', visible: false });
    expect(a1.reason).toMatch(/kept: brown baldric is missing from the body cells/);
    expect(a2.accepted).toBe(true);
    const asked = sentQuestions.join(String.fromCharCode(10));
    expect(asked).toContain('brown baldric');
    expect(asked).not.toMatch(/leather|wool|wide/);
  });

  it('no kept list and no stated reason: no variant, before any paid edit', async () => {
    process.env.GEMINI_API_KEY ||= 'test-key';
    stubJudges([false]);
    const { keptGarments: _k, ...noKept } = OPTS as any;
    expect(await SHEET.redressSheetVariant(PIXEL, noKept)).toBeNull();
    expect(editCalls).toBe(0);
  });

  it('an outfit version records that no kept check ran', async () => {
    process.env.GEMINI_API_KEY ||= 'test-key';
    stubJudges([false]);
    const { keptGarments: _k, ...noKept } = OPTS as any;
    const out = await SHEET.redressSheetVariant(PIXEL, { ...noKept, keptCheckSkipped: 'outfit version: no authored kept list' });
    expect(out.accepted).toBe(true);
    expect(out.attempts[0].gate.keptChecks).toEqual([]);
    expect(out.attempts[0].gate.keptCheckSkipped).toBe('outfit version: no authored kept list');
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
