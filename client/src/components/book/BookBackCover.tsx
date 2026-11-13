import { useEffect, useState } from 'react';
import { storyService } from '@/services';
import { createLogger } from '@/services/logger';
import { localizedApiError } from '@/utils/apiErrors';

const log = createLogger('BookBackCover');

// A printed book has a back cover. A story made before full stories drew one gets it made here, BEFORE the customer orders
// (server/lib/backCoverMaker.js, paid by us, about a minute the first time). The server decides whether this book needs one
// (backCoverTarget); this box only shows the wait or the error, and the order button waits until it reports ready.
// docs/decisions.md 2026-11-12 "Printed books make a missing back cover".
type Lang = 'en' | 'de' | 'fr' | 'it';

const TEXT: Record<Lang, { making: string; failed: string; retry: string }> = {
  en: { making: 'Preparing the back cover of your book, this can take about a minute…', failed: 'The back cover could not be made.', retry: 'Try again' },
  de: { making: 'Die Rückseite deines Buchs wird vorbereitet, das kann etwa eine Minute dauern…', failed: 'Die Rückseite konnte nicht erstellt werden.', retry: 'Erneut versuchen' },
  fr: { making: 'Préparation de la quatrième de couverture de votre livre, cela peut prendre environ une minute…', failed: 'La quatrième de couverture n’a pas pu être créée.', retry: 'Réessayer' },
  it: { making: 'Preparazione del retro di copertina del tuo libro, può richiedere circa un minuto…', failed: 'Non è stato possibile creare il retro di copertina.', retry: 'Riprova' },
};

interface Props {
  language: string;
  stories: { id: string }[];
  /** Called with true once the book has its back cover (or needs none), false while it is made or after a failure. */
  onReadyChange: (ready: boolean) => void;
}

export default function BookBackCover({ language, stories, onReadyChange }: Props) {
  const t = TEXT[(language as Lang) in TEXT ? (language as Lang) : 'en'];
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorText, setErrorText] = useState('');
  const [attempt, setAttempt] = useState(0);
  const idsKey = stories.map(s => s.id).join(',');

  useEffect(() => {
    if (!idsKey) { onReadyChange(true); return; }
    let cancelled = false;
    onReadyChange(false);
    setStatus('loading');
    const ids = idsKey.split(',');
    storyService.ensureBackCover(ids[0], ids)
      .then(() => {
        if (cancelled) return;
        setStatus('ready');
        onReadyChange(true);
      })
      .catch(err => {
        log.error('Back cover failed:', err);
        if (cancelled) return;
        setErrorText(localizedApiError(err, language));
        setStatus('error');
      });
    return () => { cancelled = true; };
    // onReadyChange is a state setter from the page; it must not restart the paid call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, attempt]);

  if (status === 'ready') return null;
  return (
    <div className="mt-3 p-3 bg-white border border-gray-200 rounded-lg" data-testid="book-back-cover">
      {status === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-gray-600" data-testid="book-back-cover-loading">
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-indigo-600 border-t-transparent" />
          {t.making}
        </div>
      )}
      {status === 'error' && (
        <div className="text-sm text-red-700" data-testid="book-back-cover-error">
          <p>{t.failed} {errorText}</p>
          <button type="button" onClick={() => setAttempt(a => a + 1)} className="mt-1 underline text-indigo-600 hover:text-indigo-800">{t.retry}</button>
        </div>
      )}
    </div>
  );
}
