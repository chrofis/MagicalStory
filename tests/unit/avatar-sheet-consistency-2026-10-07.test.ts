/**
 * Avatar-sheet defects of staging showcase job_1791315635053_t0t8qpebu (2026-10-07), pinned as behaviour:
 *
 *  1  a sheet with TWO people (head row + cells 1,4 one woman, cells 2,3 another) passed at 9-10 —
 *     every cell is now answered as same / different person, computed into identity (a hard axis).
 *  2  photographic cells passed the style judge — each cell is answered illustrated / photographic.
 *  3  a printed caption strip ("Front / Three-quarter / ...") passed — the judge's own letteringSeen
 *     boolean now sinks the ground axis, whatever excuse its reason gives.
 *  4  the head row came back thigh-length — cropHeadRowToShoulders cuts it from the pose keypoints.
 *  5  hair style and parting are judged against the SAME value the generator is given (hairRequest).
 *  7  a tail figure is told it never stands on its fin; the bodies judge is told the same rule.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

const { loadPromptTemplates } = require('../../server/services/prompts');
const sheetMod = require('../../server/lib/character2x4Sheet');
const sheet = { ...sheetMod, ...sheetMod._internal };

const ROW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/9oACAEBAAA/AKpgA//Z';

const cells8 = (v: string, overrides: Record<string, string> = {}) =>
  Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`cell${i + 1}`, overrides[`cell${i + 1}`] ?? v]));
const cells4 = (v: string, overrides: Record<string, string> = {}) =>
  Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`cell${i + 1}`, overrides[`cell${i + 1}`] ?? v]));

const cleanStyled = () => ({
  layout: { score: 10, reason: 'x' }, identity: { score: 9, reason: 'x', perCell: cells8('same') },
  style: { score: 9, reason: 'x', perCell: cells8('illustrated') }, clean: { score: 9, reason: 'x' },
  bodyFace: { score: 10, reason: 'x' }, age: { score: 9, reason: 'x' }, solo: { score: 10, reason: 'x' },
  background: { score: 10, reason: 'x' }, garment: { score: 9, reason: 'x' },
  hair: { score: 9, reason: 'x', perCell: cells8('match') }, letteringSeen: false, letteringQuoted: 'none',
  layoutScore: 10, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 10, ageScore: 9, soloScore: 10,
  backgroundScore: 10, garmentScore: 9, hairScore: 9, finalScore: 9, valid: true, failureReasons: [],
});

describe('styled sheet: every cell is read for person, medium, hair and lettering', () => {
  it('a clean verdict stays clean', () => {
    const r = sheet.scoreStyleReport(sheet.applyStyledSheetConsistencyAxes(cleanStyled()));
    expect(r.valid).toBe(true);
    expect(r.finalScore).toBe(9);
  });

  it('two people on one sheet (cells 2 and 3 are someone else) fail IDENTITY, the hard axis', () => {
    const v = cleanStyled();
    v.identity.perCell = cells8('same', { cell6: 'different', cell7: 'different' });
    const r = sheet.scoreStyleReport(sheet.applyStyledSheetConsistencyAxes(v));
    expect(r.identityScore).toBe(1);
    expect(r.valid).toBe(false);
    expect(r.failureReasons.join(' ')).toMatch(/identity: cell6, cell7/);
  });

  it('a photographic head row fails the style axis even when the judge scored the sheet 9', () => {
    const v = cleanStyled();
    v.style.perCell = cells8('illustrated', { cell3: 'photographic', cell4: 'photographic' });
    const r = sheet.scoreStyleReport(sheet.applyStyledSheetConsistencyAxes(v));
    expect(r.styleScore).toBe(1);
    expect(r.valid).toBe(false);
    expect(r.failureReasons.join(' ')).toMatch(/cell3, cell4 are photographic/);
  });

  it('hair that turned from one colour to another fails the hair axis', () => {
    const v = cleanStyled();
    v.hair.perCell = cells8('differs');
    const r = sheet.scoreStyleReport(sheet.applyStyledSheetConsistencyAxes(v));
    expect(r.hairScore).toBe(1);
    expect(r.valid).toBe(false);
  });

  it('lettering the judge itself saw sinks the ground, whatever excuse its reason gives', () => {
    const v: any = cleanStyled();
    v.background.reason = 'plain white; the labels are part of the reference sheet structure';
    v.letteringSeen = true;
    v.letteringQuoted = 'Front / Three-quarter / Profile / Rear turn';
    const r = sheet.scoreStyleReport(sheet.applyStyledSheetConsistencyAxes(v));
    expect(r.backgroundScore).toBe(2);
    expect(r.valid).toBe(false);
    expect(r.failureReasons.join(' ')).toMatch(/Front \/ Three-quarter/);
  });

  it('a judge that gives no per-cell answer leaves the axis unscored (warned), it does not invent a fail', () => {
    const v: any = cleanStyled();
    delete v.style.perCell;
    delete v.identity.perCell;
    delete v.hair.perCell;
    delete v.letteringSeen;
    const r = sheet.scoreStyleReport(sheet.applyStyledSheetConsistencyAxes(v));
    expect(r.valid).toBe(true);
  });
});

describe('row judges: hair, one person in every cell, lettering', () => {
  const heads = () => ({
    angles: { score: 9 }, cleanRender: { cleanScore: 10 }, coverage: { coverageScore: 9 }, solo: { soloScore: 10 }, crop: { cropScore: 9 },
    hair: { perCell: cells4('match') }, person: { perCell: cells4('same') }, letteringSeen: false,
  });

  it('a hair-down cell among ponytail cells fails the row', () => {
    const v: any = heads();
    v.hair.perCell = cells4('match', { cell1: 'differs', cell2: 'differs' });
    const r = sheet.scoreHeadsReport(sheet.applyRowConsistencyAxes(v, 'heads'));
    expect(r.hair.hairScore).toBe(1);
    expect(r.valid).toBe(false);
    expect(r.failureReasons.join(' ')).toMatch(/hair: cell1, cell2/);
  });

  it('a different person in a cell fails the row', () => {
    const v: any = heads();
    v.person.perCell = cells4('same', { cell3: 'different' });
    const r = sheet.scoreHeadsReport(sheet.applyRowConsistencyAxes(v, 'heads'));
    expect(r.valid).toBe(false);
  });

  it('lettering folds into the heads clean axis and the bodies background axis', () => {
    const h: any = heads();
    h.letteringSeen = true; h.letteringQuoted = 'Front';
    expect(sheet.scoreHeadsReport(sheet.applyRowConsistencyAxes(h, 'heads')).cleanRender.cleanScore).toBe(2);
    const b: any = { background: { backgroundScore: 10 }, letteringSeen: true, letteringQuoted: 'Profile' };
    expect(sheet.applyRowConsistencyAxes(b, 'bodies').background.backgroundScore).toBe(2);
  });

  it('the bodies row gate takes hair and person into its final', () => {
    const bodies: any = {
      fullBody: { feetScore: 10, headScore: 10 }, angles: { score: 10 }, outfit: { outfitScore: 10 }, proportions: { score: 10 },
      solo: { soloScore: 10 }, background: { backgroundScore: 10 }, hair: { hairScore: 1 }, person: { personScore: 10 },
    };
    sheet.applyPoseHeadGate(bodies, { cells: [1, 2, 3, 4].map(() => ({ head: true, head_max: 1, clipped: false })) });
    expect(bodies.finalScore).toBe(1);
    expect(bodies.valid).toBe(false);
  });
});

describe('head-row crop: the row is cut at the upper chest from the pose keypoints', () => {
  // Measured on staging showcase job_1791315635053_t0t8qpebu with yolo11n-pose: Daniel's head row came back
  // thigh-length (shoulders at 0.33-0.36 of the row), Sarah's accepted one was framed at the chest.
  const daniel = [
    { nose_y_frac: 0.194, shoulder_y_frac: 0.36 }, { nose_y_frac: 0.193, shoulder_y_frac: 0.357 },
    { nose_y_frac: 0.191, shoulder_y_frac: 0.34 }, { nose_y_frac: 0.184, shoulder_y_frac: 0.332 },
  ];
  const sarah = [
    { nose_y_frac: 0.36, shoulder_y_frac: 0.598 }, { nose_y_frac: 0.352, shoulder_y_frac: 0.587 },
    { nose_y_frac: 0.345, shoulder_y_frac: 0.581 }, { nose_y_frac: 0.342, shoulder_y_frac: 0.564 },
  ];

  it('a thigh-length row is cut to head, neck and the top of the chest', () => {
    const f = sheet.headRowCropFraction(daniel);
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.46);
  });

  it('the cut sits below the shoulders of the LOWEST cell, never through a shoulder', () => {
    const f = sheet.headRowCropFraction(daniel);
    expect(f).toBeGreaterThan(Math.max(...daniel.map(c => c.shoulder_y_frac)));
    expect(sheet.headRowCropFraction(sarah)).toBeGreaterThan(0.598);
  });

  it('fewer than two cells with both keypoints gives no crop', () => {
    expect(sheet.headRowCropFraction([{ nose_y_frac: 0.2, shoulder_y_frac: 0.4 }, {}, {}, {}])).toBeNull();
    expect(sheet.headRowCropFraction([])).toBeNull();
    expect(sheet.headRowCropFraction(undefined)).toBeNull();
  });

  it('a cell whose shoulders read above its nose is ignored, not trusted', () => {
    expect(sheet.headRowCropFraction([{ nose_y_frac: 0.5, shoulder_y_frac: 0.3 }, { nose_y_frac: 0.5, shoulder_y_frac: 0.3 }])).toBeNull();
  });
});

describe('hair: the generator and every judge read one value', () => {
  const emma = { name: 'E', age: 5, physical: { hairColor: 'brown', detailedHairAnalysis: { type: 'wavy', styling: 'ponytail', parting: 'side part right', lengthTop: 'ear-length' } } };
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

  it('hairRequest carries colour, style and parting, and both row generators state exactly it', () => {
    const hair = sheet.hairRequest(emma);
    expect(hair).toMatch(/brown/);
    expect(hair).toMatch(/ponytail/);
    expect(hair).toMatch(/side part/); expect(hair).not.toMatch(/(left|right)/i); // parting side is not recorded (decisions.md 2026-10-08)
    expect(sheet.buildBodyRowPrompt('standard outfit', emma, false, null)).toContain(hair);
    expect(sheet.buildHeadRowPrompt(emma, '', false)).toContain(hair);
    expect(sheet.hairRequest({ name: 'x', physical: {} })).toBe('');
  });

  it('the heads, bodies and row-cells judges are each sent the same hair the generator was told', async () => {
    const hair = sheet.hairRequest(emma);
    const sent = capture({ angles: { score: 9, reason: 'a' }, cleanRender: { cleanScore: 9, reason: 'b' }, coverage: { coverageScore: 9, reason: 'c' }, solo: { soloScore: 9, reason: 'd' }, crop: { cropScore: 9, reason: 'e' }, hair: { perCell: cells4('match'), reason: 'f' }, person: { perCell: cells4('same'), reason: 'g' }, letteringSeen: false });
    await sheet.evaluateSheetRow(ROW, 'heads', { costumeDescription: 'a red shirt', hair });
    await sheet.evaluateSheetRow(ROW, 'bodies', { costumeDescription: 'a red shirt', hair }).catch(() => {});
    await sheet.observeStyledRow(ROW, { styleLabel: 'watercolour', hair, apiKey: 'k' }).catch(() => {});
    expect(sent.length).toBe(3);
    for (const prompt of sent) {
      expect(prompt).toContain(`REQUESTED_HAIR: ${hair}`);
      expect(prompt).not.toMatch(/\{REQUESTED_HAIR\}/);
    }
  });

  it('with no declared hair the judges are told so, not left with a raw placeholder', async () => {
    const sent = capture({ angles: { score: 9, reason: 'a' }, cleanRender: { cleanScore: 9, reason: 'b' }, coverage: { coverageScore: 9, reason: 'c' }, solo: { soloScore: 9, reason: 'd' }, crop: { cropScore: 9, reason: 'e' } });
    await sheet.evaluateSheetRow(ROW, 'heads', { costumeDescription: 'a red shirt' });
    expect(sent[0]).toMatch(/REQUESTED_HAIR: none declared/);
  });
});

describe('a tail figure never stands on its fin: generator and bodies judge read one rule', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the body-row prompt states the rule', () => {
    const p = sheet.buildBodyRowPrompt('a white swim shirt and a purple scaled mermaid tail replacing the legs', { name: 'E', age: 5, physical: {} }, true, 'mermaid');
    expect(p).toContain(sheet.TAIL_POSE_RULE);
    expect(sheet.TAIL_POSE_RULE).toMatch(/never stands on it/);
  });

  it('the bodies judge is sent the same rule', async () => {
    const sent: string[] = [];
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      sent.push(JSON.parse(init.body).contents[0].parts.map((p: any) => p.text || '').join('\n'));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ fullBody: { feetScore: 9, headScore: 9, fullBodyScore: 9, reason: 'x' } }) }] }, finishReason: 'STOP' }], usageMetadata: {} }), text: async () => '' };
    }) as any;
    await sheet.evaluateSheetRow(ROW, 'bodies', { costumeDescription: 'a mermaid tail replacing the legs' }).catch(() => {});
    expect(sent[0]).toContain(sheet.TAIL_POSE_RULE);
  });
});

describe('pass 2 end to end: the per-row cell checks reach the verdict production ships', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });
  beforeAll(async () => { await loadPromptTemplates(); });
  // Big enough to split into its two rows.
  const SHEET = 'data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z';
  const okRow = () => ({ cells: Object.fromEntries([1, 2, 3, 4].map(i => [`cell${i}`, { medium: 'illustrated', hair: 'match', person: 'same' }])), letteringSeen: false, letteringQuoted: 'none', reason: 'cell1: blonde, illustrated' });
  const wholeSheet = () => ({
    layout: { score: 10, reason: 'x' }, identity: { score: 9, reason: 'x' }, style: { score: 9, reason: 'x' }, clean: { score: 9, reason: 'x' },
    bodyFace: { score: 10, reason: 'x' }, age: { score: 9, reason: 'x' }, solo: { score: 10, reason: 'x' }, background: { score: 10, reason: 'x' }, garment: { score: 9, reason: 'x' },
    layoutScore: 10, identityScore: 9, styleScore: 9, cleanScore: 9, bodyFaceScore: 10, ageScore: 9, soloScore: 10, backgroundScore: 10, garmentScore: 9, finalScore: 9, valid: true, failureReasons: [],
  });
  const stub = (bottomRow: object) => {
    let rowCall = 0;
    globalThis.fetch = vi.fn(async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      if (!body.contents) return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; // analyzer divider call
      const text = body.contents[0].parts.map((p: any) => p.text || '').join('\n');
      const verdict = /ONE row of a styled character reference sheet/.test(text) ? (rowCall++ === 0 ? okRow() : bottomRow) : wholeSheet();
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdict) }] }, finishReason: 'STOP' }], usageMetadata: {} }), text: async () => '' };
    }) as any;
  };
  const run = () => sheet.evaluateAvatarSheet(SHEET, { pass: 2, facePhoto: SHEET, realisticSheet: SHEET, artStyle: 'watercolor', declaredAge: 36, hair: 'Hair color: blonde.' });

  it('a clean pair of rows ships the whole-sheet verdict untouched', async () => {
    stub(okRow());
    const { verdict } = await run();
    expect(verdict.valid).toBe(true);
    expect(verdict.finalScore).toBe(9);
  });

  it('a body row holding another person fails identity although the whole-sheet judge said 9', async () => {
    const bad: any = okRow();
    bad.cells.cell2 = { medium: 'illustrated', hair: 'differs', person: 'different' };
    bad.cells.cell3 = { medium: 'illustrated', hair: 'differs', person: 'different' };
    stub(bad);
    const { verdict } = await run();
    expect(verdict.identityScore).toBe(1);
    expect(verdict.valid).toBe(false);
    expect(verdict.failureReasons.join(' ')).toMatch(/identity: cell6, cell7/);
  });

  it('a photographic body row fails style, and cells are numbered 5 to 8 for the bottom row', async () => {
    const bad: any = okRow();
    bad.cells.cell1.medium = 'photographic';
    stub(bad);
    const { verdict } = await run();
    expect(verdict.styleScore).toBe(1);
    expect(verdict.failureReasons.join(' ')).toMatch(/cell5 are photographic/);
  });

  it('caption strip seen in one row fails the ground', async () => {
    const bad: any = okRow();
    bad.letteringSeen = true; bad.letteringQuoted = 'Front';
    stub(bad);
    const { verdict } = await run();
    expect(verdict.backgroundScore).toBe(2);
  });
});
