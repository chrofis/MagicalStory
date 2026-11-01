import { describe, it, expect } from 'vitest';

// Staging job_1793520777470_7sgat9ene (going to bed, 2026-11-01): the Art Director dressed the back cover in
// nightwear, nothing sent the brief back, and the story stopped at the cover's render. Owner: the step that writes
// the cover scene must know the rule; the brief check sends a cover in nightwear back once with the same sentence.
const { COVER_DAY_OUTFIT_FACT, coverNightwearFindings, assertCoverClothingIsDay } = require('../../server/lib/clothingCategories.js');
const { buildCoverBeats } = require('../../server/lib/coverBeats.js');
const fs = require('fs');
const path = require('path');

const cast = { characters: [{ name: 'Mia', isMainCharacter: true }, { name: 'Tom' }] };

describe('the cover scene line carries the day-outfit sentence', () => {
  it('in a story whose wardrobe has nightwear, every cover plan line has it', () => {
    const beats = buildCoverBeats(cast, { clothingRequirements: { Mia: { standard: { used: true }, nightwear: { used: true } } } });
    expect(beats).toHaveLength(3);
    for (const b of beats) expect(b.planLine).toContain(COVER_DAY_OUTFIT_FACT);
  });
  it('a story with no nightwear keeps its cover lines unchanged', () => {
    const beats = buildCoverBeats(cast, { clothingRequirements: { Mia: { standard: { used: true } } } });
    for (const b of beats) expect(b.planLine).not.toContain(COVER_DAY_OUTFIT_FACT);
  });
});

describe('coverNightwearFindings (the critic) reads the same sentence', () => {
  it('a cover in nightwear is one re-askable finding naming who', () => {
    const f = coverNightwearFindings(-3, { Mia: 'nightwear', Tom: 'standard' });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ pageNumber: -3, type: 'cover_nightwear' });
    expect(f[0].detail).toContain('Mia');
    expect(f[0].detail).not.toContain('Tom');
    expect(f[0].detail).toContain(COVER_DAY_OUTFIT_FACT);
  });
  it('a cover in day clothes, or with no clothing, has none', () => {
    expect(coverNightwearFindings(-1, { Mia: 'standard', Tom: 'costumed:pirate' })).toEqual([]);
    expect(coverNightwearFindings(-1, null)).toEqual([]);
  });
  it('the render stop still fires on the same predicate', () => {
    expect(() => assertCoverClothingIsDay({ Mia: 'nightwear' }, 'page -3')).toThrow(/Mia is dressed in nightwear/);
    expect(() => assertCoverClothingIsDay({ Mia: 'standard' }, 'page -3')).not.toThrow();
  });
  it('is sent to the re-ask, not shipped as a cover-only flag', () => {
    const { COVER_ONLY_TYPES } = require('../../server/lib/briefChecks.js');
    expect(COVER_ONLY_TYPES.has('cover_nightwear')).toBe(false);
    const src = fs.readFileSync(path.join(__dirname, '../../server/lib/briefChecks.js'), 'utf8');
    expect(src).toMatch(/coverNightwearFindings\(x\.pageNumber/);
  });
});

describe('both Art Director templates say the cover rule wins over the bedtime rule', () => {
  for (const t of ['scene-briefs-all.txt', 'scene-expansion.txt']) {
    it(t, () => {
      const s = fs.readFileSync(path.join(__dirname, '../../prompts', t), 'utf8');
      expect(s).toMatch(/cover is never `nightwear`, even when the story ends at bedtime/);
    });
  }
});

describe('a failed run keeps the Art Director briefs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
  it('checkpointed with covers and their decided places, and read back by the partial save', () => {
    expect(src).toMatch(/saveCheckpoint\(jobId, 'art_director_briefs', \{[\s\S]{0,400}\.\.\.coverScenes\][\s\S]{0,300}jevFixed/);
    expect(src).toMatch(/cp\.step_name === 'art_director_briefs'/);
    expect(src).toMatch(/\r?\n\s+artDirectorBriefs,\r?\n/);
  });
});
