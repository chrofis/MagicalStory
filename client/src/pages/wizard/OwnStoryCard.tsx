import { useEffect, useRef, useState } from 'react';
import { Check, AlertTriangle, CircleCheck, Circle } from 'lucide-react';
import { storyService } from '@/services';
import {
  createOwnStoryChecker,
  OWN_STORY_PARTS,
  type OwnStoryPart,
  type OwnStoryResult,
} from '@/utils/ownStoryCheck';

type Lang = 'en' | 'de' | 'fr' | 'it';
const L = (lang: Lang, de: string, fr: string, it: string, en: string) =>
  lang === 'de' ? de : lang === 'fr' ? fr : lang === 'it' ? it : en;

/** Checklist label and fixed tip per story part. The tip is shown for the first missing part; Jev answers flags only. */
const PARTS: Record<OwnStoryPart, { label: Record<Lang, string>; tip: Record<Lang, string> }> = {
  WHO: {
    label: { de: 'Wer', fr: 'Qui', it: 'Chi', en: 'Who' },
    tip: { de: 'Sag, von wem die Geschichte handelt.', fr: 'Dites de qui parle l\'histoire.', it: 'Di\' di chi parla la storia.', en: 'Say who the story is about.' },
  },
  WHERE: {
    label: { de: 'Wo', fr: 'Où', it: 'Dove', en: 'Where' },
    tip: { de: 'Sag, wo die Geschichte spielt.', fr: 'Dites où se passe l\'histoire.', it: 'Di\' dove si svolge la storia.', en: 'Say where the story happens.' },
  },
  PROBLEM: {
    label: { de: 'Was geht schief', fr: 'Ce qui tourne mal', it: 'Cosa va storto', en: 'What goes wrong' },
    tip: { de: 'Was geht schief? Ein Problem macht die Geschichte spannend.', fr: 'Que se passe-t-il de travers ? Un problème rend l\'histoire passionnante.', it: 'Cosa va storto? Un problema rende la storia avvincente.', en: 'What goes wrong? A problem makes the story exciting.' },
  },
  WANT: {
    label: { de: 'Was die Figur will', fr: 'Ce que veut le personnage', it: 'Cosa vuole il personaggio', en: 'What the character wants' },
    tip: { de: 'Was will oder muss die Hauptfigur erreichen?', fr: 'Que veut ou doit atteindre le personnage principal ?', it: 'Cosa vuole o deve ottenere il protagonista?', en: 'What does the main character want or have to do?' },
  },
  ENDING: {
    label: { de: 'Wie es endet', fr: 'Comment ça finit', it: 'Come finisce', en: 'How it ends' },
    tip: { de: 'Wie soll die Geschichte enden?', fr: 'Comment l\'histoire doit-elle finir ?', it: 'Come deve finire la storia?', en: 'How should the story end?' },
  },
};

interface OwnStoryCardProps {
  lang: Lang;
  text: string;
  onTextChange: (text: string) => void;
  isSelected: boolean;
  onSelect: () => void;
  /** Age of the oldest main character, handed to the check so it can judge what suits the child. */
  age?: number;
  title: string;
  selectedLabel: string;
  useThisLabel: string;
}

/** The third idea card: the parent writes the story idea; Jev says which parts it still lacks. */
export function OwnStoryCard({ lang, text, onTextChange, isSelected, onSelect, age, title, selectedLabel, useThisLabel }: OwnStoryCardProps) {
  const [result, setResult] = useState<OwnStoryResult | null>(null);
  const [failed, setFailed] = useState(false);
  const checkerRef = useRef<ReturnType<typeof createOwnStoryChecker> | null>(null);

  useEffect(() => {
    const checker = createOwnStoryChecker({
      analyse: async (t, a, signal) => (await storyService.analyzeOwnStory({ text: t, age: a }, signal)) as OwnStoryResult,
      onResult: (r) => { setFailed(false); setResult(r); },
      onError: (err) => { console.error('Own-story check failed', err); setFailed(true); },
    });
    checkerRef.current = checker;
    return () => { checker.cancel(); checkerRef.current = null; };
  }, []);

  useEffect(() => { checkerRef.current?.update(text, age); }, [text, age]);

  const firstMissing = result?.missing[0];
  const tip = result
    ? (firstMissing ? PARTS[firstMissing].tip[lang]
      : L(lang, 'Sieht vollständig aus.', 'Cela semble complet.', 'Sembra completa.', 'Looks complete.'))
    : null;

  return (
    <div
      data-testid="own-story-card"
      className={`flex flex-col rounded-xl overflow-hidden transition-all ${
        isSelected ? 'ring-4 ring-green-500 shadow-lg shadow-green-100' : 'ring-1 ring-gray-200 hover:ring-2 hover:ring-indigo-300'
      }`}
    >
      <div className={`px-4 py-2 font-semibold flex items-center justify-between ${isSelected ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-700'}`}>
        <span>{title}</span>
        {isSelected && (
          <span className="flex items-center gap-1 text-sm"><Check size={16} />{selectedLabel}</span>
        )}
      </div>
      <textarea
        data-testid="own-story-text"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        placeholder={L(lang,
          'Schreibe deine Geschichte: wer, wo, was schiefgeht, was die Figur will und wie es endet.',
          'Écrivez votre histoire : qui, où, ce qui tourne mal, ce que veut le personnage et comment ça finit.',
          'Scrivi la tua storia: chi, dove, cosa va storto, cosa vuole il personaggio e come finisce.',
          'Write your story: who, where, what goes wrong, what the character wants and how it ends.')}
        className={`w-full px-4 py-3 border-0 focus:outline-none focus:ring-0 text-base resize-none ${isSelected ? 'bg-green-50' : 'bg-white'}`}
        rows={10}
      />
      {result && (
        <div data-testid="own-story-checklist" className="px-4 py-2 bg-indigo-50 text-indigo-800 text-sm space-y-1">
          <ul className="grid grid-cols-1 gap-0.5">
            {OWN_STORY_PARTS.map(part => (
              <li key={part} data-part={part} data-present={String(result.present[part])} className="flex items-center gap-1.5">
                {result.present[part] ? <CircleCheck size={14} className="text-green-600" /> : <Circle size={14} className="text-gray-400" />}
                <span>{PARTS[part].label[lang]}</span>
              </li>
            ))}
          </ul>
          <p data-testid="own-story-tip" className="font-medium">{tip}</p>
          {result.unsuitable && (
            <p data-testid="own-story-unsuitable" className="flex items-center gap-1.5 text-amber-700">
              <AlertTriangle size={14} />
              {L(lang,
                'Einiges davon passt vielleicht nicht zum Alter der Kinder.',
                'Certains éléments ne conviennent peut-être pas à l\'âge des enfants.',
                'Alcuni elementi potrebbero non adattarsi all\'età dei bambini.',
                'Some of this may not suit the children\'s ages.')}
            </p>
          )}
        </div>
      )}
      {failed && (
        <p data-testid="own-story-failed" className="px-4 py-2 bg-gray-50 text-gray-500 text-xs">
          {L(lang, 'Die Prüfung ist gerade nicht verfügbar.', 'La vérification n\'est pas disponible pour le moment.', 'Il controllo non è al momento disponibile.', 'The check is not available right now.')}
        </p>
      )}
      <button
        data-testid="own-story-select"
        onClick={onSelect}
        disabled={!text.trim()}
        className={`flex items-center justify-center gap-2 px-4 py-3 font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
          isSelected ? 'bg-green-600 text-white cursor-default' : 'bg-indigo-500 text-white hover:bg-indigo-600'
        }`}
      >
        <Check size={18} />
        {isSelected ? selectedLabel : useThisLabel}
      </button>
    </div>
  );
}
