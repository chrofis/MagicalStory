import React, { useRef, useState, useEffect, useCallback, useImperativeHandle } from 'react';
import HTMLFlipBook from 'react-pageflip';
import BookCoverPage from './BookCoverPage';
import BookStoryPage from './BookStoryPage';
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
  onImageClick: (url: string) => void;
  onPageChange: (pageIndex: number) => void;
  onNavigate: (path: string) => void;
  onSetPassword: () => void;
}

/** Blank white page — used to keep interior page count even for spread pairing. */
const BlankPage = React.forwardRef<HTMLDivElement>((_, ref) => (
  <div ref={ref} className="w-full h-full bg-white" data-density="hard" />
));
BlankPage.displayName = 'BlankPage';

/**
 * BookViewer — wraps react-pageflip's HTMLFlipBook with responsive sizing
 * and maps PageEntry[] to the appropriate book page components.
 */
const BookViewer = React.forwardRef<BookViewerHandle, BookViewerProps>(
  ({ pageList, story, shareToken, showTextOverlay, onImageClick, onPageChange, onNavigate, onSetPassword }, ref) => {
    const bookRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 400, height: 533 });

    // Expose navigation methods
    useImperativeHandle(ref, () => ({
      flipNext: () => bookRef.current?.pageFlip()?.flipNext(),
      flipPrev: () => bookRef.current?.pageFlip()?.flipPrev(),
      flipTo: (page: number) => bookRef.current?.pageFlip()?.flip(page),
      getCurrentPage: () => bookRef.current?.pageFlip()?.getCurrentPageIndex() ?? 0,
    }));

    // Calculate page dimensions from container — 3:4 aspect ratio per page
    const updateDimensions = useCallback(() => {
      if (!containerRef.current) return;
      const cw = containerRef.current.clientWidth;
      const ch = containerRef.current.clientHeight;
      // In landscape (desktop), 2 pages fit side by side → each page ≤ half the width
      // In portrait (mobile), 1 page fills the width
      const maxPageWidth = Math.min(cw / 2, 550);
      const maxPageHeight = Math.min(ch - 10, 780);
      // Fit 3:4 ratio within constraints
      let pw = maxPageWidth;
      let ph = pw * (4 / 3);
      if (ph > maxPageHeight) {
        ph = maxPageHeight;
        pw = ph * (3 / 4);
      }
      setDimensions({ width: Math.round(pw), height: Math.round(ph) });
    }, []);

    useEffect(() => {
      updateDimensions();
      window.addEventListener('resize', updateDimensions);
      return () => window.removeEventListener('resize', updateDimensions);
    }, [updateDimensions]);

    // Server-rendered text overlay images
    const [overlayImages, setOverlayImages] = useState<Record<number, string>>({});

    useEffect(() => {
      if (!showTextOverlay || !story.pages?.length) return;
      let cancelled = false;
      story.pages.forEach(page => {
        if (!page.text?.trim() || overlayImages[page.pageNumber]) return;
        storyService.getSharedTextOverlay(shareToken, page.pageNumber).then(result => {
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

    // Build the page components list
    const bookPages: React.ReactNode[] = [];

    for (const entry of pageList) {
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
          break;
        case 'initialPage':
          // Blank left page + dedication right page to form a spread
          bookPages.push(<BlankPage key="blank-initial" />);
          bookPages.push(
            <BookCoverPage
              key="initial-page"
              imageUrl={coverImageUrl('initialPage')}
              alt="Dedication"
              onImageClick={onImageClick}
            />
          );
          break;
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
                showTextOverlay={showTextOverlay}
                overlayImage={overlayImages[storyPage.pageNumber] || null}
                onImageClick={onImageClick}
              />
            );
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
          break;
      }
    }

    // Parity: interior pages (everything between first and last) must be even.
    // First child = front cover, last child = end page (or back cover).
    // Interior = bookPages[1] through bookPages[length-2]
    const interiorCount = bookPages.length - 2;
    if (interiorCount > 0 && interiorCount % 2 !== 0) {
      // Insert blank page before the last page
      bookPages.splice(bookPages.length - 1, 0, <BlankPage key="parity-blank" />);
    }

    return (
      <div
        ref={containerRef}
        className="w-full flex items-center justify-center"
        style={{ height: 'calc(100dvh - 200px)', minHeight: 300, maxHeight: 800 }}
      >
        {dimensions.width > 0 && (
          <HTMLFlipBook
            ref={bookRef}
            width={dimensions.width}
            height={dimensions.height}
            size="stretch"
            minWidth={250}
            maxWidth={550}
            minHeight={333}
            maxHeight={733}
            showCover={true}
            flippingTime={800}
            usePortrait={true}
            mobileScrollSupport={true}
            maxShadowOpacity={0.4}
            drawShadow={true}
            onFlip={(e: any) => onPageChange(e.data)}
            className="book-viewer"
            style={{}}
            startZIndex={0}
            clickEventForward={true}
            useMouseEvents={true}
            swipeDistance={30}
            showPageCorners={true}
            disableFlipByClick={false}
            startPage={0}
            autoSize={true}
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
