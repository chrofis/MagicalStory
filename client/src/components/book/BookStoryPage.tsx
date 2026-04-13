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
  overlayImage?: string | null;
  onImageClick?: (url: string) => void;
}

/**
 * Soft story page — image with text overlay (or translucent strip when overlay off).
 * react-pageflip requires forwardRef.
 */
const BookStoryPage = React.forwardRef<HTMLDivElement, BookStoryPageProps>(
  ({ imageUrl, text, pageNumber, textPosition, showTextOverlay, overlayImage, onImageClick }, ref) => {
    const layout = getTextOverlayPosition(pageNumber, text, (textPosition || undefined) as TextPosition | undefined);
    const isFullWidth = layout.position.includes('full');
    const trimmedText = text.trim();

    return (
      <div ref={ref} className="w-full h-full relative bg-white overflow-hidden">
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

        {/* Translucent strip — when overlay is off */}
        {!showTextOverlay && trimmedText && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent pt-8 pb-3 px-3">
            <p className="text-white text-xs leading-snug font-serif line-clamp-4 text-center">
              {trimmedText}
            </p>
          </div>
        )}

        {/* Fullscreen button */}
        {onImageClick && (
          <button
            onClick={(e) => { e.stopPropagation(); onImageClick(imageUrl); }}
            className="absolute top-2 right-2 p-1.5 rounded-full bg-black/30 text-white/80 hover:bg-black/50 hover:text-white transition-colors z-10"
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
