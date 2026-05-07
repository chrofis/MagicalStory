import React, { useRef, useState, useEffect, useCallback, useImperativeHandle } from 'react';
import HTMLFlipBook from 'react-pageflip';
import BookCoverPage from './BookCoverPage';
import BookStoryPage from './BookStoryPage';
import BookTextPage from './BookTextPage';
import BookEndPage from './BookEndPage';
import storyService from '@/services/storyService';

interface SharedStoryPage {
  pageNumber: number;
  text: string;
  textPosition?: string | null;
}

interface SharedStoryData {
  id: string;
  title: string;
  language: string;
  languageLevel?: string;
  layout?: { imageAspect?: string; textInImage?: boolean; mode?: string } | null;
  pageCount: number;
  pages: SharedStoryPage[];
  dedication?: string;
  hasImages: boolean;
  covers?: {
    frontCover?: boolean;
    initialPage?: boolean;
    backCover?: boolean;
  };
  isOwner?: boolean;
  isShared?: boolean;
  needsPassword?: boolean;
}

type PageEntry =
  | { type: 'frontCover' }
  | { type: 'initialPage' }
  | { type: 'storyText'; storyPageIdx: number }
  | { type: 'story'; storyPageIdx: number }
  | { type: 'backCover' }
  | { type: 'endPage' };

export interface BookViewerHandle {
  flipNext: () => void;
  flipPrev: () => void;
  flipTo: (page: number) => void;
  getCurrentPage: () => number;
}

interface BookViewerProps {
  pageList: PageEntry[];
  story: SharedStoryData;
  shareToken: string;
  showTextOverlay: boolean;
  /** True when text is on a separate facing page (sidepage mode) — image pages should not show any text. */
  textOnSidePage?: boolean;
  /** When true, on mobile the text is always rendered below the image (scrollable), regardless of reading mode. */
  forceTextBelowOnMobile?: boolean;
  /** Optional logical page to open on — used to preserve position when parent remounts the book (e.g. on reading-mode switch). */
  initialLogicalPage?: number;
  onImageClick: (url: string) => void;
  onPageChange: (pageIndex: number) => void;
  onNavigate: (path: string) => void;
  onSetPassword: () => void;
}

/** Blank white page — used to keep interior page count even for spread pairing. */
const BlankPage = React.forwardRef<HTMLDivElement>((_, ref) => (
  <div ref={ref} className="w-full h-full bg-white" />
));
BlankPage.displayName = 'BlankPage';

/**
 * BookViewer — wraps react-pageflip's HTMLFlipBook with responsive sizing
 * and maps PageEntry[] to the appropriate book page components.
 */
const BookViewer = React.forwardRef<BookViewerHandle, BookViewerProps>(
  ({ pageList, story, shareToken, showTextOverlay, textOnSidePage, forceTextBelowOnMobile, initialLogicalPage, onImageClick, onPageChange, onNavigate, onSetPassword }, ref) => {
    // Advanced reading level stories (and any future square-layout stories)
    // flag textInImage=false — the PDF prints image on top + text strip below
    // on the SAME page. Force that layout in the reader too so Print Preview
    // matches the actual print. Falls back to languageLevel for older stories
    // that predate the layout field.
    const forceTextBelow =
      story.layout?.textInImage === false || story.languageLevel === 'advanced';
    const bookRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 400, height: 533 });
    // Mobile breakpoint 1024: iPads in portrait (820), large phones in
    // landscape, and narrow desktops all need the single-page layout. The
    // old 768 threshold let iPads and rotated phones through to the
    // two-page spread even though they can't comfortably show one.
    const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 1024);

    // Expose navigation methods
    useImperativeHandle(ref, () => ({
      flipNext: () => bookRef.current?.pageFlip()?.flipNext(),
      flipPrev: () => bookRef.current?.pageFlip()?.flipPrev(),
      flipTo: (page: number) => bookRef.current?.pageFlip()?.flip(page),
      getCurrentPage: () => bookRef.current?.pageFlip()?.getCurrentPageIndex() ?? 0,
    }));

    // Calculate page dimensions from container — A4 aspect per page so the
    // preview matches the printed book 1:1 (no letterbox, no crop).
    const updateDimensions = useCallback(() => {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      if (mobile) {
        // Fill the container completely. Previously locked to A4 aspect so
        // the printed book matched 1:1, but on phones taller than A4 that
        // left 20%+ of the viewport as dead whitespace. On mobile we always
        // render text-below-image (readingMode=sidepage default, or advanced
        // forceTextBelow) — the image uses object-contain to keep its natural
        // aspect and the remaining height is text. No A4 lock needed.
        const available = Math.max(0, ch - 4);
        setDimensions({ width: cw, height: available });
        return;
      }
      // Desktop: keep A4 aspect so the book spread matches the printed book.
      // Modest cap increase over the old 460×650 — big enough to fill wide
      // monitors decently without the book blowing up past sensible book-
      // spread dimensions.
      const maxPageWidth = Math.min(cw / 2, 550);
      const maxPageHeight = Math.min(ch - 10, 800);
      const A4_W = 210, A4_H = 297;
      let pw = maxPageWidth;
      let ph = pw * (A4_H / A4_W);
      if (ph > maxPageHeight) {
        ph = maxPageHeight;
        pw = ph * (A4_W / A4_H);
      }
      setDimensions({ width: Math.round(pw), height: Math.round(ph) });
    }, []);

    useEffect(() => {
      updateDimensions();
      // Re-measure after layout has settled. On very short viewports (iPhone SE
      // 375×667), the first pass reads container height before the surrounding
      // flex layout + safe-area insets have resolved, producing a near-zero
      // available height and collapsing the book to a sliver. A RAF-delayed
      // second measure catches the post-layout size.
      const raf1 = requestAnimationFrame(() => {
        const raf2 = requestAnimationFrame(updateDimensions);
        (window as any).__bookViewerRaf2 = raf2;
      });
      window.addEventListener('resize', updateDimensions);
      return () => {
        cancelAnimationFrame(raf1);
        if ((window as any).__bookViewerRaf2) cancelAnimationFrame((window as any).__bookViewerRaf2);
        window.removeEventListener('resize', updateDimensions);
      };
    }, [updateDimensions]);

    // Server-rendered text overlay images
    const [overlayImages, setOverlayImages] = useState<Record<number, string>>({});

    useEffect(() => {
      if (!showTextOverlay || !story.pages?.length) return;
      let cancelled = false;
      story.pages.forEach(page => {
        if (!page.text?.trim() || overlayImages[page.pageNumber]) return;
        // Pass cached text + textPosition so the server skips the per-page
        // blob round-trip.
        storyService.getSharedTextOverlay(shareToken, page.pageNumber, page.text, (page as any).textPosition).then(result => {
          if (!cancelled) {
            setOverlayImages(prev => ({ ...prev, [page.pageNumber]: result.overlayImage }));
          }
        }).catch(() => { /* overlay fetch is best-effort */ });
      });
      return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showTextOverlay, shareToken, story.pages?.length]);

    // Build image URL helpers — append auth token as query param so owners
    // can view their own private (unshared) stories. <img> tags can't send
    // Authorization headers, so we use the ?token= query param fallback that
    // the optionalAuth middleware supports.
    const authToken = localStorage.getItem('auth_token');
    const tokenQuery = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
    const coverImageUrl = (type: string) =>
      `/api/shared/${shareToken}/cover-image/${type}${tokenQuery}`;
    const pageImageUrl = (pageNum: number) =>
      `/api/shared/${shareToken}/image/${pageNum}${tokenQuery}`;

    // Build the page components list.
    // physicalToLogical maps each flipbook index back to the pageList index
    // (spacers/blanks inherit the logical index of the neighbouring entry),
    // so the page counter in the parent shows the logical position regardless
    // of desktop blank spacers or parity blanks.
    const bookPages: React.ReactNode[] = [];
    const physicalToLogical: number[] = [];

    for (let i = 0; i < pageList.length; i++) {
      const entry = pageList[i];
      switch (entry.type) {
        case 'frontCover':
          bookPages.push(
            <BookCoverPage
              key="front-cover"
              imageUrl={coverImageUrl('frontCover')}
              alt={story.title}
              onImageClick={onImageClick}
            />
          );
          physicalToLogical.push(i);
          break;
        case 'initialPage':
          // On desktop: blank left page + dedication right page to form a spread.
          // On mobile (single-page view): just the dedication, no blank page.
          if (!isMobile) {
            bookPages.push(<BlankPage key="blank-initial" />);
            physicalToLogical.push(i); // blank spacer counts as still on the dedication logical page
          }
          bookPages.push(
            <BookCoverPage
              key="initial-page"
              imageUrl={coverImageUrl('initialPage')}
              alt="Dedication"
              onImageClick={onImageClick}
            />
          );
          physicalToLogical.push(i);
          break;
        case 'storyText': {
          // On mobile, the story page renders text below the image — no separate text page.
          // Same when forceTextBelow is set (advanced level, square layout):
          // the text lives on the same physical page as the image.
          if (isMobile || forceTextBelow) break;
          const storyPage = story.pages[entry.storyPageIdx];
          if (storyPage) {
            bookPages.push(
              <BookTextPage
                key={`text-${storyPage.pageNumber}`}
                text={storyPage.text}
                pageNumber={storyPage.pageNumber}
              />
            );
            physicalToLogical.push(i);
          }
          break;
        }
        case 'story': {
          const storyPage = story.pages[entry.storyPageIdx];
          if (storyPage) {
            bookPages.push(
              <BookStoryPage
                key={`story-${storyPage.pageNumber}`}
                imageUrl={pageImageUrl(storyPage.pageNumber)}
                text={storyPage.text}
                pageNumber={storyPage.pageNumber}
                textPosition={storyPage.textPosition}
                showTextOverlay={showTextOverlay && !forceTextBelow}
                textOnSidePage={textOnSidePage && !isMobile && !forceTextBelow}
                textBelowImage={forceTextBelow || (isMobile && (forceTextBelowOnMobile || textOnSidePage))}
                overlayImage={overlayImages[storyPage.pageNumber] || null}
                onImageClick={onImageClick}
              />
            );
            physicalToLogical.push(i);
            // forceTextBelow stories are self-contained per page (image +
            // text on the same page). Pairing two of them into a spread
            // shows two different scenes at once, which isn't the intended
            // reading experience. On desktop we insert a blank companion
            // so each story page occupies its own spread. On mobile the
            // flipbook is already locked to portrait/single-page mode
            // (pageWidth = containerWidth forces it), so a blank companion
            // would just show up as an empty page between scenes as the
            // user flips — worse UX. Desktop only.
            if (forceTextBelow && !isMobile) {
              bookPages.push(<BlankPage key={`story-${storyPage.pageNumber}-blank`} />);
              physicalToLogical.push(i);
            }
          }
          break;
        }
        case 'backCover':
          bookPages.push(
            <BookCoverPage
              key="back-cover"
              imageUrl={coverImageUrl('backCover')}
              alt="Back cover"
              onImageClick={onImageClick}
            />
          );
          physicalToLogical.push(i);
          break;
        case 'endPage':
          bookPages.push(
            <BookEndPage
              key="end-page"
              storyTitle={story.title}
              language={story.language}
              needsPassword={story.needsPassword}
              onNavigate={onNavigate}
              onSetPassword={onSetPassword}
            />
          );
          physicalToLogical.push(i);
          break;
      }
    }

    // Parity: with showCover=true, page 0 is the cover (alone), then pages 1+ pair up
    // into spreads. On desktop, the interior page count must be even so every spread has
    // both sides. On mobile (single-page portrait) each flip is one page, so parity is
    // unnecessary and a parity blank would cause asymmetric forward/back navigation.
    if (!isMobile) {
      const interiorCount = bookPages.length - 1;
      if (interiorCount > 0 && interiorCount % 2 !== 0) {
        const lastLogical = physicalToLogical[physicalToLogical.length - 1] ?? 0;
        bookPages.splice(bookPages.length - 1, 0, <BlankPage key="parity-blank" />);
        physicalToLogical.splice(physicalToLogical.length - 1, 0, lastLogical);
      }
    }

    return (
      <div
        ref={containerRef}
        className="w-full h-full flex items-center justify-center"
        style={{ minHeight: 300 }}
      >
        {dimensions.width > 0 && (
          <HTMLFlipBook
            ref={bookRef}
            width={dimensions.width}
            height={dimensions.height}
            size="fixed"
            minWidth={250}
            maxWidth={900}
            minHeight={333}
            maxHeight={1200}
            showCover={true}
            flippingTime={800}
            // Mobile (< 1024 px) renders one page at a time (portrait). On
            // desktop we want the 2-page book spread, which requires
            // usePortrait={false}. Hardcoding true forced single-page on every
            // device — the desktop "print preview" was broken.
            usePortrait={isMobile}
            mobileScrollSupport={true}
            maxShadowOpacity={0.4}
            drawShadow={true}
            onFlip={(e: any) => {
              const physicalIdx = Number(e.data) || 0;
              const logicalIdx = physicalToLogical[physicalIdx] ?? physicalIdx;
              onPageChange(logicalIdx);
            }}
            className="book-viewer"
            style={{}}
            startZIndex={0}
            clickEventForward={true}
            useMouseEvents={true}
            swipeDistance={30}
            showPageCorners={true}
            disableFlipByClick={false}
            startPage={(() => {
              if (typeof initialLogicalPage !== 'number' || initialLogicalPage <= 0) return 0;
              // Find the first physical index that maps to this logical index.
              const idx = physicalToLogical.indexOf(initialLogicalPage);
              return idx >= 0 ? idx : 0;
            })()}
            // autoSize OVERRIDES size="fixed" with parent-container measurements,
            // re-flowing pages to a different size after the initial render.
            // Symptom: A4 covers paint at the computed dims, then visibly grow
            // and get clipped by the viewport. We compute A4 dims explicitly
            // in updateDimensions(); fixed is the right mode, no autoSize.
            autoSize={false}
          >
            {bookPages}
          </HTMLFlipBook>
        )}
      </div>
    );
  }
);

BookViewer.displayName = 'BookViewer';
export default BookViewer;
