import React, { useCallback } from 'react';
import { bindCustomScroll } from './BookCustomPage';
import ClampedText from './ClampedText';

interface BookTextPageProps {
  text: string;
  pageNumber: number;
  /** Locked page: show only the first N lines, faded out (see ClampedText). */
  textClamp?: number;
  /** Rendered below the text (the trial's sign-in block); makes the page scroll like a custom page. */
  textFooter?: React.ReactNode;
}


/**
 * Text-only page — used in 'sidepage' mode where text and image are on
 * facing pages instead of overlaid.
 */
const BookTextPage = React.forwardRef<HTMLDivElement, BookTextPageProps>(
  ({ text, pageNumber, textClamp, textFooter }, ref) => {
  // A footer holds inputs/buttons: it needs the custom page's scroll + mouse handling.
  // useCallback keeps the ref callback stable so the listeners are bound once.
  const hasFooter = !!textFooter;
  const setRef = useCallback((el: HTMLDivElement | null) => {
    if (el && hasFooter) bindCustomScroll(el);
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  }, [ref, hasFooter]);
  return (
    <div
      ref={setRef}
      className="w-full h-full bg-white overflow-y-auto overscroll-contain px-6 py-8 md:px-10 md:py-12"
      // Subtle spine shading on the inner (right) edge so the reader can tell
      // where the page ends in a spread. No tinted background, no border.
      style={{ boxShadow: 'inset -8px 0 14px -10px rgba(0,0,0,0.12)' }}
    >
      <div className="max-w-md w-full mx-auto">
        {textClamp ? (
          <ClampedText
            text={text.trim()}
            lines={textClamp}
            className="text-gray-900 font-serif leading-relaxed whitespace-pre-wrap"
            style={{ fontSize: 'clamp(0.9rem, 2vw, 1.1rem)', lineHeight: 1.6 }}
          />
        ) : (
          <p
            className="text-gray-900 font-serif leading-relaxed whitespace-pre-wrap"
            style={{ fontSize: 'clamp(0.9rem, 2vw, 1.1rem)', lineHeight: 1.6 }}
          >
            {text.trim()}
          </p>
        )}
        {textFooter ? (
          <div className="mt-4">{textFooter}</div>
        ) : (
          <div className="mt-6 text-center text-xs text-gray-400 font-serif">
            {pageNumber}
          </div>
        )}
      </div>
    </div>
  );
});

BookTextPage.displayName = 'BookTextPage';
export default BookTextPage;
