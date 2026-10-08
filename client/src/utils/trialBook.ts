// Pure mapping of the /try job-status preview (title page + pages + gate) onto
// the page list BookViewer renders. Kept free of React so it can be unit-tested.
// Decision: docs/decisions.md "trial shows the book in BookViewer once the first image exists".

export interface TrialPreviewPage {
  pageNumber: number;
  imageData?: string;
  text?: string;
  locked: boolean;
}

/** Page shape BookViewer reads (SharedStoryPage) — `imageSrc` is a direct image URL / data URI. */
export interface TrialBookStoryPage {
  pageNumber: number;
  text: string;
  imageSrc?: string;
  imagePending: boolean;
}

export type TrialBookEntry =
  | { type: 'frontCover' }
  | { type: 'titlePending' }
  | { type: 'story'; storyPageIdx: number }
  | { type: 'gate' };

/**
 * The book replaces the intro slideshow as soon as there is something to show
 * that is a picture: the title page (the first image the visitor can see) or,
 * if it never came, any page image. Text alone does not start it.
 */
export function isTrialBookReady(
  storyTitle: string | null,
  pages: TrialPreviewPage[],
  titlePageImage: string | null,
): boolean {
  if (!storyTitle || pages.length === 0) return false;
  return !!titlePageImage || pages.some(p => !!p.imageData);
}

/**
 * title page (or its pending placeholder) -> pages, with the sign-in gate as
 * its own entry before page `gateIdx` (`gateIdx >= pages.length` = after the
 * last page). A locked page has no text (the server withholds it) and shows
 * its image only; a page without an image is pending.
 */
export function buildTrialBook(args: {
  titlePageImage: string | null;
  pages: TrialPreviewPage[];
  gateIdx: number;
}): { storyPages: TrialBookStoryPage[]; entries: TrialBookEntry[]; gateEntryIdx: number } {
  const { titlePageImage, pages, gateIdx } = args;
  const storyPages: TrialBookStoryPage[] = pages.map(p => ({
    pageNumber: p.pageNumber,
    text: !p.locked && p.text ? p.text : '',
    imageSrc: p.imageData || undefined,
    imagePending: !p.imageData,
  }));
  const entries: TrialBookEntry[] = [titlePageImage ? { type: 'frontCover' } : { type: 'titlePending' }];
  for (let i = 0; i < pages.length; i++) {
    if (i === gateIdx) entries.push({ type: 'gate' });
    entries.push({ type: 'story', storyPageIdx: i });
  }
  if (gateIdx >= pages.length) entries.push({ type: 'gate' });
  return { storyPages, entries, gateEntryIdx: entries.findIndex(e => e.type === 'gate') };
}
