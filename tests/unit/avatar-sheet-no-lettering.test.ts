/**
 * Avatar 2×4 sheets carry no lettering, and every sheet judge that checks marks
 * fails a sheet that does.
 *
 * Staging job_1791040103540_atbttop6w: Max's body row printed the cell names
 * the prompt used ("FRONT / THREE-QUARTER / PROFILE / REAR TURN") above and
 * below every figure, pass 2 kept them, and every check passed (clean 9): the
 * heads judge looked for letters only ON a head, the bodies judge had no text
 * check, and the style judge looked only "on the character".
 *
 * One rule (SHEET_NO_LETTERING_RULE) goes to all three generators and is
 * filled into the three judges ({SHEET_LETTERING}). Behaviour is pinned: the
 * built prompts and what a lettered verdict does to the gate.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const { loadPromptTemplates } = require('../../server/services/prompts');
const sheetMod = require('../../server/lib/character2x4Sheet');
const sheet = { ...sheetMod, ...sheetMod._internal };

const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';
const RULE = sheet.SHEET_NO_LETTERING_RULE;

describe('generators: every sheet prompt states the no-lettering rule', () => {
  const c = { name: 'A', age: 5, physical: {} };

  it('both pass-1 rows state it, and say the cell names are not drawn', () => {
    for (const p of [
      sheet.buildBodyRowPrompt('a red long-sleeve shirt', c, true, null),
      sheet.buildBodyRowPrompt('standard outfit', c, false, null),
      sheet.buildHeadRowPrompt(c, 'a red long-sleeve shirt', true),
    ]) {
      expect(p).toContain(RULE);
      expect(p).toContain(sheet.CELL_NAMES_NOT_DRAWN);
    }
  });

  it('the pass-2 restyle states it, with and without the swatch', () => {
    for (const hasAnchor of [true, false]) {
      expect(sheet.buildStyleTransferPrompt('watercolor', { hasAnchor })).toContain(RULE);
    }
  });
});

describe('critics: every mark-checking sheet judge is sent the same rule', () => {
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

  it('heads judge: rule filled, and lettering in the row fails the row', async () => {
    const sent = capture({
      angles: { score: 9, reason: 'cell1: front' },
      cleanRender: { cleanScore: 2, reason: 'cells 1-4: the word FRONT/PROFILE printed under each head' },
      coverage: { coverageScore: 9, reason: 'red crew neck' }, solo: { soloScore: 9, reason: 'one each' },
      crop: { cropScore: 9, reason: 'upper chest in all' },
    });
    const { report } = await sheet.evaluateSheetRow(ROW, 'heads', { costumeDescription: 'a red shirt' });
    expect(sent[0]).toContain(RULE);
    expect(sent[0]).not.toContain('{SHEET_LETTERING}');
    expect(report.valid).toBe(false);
  });

  it('bodies judge: rule filled, no raw placeholder', async () => {
    const sent = capture({ background: { backgroundScore: 2, reason: 'FRONT printed above cell 1' } });
    await sheet.evaluateSheetRow(ROW, 'bodies', { costumeDescription: 'a red shirt', declaredAge: 3 });
    expect(sent[0]).toContain(RULE);
    expect(sent[0]).not.toContain('{SHEET_LETTERING}');
  });

  // The bodies judge scores lettering on its background axis; that the gate's
  // recompute counts backgroundScore is pinned in avatar-sheet-eval-gate.test.ts.

  it('style judge: rule filled, and lettering (clean ≤ 3) fails the styled sheet', async () => {
    const sent = capture({
      layoutScore: 9, identityScore: 9, styleScore: 9, bodyFaceScore: 9, ageScore: 9, soloScore: 9, backgroundScore: 9, garmentScore: 9,
      clean: { score: 2, reason: 'cell5-8: FRONT, THREE-QUARTER, PROFILE, REAR TURN printed above and below each figure' },
    });
    const { report } = await sheet.evaluateStyledSheetWithGemini(ROW, ROW, ROW, 'watercolor', 'k', null, 3);
    expect(sent[0]).toContain(RULE);
    expect(sent[0]).not.toContain('{SHEET_LETTERING}');
    expect(report.finalScore).toBe(2);
    expect(report.valid).toBe(false);
  });
});
