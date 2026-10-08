import { describe, it, expect } from 'vitest';
import { buildTrialBook, isTrialBookReady } from '../../client/src/utils/trialBook';

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
  const pages = [pg(1, { text: 'one', imageData: 'i1' }), pg(2, { text: 'two' }), pg(3, { imageData: 'i3', locked: true })];

  it('pending page = no image, flagged pending; text kept', () => {
    const { storyPages } = buildTrialBook({ titlePageImage: 'T', pages, gateIdx: 2 });
    expect(storyPages[1]).toMatchObject({ pageNumber: 2, text: 'two', imageSrc: undefined, imagePending: true });
    expect(storyPages[0]).toMatchObject({ imageSrc: 'i1', imagePending: false });
  });

  it('locked page keeps its image and has no text', () => {
    const { storyPages } = buildTrialBook({ titlePageImage: 'T', pages, gateIdx: 2 });
    expect(storyPages[2]).toMatchObject({ imageSrc: 'i3', text: '', imagePending: false });
  });

  it('gate is its own entry before the first locked page', () => {
    const { entries, gateEntryIdx } = buildTrialBook({ titlePageImage: 'T', pages, gateIdx: 2 });
    expect(entries.map(e => e.type)).toEqual(['frontCover', 'story', 'story', 'gate', 'story']);
    expect(gateEntryIdx).toBe(3);
  });

  it('gate goes after the last page when nothing is locked', () => {
    const { entries, gateEntryIdx } = buildTrialBook({ titlePageImage: 'T', pages: pages.slice(0, 2), gateIdx: 2 });
    expect(entries.map(e => e.type)).toEqual(['frontCover', 'story', 'story', 'gate']);
    expect(gateEntryIdx).toBe(3);
  });

  it('title page missing -> pending first page, replaced by the cover once it lands', () => {
    expect(buildTrialBook({ titlePageImage: null, pages, gateIdx: 9 }).entries[0]).toEqual({ type: 'titlePending' });
    expect(buildTrialBook({ titlePageImage: 'T', pages, gateIdx: 9 }).entries[0]).toEqual({ type: 'frontCover' });
  });

  it('page indices and entry count stay stable when an image lands (no re-mount churn)', () => {
    const a = buildTrialBook({ titlePageImage: 'T', pages, gateIdx: 2 });
    const b = buildTrialBook({ titlePageImage: 'T', pages: [pages[0], { ...pages[1], imageData: 'i2' }, pages[2]], gateIdx: 2 });
    expect(b.entries).toEqual(a.entries);
    expect(b.storyPages[1].imagePending).toBe(false);
  });
});
