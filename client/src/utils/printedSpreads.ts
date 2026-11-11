import type { PrintedPage } from '@/services/storyService';

// The order page shows the first 3 open-book spreads of the printed sequence (6 pages), after the cover row.
export const SPREAD_PAGES_SHOWN = 6;

/** The pages shown as spreads and how many inner pages stay unseen. The cover entry is shown in the cover row, never here. */
export function spreadPages(sequence: PrintedPage[]): { shown: PrintedPage[]; more: number } {
  const inner = sequence.filter(p => p.kind !== 'cover' && p.kind !== 'backCover');
  return { shown: inner.slice(0, SPREAD_PAGES_SHOWN), more: Math.max(0, inner.length - SPREAD_PAGES_SHOWN) };
}
