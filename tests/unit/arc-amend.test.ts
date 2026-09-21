import { describe, it, expect } from 'vitest';

// The amend pass lets a cheap model repair the arc in place instead of handing
// the writer a directive against a frozen arc. What makes that safe is not
// trust but the guards: a beat the model did not name must come back
// byte-identical, and a beat that is not in the arc is not a beat.
const {
  splitArcBeats, parseArcAmend, checkAmendGuards, applyArcAmendment,
} = require('../../server/lib/arcAmend');

const ARC = [
  '1. The main character finds an egg between the roots.',
  '2. A bigger child takes it and rides away.',
  '3. The main character runs down the steps after them.',
  '4. The bigger child drops it and walks away.',
  '5. The main character carries it home.',
].join('\n');

const amend = (issues: string, beats: string) =>
  parseArcAmend(`---ISSUES---\n${issues}\n\n---AMENDED BEATS---\n${beats}`);

describe('splitArcBeats', () => {
  it('reads the numbered beats in order', () => {
    const b = splitArcBeats(ARC);
    expect(b.map((x: any) => x.n)).toEqual([1, 2, 3, 4, 5]);
    expect(b[3].text).toBe('The bigger child drops it and walks away.');
  });

  it('folds a wrapped beat back into one', () => {
    const wrapped = '1. The character walks\n   on through the rain.\n2. They arrive.';
    const b = splitArcBeats(wrapped);
    expect(b).toHaveLength(2);
    expect(b[0].text).toBe('The character walks on through the rain.');
  });
});

describe('parseArcAmend', () => {
  it('reads the issues with the beats each one claims', () => {
    const p = amend(
      '1. ISSUE: the leaving is uncaused → CHANGE: give it a cause → BEATS: 4',
      'BEAT 4: The bigger child feels it go cold, calls it a stone and walks away.',
    );
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0].beats).toEqual([4]);
    expect(p.issues[0].change).toBe('give it a cause');
    expect([...p.beats.keys()]).toEqual([4]);
  });

  it('reads several beats, each running to the next', () => {
    const p = amend(
      '1. ISSUE: a → CHANGE: b → BEATS: 2, 4',
      'BEAT 2: A bigger child takes it and rides away downhill.\nBEAT 4: The bigger child drops it and goes.',
    );
    expect([...p.beats.keys()]).toEqual([2, 4]);
    expect(p.beats.get(2)).toBe('A bigger child takes it and rides away downhill.');
  });
});

describe('checkAmendGuards', () => {
  it('passes a bounded repair', () => {
    const g = checkAmendGuards(ARC, amend(
      '1. ISSUE: a → CHANGE: b → BEATS: 4',
      'BEAT 4: The bigger child feels it go cold and walks away.',
    ));
    expect(g.ok).toBe(true);
    expect(g.applied).toEqual([4]);
  });

  it('refuses a beat the issues never named', () => {
    const g = checkAmendGuards(ARC, amend(
      '1. ISSUE: a → CHANGE: b → BEATS: 4',
      'BEAT 4: A repair.\nBEAT 2: A beat nobody asked to touch.',
    ));
    expect(g.ok).toBe(false);
    expect(g.violations.join(' ')).toContain('beat 2');
  });

  it('refuses a beat that is not in the arc', () => {
    const g = checkAmendGuards(ARC, amend(
      '1. ISSUE: a → CHANGE: b → BEATS: 99',
      'BEAT 99: An invented beat.',
    ));
    expect(g.ok).toBe(false);
    expect(g.violations.join(' ')).toContain('not in the arc');
  });

  it('refuses an empty response', () => {
    expect(checkAmendGuards(ARC, { issues: [], beats: new Map() }).ok).toBe(false);
  });

  it('flags a beat that ballooned', () => {
    const g = checkAmendGuards(ARC, amend(
      '1. ISSUE: a → CHANGE: b → BEATS: 4',
      `BEAT 4: ${'and on and on '.repeat(40)}`,
    ));
    expect(g.ok).toBe(false);
    expect(g.violations.join(' ')).toContain('tripled');
  });
});

describe('applyArcAmendment', () => {
  it('changes only the named beat and keeps the count', () => {
    const p = amend(
      '1. ISSUE: a → CHANGE: b → BEATS: 4',
      'BEAT 4: The bigger child feels it go cold, calls it a stone and walks away.',
    );
    const r = applyArcAmendment(ARC, p);
    const before = splitArcBeats(ARC);
    const after = splitArcBeats(r.arc);
    expect(after).toHaveLength(before.length);
    expect(r.applied).toEqual([4]);
    for (const b of after) {
      if (b.n === 4) expect(b.text).toContain('calls it a stone');
      else expect(b.text).toBe(before.find((o: any) => o.n === b.n).text);
    }
  });

  // No partial repairs: a refused amendment returns the arc untouched rather
  // than shipping the half that happened to pass.
  it('returns the arc unchanged when the guards refuse', () => {
    const p = amend(
      '1. ISSUE: a → CHANGE: b → BEATS: 4',
      'BEAT 4: A fine repair.\nBEAT 2: A beat nobody asked to touch.',
    );
    const r = applyArcAmendment(ARC, p);
    expect(r.arc).toBe(ARC);
    expect(r.applied).toEqual([]);
    expect(r.violations.length).toBeGreaterThan(0);
  });
});
