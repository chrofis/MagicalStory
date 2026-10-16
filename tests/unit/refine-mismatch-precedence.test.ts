/**
 * MISMATCH in the text refine and the text audit. 2026-10-09 the refine was told
 * a figure the picture lacks is never kept doing a visible act (PRECEDENCE).
 * Owner 2026-10-16 reversed it: "The text must not contradict the picture. But
 * it can go further. Text should be picture and more." (docs/decisions.md
 * 2026-10-16 "Text may go beyond the picture"). A MISMATCH is a real
 * contradiction; text that names what the picture does not show is no fault.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const cjs = createRequire(import.meta.url);
const fs = cjs('fs');

describe('refine vs audit: a figure or act the picture does not show', () => {
  const refine = fs.readFileSync('prompts/text-refine.txt', 'utf8');
  const audit = fs.readFileSync('prompts/story-text-audit.txt', 'utf8');
  it('refine: only a contradiction is closed, nothing is cut for fidelity, a multi-gap finding keeps one ledger line per gap', () => {
    expect(refine).toContain('{TEXT_VS_PICTURE}');
    expect(refine).toMatch(/STANDS: the text goes beyond the picture, which is allowed/);
    expect(refine).toMatch(/never cut an act to close a MISMATCH/);
    expect(refine).toMatch(/each gets its own ledger line/);
    expect(refine).not.toMatch(/PRECEDENCE: a figure the picture does not show/);
    expect(refine).not.toMatch(/the TEXT moves/);
    expect(refine).not.toMatch(/Julian|raven|Kiaan/);
  });
  it('the audit files a MISMATCH for a contradiction only, in the same words as the refine', () => {
    expect(audit).toContain('{TEXT_VS_PICTURE}');
    expect(audit).toMatch(/A text that names a figure, object or action its picture does not show is not a MISMATCH/);
    expect(audit).not.toMatch(/leaves the figure out of frame, is a MISMATCH too/);
  });
});
