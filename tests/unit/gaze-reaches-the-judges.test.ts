import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { gazeCharacters, formatInteractionsBlock } = require('../../server/lib/vbIdGuard');

// `extractSceneMetadata` returns BOTH `characters` (bare NAME STRINGS) and
// `fullData.characters` (the objects, each carrying looksAt/expression/position).
// All three evaluators resolved it as `meta?.characters || meta?.fullData?.characters`
// — and the string array is non-empty, so it always won. formatInteractionsBlock
// then filters `c?.name && c.looksAt`, which no string has, and every gaze line
// was dropped.
//
// So the DECLARED gaze reached no judge, on any page of any story, since the
// feature was added. Its own comment says it exists "so the judges enforce a
// DECLARED gaze instead of inferring one from what a character holds".
//
// Measured on job_1789853503332_riqncqg1i before the fix: 2-4 characters parsed
// per page, 0 gaze lines emitted. Pages 2, 3 and 6 shipped at 100/100/85 with a
// gaze the brief declares and the picture does not give — p6 declares all four
// looking at the egg and not one does.
//
// Same shape as the semanticResult.issues bug: `a || b` where `a` is truthy and
// wrong. There it was an empty array; here it is an array of the wrong type.

const NAMES = ['Levin', 'Julian'];
const OBJECTS = [
  { name: 'Levin', position: 'center', depth: 'foreground', looksAt: 'ART001', expression: 'surprised' },
  { name: 'Julian', position: 'right', depth: 'foreground', looksAt: 'ART001', expression: 'cautious' },
];

describe('gazeCharacters — the array that actually carries looksAt', () => {
  it('prefers the objects over the bare name strings', () => {
    const meta = { characters: NAMES, fullData: { characters: OBJECTS } };
    expect(gazeCharacters(meta)).toEqual(OBJECTS);
  });

  it('is not fooled by a non-empty array of strings', () => {
    // The whole bug: `meta.characters || meta.fullData.characters` picked this.
    expect(gazeCharacters({ characters: NAMES })).toBeNull();
  });

  it('takes the top-level array when IT holds the objects', () => {
    expect(gazeCharacters({ characters: OBJECTS })).toEqual(OBJECTS);
  });

  it('returns null when neither shape carries objects', () => {
    expect(gazeCharacters({})).toBeNull();
    expect(gazeCharacters(null)).toBeNull();
    expect(gazeCharacters({ characters: [], fullData: { characters: [] } })).toBeNull();
    expect(gazeCharacters({ characters: [1, 2, 3] })).toBeNull();
  });

  it('accepts objects even when only some declare a gaze', () => {
    const mixed = [{ name: 'A', looksAt: 'ART001' }, { name: 'B' }];
    expect(gazeCharacters({ characters: NAMES, fullData: { characters: mixed } })).toEqual(mixed);
  });
});

describe('the block the judges receive', () => {
  it('carries one line per declared gaze', () => {
    const block = formatInteractionsBlock([], null, gazeCharacters({ characters: NAMES, fullData: { characters: OBJECTS } }));
    const gaze = block.split('\n').filter((l: string) => / looks at /.test(l));
    expect(gaze).toHaveLength(2);
    expect(gaze[0]).toMatch(/Levin looks at/);
  });

  it('emitted NOTHING through the old expression — the regression this pins', () => {
    const meta = { characters: NAMES, fullData: { characters: OBJECTS } };
    const oldWay = (meta as never as { characters: unknown }).characters as never;
    const block = formatInteractionsBlock([], null, oldWay);
    expect(block.split('\n').filter((l: string) => / looks at /.test(l))).toHaveLength(0);
  });

  it('keeps the interaction lines beside the gaze lines', () => {
    const block = formatInteractionsBlock(
      [{ character: 'Levin', object: 'egg', where: 'holds it against his chest' }],
      null, gazeCharacters({ characters: NAMES, fullData: { characters: OBJECTS } }));
    expect(block).toMatch(/Levin \+ egg/);
    expect(block.split('\n').filter((l: string) => / looks at /.test(l))).toHaveLength(2);
  });
});

describe('every evaluator resolves it the same way', () => {
  const SRC = (rel: string) =>
    fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8').split('\r\n').join('\n');

  it('no evaluator still uses the string-first expression', () => {
    for (const f of ['server/lib/evalPipeline.js', 'server/lib/sceneValidator.js']) {
      expect(SRC(f), f).not.toMatch(/\?\.characters \|\| \w+\?\.fullData\?\.characters/);
    }
  });

  it('every call site goes through the resolver', () => {
    // quality judge + batch evaluator in evalPipeline, semantic judge in sceneValidator,
    // plus the two code comparisons against the blind inventory that read the same
    // declared characters[]: the gaze check (a13848faa) and the emotion check
    // (3d8f4871d). Both are further resolver uses, not a new way of resolving.
    expect((SRC('server/lib/evalPipeline.js').match(/gazeCharacters\(/g) || []).length).toBe(4);
    expect((SRC('server/lib/sceneValidator.js').match(/gazeCharacters\(/g) || []).length).toBe(1);
  });
});
