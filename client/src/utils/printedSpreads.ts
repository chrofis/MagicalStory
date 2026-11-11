import type { PrintedPage } from '@/services/storyService';

// The order page shows the first 3 open-book spreads of the printed sequence (6 pages), after the cover row.
export const SPREAD_PAGES_SHOWN = 6;

/** The pages shown as spreads and how many inner pages stay unseen. The cover entry is shown in the cover row, never here. */
export function spreadPages(sequence: PrintedPage[]): { shown: PrintedPage[]; more: number } {
  const inner = sequence.filter(p => p.kind !== 'cover' && p.kind !== 'backCover');
  return { shown: inner.slice(0, SPREAD_PAGES_SHOWN), more: Math.max(0, inner.length - SPREAD_PAGES_SHOWN) };
}

/**
 * The ONE cover pair of the printed BOOK, whatever the story count (what pdf.js generateCombinedBookPdf puts on the
 * cover): front = the first story's front cover; back = the first story's back cover or, when it has none, the back
 * cover of the LAST story that has one (the same borrow rule as the PDF). `covers` is in book order.
 */
export function pickBookCovers(covers: { frontCover?: string; backCover?: string }[]): { front?: string; back?: string } {
  let back = covers[0]?.backCover;
  for (let i = covers.length - 1; !back && i > 0; i--) back = covers[i]?.backCover;
  return { front: covers[0]?.frontCover, back };
}
