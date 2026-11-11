import type { BookLayout, BookLayoutOption } from '@/services/storyService';
import { SQUARE_BOOK_SIZE_LABEL, A4_BOOK_SIZE_LABEL } from '@/utils/bookPricing';
import { ChoiceCard } from '@/components/book/BlankPagesChoice';

// The customer picks the printed-book format (owner 2026-11-11, decisions.md "Price per layout from the page tiers"):
// when BOTH layouts exist, two equal option cards (radio, the ChoiceCard of the blank-pages choice), each with its
// printed page count and its own full price (the page's tier price for that layout's page count, decisions.md 2026-11-11
// "Price per layout from the page tiers"; the voucher page passes no prices).
// When only one layout exists there is nothing to choose and nothing is shown. Availability, page counts and the
// page counts come from the server (gelato.describeLayouts); this component only words them in four languages.
type Lang = 'en' | 'de' | 'fr' | 'it';

const TEXT: Record<Lang, {
  square: string; a4: string; pages: (n: number) => string; noPrice: string;
}> = {
  en: {
    square: `Square ${SQUARE_BOOK_SIZE_LABEL}: picture left, text right`,
    a4: `A4 ${A4_BOOK_SIZE_LABEL}: text below the picture`,
    pages: n => `${n} pages`, noPrice: 'Not available for this many pages',
  },
  de: {
    square: `Quadratisch ${SQUARE_BOOK_SIZE_LABEL}: Bild links, Text rechts`,
    a4: `A4 ${A4_BOOK_SIZE_LABEL}: Text unter dem Bild`,
    pages: n => `${n} Seiten`, noPrice: 'Für diese Seitenzahl nicht verfügbar',
  },
  fr: {
    square: `Carré ${SQUARE_BOOK_SIZE_LABEL} : image à gauche, texte à droite`,
    a4: `A4 ${A4_BOOK_SIZE_LABEL} : texte sous l’image`,
    pages: n => `${n} pages`, noPrice: 'Indisponible pour ce nombre de pages',
  },
  it: {
    square: `Quadrato ${SQUARE_BOOK_SIZE_LABEL}: immagine a sinistra, testo a destra`,
    a4: `A4 ${A4_BOOK_SIZE_LABEL}: testo sotto l’immagine`,
    pages: n => `${n} pagine`, noPrice: 'Non disponibile per questo numero di pagine',
  },
};

interface Props {
  language: string;
  layouts: Record<BookLayout, BookLayoutOption>;
  selected: BookLayout;
  onSelect: (layout: BookLayout) => void;
  /** Full price text of each card (e.g. "CHF 47.-"); absent = no price shown. */
  prices?: Partial<Record<BookLayout, string>>;
}

/** True when the customer has a format to choose: both layouts are available. */
export const hasFormatChoice = (layouts: Record<BookLayout, BookLayoutOption>): boolean =>
  layouts.single.available && layouts.spread.available;

export default function BookFormatChoice({ language, layouts, selected, onSelect, prices }: Props) {
  const t = TEXT[(language as Lang) in TEXT ? (language as Lang) : 'en'];
  if (!hasFormatChoice(layouts)) return null;
  const { single, spread } = layouts;
  // Prices are shown but the tier table has none for this layout's page count (beyond its last tier): not orderable.
  const spreadOrderable = !prices || !!prices.spread;
  const singleOrderable = !prices || !!prices.single;
  return (
    <div role="radiogroup" className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="book-format-choice">
      <ChoiceCard checked={selected === 'single'} onSelect={() => onSelect('single')} testId="book-format-a4" disabled={!singleOrderable}>
        <span className="flex flex-col">
          <span>{t.a4}</span>
          <span className="text-xs font-normal text-gray-600">
            {t.pages(single.printedPages)} · {singleOrderable ? (prices?.single ?? '') : t.noPrice}
          </span>
        </span>
      </ChoiceCard>
      <ChoiceCard checked={selected === 'spread'} onSelect={() => onSelect('spread')} testId="book-format-square" disabled={!spreadOrderable}>
        <span className="flex flex-col">
          <span>{t.square}</span>
          <span className="text-xs font-normal text-gray-600">
            {t.pages(spread.printedPages)} · {spreadOrderable ? (prices?.spread ?? '') : t.noPrice}
          </span>
        </span>
      </ChoiceCard>
    </div>
  );
}
