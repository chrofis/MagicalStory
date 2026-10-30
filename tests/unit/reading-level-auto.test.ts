import { describe, it, expect } from 'vitest';
import { readingLevelForAge, autoReadingLevel } from '../../client/src/utils/readingLevel';

const ch = (id: number, name: string, age: string): any => ({ id, name, age });

describe('readingLevelForAge (bands printed on the level cards: 3-6, 6-10, 10+)', () => {
  it.each([
    [0, '1st-grade'], [2, '1st-grade'], [3, '1st-grade'], [5, '1st-grade'],
    [6, 'standard'], [9, 'standard'],
    [10, 'advanced'], [14, 'advanced'],
  ])('age %i -> %s', (age, level) => {
    expect(readingLevelForAge(age as number)).toBe(level);
  });
});

describe('autoReadingLevel', () => {
  const lio = ch(1, 'Lio', '8');
  const noam = ch(2, 'Noam', '3');
  const mama = ch(3, 'Mama', '38');

  it('uses the YOUNGEST counted main, not the oldest', () => {
    const r = autoReadingLevel([lio, noam, mama], [1, 2])!;
    expect(r.name).toBe('Noam');
    expect(r.age).toBe(3);
    expect(r.level).toBe('1st-grade');
  });

  it('a single main decides alone', () => {
    expect(autoReadingLevel([lio, noam, mama], [1])!.level).toBe('standard');
  });

  it('only counts mains the server counts (2-character cast: one main, the oldest)', () => {
    const r = autoReadingLevel([lio, noam], [1, 2])!;
    expect(r.name).toBe('Lio');
  });

  it('returns null without a main or without a readable age', () => {
    expect(autoReadingLevel([lio, noam, mama], [])).toBeNull();
    expect(autoReadingLevel([ch(9, 'X', '')], [9])).toBeNull();
  });

  it('the signature changes when a main or an age changes, so a manual choice stops applying', () => {
    const a = autoReadingLevel([lio, noam, mama], [1, 2])!.signature;
    const older = autoReadingLevel([lio, ch(2, 'Noam', '4'), mama], [1, 2])!.signature;
    const other = autoReadingLevel([lio, noam, mama], [1, 3])!.signature;
    expect(new Set([a, older, other]).size).toBe(3);
    expect(autoReadingLevel([lio, noam, mama], [2, 1])!.signature).toBe(a); // order of selection does not matter
  });
});
