import type { BookLayout, BookLayoutOption } from '@/services/storyService';

// The two printed-book layouts the customer chooses between (decisions.md 2026-10-27, "The customer picks
// the book layout"). Availability, reasons and the surcharge all come from the server (gelato.describeLayouts);
// this component only words them in four languages. A greyed card states its reason.
type Lang = 'en' | 'de' | 'fr' | 'it';

const TEXT: Record<Lang, {
  title: string;
  single: { name: string; desc: string };
  spread: { name: string; desc: string };
  surcharge: (chf: number) => string;
  tooFew: (empty: number) => string;
  tooMany: (printed: number, max: number) => string;
}> = {
  en: {
    title: 'Page layout',
    single: { name: 'Text in the picture', desc: 'One page per scene, the text sits in the picture.' },
    spread: { name: 'Facing pages', desc: 'Picture on the left page, text on the right page.' },
    surcharge: chf => `+ CHF ${chf}`,
    tooFew: empty => `Not enough pages: this layout would leave ${empty} empty ${empty === 1 ? 'page' : 'pages'}.`,
    tooMany: (printed, max) => `Too many pages: facing pages would need ${printed} printed pages, more than ${max}.`,
  },
  de: {
    title: 'Seitenlayout',
    single: { name: 'Text im Bild', desc: 'Eine Seite pro Szene, der Text steht im Bild.' },
    spread: { name: 'Gegenüberliegende Seiten', desc: 'Bild auf der linken Seite, Text auf der rechten Seite.' },
    surcharge: chf => `+ CHF ${chf}`,
    tooFew: empty => `Zu wenig Seiten: Dieses Layout würde ${empty} leere ${empty === 1 ? 'Seite' : 'Seiten'} ergeben.`,
    tooMany: (printed, max) => `Zu viele Seiten: Gegenüberliegende Seiten würden ${printed} Druckseiten brauchen, mehr als ${max}.`,
  },
  fr: {
    title: 'Mise en page',
    single: { name: 'Texte dans l’image', desc: 'Une page par scène, le texte est placé dans l’image.' },
    spread: { name: 'Pages en regard', desc: 'Image sur la page de gauche, texte sur la page de droite.' },
    surcharge: chf => `+ CHF ${chf}`,
    tooFew: empty => `Pas assez de pages : cette mise en page laisserait ${empty} ${empty === 1 ? 'page vide' : 'pages vides'}.`,
    tooMany: (printed, max) => `Trop de pages : les pages en regard demanderaient ${printed} pages imprimées, plus de ${max}.`,
  },
  it: {
    title: 'Impaginazione',
    single: { name: 'Testo nell’immagine', desc: 'Una pagina per scena, il testo è nell’immagine.' },
    spread: { name: 'Pagine affiancate', desc: 'Immagine sulla pagina sinistra, testo sulla pagina destra.' },
    surcharge: chf => `+ CHF ${chf}`,
    tooFew: empty => `Pagine insufficienti: questo layout lascerebbe ${empty} ${empty === 1 ? 'pagina vuota' : 'pagine vuote'}.`,
    tooMany: (printed, max) => `Troppe pagine: le pagine affiancate richiederebbero ${printed} pagine stampate, più di ${max}.`,
  },
};

interface Props {
  language: string;
  layouts: Record<BookLayout, BookLayoutOption>;
  selected: BookLayout;
  onSelect: (layout: BookLayout) => void;
}

/** Two-card radio: "text in the picture" and "facing pages"; an unavailable card is greyed out and says why. */
export default function BookLayoutPicker({ language, layouts, selected, onSelect }: Props) {
  const t = TEXT[(language as Lang) in TEXT ? (language as Lang) : 'en'];
  const card = (layout: BookLayout) => {
    const opt = layouts[layout];
    const name = t[layout].name;
    const reason = !opt.reason ? null
      : opt.reason.code === 'TOO_FEW_PAGES' ? t.tooFew(opt.reason.emptyPages)
      : t.tooMany(opt.reason.printedPages, opt.reason.maxPages);
    const isSelected = opt.available && selected === layout;
    return (
      <button
        key={layout}
        type="button"
        role="radio"
        aria-checked={isSelected}
        aria-disabled={!opt.available}
        disabled={!opt.available}
        onClick={() => onSelect(layout)}
        data-testid={`book-layout-${layout}`}
        className={`text-left p-3 rounded-xl border-2 transition-all ${
          !opt.available ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-not-allowed'
            : isSelected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-indigo-200'}`}
      >
        <div className="flex items-center justify-between gap-2 font-semibold text-sm">
          <span className={opt.available ? 'text-gray-800' : ''}>{name}</span>
          {opt.available && opt.surchargeChf > 0 && <span className="text-indigo-700">{t.surcharge(opt.surchargeChf)}</span>}
        </div>
        <div className="text-xs mt-1">{t[layout].desc}</div>
        {reason && <div className="text-xs mt-2 font-medium text-gray-600">{reason}</div>}
      </button>
    );
  };
  return (
    <div className="mt-3" role="radiogroup" aria-label={t.title}>
      <div className="text-sm font-semibold text-gray-700 mb-2">{t.title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {card('single')}
        {card('spread')}
      </div>
    </div>
  );
}
