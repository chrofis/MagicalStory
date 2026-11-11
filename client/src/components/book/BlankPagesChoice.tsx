import type { ReactNode } from 'react';

// The blank-pages decision is an either/or choice (print with blank pages, or add a story), shown as two option cards
// with radio indicators. ChoiceCard is the one card style for both; BlankPagesChoice is the "print with N blank pages"
// card, used both in the warning box and above the order button, bound to the same blankAck state.
// docs/decisions.md 2026-11-11 "Blank pages: either/or choice".
interface CardProps {
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
  testId?: string;
  disabled?: boolean;
}

export function ChoiceCard({ checked, onSelect, children, testId, disabled }: CardProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      data-testid={testId}
      onClick={onSelect}
      className={`w-full min-h-[3.25rem] flex items-center gap-3 px-3 py-2 rounded-lg border-2 bg-white text-left text-sm font-semibold text-gray-800 transition-colors disabled:opacity-60 ${
        checked ? 'border-indigo-500' : 'border-gray-300 hover:border-gray-400'
      }`}
    >
      <span
        className={`flex-shrink-0 h-5 w-5 rounded-full border-2 flex items-center justify-center ${
          checked ? 'border-indigo-500' : 'border-gray-400'
        }`}
        aria-hidden="true"
      >
        {checked && <span className="h-2.5 w-2.5 rounded-full bg-indigo-500" />}
      </span>
      <span className="flex items-center gap-1.5">{children}</span>
    </button>
  );
}

interface Props {
  label: string;
  blankAck: boolean;
  onChange: (value: boolean) => void;
  testId?: string;
}

export default function BlankPagesChoice({ label, blankAck, onChange, testId = 'blank-pages-choice' }: Props) {
  return <ChoiceCard checked={blankAck} onSelect={() => onChange(true)} testId={testId}>{label}</ChoiceCard>;
}
