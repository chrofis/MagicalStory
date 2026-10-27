import { useState } from 'react';
import type { BookLayout, BookLayoutOption } from '@/services/storyService';

// The book's layout is decided by the story's length (decisions.md 2026-10-27, "book product model"): a short
// story is a square mini book with facing pages (no choice, just a note); every other book is A4 with the text
// in the extended picture. Only that second kind may switch to facing pages (square, surcharge) through the
// small "more options" link below. Availability and the surcharge come from the server (gelato.describeLayouts);
// this component only words them in four languages.
type Lang = 'en' | 'de' | 'fr' | 'it';

const TEXT: Record<Lang, {
  mini: string;
  more: string;
  less: string;
  facing: string;
  facingDesc: string;
  surcharge: (chf: number) => string;
}> = {
  en: {
    mini: 'Short story: printed as a small square book, picture on the left page and text on the right page.',
    more: 'More options', less: 'Fewer options',
    facing: 'Facing pages',
    facingDesc: 'Square book with the picture on the left page and the text on the right page.',
    surcharge: chf => `+ CHF ${chf}`,
  },
  de: {
    mini: 'Kurze Geschichte: wird als kleines quadratisches Buch gedruckt, Bild auf der linken Seite und Text auf der rechten Seite.',
    more: 'Weitere Optionen', less: 'Weniger Optionen',
    facing: 'Gegenüberliegende Seiten',
    facingDesc: 'Quadratisches Buch mit dem Bild auf der linken Seite und dem Text auf der rechten Seite.',
    surcharge: chf => `+ CHF ${chf}`,
  },
  fr: {
    mini: 'Histoire courte : imprimée en petit livre carré, image sur la page de gauche et texte sur la page de droite.',
    more: 'Plus d’options', less: 'Moins d’options',
    facing: 'Pages en regard',
    facingDesc: 'Livre carré avec l’image sur la page de gauche et le texte sur la page de droite.',
    surcharge: chf => `+ CHF ${chf}`,
  },
  it: {
    mini: 'Storia breve: stampata come piccolo libro quadrato, immagine sulla pagina sinistra e testo sulla pagina destra.',
    more: 'Altre opzioni', less: 'Meno opzioni',
    facing: 'Pagine affiancate',
    facingDesc: 'Libro quadrato con l’immagine sulla pagina sinistra e il testo sulla pagina destra.',
    surcharge: chf => `+ CHF ${chf}`,
  },
};

interface Props {
  language: string;
  layouts: Record<BookLayout, BookLayoutOption>;
  selected: BookLayout;
  onSelect: (layout: BookLayout) => void;
}

export default function BookFacingOption({ language, layouts, selected, onSelect }: Props) {
  const t = TEXT[(language as Lang) in TEXT ? (language as Lang) : 'en'];
  const [open, setOpen] = useState(false);
  const { single, spread } = layouts;
  // Mini book: the main layout would leave empty pages, so facing pages is the only option.
  if (!single.available) {
    return spread.available ? <p className="mt-3 text-sm text-gray-600" data-testid="book-mini-note">{t.mini}</p> : null;
  }
  // Too long for facing pages: no exception to offer.
  if (!spread.available) return null;
  const shown = open || selected === 'spread';
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => { if (shown && selected === 'spread') onSelect('single'); setOpen(!shown); }}
        aria-expanded={shown}
        data-testid="book-more-options"
        className="text-sm text-indigo-600 hover:text-indigo-800 underline"
      >
        {shown ? t.less : t.more}
      </button>
      {shown && (
        <label className="mt-2 flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={selected === 'spread'}
            onChange={e => onSelect(e.target.checked ? 'spread' : 'single')}
            data-testid="book-layout-spread"
            className="mt-1"
          />
          <span>
            <span className="font-semibold">{t.facing}</span>
            {spread.surchargeChf > 0 && <span className="ml-2 text-indigo-700">{t.surcharge(spread.surchargeChf)}</span>}
            <span className="block text-xs text-gray-500">{t.facingDesc}</span>
          </span>
        </label>
      )}
    </div>
  );
}
