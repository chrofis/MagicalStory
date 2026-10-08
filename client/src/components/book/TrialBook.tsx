import React, { createContext, useContext, useMemo } from 'react';
import BookViewer from './BookViewer';
import { buildTrialBook, type TrialPreviewPage } from '@/utils/trialBook';

// The sign-in gate is a page of the book. Its content changes with every
// keystroke / auth state, but must NOT make the book rebuild its pages (that
// re-seats the page DOM and costs input focus). So the page holds a stable
// <GateSlot/> and the live content reaches it through this context.
const TrialGateContext = createContext<React.ReactNode>(null);
export const TrialGateProvider = TrialGateContext.Provider;
const GateSlot = () => <>{useContext(TrialGateContext)}</>;
const gateNode = <GateSlot />;

interface TrialBookProps {
  storyTitle: string;
  language: string;
  titlePageImage: string | null;
  pages: TrialPreviewPage[];
  /** Index of the story page the sign-in gate sits in front of (>= pages.length: after the last page). */
  gateIdx: number;
  pendingImageLabel: string;
  /** Rendered as the title page while it is still being drawn. */
  titlePendingNode: React.ReactNode;
}

function samePages(a: TrialPreviewPage[], b: TrialPreviewPage[]) {
  return a.length === b.length && a.every((p, i) =>
    p.pageNumber === b[i].pageNumber && p.locked === b[i].locked && p.text === b[i].text && p.imageData === b[i].imageData);
}

/**
 * The /try result: the existing BookViewer (page flip) fed with the job-status
 * preview. Memoized on content, so the 3 s poll (new array identity, same data)
 * does not re-render the viewer; when an image lands only that page's props change.
 */
const TrialBook = React.memo(function TrialBook({ storyTitle, language, titlePageImage, pages, gateIdx, pendingImageLabel, titlePendingNode }: TrialBookProps) {
  const { storyPages, entries } = useMemo(() => buildTrialBook({ titlePageImage, pages, gateIdx }), [titlePageImage, pages, gateIdx]);
  const story = useMemo(() => ({
    id: 'trial',
    title: storyTitle,
    language,
    // textInImage=false = image with the text below it on the same page (the old
    // list layout); a locked page has no text and shows the picture alone.
    layout: { textInImage: false },
    pageCount: storyPages.length,
    pages: storyPages,
    hasImages: true,
    coverImageSrc: titlePageImage ? { frontCover: titlePageImage } : undefined,
  }), [storyTitle, language, storyPages, titlePageImage]);
  const pageList = useMemo(() => entries.map(e => {
    if (e.type === 'gate') return { type: 'custom' as const, key: 'gate', node: gateNode };
    if (e.type === 'titlePending') return { type: 'custom' as const, key: 'title-pending', node: titlePendingNode };
    return e;
  }), [entries, titlePendingNode]);

  return (
    <div className="h-[72vh] min-h-[440px] max-h-[780px] w-full lg:w-[min(1000px,calc(100vw-4rem))] lg:relative lg:left-1/2 lg:-translate-x-1/2">
      <BookViewer
        pageList={pageList}
        story={story}
        shareToken=""
        showTextOverlay={false}
        pendingImageLabel={pendingImageLabel}
      />
    </div>
  );
}, (a, b) =>
  a.storyTitle === b.storyTitle && a.language === b.language && a.titlePageImage === b.titlePageImage &&
  a.gateIdx === b.gateIdx && a.pendingImageLabel === b.pendingImageLabel && samePages(a.pages, b.pages));

export default TrialBook;
