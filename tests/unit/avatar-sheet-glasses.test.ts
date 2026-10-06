import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// @ts-ignore — CommonJS lib
const sheet = require('../../server/lib/character2x4Sheet.js');
// @ts-ignore
const { declaredGlasses } = require('../../server/lib/avatarOverrides.js');

const { buildBodyRowPrompt, buildHeadRowPrompt, buildGlassesBlock, _internal } = sheet;
const sarah = { name: 'Sarah', age: 36, physical: { glasses: 'rectangular black-framed glasses' } };
const noGlasses = { name: 'Max', age: 36, physical: { glasses: 'none' } };

// Staging job_1791267520938_essbvehs8: Sarah's pass-1 head row drew the front and three-quarter
// cells WITHOUT her glasses (profile and body cells had them). No prompt or judge stated glasses,
// so every page's face repair, the dedication page and the back cover copied a glassless face.
describe('a declared pair of glasses is stated to the sheet generator and checked by both row judges', () => {
  it('declaredGlasses reads physical.glasses and ignores none / empty', () => {
    expect(declaredGlasses(sarah)).toBe('rectangular black-framed glasses');
    expect(declaredGlasses(noGlasses)).toBeNull();
    expect(declaredGlasses({ physical: { glasses: '  ' } })).toBeNull();
    expect(declaredGlasses({})).toBeNull();
  });
  it('both rows of the generator carry them; a character without glasses gets no line', () => {
    expect(buildHeadRowPrompt(sarah, 'a coat')).toContain('rectangular black-framed glasses');
    expect(buildBodyRowPrompt('a coat', sarah)).toContain('rectangular black-framed glasses');
    expect(buildHeadRowPrompt(sarah, 'a coat')).toMatch(/front and three-quarter included/);
    expect(buildHeadRowPrompt(noGlasses, 'a coat')).not.toMatch(/glasses/i);
    expect(buildBodyRowPrompt('a coat', noGlasses)).not.toMatch(/glasses/i);
    expect(buildGlassesBlock({})).toBe('');
  });
  it('the heads judge fails a face without them and the body gate takes the glasses axis', () => {
    const heads = _internal.scoreHeadsReport({
      angles: { score: 10 }, cleanRender: { cleanScore: 10 }, coverage: { coverageScore: 10 },
      solo: { soloScore: 10 }, crop: { cropScore: 9 }, glasses: { glassesScore: 2, reason: 'cell1: none; cell2: none' },
    });
    expect(heads.finalScore).toBe(2);
    expect(heads.valid).toBe(false);
    expect(heads.failureReasons.join(' ')).toMatch(/glasses/);
    const bodies = _internal.applyPoseHeadGate({ fullBody: { feetScore: 10, headScore: 10 }, angles: { score: 10 }, glasses: { glassesScore: 3 } }, null);
    expect(bodies.finalScore).toBe(3);
  });
  it('the axis is computed from the per-cell answers, not scored by the judge', () => {
    const g = 'rectangular black-framed glasses';
    const cells = (a: string, b: string, c: string, d: string) => ({ glasses: { perCell: { cell1: a, cell2: b, cell3: c, cell4: d } } });
    const bad = _internal.applyGlassesAxis(cells('no', 'no', 'yes', 'yes'), g);
    expect(bad.glasses.glassesScore).toBe(1);
    expect(bad.failureReasons.join(' ')).toMatch(/glasses: 2 cell/);
    expect(_internal.applyGlassesAxis(cells('yes', 'yes', 'yes', 'na'), g).glasses.glassesScore).toBe(10);
    // nothing declared: never judged, even if the judge wrote 'no'
    expect(_internal.applyGlassesAxis(cells('no', 'no', 'no', 'no'), null).glasses.glassesScore).toBe(10);
    // declared but no answer: unscored (the gate takes the axes it has), not a silent 10
    expect(_internal.applyGlassesAxis({}, g).glasses.glassesScore).toBeUndefined();
  });
  it('both judge templates take REQUESTED_GLASSES and answer per cell', () => {
    for (const f of ['sheet-row-heads-eval.txt', 'sheet-row-bodies-eval.txt']) {
      const t = fs.readFileSync(path.join(__dirname, '../../prompts', f), 'utf8');
      expect(t).toContain('{REQUESTED_GLASSES}');
      expect(t).toContain('"glasses": {"perCell"');
    }
  });
});
