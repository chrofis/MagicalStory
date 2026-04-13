import React from 'react';
import { Maximize2 } from 'lucide-react';

interface BookCoverPageProps {
  imageUrl: string;
  alt: string;
  onImageClick?: (url: string) => void;
}

/**
 * Hard cover page for the flip-book (front cover, back cover, initial/dedication).
 * react-pageflip requires forwardRef — the ref attaches to the outer div.
 */
const BookCoverPage = React.forwardRef<HTMLDivElement, BookCoverPageProps>(
  ({ imageUrl, alt, onImageClick }, ref) => (
    <div ref={ref} className="w-full h-full relative bg-white" data-density="hard">
      <img
        src={imageUrl}
        alt={alt}
        className="w-full h-full object-contain"
        draggable={false}
      />
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
  )
);

BookCoverPage.displayName = 'BookCoverPage';
export default BookCoverPage;
