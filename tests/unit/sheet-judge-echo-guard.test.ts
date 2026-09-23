/**
 * Every avatar-sheet judge rejects a verdict it copied instead of judged.
 *
 * Staging job_1790100385959_1nitlympp: the three pass-1 row judges (heads,
 * bodies, identity) returned their template's worked example verbatim on 6 of
 * 6 sheets — every reason string and every score — over sheets with a
 * duplicated profile in cells 3/4 and an invented collar. The pass-2 style
 * judge had been fixed for the same failure on 2026-08-12, but its guard only
 * knew placeholders and two legacy strings, and the same run's pass-2 layout
 * reason was TASK 1's own sentences on 5 of 6 sheets.
 *
 * Also pinned: the cell-4/8 pose the generator asks for is the pose every
 * judge is told to expect (generator↔critic).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const { loadPromptTemplates } = require('../../server/services/prompts');
const sheetMod = require('../../server/lib/character2x4Sheet');
const sheet = { ...sheetMod, ...sheetMod._internal };
const { isEchoedJudgeVerdict, REAR_TURN_POSE } = sheet;

// Kiaan's stored pass-1 heads verdict from the run, verbatim.
const STORED_HEADS = {
  angles: { score: 9, reason: 'Front, three-quarter, profile, back left to right' },
  cleanRender: { cleanScore: 9, reason: 'No arrows or stray marks on any head' },
  coverage: { coverageScore: 9, reason: 'Visible shoulders are clothed in the requested garment in every cell' },
  solo: { soloScore: 10, reason: 'One head per cell, four separate heads, no extra or ghosted person' },
  finalScore: 9, valid: true, failureReasons: [],
};

// The pre-2026-09-23 style-eval TASK 1 bullet and the reason the judge returned.
const OLD_TASK1 = 'TASK 1: LAYOUT PRESERVED\n- Image 3 is a 4-column × 2-row grid like Image 2. Top row = 4 head-and-neck cells. Bottom row = 4 full-body cells. Same cell order: front, three-quarter, profile, back.\n';
const LIFTED_LAYOUT = 'Image 3 is a 4-column × 2-row grid like Image 2. Top row = 4 head-and-neck cells. Bottom row = 4 full-body cells. Same cell order: front, three-quarter, profile, back.';

describe('isEchoedJudgeVerdict — one guard for all four sheet judges', () => {
  it('flags the stored pass-1 row verdict (template example verbatim)', () => {
    expect(isEchoedJudgeVerdict(STORED_HEADS, 'any prompt')).toBe(true);
  });

  it('flags the stored identity verdicts (top-level reason, full stop or one clause appended)', () => {
    for (const reason of [
      'All 4 heads match the reference person in face structure, hair, skin tone, and age.',
      'All 4 heads match the reference person in face structure, hair, skin tone, and age. The character also appears to be around 3 years old in all images.',
    ]) {
      const v = { perCell: { cell1: 9, cell2: 9, cell3: 9, cell4: 9 }, identityScore: 9, reason };
      expect(isEchoedJudgeVerdict(v, 'any prompt'), reason).toBe(true);
    }
  });

  it('NEGATIVE CONTROL — a short legacy string opening a real observation is not an echo', () => {
    expect(isEchoedJudgeVerdict({ proportions: { score: 4, reason: 'Proportions match the stated age poorly: about 3.5 heads tall, reads 2' } }, '')).toBe(false);
  });

  it('flags an unfilled placeholder', () => {
    expect(isEchoedJudgeVerdict({ angles: { score: 9, reason: 'cell1: <facing you see>' } }, '')).toBe(true);
  });

  it('flags a reason made only of the prompt\'s own sentences (the pass-2 layout echo)', () => {
    expect(isEchoedJudgeVerdict({ layout: { score: 10, reason: LIFTED_LAYOUT } }, OLD_TASK1)).toBe(true);
  });

  it('NEGATIVE CONTROL — an observed, per-cell verdict passes', () => {
    const v = {
      angles: { score: 2, reason: 'cell1: front; cell2: three-quarter left; cell3: profile left; cell4: profile right, no eye toward camera' },
      solo: { soloScore: 10, reason: 'one head in each of the four cells' },
    };
    expect(isEchoedJudgeVerdict(v, OLD_TASK1)).toBe(false);
  });

  it('NEGATIVE CONTROL — task wording plus one observation of its own is not an echo', () => {
    const v = { layout: { score: 5, reason: 'Image 3 is a 4-column × 2-row grid like Image 2. Cells 3 and 4 are both profiles.' } };
    expect(isEchoedJudgeVerdict(v, OLD_TASK1)).toBe(false);
  });

  it('a verdict with no reasons at all is not called an echo', () => {
    expect(isEchoedJudgeVerdict({ finalScore: 10 }, OLD_TASK1)).toBe(false);
  });
});

describe('the row and identity judges re-ask once, then fail loudly', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  beforeAll(async () => { await loadPromptTemplates(); });

  const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';
  const reply = (obj: any) => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }], usageMetadata: {} }),
    text: async () => '',
  });
  const judged = { ...STORED_HEADS, angles: { score: 2, reason: 'cell1: front; cell2: three-quarter; cell3: profile; cell4: profile, no eye' }, cleanRender: { cleanScore: 10, reason: 'no marks' }, coverage: { coverageScore: 9, reason: 'red crew-neck shirt in all cells' }, solo: { soloScore: 10, reason: 'one head per cell' }, finalScore: 2, valid: false };

  it('an echo followed by a real verdict returns the real verdict after two calls', async () => {
    const f = vi.fn().mockResolvedValueOnce(reply(STORED_HEADS)).mockResolvedValueOnce(reply(judged));
    globalThis.fetch = f as any;
    const { report } = await sheet.evaluateSheetRow(ROW, 'heads', { costumeDescription: 'a red shirt' });
    expect(f).toHaveBeenCalledTimes(2);
    expect(report.angles.score).toBe(2);
  });

  it('two echoes throw — the caller records the row as unjudged, never as a 9', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply(STORED_HEADS)) as any;
    await expect(sheet.evaluateSheetRow(ROW, 'heads', { costumeDescription: 'a red shirt' })).rejects.toThrow(/echoed its prompt twice/);
  });

  it('the identity judge has the same guard', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(reply({ perCell: { cell1: 9, cell2: 9, cell3: 9, cell4: 9 }, identityScore: 9, reason: 'All 4 heads match the reference person in face structure, hair, skin tone, and age' })) as any;
    await expect(sheet.evaluateIdentity(ROW, { declaredAge: 3 })).rejects.toThrow(/echoed its prompt twice/);
  });
});

describe('generator↔critic: the cell-4/8 pose is one definition', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  beforeAll(async () => { await loadPromptTemplates(); });

  const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';
  const capture = () => {
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      sent.push(body.contents[0].parts.map((p: any) => p.text || '').join('\n'));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"finalScore":10}' }] }, finishReason: 'STOP' }], usageMetadata: {} }), text: async () => '' };
    }) as any;
    return sent;
  };

  it('both live generator rows carry it', () => {
    const c = { name: 'A', age: 5, physical: {} };
    expect(sheet.buildBodyRowPrompt('a red shirt', c, false, null, null)).toContain(REAR_TURN_POSE);
    expect(sheet.buildHeadRowPrompt(c, 'a red shirt')).toContain(REAR_TURN_POSE);
  });

  it('every judge is sent it, and none calls cell 4/8 a plain back view', async () => {
    const sent = capture();
    await sheet.evaluateSheetRow(ROW, 'heads', { costumeDescription: 'a red shirt' });
    await sheet.evaluateSheetRow(ROW, 'bodies', { costumeDescription: 'a red shirt', declaredAge: 5 });
    await sheet.evaluateIdentity(ROW, { sourcePhoto: ROW, declaredAge: 5 });
    await sheet.evaluateStyledSheetWithGemini(ROW, ROW, ROW, 'watercolor', 'k', null, 5);
    expect(sent).toHaveLength(4);
    for (const p of sent) {
      expect(p).toContain(REAR_TURN_POSE);
      expect(p).not.toMatch(/profile, back\b/);
      expect(p).not.toMatch(/needs no face/);
    }
  });

  it('no judge template shows a filled-in score to copy', async () => {
    const sent = capture();
    await sheet.evaluateSheetRow(ROW, 'heads', {});
    await sheet.evaluateSheetRow(ROW, 'bodies', {});
    await sheet.evaluateIdentity(ROW, { sourcePhoto: ROW });
    await sheet.evaluateStyledSheetWithGemini(ROW, ROW, ROW, 'watercolor', 'k', null, 5);
    for (const p of sent) expect(p).not.toMatch(/"(?:score|\w+Score|cell\d)":\s*\d/);
  });
});
