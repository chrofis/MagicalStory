import { useEffect, useState, type ReactNode } from 'react';
import { storyService } from '@/services';
import type { PrintedPage } from '@/services/storyService';
import { createLogger } from '@/services/logger';
import { toImgSrc } from '@/utils/imgSrc';
import { spreadPages } from '@/utils/printedSpreads';

const log = createLogger('PrintedBookSpreads');

// "Your printed book" on the order page: front/back cover first, then the first 3 open-book spreads (left page | right
// page) of the printed sequence, then "+ N more pages" and the preview button (children) as the way to see the rest.
// docs/decisions.md 2026-11-11 "Printed-book spreads".
interface StoryImages {
  pages: Record<number, string>;
  frontCover?: string;
  initialPage?: string;
  backCover?: string;
}

interface Props {
  sequence: PrintedPage[];
  storyIds: string[];
  /** Square book (cells are square) or A4 (portrait cells). */
  square: boolean;
  /** Square dedication page per story id (what a square book prints); replaces the A4 dedication image. */
  dedicationOverride?: Record<string, string | undefined>;
  /** Cover row supplied by the page (square covers). When absent the story's own front/back covers are shown. */
  covers?: ReactNode;
  coverLabels: { front: string; back: string };
  title: string;
  morePages: (n: number) => string;
  /** Shown right under the "+ N more pages" note (the preview button). */
  children?: ReactNode;
}

const asSrc = (d?: string) => toImgSrc(d) ?? undefined;
const isEmptyKind = (k: PrintedPage['kind']) => k === 'filler' || k === 'insideFront' || k === 'insideBack' || k === 'separator';

export default function PrintedBookSpreads({
  sequence, storyIds, square, dedicationOverride, covers, coverLabels, title, morePages, children,
}: Props) {
  const [images, setImages] = useState<Record<number, StoryImages>>({});
  const idsKey = storyIds.join(',');

  useEffect(() => {
    let cancelled = false;
    storyIds.forEach((id, si) => {
      storyService.getAllImages(id, true).then(res => {
        if (cancelled || !res) return;
        const pages: Record<number, string> = {};
        res.images.forEach(i => { pages[i.pageNumber] = i.imageData; });
        setImages(prev => ({
          ...prev,
          [si]: {
            pages,
            frontCover: res.covers.frontCover?.imageData,
            initialPage: res.covers.initialPage?.imageData,
            backCover: res.covers.backCover?.imageData,
          },
        }));
      }).catch(err => log.error('Failed to load preview images:', err));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const imageFor = (p: PrintedPage): string | undefined => {
    const si = p.storyIndex ?? 0;
    const set = images[si];
    if (p.kind === 'dedication') return dedicationOverride?.[storyIds[si]] ?? set?.initialPage;
    if (!set) return undefined;
    if ((p.kind === 'story' || p.kind === 'storyImage') && p.pageNumber) return set.pages[p.pageNumber];
    return undefined;
  };

  const { shown, more } = spreadPages(sequence);
  const spreads: PrintedPage[][] = [];
  for (let i = 0; i < shown.length; i += 2) spreads.push(shown.slice(i, i + 2));
  const aspect = square ? 'aspect-square' : 'aspect-[3/4]';

  const renderPage = (p: PrintedPage | undefined, side: 'left' | 'right') => {
    const src = p && !isEmptyKind(p.kind) ? asSrc(imageFor(p)) : undefined;
    return (
      <div
        data-testid={`printed-page-${side}`}
        data-kind={p?.kind ?? 'none'}
        className={`${aspect} bg-white overflow-hidden ${p?.kind === 'storyText' ? '' : 'flex items-center justify-center'}`}
      >
        {src && <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />}
        {p?.kind === 'storyText' && (
          <div className="w-full h-full p-3 overflow-hidden text-xs leading-snug text-gray-800 break-words" data-testid="printed-page-text">
            {p.text}
          </div>
        )}
      </div>
    );
  };

  const ownCovers = (si: number) => {
    const set = images[si];
    return [
      { key: 'front', src: asSrc(set?.frontCover), label: coverLabels.front },
      { key: 'back', src: asSrc(set?.backCover), label: coverLabels.back },
    ].filter(c => c.src);
  };

  return (
    <div className="mt-4" data-testid="printed-book-section">
      <div className="font-semibold text-sm text-gray-800 mb-2">{title}</div>
      <div data-testid="printed-book-covers">
        {covers ?? (
          <div className="grid grid-cols-2 gap-2">
            {ownCovers(0).map(c => (
              <figure key={c.key}>
                <img src={c.src} alt={c.label} className={`w-full ${aspect} object-cover rounded border border-gray-200`} />
                <figcaption className="text-xs text-gray-500 mt-1 text-center">{c.label}</figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>
      <div className="mt-3 space-y-3" data-testid="printed-book-spreads">
        {spreads.map((pair, i) => (
          <div key={i} data-testid="printed-spread" className="grid grid-cols-2 gap-px bg-gray-300 border border-gray-300 rounded shadow-sm overflow-hidden">
            {renderPage(pair[0], 'left')}
            {renderPage(pair[1], 'right')}
          </div>
        ))}
      </div>
      {more > 0 && <div className="mt-2 text-sm text-gray-600 text-center" data-testid="printed-book-more">{morePages(more)}</div>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
