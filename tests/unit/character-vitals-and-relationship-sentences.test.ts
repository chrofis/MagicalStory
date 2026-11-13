import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { heightProblem as clientHeightProblem, heightHint, ageLabel, agedNoun } from '../../client/src/utils/characterVitals';
import { relationshipAgeConflict, relationshipAgeConflictText, relationshipTypes } from '../../client/src/constants/relationships';

const require_ = createRequire(import.meta.url);
const { findVitalsProblem, heightProblem, ageProblem, genderProblem } = require_('../../server/lib/characterVitals');
const { relationshipSentence } = require_('../../server/lib/relationships');
const { ageForPrompt, buildRelationshipLines } = require_('../../server/lib/promptBuilders');

const label = (key: string, lang = 'en') => (require_('../../shared/relationship-types.json').types.find((t: any) => t.key === key).labels[lang]);

describe('age 0 is an age (decisions 2026-11-13)', () => {
  it('server save accepts age 0 and refuses nonsense', () => {
    expect(ageProblem('0')).toBeNull();
    expect(ageProblem(0)).toBeNull();
    expect(ageProblem('')).toBeNull();
    expect(ageProblem('-1')).toBe('CHARACTER_AGE_INVALID');
    expect(ageProblem('abc')).toBe('CHARACTER_AGE_INVALID');
    expect(ageProblem('121')).toBe('CHARACTER_AGE_INVALID');
  });
  it('a prompt describes age 0 as a baby, not "0"', () => {
    expect(ageForPrompt('0')).toMatch(/baby/);
    expect(ageForPrompt(0)).toMatch(/baby/);
    expect(ageForPrompt('7')).toBe('7');
    expect(ageForPrompt('')).toBe('');
    expect(ageForPrompt(undefined)).toBe('');
  });
  it('the customer sees "under 1 year" in every language', () => {
    expect(ageLabel('0', 'de')).toBe('unter 1 Jahr');
    expect(ageLabel('0', 'en')).toBe('under 1 year');
    expect(ageLabel('0', 'fr')).toBe("moins d'un an");
    expect(ageLabel('0', 'it')).toBe('meno di 1 anno');
    expect(ageLabel('7', 'de')).toBe('7 Jahre');
    expect(ageLabel('', 'de')).toBe('');
  });
  it('the avatar prompt says baby for age 0', () => {
    expect(agedNoun(0, 'boy')).toBe('a baby boy');
    expect(agedNoun(7, 'girl')).toBe('a 7-year-old girl');
  });
});

describe('height is whole cm 40-250 (a typed "1.10" was read as 1 cm)', () => {
  it.each(['1.10', '1,10', '1', '39', '251', '110.5', 'tall', '-5'])('refuses %s on both sides', (v) => {
    expect(clientHeightProblem(v)).toBe(true);
    expect(heightProblem(v)).toBe('CHARACTER_HEIGHT_INVALID');
  });
  it.each(['40', '110', '250', ' 170 ', ''])('accepts %s on both sides', (v) => {
    expect(clientHeightProblem(v)).toBe(false);
    expect(heightProblem(v)).toBeNull();
  });
  it('has a hint in four languages', () => {
    for (const l of ['de', 'fr', 'it', 'en']) expect(heightHint(l)).toMatch(/110/);
    expect(heightHint('de')).toMatch(/Grösse in cm/);
  });
  it('the save refuses a new bad height but lets an unchanged stored value through', () => {
    const stored = [{ id: 1, name: 'A', age: '6', physical: { height: 'average' } }];
    expect(findVitalsProblem([{ id: 1, name: 'A', age: '6', physical: { height: '1.10' } }], stored)).toMatchObject({ code: 'CHARACTER_HEIGHT_INVALID', characterId: 1 });
    expect(findVitalsProblem([{ id: 1, name: 'A', age: '6', physical: { height: 'average' } }], stored)).toBeNull();
    expect(findVitalsProblem([{ id: 2, name: 'B', age: '0', physical: { height: '55' } }], stored)).toBeNull();
    expect(findVitalsProblem([{ id: 2, name: 'B', age: '500' }], stored)).toMatchObject({ code: 'CHARACTER_AGE_INVALID' });
  });
});

describe('relationship sentences are full and unambiguous', () => {
  it('built-in labels in every language become one English sentence', () => {
    for (const l of ['en', 'de', 'fr', 'it']) {
      expect(relationshipSentence('Anna', 'Ben', label('grandparentOf', l))).toBe('Anna is a grandparent of Ben');
    }
    expect(relationshipSentence('Anna', 'Ben', label('friends'))).toBe('Anna and Ben are friends');
  });
  it('a custom label reads "A is B\'s <label>", never "A is Grossmutter B"', () => {
    expect(relationshipSentence('Anna', 'Ben', 'Grossmutter')).toBe("Anna is Ben's Grossmutter");
  });
  it('every built-in type has a sentence naming both people', () => {
    for (const t of relationshipTypes.slice(1, -1)) {
      const s = relationshipSentence('AAA', 'BBB', t.value.en);
      expect(s).toMatch(/AAA/);
      expect(s).toMatch(/BBB/);
    }
  });
  it('the story brief uses it for built-in and custom cells', () => {
    const lines = buildRelationshipLines({
      characters: [{ id: 1, name: 'Anna' }, { id: 2, name: 'Ben' }, { id: 3, name: 'Cleo' }],
      relationships: { '1-2': label('parentOf'), '1-3': 'Tante' },
      relationshipTexts: {},
    });
    expect(lines).toEqual(['Anna is a parent of Ben', "Anna is Cleo's Tante"]);
  });
});

describe('warning when a younger character is parent/grandparent of an older one', () => {
  it('warns from ages and typed key only', () => {
    expect(relationshipAgeConflict(label('parentOf'), '5', '40')).toBe(true);
    expect(relationshipAgeConflict(label('grandparentOf', 'de'), '8', '35')).toBe(true);
    expect(relationshipAgeConflict(label('childOf'), '40', '5')).toBe(true);
    expect(relationshipAgeConflict(label('parentOf'), '40', '5')).toBe(false);
    expect(relationshipAgeConflict(label('childOf'), '5', '40')).toBe(false);
    expect(relationshipAgeConflict(label('parentOf'), '30', '30')).toBe(false);
  });
  it('age 0 counts as an age', () => {
    expect(relationshipAgeConflict(label('parentOf'), '0', '30')).toBe(true);
    expect(relationshipAgeConflict(label('parentOf'), '30', '0')).toBe(false);
  });
  it('never warns for a custom label, a sibling, or a missing age', () => {
    expect(relationshipAgeConflict('Grossmutter', '5', '40')).toBe(false);
    expect(relationshipAgeConflict(label('olderSiblingOf'), '5', '40')).toBe(false);
    expect(relationshipAgeConflict(label('parentOf'), '', '40')).toBe(false);
  });
  it('has the warning text in four languages', () => {
    for (const l of ['de', 'fr', 'it', 'en'] as const) expect(relationshipAgeConflictText(l).length).toBeGreaterThan(20);
  });
});

describe('gender is checked on save (decisions 2026-11-13)', () => {
  it('accepts male, female and an unpicked draft, refuses anything else (no third choice)', () => {
    for (const ok of ['male', 'female', '', undefined, null]) expect(genderProblem(ok as any), String(ok)).toBeNull();
    for (const bad of ['other', 'boy', 'girl', 'männlich', 'Male', 5, {}]) expect(genderProblem(bad as any), String(bad)).toBe('CHARACTER_GENDER_INVALID');
  });
  it('findVitalsProblem reports it with the character, even if the same value is stored', () => {
    const r = findVitalsProblem([{ id: 1, name: 'Ana', gender: 'boy' }], [{ id: 1, gender: 'boy' }]);
    expect(r).toEqual({ code: 'CHARACTER_GENDER_INVALID', characterId: 1, name: 'Ana' });
    expect(findVitalsProblem([{ id: 1, name: 'Ana', gender: 'female', age: '0' }], [])).toBeNull();
  });
});

describe('the forms offer male and female only (owner 2026-11-13)', () => {
  const fs = require_('fs'); const path = require_('path');
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../client/src', f), 'utf8');
  it('the character form has no third gender option, and the trial picks boy or girl', () => {
    expect(read('components/character/CharacterForm.tsx')).not.toMatch(/<option value="other"/);
    expect(read('types/character.ts')).toMatch(/gender: 'male' \| 'female';/);
    expect(read('pages/trial/TrialCharacterStep.tsx')).not.toMatch(/value: 'other'/);
  });
});

describe('one gender label everywhere (owner 2026-11-13)', () => {
  const fs = require_('fs'); const path = require_('path');
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '../../client/src', f), 'utf8');
  it('the character list uses the shared label, never a third word for an unset gender', () => {
    const list = read('components/character/CharacterList.tsx');
    expect(list).toMatch(/genderLabel\(char\.gender, language\)/);
    expect(list).not.toMatch(/t\.other/);
  });
});

describe('the voucher PDF is named in the card language, one map for mail and download', () => {
  const { voucherPdfFilename } = require_('../../server/lib/vouchers');
  it.each([['de', 'Magical-Story-Gutschein.pdf'], ['fr', 'Magical-Story-Bon-Cadeau.pdf'], ['it', 'Magical-Story-Buono-Regalo.pdf'], ['en', 'Magical-Story-Gift-Voucher.pdf']])('%s', (l, name) => {
    expect(voucherPdfFilename(l)).toBe(name);
  });
  it('the download route no longer hard-codes the German name', () => {
    const fs = require_('fs'); const path = require_('path');
    expect(fs.readFileSync(path.join(__dirname, '../../server/routes/vouchers.js'), 'utf8')).not.toMatch(/Gutschein\.pdf/);
  });
});
