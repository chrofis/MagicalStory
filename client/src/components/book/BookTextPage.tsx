import React from 'react';

interface BookTextPageProps {
  text: string;
  pageNumber: number;
}

/**
 * Text-only page — used in 'sidepage' mode where text and image are on
 * facing pages instead of overlaid.
 */
const BookTextPage = React.forwardRef<HTMLDivElement, BookTextPageProps>(
  ({ text, pageNumber }, ref) => (
    <div
      ref={ref}
      className="w-full h-full bg-white overflow-y-auto overscroll-contain px-6 py-8 md:px-10 md:py-12"
      // Subtle spine shading on the inner (right) edge so the reader can tell
      // where the page ends in a spread. No tinted background, no border.
      style={{ boxShadow: 'inset -8px 0 14px -10px rgba(0,0,0,0.12)' }}
    >
      <div className="max-w-md w-full mx-auto">
        <p
          className="text-gray-900 font-serif leading-relaxed whitespace-pre-wrap"
          style={{ fontSize: 'clamp(0.9rem, 2vw, 1.1rem)', lineHeight: 1.6 }}
        >
          {text.trim()}
        </p>
        <div className="mt-6 text-center text-xs text-gray-400 font-serif">
          {pageNumber}
        </div>
      </div>
    </div>
  )
);

BookTextPage.displayName = 'BookTextPage';
export default BookTextPage;
