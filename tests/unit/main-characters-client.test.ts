import { describe, it, expect } from 'vitest';
import { pickMainCharacters, defaultMainCharacterId, mainLimit, addMainCharacter, trimMainCharacters } from '../../client/src/utils/mainCharacters';
import serverPicker from '../../server/lib/promptBuilders.js';

const ch = (id: number, name: string, age: string): any => ({ id, name, age });
const Lio = ch(1790699593024, 'Lio', '4');
const Noam = ch(1790606665421, 'Noam', '2');

describe('mainLimit', () => {
  it('1 for 1-2 characters, 2 for 3+', () => {
    expect([1, 2, 3, 4, 5, 7].map(mainLimit)).toEqual([1, 1, 2, 2, 2, 2]);
  });
});

describe('pickMainCharacters (client mirror)', () => {
  it('2 characters: cap 1, oldest main counts', () => {
    const r = pickMainCharacters([Noam, Lio], [Noam.id, Lio.id]);
    expect(r.counted.map(c => c.name)).toEqual(['Lio']);
    expect(r.focusAge).toBe(4);
  });
  it('4 characters: cap 2, oldest first', () => {
    const four = [Noam, Lio, ch(3, 'Mama', '35'), ch(4, 'Papa', '37')];
    expect(pickMainCharacters(four, [Noam.id, Lio.id, 3]).counted.map(c => c.name)).toEqual(['Mama', 'Lio']);
  });
  it('only the younger as main: focus is the younger', () => {
    const r = pickMainCharacters([Noam, Lio], [Noam.id]);
    expect(r.focus?.name).toBe('Noam');
    expect(r.focusAge).toBe(2);
  });
  it('unknown age: no focusAge', () => {
    expect(pickMainCharacters([ch(1, 'A', ''), ch(2, 'B', '3')], [1]).focusAge).toBeNull();
  });
  it('no mains declared: no focus', () => {
    expect(pickMainCharacters([Noam, Lio], []).focus).toBeNull();
  });
  it('agrees with the server pickMainCharacters on the same roster', () => {
    const chars = [Noam, Lio, ch(3, 'Mama', '35'), ch(4, 'Papa', '37'), ch(5, 'Oma', '70')];
    for (const mains of [[1], [Noam.id, Lio.id], [Noam.id, Lio.id, 3], [3, 4, 5]]) {
      const mod: any = serverPicker;
      const s = mod.pickMainCharacters({ characters: chars, mainCharacters: mains });
      expect(pickMainCharacters(chars, mains).counted.map(x => x.id)).toEqual(s.mains.map((x: any) => x.id));
    }
  });
});

describe('addMainCharacter', () => {
  it('limit 1: radio swap, previous main is dropped', () => {
    expect(addMainCharacter(1, [Noam.id], Lio.id)).toEqual([Lio.id]);
    expect(addMainCharacter(2, [Noam.id], Lio.id)).toEqual([Lio.id]);
  });
  it('limit 2: second main appends, third is refused (button disabled)', () => {
    expect(addMainCharacter(4, [1], 2)).toEqual([1, 2]);
    expect(addMainCharacter(4, [1, 2], 3)).toEqual([1, 2]);
  });
  it('already main: unchanged', () => {
    expect(addMainCharacter(4, [1, 2], 2)).toEqual([1, 2]);
  });
  it('un-excluding a character can lift the limit to 2 (count is after the change)', () => {
    expect(addMainCharacter(4, [1], 2)).toEqual([1, 2]);
  });
});

describe('trimMainCharacters', () => {
  it('cast shrinks 3 -> 2: keeps the first-selected main only', () => {
    expect(trimMainCharacters([1, 2], [2, 1])).toEqual([2]);
  });
  it('stored roles above the limit on load are trimmed', () => {
    expect(trimMainCharacters([Noam.id, Lio.id], [Noam.id, Lio.id])).toEqual([Noam.id]);
    expect(trimMainCharacters([1, 2, 3, 4, 5], [1, 2, 3])).toEqual([1, 2]);
    expect(trimMainCharacters([1, 2, 3], [1, 2])).toEqual([1, 2]);
  });
  it('drops mains that are no longer in the story, within-limit mains untouched', () => {
    expect(trimMainCharacters([1, 2, 3, 4], [9, 2])).toEqual([2]);
    expect(trimMainCharacters([1, 2, 3, 4], [1, 2])).toEqual([1, 2]);
  });
});

describe('server pickMainCharacters cap', () => {
  it('1 / 2 / 3 / 5 characters -> 1 / 1 / 2 / 2 mains, oldest first, all declared', () => {
    const mod: any = serverPicker;
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ch(i + 1, 'C' + i, String(2 + i * 3)));
    for (const [n, want] of [[1, 1], [2, 1], [3, 2], [5, 2]] as const) {
      const chars = mk(n);
      const r = mod.pickMainCharacters({ characters: chars, mainCharacters: chars.map(c => c.id) });
      expect(r.mains).toHaveLength(want);
      expect(r.mains[0].id).toBe(chars[n - 1].id);
    }
  });
});

describe('defaultMainCharacterId', () => {
  it('first-created child, not the oldest or youngest', () => {
    expect(defaultMainCharacterId([Lio, Noam, ch(9, 'Mama', '35')])).toBe(Noam.id);
  });
  it('ignores adults when a child exists', () => {
    expect(defaultMainCharacterId([ch(1, 'Mama', '35'), ch(2, 'Kid', '8')])).toBe(2);
  });
  it('no child 1-10: youngest', () => {
    expect(defaultMainCharacterId([ch(1, 'Mama', '35'), ch(2, 'Teen', '15')])).toBe(2);
  });
  it('empty list: null', () => {
    expect(defaultMainCharacterId([])).toBeNull();
  });
});
