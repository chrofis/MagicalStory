/**
 * MISMATCH precedence in the text refine (2026-10-09, job_1791497309909_6quecrr9t
 * audit T4 p4): the picture lacked Julian and the raven; refine fixed the raven
 * half, kept "Julian laughed and patted the little dragon" as "the story's own
 * event" and marked T4 fixed. The "detail the story turns on / ending's own act"
 * clause must never cover a MISMATCH gap, and the audit must file the same shape.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const cjs = createRequire(import.meta.url);
const fs = cjs('fs');

describe('refine vs audit: a figure not in the picture', () => {
  const refine = fs.readFileSync('prompts/text-refine.txt', 'utf8');
  const audit = fs.readFileSync('prompts/story-text-audit.txt', 'utf8');
  it('refine states the precedence and the all-gaps ledger rule, with no story names', () => {
    expect(refine).toMatch(/PRECEDENCE: a figure the picture does not show is never kept doing a visible act/);
    expect(refine).toMatch(/never covers a MISMATCH gap/);
    expect(refine).toMatch(/says fixed only when every gap of its finding has its own closed line/);
    expect(refine).toMatch(/A passage moved onto a page names only figures that page's picture shows/);
    expect(refine).not.toMatch(/Julian|raven|Kiaan/);
  });
  it('the audit files a figure out of frame doing a visible act as a MISMATCH, in the same words', () => {
    expect(audit).toMatch(/leaves the figure out of frame, is a MISMATCH too/);
    expect(audit).toMatch(/a page that was given a passage naming a figure its picture lacks/);
  });
});
