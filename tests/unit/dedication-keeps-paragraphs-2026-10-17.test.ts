/**
 * The dedication page keeps the writer's own line and paragraph breaks (owner, 2026-10-17):
 * a dedication typed as a greeting, a blank line, then two paragraphs printed as one block
 * because the layout collapsed every whitespace run (prod job_1792078014622_uh8tj6ht1).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);
const { dedicationLines } = nodeRequire('../../server/lib/coverTypography.js');

const TYPED = 'Dear Sam\n\nYou light up every room you walk into, and your laugh makes everyone around you smile.\n\nBe brave. We love you, Grandma and Grandpa';

describe('dedicationLines', () => {
  it('keeps the greeting on its own line and a paragraph break after it', () => {
    const lines = dedicationLines(TYPED);
    expect(lines[0]).toBe('Dear Sam');
    expect(lines[1]).toBe('');
  });
  it('marks every blank-line paragraph break, and only those', () => {
    const lines = dedicationLines(TYPED);
    expect(lines.filter(l => l === '').length).toBe(2);
    expect(lines[lines.length - 1]).toContain('Grandpa');
  });
  it('wraps a long paragraph into several lines without merging it into the next', () => {
    const lines = dedicationLines(TYPED);
    const second = lines.slice(2, lines.indexOf('', 2));
    expect(second.length).toBeGreaterThan(1);
    expect(second.join(' ')).toBe('You light up every room you walk into, and your laugh makes everyone around you smile.');
  });
  it('a one-line dedication stays one line; runs of blank lines and CRLF give one break', () => {
    expect(dedicationLines('For you, my little sunshine.')).toEqual(['For you, my little sunshine.']);
    expect(dedicationLines('Hi\r\n\r\n\r\nBye')).toEqual(['Hi', '', 'Bye']);
    expect(dedicationLines('\n\nHi')).toEqual(['Hi']);
  });
});
