// Pure mapping of the /try job-status preview (title page + pages + gate) onto
// the page list BookViewer renders. Kept free of React so it can be unit-tested.
// Decision: docs/decisions.md "trial shows the book in BookViewer once the first image exists".

export interface TrialPreviewPage {
  pageNumber: number;
  imageData?: string;
  text?: string;
  /** Locked page only: the opening of the text (server-cut). The full text never arrives. */
  teaser?: string;
  locked: boolean;
}

/** Lines of a locked page's teaser that stay visible (owner decision 2026-10-08). */
export const TRIAL_TEASER_LINES = 3;

/** Page shape BookViewer reads (SharedStoryPage) — `imageSrc` is a direct image URL / data URI. */
export interface TrialBookStoryPage {
  pageNumber: number;
  text: string;
  imageSrc?: string;
  imagePending: boolean;
  /** Locked page: the sign-in block goes under the clamped teaser (TrialBook supplies the node). */
  locked: boolean;
  textClamp?: number;
}

export type TrialBookEntry =
  | { type: 'frontCover' }
  | { type: 'titlePending' }
  | { type: 'story'; storyPageIdx: number }
  | { type: 'storyText'; storyPageIdx: number };

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
 * title page (or its pending placeholder) -> pages. `textOnFacingPage` (desktop
 * spread) puts each page's text on the page AFTER its picture, so the open book
 * reads picture left, text right; on mobile the text sits under the picture.
 * A locked page carries only the server's teaser, clamped to
 * TRIAL_TEASER_LINES; the sign-in block is attached to it by TrialBook. A page
 * without an image is pending.
 */
export function buildTrialBook(args: {
  titlePageImage: string | null;
  pages: TrialPreviewPage[];
  textOnFacingPage: boolean;
}): { storyPages: TrialBookStoryPage[]; entries: TrialBookEntry[] } {
  const { titlePageImage, pages, textOnFacingPage } = args;
  const storyPages: TrialBookStoryPage[] = pages.map(p => ({
    pageNumber: p.pageNumber,
    text: (p.locked ? p.teaser : p.text) || '',
    imageSrc: p.imageData || undefined,
    imagePending: !p.imageData,
    locked: p.locked,
    textClamp: p.locked ? TRIAL_TEASER_LINES : undefined,
  }));
  const entries: TrialBookEntry[] = [titlePageImage ? { type: 'frontCover' } : { type: 'titlePending' }];
  for (let i = 0; i < pages.length; i++) {
    entries.push({ type: 'story', storyPageIdx: i });
    if (textOnFacingPage) entries.push({ type: 'storyText', storyPageIdx: i });
  }
  return { storyPages, entries };
}
