import { useEffect, useState } from 'react';
import { storyService } from '@/services';
import { createLogger } from '@/services/logger';
import { localizedApiError } from '@/utils/apiErrors';

const log = createLogger('BookSquareCovers');

// A SQUARE book (the mini book, or the facing-pages exception) prints square versions of the covers and the
// dedication page. They are made once per cover (about 10 seconds, server/lib/squareCovers.js) and shown here
// BEFORE payment, so the customer sees what will be printed. The order button stays off until they are ready.
// docs/decisions.md 2026-10-28 "Square covers".
type Lang = 'en' | 'de' | 'fr' | 'it';
type CoverKey = 'frontCover' | 'backCover' | 'initialPage';
const COVER_ORDER: CoverKey[] = ['frontCover', 'backCover', 'initialPage'];

const TEXT: Record<Lang, { title: string; making: string; failed: string; retry: string; front: string; back: string; dedication: string }> = {
  en: { title: 'Your square book covers', making: 'Preparing the square covers, this takes about 10 seconds…', failed: 'The square covers could not be made.', retry: 'Try again', front: 'Front cover', back: 'Back cover', dedication: 'Dedication page' },
  de: { title: 'Die Umschläge deines quadratischen Buchs', making: 'Die quadratischen Umschläge werden vorbereitet, das dauert etwa 10 Sekunden…', failed: 'Die quadratischen Umschläge konnten nicht erstellt werden.', retry: 'Erneut versuchen', front: 'Vorderseite', back: 'Rückseite', dedication: 'Widmungsseite' },
  fr: { title: 'Les couvertures de votre livre carré', making: 'Préparation des couvertures carrées, environ 10 secondes…', failed: 'Les couvertures carrées n’ont pas pu être créées.', retry: 'Réessayer', front: 'Couverture', back: 'Quatrième de couverture', dedication: 'Page de dédicace' },
  it: { title: 'Le copertine del tuo libro quadrato', making: 'Preparazione delle copertine quadrate, circa 10 secondi…', failed: 'Non è stato possibile creare le copertine quadrate.', retry: 'Riprova', front: 'Copertina', back: 'Retro di copertina', dedication: 'Pagina della dedica' },
};

interface Props {
  language: string;
  /** True when the resolved layout is the square one (layout === 'spread'). */
  active: boolean;
  stories: { id: string; title: string }[];
  /** Called with true once every story's square covers exist, false while they are made or after a failure. */
  onReadyChange: (ready: boolean) => void;
}

type Covers = Record<string, Partial<Record<CoverKey, string>>>;

export default function BookSquareCovers({ language, active, stories, onReadyChange }: Props) {
  const t = TEXT[(language as Lang) in TEXT ? (language as Lang) : 'en'];
  const [covers, setCovers] = useState<Covers>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState('');
  const [attempt, setAttempt] = useState(0);
  const idsKey = stories.map(s => s.id).join(',');

  useEffect(() => {
    if (!active || !idsKey) { onReadyChange(true); return; }
    let cancelled = false;
    onReadyChange(false);
    setStatus('loading');
    Promise.all(idsKey.split(',').map(id => storyService.makeSquareCovers(id).then(r => [id, r.covers] as const)))
      .then(entries => {
        if (cancelled) return;
        setCovers(Object.fromEntries(entries));
        setStatus('ready');
        onReadyChange(true);
      })
      .catch(err => {
        log.error('Square covers failed:', err);
        if (cancelled) return;
        setErrorText(localizedApiError(err, language));
        setStatus('error');
      });
    return () => { cancelled = true; };
    // onReadyChange is a state setter from the page; it must not restart the paid call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, idsKey, attempt]);

  if (!active) return null;
  const label: Record<CoverKey, string> = { frontCover: t.front, backCover: t.back, initialPage: t.dedication };
  return (
    <div className="mt-3 p-3 bg-white border border-gray-200 rounded-lg" data-testid="book-square-covers">
      <div className="text-sm font-semibold text-gray-700 mb-2">{t.title}</div>
      {status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-gray-600" data-testid="book-square-covers-loading">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-indigo-600 border-t-transparent" />
          {t.making}
        </div>
      )}
      {status === 'error' && (
        <div className="text-sm text-red-700">
          <p>{t.failed} {errorText}</p>
          <button type="button" onClick={() => setAttempt(a => a + 1)} className="mt-1 underline text-indigo-600 hover:text-indigo-800">{t.retry}</button>
        </div>
      )}
      {status === 'ready' && stories.map(s => (
        <div key={s.id} className="mb-2 last:mb-0">
          {stories.length > 1 && <div className="text-xs text-gray-500 mb-1 truncate">{s.title}</div>}
          <div className="grid grid-cols-3 gap-2">
            {COVER_ORDER.filter(k => covers[s.id]?.[k]).map(k => (
              <figure key={k}>
                <img src={covers[s.id]![k]} alt={label[k]} className="w-full aspect-square object-cover rounded border border-gray-200" />
                <figcaption className="text-xs text-gray-500 mt-1 text-center">{label[k]}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
