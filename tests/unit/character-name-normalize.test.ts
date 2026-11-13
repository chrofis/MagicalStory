import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normalizeCharacterName } = require('../../server/lib/characterName');

describe('normalizeCharacterName', () => {
  it.each([
    ['LUNA', 'Luna'],
    ['luna', 'Luna'],
    ['ANNE-SOPHIE', 'Anne-Sophie'],
    ['anne-sophie', 'Anne-Sophie'],
    ['JEAN LUC', 'Jean Luc'],
    ["O'BRIEN", "O'Brien"],
    ['ÉLODIE', 'Élodie'],
    ['zoë', 'Zoë'],
    ['ÇAĞLA', 'Çağla'],
  ])('title-cases %s -> %s', (input, expected) => {
    expect(normalizeCharacterName(input)).toBe(expected);
  });

  it.each(['Luna', 'McKenzie', 'DeShawn', 'Anne-Sophie', 'Jean-Luc', 'Lea', 'LéA', 'Élodie', 'JJ', 'AJ', 'J', 'ed', '', 'A.J.'])(
    'leaves %j untouched', (input) => {
      expect(normalizeCharacterName(input)).toBe(input);
    });

  it('passes non-strings through', () => {
    expect(normalizeCharacterName(undefined)).toBeUndefined();
    expect(normalizeCharacterName(null)).toBeNull();
  });
});

// Relationship text typed into the name box (owner decision 2026-11-13, decisions.md).
const { splitCharacterName, normalizeCharacterEntry, appendSpecialDetails } = require('../../server/lib/characterName');
import { readFileSync } from 'fs';

describe('name box holds one clean name', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeCharacterName('  Luna   Marie ')).toBe('Luna Marie');
  });
  it('cuts at the first comma and keeps the rest', () => {
    expect(splitCharacterName('Noah, Freund von Louis und Tobias, Bruder von Tilo')).toEqual({
      name: 'Noah', moved: 'Freund von Louis und Tobias, Bruder von Tilo',
    });
    expect(normalizeCharacterName('Tobias, Freund von Noah')).toBe('Tobias');
  });
  it('case rule applies to the head ("TILO, Bruder von Noah")', () => {
    expect(normalizeCharacterName('TILO , Bruder von Noah')).toBe('Tilo');
  });
  it('a leading comma leaves no name (the routes refuse it)', () => {
    expect(splitCharacterName(', Bruder von Tilo').name).toBe('');
  });
  it('no comma, no split: the form stops that case, code does not guess', () => {
    expect(normalizeCharacterName('Aurelia Schwester von Aria')).toBe('Aurelia Schwester von Aria');
  });
  it('appendSpecialDetails never loses or repeats text', () => {
    expect(appendSpecialDetails('', 'Freund von Noah')).toBe('Freund von Noah');
    expect(appendSpecialDetails('mag Frösche', 'Freund von Noah')).toBe('mag Frösche. Freund von Noah');
    expect(appendSpecialDetails('Freund von Noah', 'Freund von Noah')).toBe('Freund von Noah');
    expect(appendSpecialDetails('mag Frösche', '')).toBe('mag Frösche');
  });
});

describe('normalizeCharacterEntry (save, trial and create-story snapshot)', () => {
  it('moves the text after the comma into traits.specialDetails, keeping other traits', () => {
    const c = { id: 1, name: 'Tobias, Freund von Noah ', traits: { strengths: ['brave'], specialDetails: 'mag Frösche' } };
    const out = normalizeCharacterEntry(c);
    expect(out.name).toBe('Tobias');
    expect(out.traits).toEqual({ strengths: ['brave'], specialDetails: 'mag Frösche. Freund von Noah' });
    expect(c.name).toBe('Tobias, Freund von Noah '); // input not mutated
  });
  it('creates traits when the character has none', () => {
    expect(normalizeCharacterEntry({ id: 2, name: 'Noah, Freund von Louis' }).traits).toEqual({ specialDetails: 'Freund von Louis' });
  });
  it('is idempotent and returns a clean entry as is', () => {
    const clean = { id: 3, name: 'Luna' };
    expect(normalizeCharacterEntry(clean)).toBe(clean);
    const once = normalizeCharacterEntry({ id: 4, name: 'Noah, Freund von Louis' });
    expect(normalizeCharacterEntry(once)).toBe(once);
  });
  it('passes non-characters through', () => {
    expect(normalizeCharacterEntry(null)).toBeNull();
    expect(normalizeCharacterEntry({ id: 5 })).toEqual({ id: 5 });
  });
  it('the create-story snapshot map yields clean names for old stored comma names', () => {
    const snapshot = [{ id: 1, name: 'Noah, Freund von Louis und Tobias, Bruder von Tilo' }, { id: 2, name: 'TOBIAS ' }].map(normalizeCharacterEntry);
    expect(snapshot.map((c: any) => c.name)).toEqual(['Noah', 'Tobias']);
  });
});

describe('the routes that accept a character name use the one normaliser', () => {
  const src = (f: string) => readFileSync(`server/routes/${f}`, 'utf8');
  it('characters.js save normalises every character and refuses a name that leaves nothing', () => {
    const s = src('characters.js');
    expect(s).toMatch(/normalizeCharacterEntry\(char\)/);
    expect(s).toMatch(/CHARACTER_NAME_REQUIRED/);
  });
  it('jobs.js create-story normalises the characters snapshot', () => {
    expect(src('jobs.js')).toMatch(/inputData\.characters\.map\(normalizeCharacterEntry\)/);
  });
  it('trial.js create and update split the name and keep the moved text', () => {
    const s = src('trial.js');
    expect((s.match(/splitCharacterName\(/g) || []).length).toBe(2);
    expect((s.match(/appendSpecialDetails\(/g) || []).length).toBe(2);
  });
});
