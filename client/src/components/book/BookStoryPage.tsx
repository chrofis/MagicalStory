import React from 'react';
import { Maximize2 } from 'lucide-react';
import {
  getTextOverlayPosition,
  getOverlayClasses,
  getOverlayPositionStyle,
  getGradientStyle,
  getTextContainerStyle,
  OVERLAY_FONT_SIZE,
  OVERLAY_TEXT_SHADOW,
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

    // Mobile read mode: image at top, full text below — no overlay or facing page.
    if (textBelowImage) {
      return (
        <div ref={ref} className="w-full h-full relative bg-white overflow-hidden group flex flex-col">
          <div className="relative flex-shrink-0" style={{ height: '60%' }}>
            <img
              src={imageUrl}
              alt={`Page ${pageNumber}`}
              className="w-full h-full object-contain"
              draggable={false}
            />
            {onImageClick && (
              <button
                onClick={(e) => { e.stopPropagation(); onImageClick(imageUrl); }}
                className="absolute top-2 left-1/2 -translate-x-1/2 p-1.5 rounded-full bg-black/30 text-white/80 hover:bg-black/50 hover:text-white transition-opacity opacity-0 group-hover:opacity-100 z-10"
                aria-label="Fullscreen"
              >
                <Maximize2 size={14} />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto bg-amber-50 px-4 py-3">
            <p
              className="text-gray-900 leading-relaxed whitespace-pre-wrap font-serif"
              style={{ fontSize: 'clamp(0.85rem, 2.2vw, 1rem)', lineHeight: 1.55 }}
            >
              {trimmedText}
            </p>
          </div>
        </div>
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
              style={{
                ...getOverlayPositionStyle(layout),
                ...getGradientStyle(layout),
              }}
            >
              <div className="p-2 md:p-3" style={getTextContainerStyle(layout)}>
                <p
                  className={`text-gray-900 leading-snug whitespace-pre-wrap font-serif ${isFullWidth ? 'text-center' : ''}`}
                  style={{ fontSize: OVERLAY_FONT_SIZE, textShadow: OVERLAY_TEXT_SHADOW }}
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
