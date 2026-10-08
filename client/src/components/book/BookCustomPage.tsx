import React from 'react';
import { bindManualTouchScroll } from './BookStoryPage';

interface BookCustomPageProps {
  children: React.ReactNode;
}

// Native listener: React's synthetic stopPropagation runs at the root, after the
// flip container's own native mousedown handler has already started a drag.
export function bindCustomScroll(el: HTMLDivElement | null) {
  if (!el) return;
  bindManualTouchScroll(el);
  el.addEventListener('mousedown', (e) => e.stopPropagation());
}

/**
 * A page whose content is supplied by the caller (e.g. the trial's sign-in gate
 * or a pending-title placeholder). Scrolls inside the page; mouse/touch input
 * is kept away from the flip handlers so buttons and inputs on it work.
 * react-pageflip requires forwardRef — the ref attaches to the outer div.
 */
const BookCustomPage = React.forwardRef<HTMLDivElement, BookCustomPageProps>(({ children }, ref) => (
  <div ref={ref} className="w-full h-full relative bg-white overflow-hidden">
    <div
      ref={bindCustomScroll}
      className="absolute inset-0 overflow-y-auto overscroll-contain px-4 py-4"
      style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
    >
      {children}
    </div>
  </div>
));

BookCustomPage.displayName = 'BookCustomPage';
export default BookCustomPage;
