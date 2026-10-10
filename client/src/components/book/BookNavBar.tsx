import { ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';

/** Reader chrome strings for the page buttons; one source for the story viewer and the trial book. */
export const bookNavLabels = {
  en: { prevPage: 'Previous page', nextPage: 'Next page', firstPage: 'Go to first page' },
  de: { prevPage: 'Vorherige Seite', nextPage: 'Nächste Seite', firstPage: 'Zur ersten Seite' },
  fr: { prevPage: 'Page précédente', nextPage: 'Page suivante', firstPage: 'Aller à la première page' },
  it: { prevPage: 'Pagina precedente', nextPage: 'Pagina successiva', firstPage: 'Vai alla prima pagina' },
} as const;

export function bookNavLabelsFor(language: string) {
  return bookNavLabels[(['en', 'de', 'fr', 'it'] as const).find(l => l === language) ?? 'en'];
}

interface BookNavBarProps {
  currentPage: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
  onFirst: () => void;
  labels: { prevPage: string; nextPage: string; firstPage: string };
  /** The story viewer shows these buttons below the book on phones only (arrows sit beside the book on desktop). */
  mobileOnly?: boolean;
}

/** First / previous / "n / total" / next row under the book. Shared by SharedStoryViewer and the trial book. */
export default function BookNavBar({ currentPage, totalPages, onPrev, onNext, onFirst, labels, mobileOnly = false }: BookNavBarProps) {
  const hide = mobileOnly ? 'md:hidden' : '';
  return (
    <div className="flex items-center justify-center gap-3 md:gap-4 pb-0.5 short:absolute short:left-1/2 short:-translate-x-1/2 short:z-20 short:pb-0 short:bottom-[max(4px,env(safe-area-inset-bottom))]">
      <div className={hide}>
        {currentPage > 1 && (
          <button
            onClick={onFirst}
            className="p-1.5 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-400"
            aria-label={labels.firstPage}
          >
            <ChevronsLeft className="w-4 h-4" />
          </button>
        )}
      </div>
      <button
        onClick={onPrev}
        disabled={currentPage === 0}
        className={`${hide} p-2 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed`}
        aria-label={labels.prevPage}
      >
        <ChevronLeft className="w-5 h-5" />
      </button>
      <span className="text-indigo-400 text-sm font-medium min-w-[3rem] text-center">
        {currentPage + 1} / {totalPages}
      </span>
      <button
        onClick={onNext}
        disabled={currentPage >= totalPages - 1}
        className={`${hide} p-2 rounded-full bg-white shadow-md border border-indigo-200 text-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed`}
        aria-label={labels.nextPage}
      >
        <ChevronRight className="w-5 h-5" />
      </button>
    </div>
  );
}
