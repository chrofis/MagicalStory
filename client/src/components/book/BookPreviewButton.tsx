import { Eye } from 'lucide-react';
import type { BookLayout } from '@/services/storyService';
import { withLang } from '@/utils/langPath';

// "Preview book" opens the full-book preview (pages/BookPreview.tsx) in its own browser tab with its own URL, so it can
// be reloaded or shared with someone logged in as the owner. docs/decisions.md 2026-10-28 "Book preview".
type Lang = 'en' | 'de' | 'fr' | 'it';
const LABEL: Record<Lang, string> = { en: 'Preview book', de: 'Buch ansehen', fr: 'Aperçu du livre', it: 'Anteprima del libro' };
const HINT: Record<Lang, string> = {
  en: 'See every page exactly as it will be printed. The first time takes 1 to 2 minutes.',
  de: 'Sieh jede Seite genau so, wie sie gedruckt wird. Beim ersten Mal dauert es 1 bis 2 Minuten.',
  fr: 'Voyez chaque page exactement comme elle sera imprimée. La première fois, comptez 1 à 2 minutes.',
  it: 'Guarda ogni pagina esattamente come verrà stampata. La prima volta ci vogliono 1 o 2 minuti.',
};

export function bookPreviewUrl(storyIds: string[], layout: BookLayout, coverType: 'softcover' | 'hardcover', language: string): string {
  const q = new URLSearchParams({ stories: storyIds.join(','), layout, cover: coverType });
  return withLang(`/book-preview?${q.toString()}`, language);
}

interface Props {
  language: string;
  storyIds: string[];
  layout: BookLayout;
  coverType: 'softcover' | 'hardcover';
  disabled?: boolean;
}

export default function BookPreviewButton({ language, storyIds, layout, coverType, disabled }: Props) {
  const l: Lang = (language as Lang) in LABEL ? (language as Lang) : 'en';
  return (
    <div className="mb-4">
      <button
        type="button"
        data-testid="book-preview-button"
        disabled={disabled || storyIds.length === 0}
        onClick={() => window.open(bookPreviewUrl(storyIds, layout, coverType, language), '_blank', 'noopener')}
        className="w-full py-3 bg-indigo-100 text-indigo-700 border-2 border-indigo-300 rounded-xl font-semibold hover:bg-indigo-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        <Eye size={20} />
        {LABEL[l]}
      </button>
      <p className="text-xs text-gray-500 mt-1 text-center">{HINT[l]}</p>
    </div>
  );
}
