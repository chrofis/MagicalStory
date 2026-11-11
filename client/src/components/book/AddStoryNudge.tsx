import { Plus } from 'lucide-react';
import { ChoiceCard } from './BlankPagesChoice';

// Short-book nudge (decisions.md, short-book layout 2026-10-26): a book with blank pages has
// room for another story, so one of the warning's two actions is adding one (no price change).
// The two action buttons of the warning share this one className (sibling-button rule, CLAUDE.md).
export const BLANK_ACTION_BUTTON_CLASS =
  'bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600';

type Lang = 'en' | 'de' | 'fr' | 'it';
const ADD: Record<Lang, string> = {
  en: 'Add another story',
  de: 'Weitere Geschichte hinzufügen',
  fr: 'Ajouter une autre histoire',
  it: 'Aggiungi un’altra storia',
};

interface Props {
  /** Button text; defaults to the built-in translation for `language`. */
  label?: string;
  language?: string;
  onAdd: () => void;
  busy?: boolean;
  /** Render as an (unselected) option card of the either/or choice instead of a button. */
  asChoice?: boolean;
}

/** "Add another story" button for the blank-pages warning. */
export default function AddStoryNudge({ label, language, onAdd, busy = false, asChoice = false }: Props) {
  const text = label ?? ADD[(language as Lang) in ADD ? (language as Lang) : 'en'];
  if (asChoice) {
    return <ChoiceCard checked={false} onSelect={onAdd} disabled={busy} testId="add-story-nudge">{text}</ChoiceCard>;
  }
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={busy}
      data-testid="add-story-nudge"
      className={BLANK_ACTION_BUTTON_CLASS}
    >
      <Plus size={16} />
      {text}
    </button>
  );
}
