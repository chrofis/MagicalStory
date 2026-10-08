import { describe, it, expect } from 'vitest';
import { buildTrialBook, isTrialBookReady, TRIAL_TEASER_LINES } from '../../client/src/utils/trialBook';

const pg = (n: number, o: Partial<{ imageData: string; text: string; locked: boolean }> = {}) =>
  ({ pageNumber: n, locked: false, ...o });

describe('isTrialBookReady (viewer starts at the first image, not at the text)', () => {
  it('text alone does not start the book', () => {
    expect(isTrialBookReady('T', [pg(1, { text: 'a' })], null)).toBe(false);
  });
  it('title page image starts it', () => {
    expect(isTrialBookReady('T', [pg(1, { text: 'a' })], 'data:img')).toBe(true);
  });
  it('a page image starts it when the title page never came', () => {
    expect(isTrialBookReady('T', [pg(1, { imageData: 'x' })], null)).toBe(true);
  });
  it('needs a title and pages', () => {
    expect(isTrialBookReady(null, [pg(1, { imageData: 'x' })], 'i')).toBe(false);
    expect(isTrialBookReady('T', [], 'i')).toBe(false);
  });
});

describe('buildTrialBook', () => {
  const pages = [
    pg(1, { text: 'one', imageData: 'i1' }),
    pg(2, { text: 'two' }),
    { pageNumber: 3, locked: true, imageData: 'i3', teaser: 'three opens' },
  ];

  it('pending page = no image, flagged pending; text kept', () => {
    const { storyPages } = buildTrialBook({ titlePageImage: 'T', pages, textOnFacingPage: true });
    expect(storyPages[1]).toMatchObject({ pageNumber: 2, text: 'two', imageSrc: undefined, imagePending: true });
    expect(storyPages[0]).toMatchObject({ imageSrc: 'i1', imagePending: false });
  });

  it('locked page keeps its image, shows only the teaser clamped to 3 lines', () => {
    const { storyPages } = buildTrialBook({ titlePageImage: 'T', pages, textOnFacingPage: true });
    expect(storyPages[2]).toMatchObject({ imageSrc: 'i3', text: 'three opens', locked: true, textClamp: TRIAL_TEASER_LINES, imagePending: false });
    expect(TRIAL_TEASER_LINES).toBe(3);
    expect(storyPages[0]).toMatchObject({ locked: false, textClamp: undefined });
  });

  it('a locked page never shows a full text even if one slipped in', () => {
    const { storyPages } = buildTrialBook({ titlePageImage: 'T', pages: [{ pageNumber: 4, locked: true, text: 'FULL' }], textOnFacingPage: false });
    expect(storyPages[0].text).toBe('');
  });

  it('there is no gate page: entries are cover + story pages only', () => {
    const { entries } = buildTrialBook({ titlePageImage: 'T', pages, textOnFacingPage: false });
    expect(entries.map(e => e.type)).toEqual(['frontCover', 'story', 'story', 'story']);
  });

  it('desktop spread: each picture is followed by its text page (picture left, text right)', () => {
    const { entries } = buildTrialBook({ titlePageImage: 'T', pages: pages.slice(0, 2), textOnFacingPage: true });
    expect(entries).toEqual([
      { type: 'frontCover' },
      { type: 'story', storyPageIdx: 0 }, { type: 'storyText', storyPageIdx: 0 },
      { type: 'story', storyPageIdx: 1 }, { type: 'storyText', storyPageIdx: 1 },
    ]);
  });

  it('title page missing -> pending first page, replaced by the cover once it lands', () => {
    expect(buildTrialBook({ titlePageImage: null, pages, textOnFacingPage: false }).entries[0]).toEqual({ type: 'titlePending' });
    expect(buildTrialBook({ titlePageImage: 'T', pages, textOnFacingPage: false }).entries[0]).toEqual({ type: 'frontCover' });
  });

  it('page indices and entry count stay stable when an image lands (no re-mount churn)', () => {
    const a = buildTrialBook({ titlePageImage: 'T', pages, textOnFacingPage: true });
    const b = buildTrialBook({ titlePageImage: 'T', pages: [pages[0], { ...pages[1], imageData: 'i2' }, pages[2]], textOnFacingPage: true });
    expect(b.entries).toEqual(a.entries);
    expect(b.storyPages[1].imagePending).toBe(false);
  });
});
