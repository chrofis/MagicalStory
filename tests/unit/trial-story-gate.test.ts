/**
 * The trial waiting page shows the story (title + pages) while the book is
 * still being drawn, but only the first TRIAL_FREE_PAGES pages carry text for a
 * visitor who left no contact. The gate is server-side: a locked page must have
 * NO `text` key (absent, not empty) so the text never reaches the client.
 */
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-trial-story-gate';
const {
  TRIAL_FREE_PAGES,
  buildTrialStoryPages,
  mergeTrialPageRecords,
  isTrialContactEmail,
  buildTrialTeaser,
  TRIAL_TEASER_MAX_CHARS,
} = require('../../server/routes/trial.js');

const six = [1, 2, 3, 4, 5, 6].map(n => ({ pageNumber: n, text: `Text ${n}`, imageData: `data:image/jpeg;base64,IMG${n}` }));

describe('buildTrialStoryPages', () => {
  it('free pages carry their text, later pages are locked without a text key', () => {
    const pages = buildTrialStoryPages(six, { unlocked: false, freePages: TRIAL_FREE_PAGES });
    expect(pages).toHaveLength(6);
    for (const p of pages.slice(0, 3)) {
      expect(p.locked).toBe(false);
      expect(p.text).toBe(`Text ${p.pageNumber}`);
    }
    for (const p of pages.slice(3)) {
      expect(p.locked).toBe(true);
      expect('text' in p).toBe(false);
    }
  });

  // Regression (owner 2026-10-08, 3-line teaser): job-status serves this output
  // verbatim, so a locked page may carry a teaser but the page text never.
  it('a long locked page sends a teaser only; its full text appears nowhere in the payload', () => {
    const long = 'Once upon a time there was a little fox who loved to explore the forest. '.repeat(12).trim();
    const pages = buildTrialStoryPages(
      [{ pageNumber: 1, text: 'free' }, { pageNumber: 4, text: long }],
      { unlocked: false, freePages: 3 });
    const locked = pages[1];
    expect(locked.locked).toBe(true);
    expect('text' in locked).toBe(false);
    expect(locked.teaser.length).toBeGreaterThan(0);
    expect(locked.teaser.length).toBeLessThanOrEqual(TRIAL_TEASER_MAX_CHARS);
    expect(long.startsWith(locked.teaser)).toBe(true);
    expect(JSON.stringify(pages)).not.toContain(long);
    expect(JSON.stringify(pages)).not.toContain(long.slice(0, TRIAL_TEASER_MAX_CHARS + 40));
  });

  it('unlocked pages carry the full text and no teaser', () => {
    const pages = buildTrialStoryPages([{ pageNumber: 5, text: 'full text of five' }], { unlocked: true, freePages: 3 });
    expect(pages[0]).toMatchObject({ locked: false, text: 'full text of five' });
    expect('teaser' in pages[0]).toBe(false);
  });

  it('keeps images on locked pages', () => {
    const pages = buildTrialStoryPages(six, { unlocked: false, freePages: 3 });
    expect(pages[5].imageData).toBe('data:image/jpeg;base64,IMG6');
  });

  it('unlocked returns every text and no locked page', () => {
    const pages = buildTrialStoryPages(six, { unlocked: true, freePages: 3 });
    expect(pages.every(p => p.locked === false)).toBe(true);
    expect(pages.map(p => p.text)).toEqual(six.map(p => p.text));
  });

  it('fewer pages than free pages: nothing is locked', () => {
    const pages = buildTrialStoryPages(six.slice(0, 2), { unlocked: false, freePages: 3 });
    expect(pages.map(p => p.locked)).toEqual([false, false]);
    expect(pages.every(p => typeof p.text === 'string')).toBe(true);
  });

  it('exactly the free page count is fully readable', () => {
    const pages = buildTrialStoryPages(six.slice(0, 3), { unlocked: false, freePages: 3 });
    expect(pages.every(p => !p.locked && p.text)).toBe(true);
  });

  it('a page without an image has no imageData key', () => {
    const pages = buildTrialStoryPages([{ pageNumber: 1, text: 'a' }, { pageNumber: 2, text: 'b', imageData: '' }], { unlocked: false, freePages: 3 });
    expect('imageData' in pages[0]).toBe(false);
    expect('imageData' in pages[1]).toBe(false);
  });

  it('sorts by page number and handles empty input', () => {
    const pages = buildTrialStoryPages([six[2], six[0], six[1]], { unlocked: true, freePages: 3 });
    expect(pages.map(p => p.pageNumber)).toEqual([1, 2, 3]);
    expect(buildTrialStoryPages([], { unlocked: false, freePages: 3 })).toEqual([]);
    expect(buildTrialStoryPages(undefined, { unlocked: false, freePages: 3 })).toEqual([]);
  });

  it('locked page JSON never contains the withheld text', () => {
    const json = JSON.stringify(buildTrialStoryPages(six, { unlocked: false, freePages: 3 }));
    expect(json).not.toContain('Text 4');
    expect(json).not.toContain('Text 6');
    expect(json).toContain('Text 3');
  });
});

describe('mergeTrialPageRecords', () => {
  it('joins texts and images by page number, images arriving later than text', () => {
    const recs = mergeTrialPageRecords({ 1: 'a', 2: 'b' }, [{ pageNumber: 2, imageData: 'IMG2' }]);
    const byPage = Object.fromEntries(recs.map((r: any) => [r.pageNumber, r]));
    expect(byPage[1]).toEqual({ pageNumber: 1, text: 'a' });
    expect(byPage[2]).toEqual({ pageNumber: 2, text: 'b', imageData: 'IMG2' });
  });

  it('tolerates missing inputs and ignores image-less rows', () => {
    expect(mergeTrialPageRecords(undefined, undefined)).toEqual([]);
    expect(mergeTrialPageRecords({}, [{ pageNumber: 1 }])).toEqual([]);
  });
});

describe('isTrialContactEmail', () => {
  it('placeholder anonymous address is not contact, a real or unverified email is', () => {
    expect(isTrialContactEmail('anon_abc123@anonymous')).toBe(false);
    expect(isTrialContactEmail('parent@example.com')).toBe(true);
    expect(isTrialContactEmail(null)).toBe(false);
    expect(isTrialContactEmail('')).toBe(false);
  });
});


describe('buildTrialTeaser', () => {
  const long = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega. '.repeat(5).trim();

  it('cuts a long text at a word boundary within the cap', () => {
    const t = buildTrialTeaser(long);
    expect(t.length).toBeLessThanOrEqual(TRIAL_TEASER_MAX_CHARS);
    expect(t.length).toBeGreaterThan(TRIAL_TEASER_MAX_CHARS - 30);
    expect(long.startsWith(t)).toBe(true);
    // the next char in the source is whitespace: no word was split
    expect(/\s/.test(long[t.length])).toBe(true);
    expect(t).toBe(t.trimEnd());
  });

  it('never returns the whole text, even for a short page (at most two thirds)', () => {
    const short = 'The fox ran home through the quiet snowy wood before night.';
    const t = buildTrialTeaser(short);
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThanOrEqual(Math.floor(short.length * 2 / 3));
    expect(t.length).toBeLessThan(short.length);
    expect(short.startsWith(t)).toBe(true);
  });

  it('a single long word is cut at the cap; empty / non-string give empty', () => {
    expect(buildTrialTeaser('x'.repeat(1000)).length).toBe(TRIAL_TEASER_MAX_CHARS);
    expect(buildTrialTeaser('')).toBe('');
    expect(buildTrialTeaser('   ')).toBe('');
    expect(buildTrialTeaser(undefined as any)).toBe('');
    expect(buildTrialTeaser('a')).toBe('');
  });
});
