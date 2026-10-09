/**
 * ONE matcher for "is this cast name in this text?" (docs/decisions.md 2026-10-09, name matchers;
 * docs/SETTLED.md: a character string becomes an entry only through castResolver).
 *
 * Before the consolidation fourteen call sites each wrote their own: a `.includes()` substring
 * ("Turi" in "capturing", "Rico" in "tricorn", "Papagei" in "Papageieninsel"), an ASCII `\b`
 * regex (blind to "Noé"), a Unicode regex copied six times with different edges. The cases below
 * are the real ones the replay over 49 stored staging stories found, plus the edges of the rule.
 */
import { describe, it, expect } from 'vitest';

const CR = require('../../server/lib/castResolver');
const { getCharactersInScene, unionPageCast, findCastMissingFromMetadata } = require('../../server/lib/sceneMetadata');
const { namesIn } = require('../../server/lib/planCounters');
const { selectGeometryFacts } = require('../../server/lib/sceneGeometry');
const { characterWindow } = require('../../server/lib/clothingCheck');

describe('isNameMentioned: whole word, letters and digits are word characters', () => {
  it('"Max" is never found inside "Maximilian", nor "Ann" inside "Anna"', () => {
    expect(CR.isNameMentioned('Maximilian rides home', 'Max')).toBe(false);
    expect(CR.isNameMentioned('Anna waves', 'Ann')).toBe(false);
    expect(CR.isNameMentioned('Max rides home', 'Max')).toBe(true);
  });

  it('the real substring false positives from the stored stories do not match', () => {
    expect(CR.isNameMentioned('a shot capturing his quiet focus', 'Turi')).toBe(false);
    expect(CR.isNameMentioned('she wears a red wool tricorn hat', 'Rico')).toBe(false);
    expect(CR.isNameMentioned('Teppichmeer und Papageieninsel', 'Papagei')).toBe(false);
  });

  it('accented names match where an ASCII \\b never did', () => {
    expect(CR.isNameMentioned('Noé a sorti un biscuit', 'Noé')).toBe(true);
    expect(CR.isNameMentioned('Il a vu Zoé.', 'Zoé')).toBe(true);
    expect(CR.isNameMentioned('Émile court', 'Émile')).toBe(true);
  });

  it('a possessive counts by default and is refused on request', () => {
    expect(CR.isNameMentioned("Anna's hat", 'Anna')).toBe(true);
    expect(CR.isNameMentioned('Anna’s hat', 'Anna')).toBe(true);
    expect(CR.isNameMentioned("Anna's attic", 'Anna', { possessive: false })).toBe(false);
    expect(CR.isNameMentioned('Anna’s attic', 'Anna', { possessive: false })).toBe(false);
    expect(CR.isNameMentioned('Anna sits in the attic', 'Anna', { possessive: false })).toBe(true);
  });

  it('is case-insensitive unless asked, so a name that is also a word can keep its capital', () => {
    expect(CR.isNameMentioned('the rose bush', 'Rose')).toBe(true);
    expect(CR.isNameMentioned('the rose bush', 'Rose', { caseSensitive: true })).toBe(false);
    expect(CR.isNameMentioned('Rose waves', 'Rose', { caseSensitive: true })).toBe(true);
  });

  it('treats regex metacharacters in a name as literals, and an empty or one-letter name as in no text', () => {
    expect(CR.isNameMentioned('Lea (Mami) waves', 'Lea (Mami)')).toBe(true);
    expect(CR.isNameMentioned('A student waves', 'A')).toBe(false); // one letter is a word of the language, never a person
    expect(CR.isNameMentioned('anything', '')).toBe(false);
    expect(CR.isNameMentioned(null, 'Max')).toBe(false);
  });
});

describe('namesMentioned and entriesMentioned', () => {
  it('namesMentioned keeps the order of the names and counts an alias as its name', () => {
    expect(CR.namesMentioned('Malva looks at Grimm', ['Grimm', 'Malva Grimm', 'Lena'], { 'Malva Grimm': ['Malva'] }))
      .toEqual(['Grimm', 'Malva Grimm']);
  });

  const storyData = { characters: [{ name: 'Max' }, { name: 'Lukas Zimmer' }, { name: 'Lukas Meier' }] };
  const vb = { secondaryCharacters: [{ id: 'CHR001', name: 'Mother' }], animals: [{ id: 'ANI001', name: 'Mother Dragon' }, { id: 'ANI002', name: 'Turi' }] };
  const index = CR.buildCastIndex(storyData, vb);

  it('finds whole names only, in pool order', () => {
    expect(CR.entriesMentioned('Maximilian and Max walk', index).map((e: any) => e.name)).toEqual(['Max']);
    expect(CR.entriesMentioned('a shot capturing the light', index)).toEqual([]);
  });

  it('kinds limits the pools searched', () => {
    expect(CR.entriesMentioned('Mother Dragon and Turi', index, { kinds: ['animal'] }).map((e: any) => e.name)).toEqual(['Mother Dragon', 'Turi']);
    expect(CR.entriesMentioned('Turi waves', index, { kinds: ['secondary'] })).toEqual([]);
  });

  it('a bare first token counts only when no other entry carries that word', () => {
    // "Lukas" is the first word of two cast entries: refused. "Mother" belongs to a secondary AND is a word of "Mother Dragon".
    expect(CR.entriesMentioned('Lukas waves', index, { firstToken: true })).toEqual([]);
    const solo = CR.buildCastIndex({ characters: [{ name: 'Malva Grimm' }, { name: 'Max' }] }, null);
    expect(CR.entriesMentioned('Malva waves', solo, { firstToken: true }).map((e: any) => e.name)).toEqual(['Malva Grimm']);
    expect(CR.entriesMentioned('Malva waves', solo)).toEqual([]);
  });
});

describe('replaceNames / replaceNamesWith: one pass, whole words, possessive kept after the replacement', () => {
  it('replaces whole names only and keeps the possessive suffix', () => {
    expect(CR.replaceNames("Noah's hat; Noahs; Hansel", { noah: 'the figure', hans: 'X' })).toBe("the figure's hat; Noahs; Hansel");
  });
  it('is simultaneous and the longer name wins', () => {
    expect(CR.replaceNames('Anna Maria met Anna', { anna: 'A', 'anna maria': 'AM', a: 'never' })).toBe('AM met A');
  });
  it('caseSensitive keeps a lower-case noun alone', () => {
    expect(CR.replaceNamesWith('Rose and the rose', ['Rose'], () => 'X', { caseSensitive: true })).toBe('X and the rose');
  });
});

describe('the sites that used their own matcher now agree with it', () => {
  const chars = [{ name: 'Max' }, { name: 'Turi' }];

  it('getCharactersInScene: the text scan never finds "Max" in "Maximilian"', () => {
    expect(getCharactersInScene('Maximilian the king rides past.', chars)).toEqual([]);
    expect(getCharactersInScene('Max rides past.', chars).map((c: any) => c.name)).toEqual(['Max']);
  });

  it('getCharactersInScene: a listed first name shared by two cast entries refuses instead of taking both', () => {
    const two = [{ name: 'Lukas Zimmer' }, { name: 'Lukas Meier' }];
    const brief = 'Scene\n---METADATA---\n```json\n{"characters":["Lukas"]}\n```';
    expect(getCharactersInScene(brief, two)).toEqual([]);
    const one = [{ name: 'Lukas Zimmer' }, { name: 'Max' }];
    expect(getCharactersInScene(brief, one).map((c: any) => c.name)).toEqual(['Lukas Zimmer']);
  });

  it('unionPageCast resolves hint names (with a parenthetical) through the same rule', () => {
    expect(unionPageCast('No names here.', ['Max (background)'], chars).map((c: any) => c.name)).toEqual(['Max']);
    expect(unionPageCast('No names here.', ['Maximilian'], chars)).toEqual([]);
  });

  it('findCastMissingFromMetadata keeps its case-sensitive, possessive-refusing reading', () => {
    const brief = '```json\n{"characters":[]}\n```\nRose waves at the rose bush. Max\'s attic is dark.';
    // metadata lists nobody, so the scan runs: "Rose" is found with its capital; Max appears only as a possessive.
    expect(findCastMissingFromMetadata(`Rose waves at the rose bush. Max's attic.\n---METADATA---\n\`\`\`json\n{"characters":[]}\n\`\`\``, ['Rose', 'Max'])).toEqual(['Rose']);
    expect(brief).toBeTruthy();
  });

  it('planCounters.namesIn finds an accented cast name the ASCII \\b missed', () => {
    expect(namesIn('Noé a sorti de sa poche un biscuit', ['Noé', 'Jules'])).toEqual(['Noé']);
  });

  it('planCounters.namesIn still ignores quoted speech', () => {
    expect(namesIn('Anna says "Max is here"', ['Anna', 'Max'])).toEqual(['Anna']);
  });

  it('selectGeometryFacts keeps a clean sentence whose words merely contain a cast name ("Turi" in "capturing")', () => {
    const r = selectGeometryFacts({
      mainScenePrompt: 'Medium shot capturing the moment of hatching and the tiny, magical spark lighting the night air.',
      castNames: ['Turi'],
    });
    expect(r.facts.join(' ')).toContain('capturing');
  });

  it('characterWindow starts at an accented name', () => {
    expect(characterWindow('Zoé — a girl — in her red robe. Max waits.', 'Zoé', ['Zoé', 'Max'])).toContain('red robe');
  });
});
