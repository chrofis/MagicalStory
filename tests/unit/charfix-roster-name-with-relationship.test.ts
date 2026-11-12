// Regression: a customer typed relationship text into the character name box
// ("Noah, Freund von Louis und Tobias, Bruder von Tilo"). The story, the briefs
// and the detector use "Noah"; the roster holds the full field. char-fix
// refused the customer's own character ("no uploaded character entry" /
// "no bbox for ..."). Prod job_1794498448758_ryuv0q8lb, job_1794506785522_17d2hnvd9,
// job_1794479943880_pvykbjtwx (2026-11-12). bugs.json charfix-misses-cast-named-with-relationship.
import { describe, it, expect } from 'vitest';
import {
  charFixReferenceGap, findRosterCharacter, resolveCharBbox,
} from '../../server/lib/charRepairTarget.js';
import { buildCastIndex, resolveEntity, shortName, sameEntity } from '../../server/lib/castResolver.js';

const NOAH = 'Noah, Freund von Louis und Tobias, Bruder von Tilo';
const roster = [
  { id: 1, name: NOAH },
  { id: 2, name: 'Louis, Freund von Noah' },
  { id: 3, name: 'Tobias, Freund von Noah' },
  { id: 4, name: 'Tilo, jüngerer Bruder von Noah' },
];
const story = { characters: roster };
const idx = buildCastIndex(story, null);
const box = [0.1, 0.1, 0.9, 0.5];

describe('shortName / castResolver', () => {
  it('takes the part before the first comma, else the name unchanged', () => {
    expect(shortName(NOAH)).toBe('Noah');
    expect(shortName('Mila')).toBe('Mila');
    expect(shortName(', odd')).toBe(', odd');
  });
  it('resolves the short name and the full field to the same entry, and never to a neighbour', () => {
    expect(resolveEntity('Noah', idx)?.id).toBe('1');
    expect(resolveEntity(NOAH, idx)?.id).toBe('1');
    // "Louis" used to land on Noah's entry because Noah's relationship text contains "Louis"
    expect(resolveEntity('Louis', idx)?.id).toBe('2');
    expect(resolveEntity('Tobias', idx)?.id).toBe('3');
    expect(sameEntity('Noah', NOAH, idx)).toBe(true);
    expect(sameEntity('Louis', NOAH, idx)).toBe(false);
  });
});

describe('charFixReferenceGap / findRosterCharacter', () => {
  it('finds the roster entry for the short name the story uses', () => {
    expect(charFixReferenceGap({ characters: roster, characterName: 'Noah' })).toBeNull();
    expect(charFixReferenceGap({ characters: roster, characterName: 'Tobias' })).toBeNull();
    expect(findRosterCharacter(roster, 'Noah')?.id).toBe(1);
  });
  it('still declines a figure the story invented', () => {
    expect(charFixReferenceGap({ characters: roster, characterName: 'Thalassa' })?.reason).toBe('no-roster-entry');
  });
  it('does not hand an invented secondary the roster entry of a same-named person', () => {
    const vb = { secondaryCharacters: [{ id: 'CHR001', name: 'Noah Fischer' }] };
    expect(findRosterCharacter(roster, 'Noah Fischer', vb)).toBeNull();
  });
});

describe('resolveCharBbox — both directions of the name mismatch', () => {
  const fig = (name) => ({ name, faceBox: box, bodyBox: box });
  it('short target name finds the figure the detector labelled with the full roster field', () => {
    const r = resolveCharBbox('Noah', { bestEval: { bboxDetection: { figures: [fig(NOAH)] } }, pageNumber: 14, castIndex: idx });
    expect(r.source).toBe('bbox');
  });
  it('full roster field as target finds the figure labelled with the short name', () => {
    const r = resolveCharBbox(NOAH, { bestEval: { bboxDetection: { figures: [fig('Noah'), fig('UNKNOWN')] } }, pageNumber: 8, castIndex: idx });
    expect(r.source).toBe('bbox');
  });
  it('does not pick a different person', () => {
    const r = resolveCharBbox('Noah', { bestEval: { bboxDetection: { figures: [fig('Louis')] } }, pageNumber: 8, castIndex: idx });
    expect(r.source).toBeNull();
  });
});
