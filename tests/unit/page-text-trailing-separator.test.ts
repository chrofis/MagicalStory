import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { stripTrailingSeparator } = nodeRequire('../../server/lib/sceneMetadata.js');

// Backlog #66: the text writer's "---" page rule leaked into the stored page
// text of job_1789348171785_9oxos7dwv (pages 1, 2 and 8) and shipped under the
// illustration in the book and the PDF. parseRefinedText cuts a page at the
// NEXT "## Page N" heading, so a rule the writer put INSIDE the page body
// survives. A delimiter is a run of >= 2 dash characters standing alone at the
// very end of the text; a single dash is never a delimiter, because German and
// French prose legitimately ends a line on an em-dash.
describe('stripTrailingSeparator — page text delimiter', () => {
  it('strips the real shape from story C (blank line + "---")', () => {
    const p1 = 'Julian trottete dicht hinter ihm her und beobachtete alles genau.\n\n---';
    expect(stripTrailingSeparator(p1))
      .toBe('Julian trottete dicht hinter ihm her und beobachtete alles genau.');
    const p2 = '«Es ist schwer», sagte Julian und hielt es fest.\n\n---';
    expect(stripTrailingSeparator(p2)).toBe('«Es ist schwer», sagte Julian und hielt es fest.');
    const p8 = 'Levin ging weiter, ohne etwas zu sagen.\n\n---';
    expect(stripTrailingSeparator(p8)).toBe('Levin ging weiter, ohne etwas zu sagen.');
  });

  it('leaves no trailing whitespace behind', () => {
    expect(stripTrailingSeparator('Ende der Seite.  ---  ')).toBe('Ende der Seite.');
    expect(stripTrailingSeparator('Ende der Seite.\n\n---\n\n')).toBe('Ende der Seite.');
  });

  it('still strips a separator alone on its own line (existing behaviour)', () => {
    expect(stripTrailingSeparator('Der Hund bellte.\n---')).toBe('Der Hund bellte.');
    expect(stripTrailingSeparator('Der Hund bellte.\n\n———\n')).toBe('Der Hund bellte.');
  });

  it('strips the two-dash and en/em-dash-run variants', () => {
    expect(stripTrailingSeparator('Sie lachten. --')).toBe('Sie lachten.');
    expect(stripTrailingSeparator('Sie lachten.\n––')).toBe('Sie lachten.');
    expect(stripTrailingSeparator('Sie lachten.\n—-—')).toBe('Sie lachten.');
  });

  // NEGATIVE CONTROL — this is what separates the fix from a blunt trim.
  it('leaves a page that legitimately ENDS on an em-dash exactly as written', () => {
    const de = 'Levin holte Luft und sagte: «Und dann —»';
    expect(stripTrailingSeparator(de)).toBe(de);
    const trailing = 'Er wollte etwas sagen, aber —';
    expect(stripTrailingSeparator(trailing)).toBe(trailing);
    const fr = 'Il ouvrit la bouche, puis —';
    expect(stripTrailingSeparator(fr)).toBe(fr);
  });

  // NEGATIVE CONTROL — a dash doing punctuation work mid-clause.
  it('leaves an em-dash mid-sentence exactly as written', () => {
    const mid = 'Julian — der Kleinere — hielt das Ei fest und ging weiter.';
    expect(stripTrailingSeparator(mid)).toBe(mid);
    const dialogue = '«Was—» rief er, doch der Drache war schon fort.';
    expect(stripTrailingSeparator(dialogue)).toBe(dialogue);
  });

  // A dash run glued to a word is typography, not a delimiter: a delimiter
  // stands alone.
  it('leaves a dash run attached to a word alone', () => {
    expect(stripTrailingSeparator('Das Wort--')).toBe('Das Wort--');
  });

  it('returns text with no separator byte-identical', () => {
    const plain = 'Rote und gelbe Blätter bedeckten den Boden des Lindenhofs.\n\nLevin suchte.';
    expect(stripTrailingSeparator(plain)).toBe(plain);
    expect(stripTrailingSeparator('')).toBe('');
    expect(stripTrailingSeparator(null)).toBe('');
  });
});
