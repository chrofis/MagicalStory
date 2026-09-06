/**
 * I11 — an invented child cast as a PEER of the commissioned children must
 * carry their age band.
 *
 * Evidence: job_1788641639919_mpjwlzkf1 (Baden, en-gb, 14 pages). The book was
 * commissioned for Lily (6) and Ethan (9). The bible invented CHR001 "The boy
 * in the striped scarf" with `age: "a boy of about ten"` and no constraint of
 * any kind tying that number to the commissioned children; on p5 he renders as
 * an 11-12-year-old beside a 6-year-old.
 */
import { describe, it, expect } from 'vitest';

// @ts-ignore — CommonJS lib
import ageBand from '../../server/lib/inventedAgeBand.js';
const {
  parseStatedAge, commissionedChildBand, buildChildAgeBandNote,
  checkSecondaryAges, clampAgeToBand, secondaryAgeCues,
} = ageBand as any;

// The commissioned cast of that story, verbatim from story_jobs.input_data.
const BADEN_CAST = [
  { name: 'Lily', age: '6' },
  { name: 'Ethan', age: '9' },
  { name: 'James', age: '42' },
  { name: 'Rachel', age: '40' },
  { name: 'Margaret', age: '70' },
];

// The two entries the bible actually produced, verbatim from
// stories.data.visualBible.secondaryCharacters.
const CHR001 = {
  id: 'CHR001',
  name: 'The boy in the striped scarf',
  age: 'a boy of about ten',
  appearsInPages: [3, 5, 6, 11, 13],
  description: 'a boy of about ten. slightly tall for his age, lean and upright.',
};
const CHR002 = {
  id: 'CHR002',
  name: 'The smallest girl',
  age: 'a girl of about five',
  appearsInPages: [3, 10, 12, 13, 14],
  description: 'a girl of about five. small and slight, noticeably shorter than the other children.',
};

describe('parseStatedAge', () => {
  it('reads the prose shape the bible actually writes', () => {
    expect(parseStatedAge('a boy of about ten')).toBe(10);
    expect(parseStatedAge('a girl of about five')).toBe(5);
  });

  it('reads numerals, bare and embedded', () => {
    expect(parseStatedAge('6')).toBe(6);
    expect(parseStatedAge(9)).toBe(9);
    expect(parseStatedAge('aged 11')).toBe(11);
  });

  it('takes the number the sentence leads with', () => {
    expect(parseStatedAge('nine or ten')).toBe(9);
    expect(parseStatedAge('about 8, nearly nine')).toBe(8);
  });

  it('returns null rather than a wrong number', () => {
    expect(parseStatedAge('')).toBeNull();
    expect(parseStatedAge(null)).toBeNull();
    expect(parseStatedAge('a young boy')).toBeNull();
    expect(parseStatedAge('400')).toBeNull();
  });
});

describe('commissionedChildBand', () => {
  it('spans only the children, never the adults', () => {
    const band = commissionedChildBand(BADEN_CAST);
    expect(band.min).toBe(6);
    expect(band.max).toBe(9);
    expect(band.names).toEqual(['Lily', 'Ethan']);
    // Tolerance: one year below the youngest, two above the eldest.
    expect([band.low, band.high]).toEqual([5, 11]);
  });

  it('an all-adult commission constrains nothing', () => {
    expect(commissionedChildBand([{ name: 'James', age: '42' }])).toBeNull();
    expect(commissionedChildBand([])).toBeNull();
    expect(commissionedChildBand(null)).toBeNull();
  });

  it('a single child gives a one-year band', () => {
    const band = commissionedChildBand([{ name: 'Ana', age: 4 }]);
    expect([band.min, band.max, band.low, band.high]).toEqual([4, 4, 3, 6]);
  });

  it('never yields a negative floor', () => {
    expect(commissionedChildBand([{ name: 'Baby', age: 0 }]).low).toBe(0);
  });
});

describe('buildChildAgeBandNote — the number injected into the bible prompt', () => {
  it('states the band and stays archetypal', () => {
    const note = buildChildAgeBandNote(commissionedChildBand(BADEN_CAST));
    expect(note).toContain('6-9');
    // Archetypes only — no character from any test story.
    expect(note).not.toMatch(/Lily|Ethan|scarf|Baden/);
    // No emphasis hammers.
    expect(note).not.toMatch(/CRITICAL|MUST|NEVER|LOCKED|ABSOLUTELY/);
  });

  it('is empty when there is no band, so a caller can inject blindly', () => {
    expect(buildChildAgeBandNote(null)).toBe('');
  });
});

describe('checkSecondaryAges — the deterministic post-check', () => {
  const band = commissionedChildBand(BADEN_CAST);

  it('flags a declared peer outside the tolerated band', () => {
    const r = checkSecondaryAges([{ ...CHR001, peer: true, age: 'a boy of about twelve' }], band);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].statedAge).toBe(12);
    expect(r.findings[0].detail).toContain('6-9');
    expect(r.findings[0].detail).toContain('5-11');
  });

  it('the story as it actually shipped: both entries sit inside the band', () => {
    // The measured outcome. "About ten" is within [5, 11], so the rule as
    // specified does NOT flag this book — the injected band (which the bible
    // never saw) is what would have moved the number, not the post-check.
    const r = checkSecondaryAges([{ ...CHR001, peer: true }, { ...CHR002, peer: true }], band);
    expect(r.findings).toEqual([]);
    expect(r.checked).toBe(2);
  });

  it('a non-peer carries its own age and is never flagged', () => {
    const r = checkSecondaryAges([{ ...CHR001, peer: false, age: 'a helper of about seventeen' }], band);
    expect(r.findings).toEqual([]);
    expect(r.unchecked).toEqual([]);
  });

  it('never infers peerhood from prose — an undeclared entry is reported unchecked', () => {
    // Classification is the PROMPT's job (docs/SETTLED.md). Code reads a field.
    const r = checkSecondaryAges([CHR001], band);
    expect(r.findings).toEqual([]);
    expect(r.unchecked.map((u: any) => u.id)).toEqual(['CHR001']);
  });

  it('a peer whose age cannot be read is reported, never guessed', () => {
    const r = checkSecondaryAges([{ id: 'CHR009', name: 'A child', peer: 'yes', age: 'a young child' }], band);
    expect(r.findings).toEqual([]);
    expect(r.unchecked[0].reason).toContain('no age');
  });

  it('no band means no findings at all', () => {
    expect(checkSecondaryAges([{ ...CHR001, peer: true }], null).findings).toEqual([]);
  });

  it('is total — junk in, no throw', () => {
    expect(() => checkSecondaryAges([null, undefined, {}] as any, band)).not.toThrow();
    expect(checkSecondaryAges(null, band).findings).toEqual([]);
  });
});

describe('clampAgeToBand — the fallback when a finding cannot be fed back', () => {
  const band = commissionedChildBand(BADEN_CAST);
  it('pulls to the nearest edge and leaves an in-band age alone', () => {
    expect(clampAgeToBand(14, band)).toBe(11);
    expect(clampAgeToBand(2, band)).toBe(5);
    expect(clampAgeToBand(10, band)).toBe(10);
  });
  it('is a no-op without a band', () => {
    expect(clampAgeToBand(14, null)).toBe(14);
  });
});

describe('secondaryAgeCues — what the image prompt is missing today', () => {
  it('turns bible entries into the {name, age} shape the block consumes', () => {
    expect(secondaryAgeCues([CHR001, CHR002])).toEqual([
      { name: 'The boy in the striped scarf', age: 10 },
      { name: 'The smallest girl', age: 5 },
    ]);
  });

  it('restricts to the entries the page actually carries', () => {
    // p5 carries the scarf boy only; the smallest girl is not on that page.
    expect(secondaryAgeCues([CHR001, CHR002], 5)).toEqual([
      { name: 'The boy in the striped scarf', age: 10 },
    ]);
  });

  it('drops an entry whose age cannot be read rather than inventing one', () => {
    expect(secondaryAgeCues([{ id: 'CHR009', name: 'A child', age: 'young' }])).toEqual([]);
  });
});
