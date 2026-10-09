import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import BookViewer from './BookViewer';
import { buildTrialBook, type TrialPreviewPage } from '@/utils/trialBook';

// The sign-in gate is a page of the book. Its content changes with every
// keystroke / auth state, but must NOT make the book rebuild its pages (that
// re-seats the page DOM and costs input focus). So the page holds a stable
// <GateSlot/> and the live content reaches it through this context.
const TrialGateContext = createContext<{ node: React.ReactNode; onSeen?: () => void }>({ node: null });
export const TrialGateProvider = TrialGateContext.Provider;

// The sign-in block sits under the teaser of EVERY locked page. Its content changes
// with every keystroke / auth state, but must NOT make the book rebuild its pages
// (that re-seats the page DOM and costs input focus). So each page holds a stable
// <GateSlot/> and the live content reaches it through this context. `onSeen`
// (funnel gate_seen) fires when a slot scrolls/flips into view.
const GateSlot = () => {
  const { node, onSeen } = useContext(TrialGateContext);
  const elRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = elRef.current;
    if (!el || !onSeen || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) onSeen();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [onSeen]);
  return <div ref={elRef}>{node}</div>;
};
const gateNode = <GateSlot />;

// Same threshold as BookViewer's own mobile switch (single page vs spread).
function useIsMobile() {
  const [mobile, setMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 1024);
  useEffect(() => {
    const onResize = () => setMobile(window.innerWidth < 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

interface TrialBookProps {
  storyTitle: string;
  language: string;
  titlePageImage: string | null;
  pages: TrialPreviewPage[];
  pendingImageLabel: string;
  /** Rendered as the title page while it is still being drawn. */
  titlePendingNode: React.ReactNode;
}

function samePages(a: TrialPreviewPage[], b: TrialPreviewPage[]) {
  return a.length === b.length && a.every((p, i) =>
    p.pageNumber === b[i].pageNumber && p.locked === b[i].locked && p.text === b[i].text && p.teaser === b[i].teaser && p.imageData === b[i].imageData);
}

/**
 * The /try result: the existing BookViewer (page flip) fed with the job-status
 * preview. Memoized on content, so the 3 s poll (new array identity, same data)
 * does not re-render the viewer; when an image lands only that page's props change.
 */
const TrialBook = React.memo(function TrialBook({ storyTitle, language, titlePageImage, pages, pendingImageLabel, titlePendingNode }: TrialBookProps) {
  const isMobile = useIsMobile();
  // Desktop spread: picture on the left page, its text on the right page.
  const { storyPages, entries } = useMemo(
    () => buildTrialBook({ titlePageImage, pages, textOnFacingPage: !isMobile }),
    [titlePageImage, pages, isMobile]);
  const story = useMemo(() => ({
    id: 'trial',
    title: storyTitle,
    language,
    pageCount: storyPages.length,
    // Locked pages: teaser + the sign-in block under it.
    pages: storyPages.map(p => ({ ...p, textFooter: p.locked ? gateNode : undefined })),
    hasImages: true,
    coverImageSrc: titlePageImage ? { frontCover: titlePageImage } : undefined,
  }), [storyTitle, language, storyPages, titlePageImage]);
  // react-pageflip moves its page elements out of React's tree, so a change of the page LIST (the pending
  // title page becoming the cover, more pages arriving) makes React remove nodes that are no longer where it
  // put them: WebKit throws NotFoundError ("The object can not be found here") and React unmounts the whole
  // page - the white page when the title arrived (owner iPhone, 2026-10-09). A changed structure therefore
  // remounts the viewer, on the page the visitor was reading. Image/text updates keep the same structure.
  const structureKey = `${isMobile ? 'm' : 'd'}:${titlePageImage ? 'cover' : 'pending'}:${pages.length}`;
  const logicalPageRef = useRef(0);
  const onPageChange = useCallback((i: number) => { logicalPageRef.current = i; }, []);
  const pageList = useMemo(() => entries.map(e => {
    if (e.type === 'titlePending') return { type: 'custom' as const, key: 'title-pending', node: titlePendingNode };
    return e;
  }), [entries, titlePendingNode]);

  return (
    <div className="h-[72vh] min-h-[440px] max-h-[780px] w-full lg:w-[min(1000px,calc(100vw-4rem))] lg:relative lg:left-1/2 lg:-translate-x-1/2">
      <BookViewer
        key={structureKey}
        initialLogicalPage={logicalPageRef.current}
        onPageChange={onPageChange}
        textOnSidePage
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
  a.pendingImageLabel === b.pendingImageLabel && samePages(a.pages, b.pages));

export default TrialBook;
