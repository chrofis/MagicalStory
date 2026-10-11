/**
 * The avatar sheet defect judge (server/lib/avatarSheetJudge.js, prompts/avatar-sheet-defect-judge.txt):
 * the parse is STRICT (a word outside its closed enum, a missing cell, a bad cell number all throw: a
 * misspelt verdict must never read as "no defect"), the per-cell enum comparison finds hats / bald cells /
 * held objects / hair-colour changes without reading prose, and the prompt is filled for both sheet kinds.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const judge = require('../../server/lib/avatarSheetJudge.js');

const cell = (n: number, over: Record<string, string> = {}) => ({
  cell: n, headgear: 'none', hairVisible: 'full', hairColour: 'brown', hairStyle: 'down', head: 'present',
  top: 'blue hoodie', extras: 'none', heldObject: 'none', ...over,
});
const clean = () => ({
  cells: [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n)),
  ...Object.fromEntries(judge.DEFECT_TYPES.map((t: string) => [t, { verdict: 'ok', cells: [] }])),
  evidence: 'none',
});

describe('parseAvatarSheetVerdict', () => {
  it('accepts a clean sheet and reports no defect', () => {
    const p = judge.parseAvatarSheetVerdict(clean());
    expect(judge.defectsOf(p)).toEqual([]);
  });

  it('maps a non-ok verdict word to its defect type', () => {
    const raw: any = clean();
    raw.bald = { verdict: 'bald_cell', cells: [5, 5] };
    const p = judge.parseAvatarSheetVerdict(raw);
    expect(p.verdicts.bald.cells).toEqual([5]);
    expect(judge.defectsOf(p)).toEqual(['bald']);
  });

  it('throws on a verdict word outside its enum (regression: "pieces_differs" typo from the judge)', () => {
    const raw: any = clean();
    raw.costume = { verdict: 'pieces_differs', cells: [1] };
    expect(() => judge.parseAvatarSheetVerdict(raw)).toThrow(/costume\.verdict/);
  });

  it('throws on a missing cell, a wrong cell order and a bad cell enum', () => {
    const short: any = clean(); short.cells.pop();
    expect(() => judge.parseAvatarSheetVerdict(short)).toThrow(/all 8 cells/);
    const swapped: any = clean(); [swapped.cells[0], swapped.cells[1]] = [swapped.cells[1], swapped.cells[0]];
    expect(() => judge.parseAvatarSheetVerdict(swapped)).toThrow(/must be cell 1/);
    const badEnum: any = clean(); badEnum.cells[3].headgear = 'fez';
    expect(() => judge.parseAvatarSheetVerdict(badEnum)).toThrow(/cell 4 headgear/);
    const badCells: any = clean(); badCells.hat = { verdict: 'ok', cells: [9] };
    expect(() => judge.parseAvatarSheetVerdict(badCells)).toThrow(/cells must be a list/);
  });
});

describe('cellSignals (per-cell enum comparison)', () => {
  it('flags headgear present in some cells only, or of a different kind', () => {
    const some = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, n === 1 || n === 5 ? { headgear: 'hat' } : {}));
    expect(judge.cellSignals(some).hat).toBe(true);
    const mixed = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, { headgear: n < 5 ? 'hat' : 'hood' }));
    expect(judge.cellSignals(mixed).hat).toBe(true);
  });

  it('does not flag the same costume headgear in all 8 cells', () => {
    const all = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, { headgear: 'hat', hairVisible: 'hidden_by_headgear' }));
    expect(judge.cellSignals(all).hat).toBe(false);
  });

  it('flags a bald cell only when another cell shows hair, and a missing head always', () => {
    const bald = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, n === 5 ? { hairVisible: 'bald' } : {}));
    expect(judge.cellSignals(bald).bald).toBe(true);
    const headless = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, n === 6 ? { head: 'missing_or_blank_face' } : {}));
    expect(judge.cellSignals(headless).bald).toBe(true);
    const allBald = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, { hairVisible: 'bald' }));
    expect(judge.cellSignals(allBald).bald).toBe(false);
  });

  it('flags a held object and a hair colour that changes between cells with visible hair', () => {
    const held = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, n === 7 ? { heldObject: 'something' } : {}));
    expect(judge.cellSignals(held).held).toBe(true);
    const recolour = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, n === 3 ? { hairColour: 'blonde' } : {}));
    expect(judge.cellSignals(recolour).hair).toBe(true);
    const hidden = [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, n === 3 ? { hairColour: 'blonde', hairVisible: 'hidden_by_headgear' } : {}));
    expect(judge.cellSignals(hidden).hair).toBe(false);
  });
});

describe('defectsOf signal modes', () => {
  it('consistency ignores photo-only words, either adds the cell comparison', () => {
    const raw: any = clean();
    raw.hair = { verdict: 'differs_from_photo', cells: [] };
    const p = judge.parseAvatarSheetVerdict(raw);
    expect(judge.defectsOf(p, { hair: 'verdict' })).toEqual(['hair']);
    expect(judge.defectsOf(p, { hair: 'consistency' })).toEqual([]);
    p.cells[1].heldObject = 'something';
    expect(judge.defectsOf(p, { hair: 'consistency', held: 'cells' })).toEqual(['held']);
    expect(judge.defectsOf(p, { hair: 'consistency', held: 'verdict' })).toEqual([]);
    expect(judge.defectsOf(p, { hair: 'consistency', held: 'either' })).toEqual(['held']);
  });

  it('rejects an unknown signal mode instead of treating it as off', () => {
    const p = judge.parseAvatarSheetVerdict(clean());
    expect(() => judge.defectsOf(p, { hat: 'sometimes' })).toThrow(/unknown signal mode/);
  });
});

describe('buildAvatarSheetJudgePrompt', () => {
  beforeAll(async () => { await require('../../server/services/prompts.js').loadPromptTemplates(); });

  it('fills every placeholder for both sheet kinds, with and without a photo', () => {
    for (const kind of ['standard', 'costume']) {
      for (const hasPhoto of [true, false]) {
        const p = judge.buildAvatarSheetJudgePrompt({ kind, hasPhoto });
        expect(p).not.toMatch(/\{[A-Z_]+\}/);
        expect(p).toContain(hasPhoto ? 'Image 2 is a PHOTO' : 'No photo is given');
      }
    }
    expect(judge.buildAvatarSheetJudgePrompt({ kind: 'costume', hasPhoto: true })).toContain('COSTUME sheet');
    expect(judge.buildAvatarSheetJudgePrompt({ kind: 'standard', hasPhoto: true })).toContain('EVERYDAY-CLOTHES');
  });

  it('refuses an unknown sheet kind', () => {
    expect(() => judge.buildAvatarSheetJudgePrompt({ kind: 'cape', hasPhoto: false })).toThrow(/unknown sheet kind/);
  });
});
