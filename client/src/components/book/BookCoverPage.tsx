import React from 'react';
import { Maximize2 } from 'lucide-react';

interface BookCoverPageProps {
  imageUrl: string;
  alt: string;
  onImageClick?: (url: string) => void;
  /**
   * Whether this cover is the LCP element (above-the-fold first paint).
   * When true, hints the browser to fetch immediately and decode async so
   * the first paint isn't blocked. Use only for the front cover.
   */
  priority?: boolean;
}

/**
 * Hard cover page for the flip-book (front cover, back cover, initial/dedication).
 * react-pageflip requires forwardRef — the ref attaches to the outer div.
 */
const BookCoverPage = React.forwardRef<HTMLDivElement, BookCoverPageProps>(
  ({ imageUrl, alt, onImageClick, priority }, ref) => (
    <div ref={ref} className="w-full h-full relative bg-white group">
      <img
        src={imageUrl}
        alt={alt}
        className="w-full h-full object-contain"
        draggable={false}
        {...(priority ? { fetchPriority: 'high' as const, decoding: 'async' as const } : {})}
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
  )
);

BookCoverPage.displayName = 'BookCoverPage';
export default BookCoverPage;
