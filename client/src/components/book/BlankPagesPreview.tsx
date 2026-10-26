import { useEffect, useState } from 'react';
import { storyService } from '@/services';
import type { PrintedPage } from '@/services/storyService';
import { createLogger } from '@/services/logger';

const log = createLogger('BlankPagesPreview');

interface StoryImages {
  pages: Record<number, string>;
  frontCover?: string;
  initialPage?: string;
  backCover?: string;
}

interface Props {
  sequence: PrintedPage[];
  storyIds: string[];
  filledPages: number;
  printedPages: number;
  blankPages: number;
  title: string;
  summary: (filled: number, printed: number, blank: number) => string;
  legendFilled: string;
  legendBlank: string;
}

const asSrc = (d?: string) => (d ? (d.startsWith('data:') ? d : `data:image/jpeg;base64,${d}`) : undefined);

/**
 * Compact printed-book strip shown before checkout when the book has blank pages.
 * Blank pages are drawn as empty white pages with a dashed border so they cannot be missed.
 */
export default function BlankPagesPreview({
  sequence, storyIds, filledPages, printedPages, blankPages, title, summary, legendFilled, legendBlank,
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
    const set = images[p.storyIndex ?? 0];
    if (!set) return undefined;
    if (p.kind === 'cover') return set.frontCover;
    if (p.kind === 'dedication') return set.initialPage;
    if (p.kind === 'backCover') return set.backCover;
    if ((p.kind === 'story' || p.kind === 'storyImage') && p.pageNumber) return set.pages[p.pageNumber];
    return undefined;
  };

  return (
    <div className="mt-3" data-testid="blank-pages-preview">
      <div className="font-semibold text-sm text-gray-800 mb-1">{title}</div>
      <div className="text-sm text-gray-700 mb-2">{summary(filledPages, printedPages, blankPages)}</div>
      <div className="flex flex-wrap gap-1">
        {sequence.map((p, i) => {
          const blank = p.kind === 'filler' || p.kind === 'insideFront' || p.kind === 'insideBack' || p.kind === 'separator';
          const src = blank ? undefined : asSrc(imageFor(p));
          return (
            <div
              key={i}
              data-kind={p.kind}
              className={`w-9 h-12 sm:w-11 sm:h-14 rounded-sm overflow-hidden flex items-center justify-center text-[9px] ${
                blank ? 'bg-white border border-dashed border-gray-300' : 'bg-indigo-50 border border-indigo-200'
              }`}
            >
              {src && <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />}
              {/* spread layout: the right-hand page holds the text */}
              {p.kind === 'storyText' && (
                <div className="w-full px-1 space-y-1" aria-hidden="true">
                  <div className="h-px bg-indigo-300" /><div className="h-px bg-indigo-300" /><div className="h-px bg-indigo-300" /><div className="h-px bg-indigo-300 w-2/3" />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 mt-2 text-xs text-gray-600">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-4 bg-indigo-50 border border-indigo-200" />{legendFilled}</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-4 bg-white border border-dashed border-gray-400" />{legendBlank}</span>
      </div>
    </div>
  );
}
