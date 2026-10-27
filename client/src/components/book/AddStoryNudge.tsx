import { Plus } from 'lucide-react';

type Lang = 'en' | 'de' | 'fr' | 'it';

// Short-book nudge (decisions.md, short-book layout 2026-10-26): a book with blank pages has
// room for another story, so the warning's main action is adding one.
const TEXT: Record<Lang, { add: string; spreadNote: string }> = {
  en: {
    add: 'Add another story',
    spreadNote: 'Stories are printed with the picture on one page and the text on the facing page.',
  },
  de: {
    add: 'Weitere Geschichte hinzufügen',
    spreadNote: 'Geschichten werden mit dem Bild auf einer Seite und dem Text auf der gegenüberliegenden Seite gedruckt.',
  },
  fr: {
    add: 'Ajouter une autre histoire',
    spreadNote: 'Les histoires sont imprimées avec l’image sur une page et le texte sur la page en face.',
  },
  it: {
    add: 'Aggiungi un’altra storia',
    spreadNote: 'Le storie vengono stampate con l’immagine su una pagina e il testo sulla pagina a fronte.',
  },
};

interface Props {
  language: string;
  /** 'spread' adds the one-line note that explains the picture/text page layout. */
  layout: 'single' | 'spread';
  onAdd: () => void;
  busy?: boolean;
}

/** Primary "Add another story" button for the blank-pages warning, plus the spread-layout note. */
export default function AddStoryNudge({ language, layout, onAdd, busy = false }: Props) {
  const t = TEXT[(language as Lang) in TEXT ? (language as Lang) : 'en'];
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onAdd}
        disabled={busy}
        data-testid="add-story-nudge"
        className="bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600 disabled:opacity-60"
      >
        <Plus size={16} />
        {t.add}
      </button>
      {layout === 'spread' && <p className="text-xs text-gray-600 mt-2">{t.spreadNote}</p>}
    </div>
  );
}
