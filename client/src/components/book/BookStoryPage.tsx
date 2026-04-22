import React, { useCallback, useRef } from 'react';
import { Maximize2 } from 'lucide-react';
import {
  getTextOverlayPosition,
  getOverlayClasses,
  getOverlayPositionStyle,
  getTextContainerStyle,
  OVERLAY_FONT_SIZE,
  OVERLAY_TEXT_STROKE_STYLE,
} from '@/utils/textOverlay';
import type { TextPosition } from '@/utils/textOverlay';

interface BookStoryPageProps {
  imageUrl: string;
  text: string;
  pageNumber: number;
  textPosition?: string | null;
  showTextOverlay: boolean;
  /** When true, the text is shown on a separate facing page — don't render any text on the image. */
  textOnSidePage?: boolean;
  /** Mobile read mode: image at top of page with full story text below it. */
  textBelowImage?: boolean;
  overlayImage?: string | null;
  onImageClick?: (url: string) => void;
}

/**
 * Soft story page — image with text overlay (or translucent strip when overlay off).
 * react-pageflip requires forwardRef.
 */
const BookStoryPage = React.forwardRef<HTMLDivElement, BookStoryPageProps>(
  ({ imageUrl, text, pageNumber, textPosition, showTextOverlay, textOnSidePage, textBelowImage, overlayImage, onImageClick }, ref) => {
    const layout = getTextOverlayPosition(pageNumber, text, (textPosition || undefined) as TextPosition | undefined);
    const isFullWidth = layout.position.includes('full');
    const trimmedText = text.trim();

    // Mobile read mode: image at top, scrollable text panel below. Extracted
    // into a subcomponent so we can use hooks for the scroll-indicator state.
    if (textBelowImage) {
      return (
        <TextBelowImagePage
          imageUrl={imageUrl}
          trimmedText={trimmedText}
          pageNumber={pageNumber}
          onImageClick={onImageClick}
          forwardedRef={ref}
        />
      );
    }

    return (
      <div ref={ref} className="w-full h-full relative bg-white overflow-hidden group">
        <img
          src={imageUrl}
          alt={`Page ${pageNumber}`}
          className="w-full h-full object-contain"
          draggable={false}
        />

        {/* Text overlay — server-rendered or CSS fallback */}
        {showTextOverlay && trimmedText && (
          overlayImage ? (
            <img
              src={overlayImage}
              alt=""
              className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              draggable={false}
            />
          ) : (
            <div
              className={getOverlayClasses(layout)}
              style={getOverlayPositionStyle(layout)}
            >
              <div className="p-2 md:p-3" style={getTextContainerStyle(layout)}>
                <p
                  className={`leading-snug whitespace-pre-wrap font-serif ${isFullWidth ? 'text-center' : ''}`}
                  style={{ fontSize: OVERLAY_FONT_SIZE, ...OVERLAY_TEXT_STROKE_STYLE }}
                >
                  {trimmedText}
                </p>
              </div>
            </div>
          )
        )}

        {/* Translucent strip — when overlay is off AND text isn't shown on a facing page */}
        {!showTextOverlay && !textOnSidePage && trimmedText && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent pt-8 pb-3 px-3">
            <p className="text-white text-xs leading-snug font-serif line-clamp-4 text-center">
              {trimmedText}
            </p>
          </div>
        )}

        {/* Fullscreen button — top-center, only visible on hover so it doesn't block the page-flip corners */}
        {onImageClick && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onImageClick(imageUrl); }}
            className="absolute top-2 left-1/2 -translate-x-1/2 p-1.5 rounded-full bg-black/30 text-white/80 hover:bg-black/50 hover:text-white transition-opacity opacity-0 group-hover:opacity-100 z-10"
            aria-label="Fullscreen"
          >
            <Maximize2 size={14} />
          </button>
        )}
      </div>
    );
  }
);

BookStoryPage.displayName = 'BookStoryPage';
export default BookStoryPage;

// ─── Mobile text-below-image layout ────────────────────────────────────────────
// Handles its own scrolling because react-pageflip registers a window-level
// touchmove listener with preventDefault(), which kills native scrolling the
// moment a touchstart fires inside the book. stopPropagation on the child can't
// block window-level listeners. Instead we drive scrollTop manually from
// touch events and let page-flip's preventDefault silently no-op our intent.
// Also exposes a scroll-hint chevron + fade while there's still content below
// the visible area — without it users don't realise the text is scrollable.

interface TextBelowPageProps {
  imageUrl: string;
  trimmedText: string;
  pageNumber: number;
  onImageClick?: (url: string) => void;
  forwardedRef: React.ForwardedRef<HTMLDivElement>;
}

const TextBelowImagePage: React.FC<TextBelowPageProps> = ({ imageUrl, trimmedText, pageNumber, onImageClick, forwardedRef }) => {
  const scrollEl = useRef<HTMLDivElement | null>(null);

  // Touch-driven scroll — bypasses page-flip's window-level preventDefault.
  const bindScroll = useCallback((el: HTMLDivElement | null) => {
    scrollEl.current = el;
    if (!el) return;
    let lastY: number | null = null;
    const onStart = (e: TouchEvent) => {
      e.stopPropagation();
      lastY = e.touches[0]?.clientY ?? null;
    };
    const onMove = (e: TouchEvent) => {
      e.stopPropagation();
      const y = e.touches[0]?.clientY;
      if (y == null || lastY == null) return;
      const delta = lastY - y;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const wantsDown = delta > 0;
      if ((wantsDown && !atBottom) || (!wantsDown && !atTop)) {
        el.scrollTop += delta;
      }
      lastY = y;
    };
    const onEnd = (e: TouchEvent) => {
      e.stopPropagation();
      lastY = null;
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
  }, []);

  return (
    // Absolute-positioned split instead of flex: HTMLFlipBook wraps each page
    // in its own div and applies inline styles, which was collapsing the
    // flex-1 text zone unpredictably on narrow viewports. Absolute top/bottom
    // with percentage heights gives us deterministic image + text zones that
    // don't depend on flex-basis resolution through the flipbook wrapper.
    <div ref={forwardedRef} className="w-full h-full relative bg-white overflow-hidden group">
      <div className="absolute inset-x-0 top-0" style={{ height: '60%' }}>
        <img
          src={imageUrl}
          alt={`Page ${pageNumber}`}
          className="w-full h-full object-contain"
          draggable={false}
        />
        {onImageClick && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onImageClick(imageUrl); }}
            className="absolute top-2 left-1/2 -translate-x-1/2 p-1.5 rounded-full bg-black/30 text-white/80 hover:bg-black/50 hover:text-white transition-opacity opacity-0 group-hover:opacity-100 z-10"
            aria-label="Fullscreen"
          >
            <Maximize2 size={14} />
          </button>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 border-t border-gray-200" style={{ height: '40%' }}>
        <div
          ref={bindScroll}
          className="absolute inset-0 overflow-y-auto overscroll-contain bg-white px-4 py-3"
          style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
        >
          <p
            className="text-gray-900 leading-relaxed whitespace-pre-wrap font-serif"
            style={{ fontSize: 'clamp(0.95rem, 2.4vw, 1.05rem)', lineHeight: 1.55 }}
          >
            {trimmedText}
          </p>
        </div>
      </div>
    </div>
  );
};
