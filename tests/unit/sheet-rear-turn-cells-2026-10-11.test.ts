/**
 * Cells 4 and 8 of an avatar sheet are the rear turn (staging job_1791709770102_cnksoiyxt: a costumed head row repeated a face
 * looking at the camera in cell 4, so the waiting-page rotation had no back head). One constant states the pose to the generator
 * and the judge; the judge reads a per-cell `view` enum and a wrong rear cell is a layout defect that triggers the redo.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const judge = require('../../server/lib/avatarSheetJudge.js');
const sheet = require('../../server/lib/character2x4Sheet.js');
const { redoLinesOf } = require('../../server/lib/oneCallSheet.js');
const { REAR_TURN_POSE, REAR_TURN_NEVER } = sheet._internal;

const cell = (n: number, over: Record<string, string> = {}) => ({
  cell: n, headgear: 'none', hairVisible: 'full', hairColour: 'brown', hairStyle: 'down', head: 'present',
  top: 'blue hoodie', extras: 'none', heldObject: 'none', view: ['front', 'three_quarter', 'profile', 'rear'][(n - 1) % 4], ...over,
});
const verdict = (cells: any[]) => ({
  cells,
  ...Object.fromEntries(judge.DEFECT_TYPES.map((t: string) => [t, { verdict: 'ok', cells: [] }])),
  evidence: 'none',
});
const cells = (over: Record<number, string> = {}) => [1, 2, 3, 4, 5, 6, 7, 8].map(n => cell(n, over[n] ? { view: over[n] } : {}));

describe('rear-turn cells', () => {
  it('a sheet whose cells 4 and 8 are the rear turn has no layout defect', () => {
    expect(judge.sheetDefects(judge.parseAvatarSheetVerdict(verdict(cells())))).toEqual([]);
  });

  it('a three-quarter face in cell 4 is a layout defect naming cell 4 only', () => {
    const d = judge.sheetDefects(judge.parseAvatarSheetVerdict(verdict(cells({ 4: 'three_quarter' }))));
    expect(d).toEqual([{ type: 'layout', word: 'wrong_pose', cells: [4] }]);
  });

  it('both rear cells wrong lists both', () => {
    const d = judge.sheetDefects(judge.parseAvatarSheetVerdict(verdict(cells({ 4: 'front', 8: 'profile' }))));
    expect(d[0].cells).toEqual([4, 8]);
  });

  it('the judge\'s own layout word still wins over the cell signal', () => {
    const v: any = verdict(cells({ 4: 'profile' }));
    v.layout = { verdict: 'lettering', cells: [2] };
    expect(judge.sheetDefects(judge.parseAvatarSheetVerdict(v))).toEqual([{ type: 'layout', word: 'lettering', cells: [2] }]);
  });

  it('a view outside the enum, or a missing view, is a parse failure, never a pass', () => {
    expect(() => judge.parseAvatarSheetVerdict(verdict(cells({ 4: 'sideways' })))).toThrow(/view/);
    const noView = cells().map(({ view, ...rest }: any) => rest);
    expect(() => judge.parseAvatarSheetVerdict(verdict(noView))).toThrow(/view/);
  });

  it('the redo names the rear turn with the same constants the generator uses', () => {
    const line = redoLinesOf([{ type: 'layout', word: 'wrong_pose', cells: [4] }])[0];
    expect(line).toContain(REAR_TURN_POSE);
    expect(line).toContain(REAR_TURN_NEVER);
    expect(line).toMatch(/cell 4/);
  });

  it('generator and judge prompts both carry the shared rear-turn constants', async () => {
    await require('../../server/services/prompts.js').loadPromptTemplates();
    const gen = sheet.buildOneCallSheetPrompt({ name: 'A', age: 5, physical: {} }, { costumeDescription: 'a red shirt', styleLine: 'watercolour', kind: 'standard' });
    expect(gen).toContain(REAR_TURN_POSE);
    expect(gen).toContain(REAR_TURN_NEVER);
    const j = judge.buildAvatarSheetJudgePrompt({ kind: 'standard', hasPhoto: false });
    expect(j).toContain(REAR_TURN_POSE);
    expect(j).toContain(REAR_TURN_NEVER);
    expect(j).not.toMatch(/\{[A-Z_]+\}/);
  });
});
