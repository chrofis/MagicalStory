/**
 * The cell-level sheet judge (server/lib/avatarCellJudge.js): strict enum parse of one cell's answer, and the cross-cell
 * decisions made by code over those enums. Only what a cell can show is compared (no belt on head cells).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cj = require('../../server/lib/avatarCellJudge.js');

const c = (over: Record<string, any> = {}) => ({
  headgear: 'none', hairColour: 'brown', hairLength: 'short', hairWorn: 'down', head: 'present', topKind: 'hoodie', topColour: 'blue',
  layers: [], held: 'no', medium: 'watercolour', extraPeople: 'no', lettering: 'no', ...over,
});
const sheet = (f: (i: number) => Record<string, any> = () => ({})) => [0, 1, 2, 3, 4, 5, 6, 7].map(i => c(f(i)));

describe('parseCellAnswer', () => {
  it('accepts a valid answer and de-duplicates layers', () => {
    expect(cj.parseCellAnswer({ ...c(), layers: ['vest', 'vest'] }).layers).toEqual(['vest']);
  });
  it('throws on a word outside its list and on a layer outside the vocabulary (regression: "headband_scarf" returned as a layer)', () => {
    expect(() => cj.parseCellAnswer({ ...c(), headgear: 'fez' })).toThrow(/headgear/);
    expect(() => cj.parseCellAnswer({ ...c(), layers: ['headband_scarf'] })).toThrow(/layers/);
    expect(() => cj.parseCellAnswer(null)).toThrow(/not an object/);
  });
});

describe('decideSheet', () => {
  it('a clean sheet has no defect under every decider', () => {
    for (const t of cj.DECIDER_TYPES) for (const name of Object.keys(cj.DECIDERS[t])) {
      expect(cj.decideSheet(sheet(), { [t]: name })[t], `${t}.${name}`).toEqual([]);
    }
  });
  it('hat: present in some cells only is a defect, the same hat in all 8 is not', () => {
    expect(cj.decideSheet(sheet(i => (i === 0 || i === 4 ? { headgear: 'hat_brimmed' } : {}))).hat.length).toBeGreaterThan(0);
    expect(cj.decideSheet(sheet(() => ({ headgear: 'hat_brimmed' }))).hat).toEqual([]);
    expect(cj.decideSheet(sheet(i => ({ headgear: i < 4 ? 'hat_brimmed' : 'beanie' })), { hat: 'presenceOrKind' }).hat.length).toBeGreaterThan(0);
  });
  it('bald: a bald or buzz cell beside cells with hair, and a missing head', () => {
    expect(cj.decideSheet(sheet(i => (i === 4 ? { hairLength: 'bald' } : {})), { bald: 'baldOrMissing' }).bald).toEqual([5]);
    expect(cj.decideSheet(sheet(i => (i === 4 ? { hairLength: 'buzz' } : {})), { bald: 'baldOrMissing' }).bald).toEqual([]);
    expect(cj.decideSheet(sheet(i => (i === 4 ? { hairLength: 'buzz' } : {})), { bald: 'buzzBesideShort' }).bald).toEqual([5]);
    expect(cj.decideSheet(sheet(i => (i === 2 ? { head: 'missing' } : {})), { bald: 'baldOrMissing' }).bald).toEqual([3]);
  });
  it('hair colour: adjacent classes tolerated at tol 1, not at 0; hidden hair is ignored', () => {
    const s = sheet(i => (i === 3 ? { hairColour: 'light_brown' } : {}));
    expect(cj.decideSheet(s, { hair: 'colour0' }).hair).toEqual([4]);
    expect(cj.decideSheet(s, { hair: 'colour1' }).hair).toEqual([]);
    const far = sheet(i => (i === 3 ? { hairColour: 'blonde' } : {}));
    expect(cj.decideSheet(far, { hair: 'colour1' }).hair).toEqual([4]);
    const hidden = sheet(i => (i === 3 ? { hairColour: 'blonde', hairLength: 'hidden' } : {}));
    expect(cj.decideSheet(hidden, { hair: 'colour0' }).hair).toEqual([]);
  });
  it('rowMatch compares only what a head cell shows: a belt in the body cells is not a difference, straps are', () => {
    const belt = sheet(i => (i >= 4 ? { layers: ['belt', 'pouch', 'boots'] } : {}));
    expect(cj.decideSheet(belt, { rowMatch: 'piecesOnly' }).rowMatch).toEqual([]);
    const straps = sheet(i => (i < 4 ? { layers: ['overalls_straps'] } : {}));
    expect(cj.decideSheet(straps, { rowMatch: 'piecesOnly' }).rowMatch.length).toBeGreaterThan(0);
    const colour = sheet(i => (i < 4 ? { topColour: 'red' } : {}));
    expect(cj.decideSheet(colour, { rowMatch: 'anyCell' }).rowMatch.length).toBe(4);
  });
  it('held and layout', () => {
    expect(cj.decideSheet(sheet(i => (i === 6 ? { held: 'yes' } : {})), { held: 'any' }).held).toEqual([7]);
    expect(cj.decideSheet(sheet(i => (i === 1 ? { medium: 'photograph' } : {}))).layout).toEqual([2]);
    expect(cj.decideSheet(sheet(i => (i === 0 ? { extraPeople: 'yes' } : {})), { layout: 'mediumOnly' }).layout).toEqual([]);
  });
  it('refuses an unknown decider and a wrong cell count', () => {
    expect(() => cj.decideSheet(sheet(), { hat: 'nope' })).toThrow(/no decider/);
    expect(() => cj.decideSheet(sheet().slice(0, 7))).toThrow(/8 parsed cells/);
  });
});

describe('buildCellPrompt', () => {
  beforeAll(async () => { await require('../../server/services/prompts.js').loadPromptTemplates(); });
  it('fills both cell kinds and restricts head cells', () => {
    const head = cj.buildCellPrompt('head'), body = cj.buildCellPrompt('body');
    expect(head).not.toMatch(/\{[A-Z_]+\}/); expect(body).not.toMatch(/\{[A-Z_]+\}/);
    expect(head).toContain('HEAD cell'); expect(body).toContain('FULL-BODY cell');
    expect(() => cj.buildCellPrompt('torso')).toThrow(/unknown cell kind/);
  });
});
