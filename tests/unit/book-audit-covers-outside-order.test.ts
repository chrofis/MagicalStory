import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { coverLabelForPage, COVER_PAGE_NUMBERS, coverLabel } = require('../../server/lib/coverKeys');

// Owner ruling 2026-09-20: "story chronology does not bind the cover. The cover
// can show the end of the story, that is fine."
//
// The book audit fed every surface to the judge as a bare "PAGE <n>" in reading
// order, so a cover was read as a story page and question 6 (FUTURE) reported it
// for showing a moment a later page's text establishes.
//
// Measured over the 14 staging stories carrying a stored audit: 9 faults sit on
// a cover page and 8 of them are that complaint — e.g. "the picture shows the
// dragon already hatched, a major event established much later in the story".
// The 9th is a genuine continuity fault (a shell drawn green where the text says
// red-brown) and must survive, so the exemption is scoped to question 6 alone.
//
// These pin the labelling and the exemption, never the judge's wording.

const BOOK_AUDIT = path.join(__dirname, '..', '..', 'prompts', 'book-audit.txt');
const read = () => fs.readFileSync(BOOK_AUDIT, 'utf8');

describe('a cover is named, not just numbered', () => {
  it('maps each cover page number to its own label', () => {
    expect(coverLabelForPage(COVER_PAGE_NUMBERS.frontCover)).toBe(coverLabel('frontCover'));
    expect(coverLabelForPage(COVER_PAGE_NUMBERS.initialPage)).toBe(coverLabel('initialPage'));
    expect(coverLabelForPage(COVER_PAGE_NUMBERS.backCover)).toBe(coverLabel('backCover'));
  });

  it('gives the three covers three distinct labels', () => {
    const labels = [-1, -2, -3].map(coverLabelForPage);
    expect(new Set(labels).size).toBe(3);
    expect(labels.every(Boolean)).toBe(true);
  });

  it('returns null for a story page, so story pages keep a bare number', () => {
    for (const n of [1, 2, 7, 18, 0]) expect(coverLabelForPage(n)).toBeNull();
  });

  it('returns null rather than guessing for an unknown negative page', () => {
    expect(coverLabelForPage(-4)).toBeNull();
    expect(coverLabelForPage(-99)).toBeNull();
  });

  it('does not throw on junk', () => {
    for (const junk of [null, undefined, NaN, 'x', {}]) {
      expect(coverLabelForPage(junk as never)).toBeNull();
    }
  });
});

describe('question 6 does not bind a cover', () => {
  it('the FUTURE question exempts covers', () => {
    const q6 = read().split('\n').find((l) => l.startsWith('6. FUTURE:')) || '';
    expect(q6).toMatch(/cover/i);
    expect(q6).toMatch(/never report one here/i);
  });

  it('the exemption sits in question 6 and nowhere else', () => {
    // Scoped deliberately: a cover drawn in the wrong colours, or contradicting
    // its own words, is still a fault under the other five questions.
    const lines = read().split('\n');
    const withCover = lines.filter((l) => /^\d\. /.test(l) && /never report one here/i.test(l));
    expect(withCover).toHaveLength(1);
    expect(withCover[0]).toMatch(/^6\. FUTURE:/);
  });

  it('leaves the other questions able to fault a cover', () => {
    const body = read();
    for (const q of ['1. TOGETHER:', '2. CONTRADICTION:', '3. ONPAGE:', '4. EMOTION:', '5. CHANGE:']) {
      const line = body.split('\n').find((l) => l.startsWith(q)) || '';
      expect(line).not.toMatch(/never report one here/i);
    }
  });

  it('keeps the p<N> fault format the parser keys on', () => {
    // The heading gains a name; the fault line must still carry the number.
    expect(read()).toContain('FAULT[IMG][<WEIGHT>]: p<N>');
    expect(read()).toContain('FAULT[TEXT][<WEIGHT>]: p<N>');
  });
});
