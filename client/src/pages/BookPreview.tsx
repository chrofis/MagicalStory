import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { storyService, type BookLayout, type BookPreviewManifest, type BookPreviewState } from '@/services/storyService';
import { createLogger } from '@/services/logger';
import { localizedApiError } from '@/utils/apiErrors';
import { buildSpreads } from '@/utils/bookSpreads';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

const log = createLogger('BookPreview');

// Full-screen page-flip viewer of the PRINTED book: the server builds the print PDF (the same function the paid order uses)
// and returns one image per PDF page; this page only lays them out as spreads. docs/decisions.md 2026-10-28 "Book preview".
type Lang = 'en' | 'de' | 'fr' | 'it';
const TEXT: Record<Lang, {
  title: string; preparing: string; covers: string; painting: string; rendering: (done: number, total: number) => string;
  failed: string; retry: string; prev: string; next: string; cover: string; spread: (n: number, total: number) => string;
  badLink: string;
}> = {
  en: {
    title: 'Book preview', preparing: 'Getting your book ready…', covers: 'Preparing the square covers…',
    painting: 'Painting the text pages exactly as they will be printed. The first time takes 1 to 2 minutes, please keep this tab open.',
    rendering: (d, t) => (t ? `Rendering the pages (${d} of ${t})…` : 'Rendering the pages…'),
    failed: 'The preview could not be prepared.', retry: 'Try again', prev: 'Back', next: 'Next', cover: 'Cover (back, spine, front)',
    spread: (n, t) => `Spread ${n} of ${t}`, badLink: 'This preview link is incomplete.',
  },
  de: {
    title: 'Buchvorschau', preparing: 'Dein Buch wird vorbereitet…', covers: 'Die quadratischen Umschläge werden vorbereitet…',
    painting: 'Die Textseiten werden genau so gemalt, wie sie gedruckt werden. Beim ersten Mal dauert das 1 bis 2 Minuten, bitte lass diesen Tab offen.',
    rendering: (d, t) => (t ? `Die Seiten werden gerendert (${d} von ${t})…` : 'Die Seiten werden gerendert…'),
    failed: 'Die Vorschau konnte nicht erstellt werden.', retry: 'Erneut versuchen', prev: 'Zurück', next: 'Weiter', cover: 'Umschlag (Rückseite, Rücken, Vorderseite)',
    spread: (n, t) => `Doppelseite ${n} von ${t}`, badLink: 'Dieser Vorschau-Link ist unvollständig.',
  },
  fr: {
    title: 'Aperçu du livre', preparing: 'Préparation de votre livre…', covers: 'Préparation des couvertures carrées…',
    painting: 'Les pages de texte sont peintes exactement comme elles seront imprimées. La première fois, comptez 1 à 2 minutes et gardez cet onglet ouvert.',
    rendering: (d, t) => (t ? `Création des pages (${d} sur ${t})…` : 'Création des pages…'),
    failed: 'L’aperçu n’a pas pu être préparé.', retry: 'Réessayer', prev: 'Précédent', next: 'Suivant', cover: 'Couverture (dos, tranche, face)',
    spread: (n, t) => `Double page ${n} sur ${t}`, badLink: 'Ce lien d’aperçu est incomplet.',
  },
  it: {
    title: 'Anteprima del libro', preparing: 'Preparazione del tuo libro…', covers: 'Preparazione delle copertine quadrate…',
    painting: 'Le pagine di testo vengono dipinte esattamente come saranno stampate. La prima volta ci vogliono 1 o 2 minuti, tieni aperta questa scheda.',
    rendering: (d, t) => (t ? `Creazione delle pagine (${d} di ${t})…` : 'Creazione delle pagine…'),
    failed: 'Non è stato possibile preparare l’anteprima.', retry: 'Riprova', prev: 'Indietro', next: 'Avanti', cover: 'Copertina (retro, dorso, fronte)',
    spread: (n, t) => `Doppia pagina ${n} di ${t}`, badLink: 'Questo link all’anteprima è incompleto.',
  },
};

const POLL_MS = 2500;
const SWIPE_PX = 50;
const isLayout = (v: string | null): v is BookLayout => v === 'single' || v === 'spread';
const isCover = (v: string | null): v is 'softcover' | 'hardcover' => v === 'softcover' || v === 'hardcover';

export default function BookPreview() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const [params] = useSearchParams();
  const t = TEXT[(language as Lang) in TEXT ? (language as Lang) : 'en'];

  const storyIds = useMemo(() => (params.get('stories') || '').split(',').filter(Boolean), [params]);
  const layout = params.get('layout');
  const cover = params.get('cover');
  const linkOk = storyIds.length > 0 && isLayout(layout) && isCover(cover);

  const [state, setState] = useState<BookPreviewState | null>(null);
  const [errorText, setErrorText] = useState('');
  const [attempt, setAttempt] = useState(0);        // bumped by "Try again"
  const retryNext = useRef(false);
  const [index, setIndex] = useState(0);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => { document.title = t.title; }, [t.title]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!isAuthenticated) {
      navigate(`/?login=true&redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`, { replace: true });
    }
  }, [isAuthenticated, isAuthLoading, navigate]);

  // Start-or-poll until ready or error (the endpoint is idempotent, a reload simply joins or reads the stored preview).
  useEffect(() => {
    if (!linkOk || !isAuthenticated) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const retry = retryNext.current;
        retryNext.current = false;
        const s = await storyService.requestBookPreview(storyIds, layout as BookLayout, cover as 'softcover' | 'hardcover', retry);
        if (cancelled) return;
        setState(s);
        if (s.state === 'running') timer = setTimeout(tick, POLL_MS);
        if (s.state === 'error') log.error('Book preview failed:', s.error);
      } catch (err) {
        log.error('Book preview request failed:', err);
        if (cancelled) return;
        setErrorText(localizedApiError(err, language));
        setState({ state: 'error', error: String(err) });
      }
    };
    setState(null);
    setErrorText('');
    tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [linkOk, isAuthenticated, storyIds, layout, cover, attempt, language]);

  const manifest: BookPreviewManifest | null = state?.state === 'ready' ? state.manifest : null;
  const spreads = useMemo(() => (manifest ? buildSpreads(manifest.pages.length) : []), [manifest]);
  const last = spreads.length - 1;

  const go = useCallback((delta: number) => setIndex(i => Math.min(Math.max(i + delta, 0), Math.max(0, last))), [last]);

  useEffect(() => {
    if (!manifest) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manifest, go]);

  if (isAuthLoading || !isAuthenticated) return <LoadingSpinner fullScreen />;
  if (!linkOk) return <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center px-4">{t.badLink}</div>;

  const stageText = (s: BookPreviewState | null) => {
    if (!s || s.state !== 'running') return t.preparing;
    if (s.stage === 'covers') return t.covers;
    if (s.stage === 'painting') return t.painting;
    if (s.stage === 'rendering') return t.rendering(s.done, s.total);
    return t.preparing;
  };

  if (!manifest) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center px-4 text-center gap-4" data-testid="book-preview-wait">
        {state?.state === 'error' ? (
          <>
            <p className="text-lg text-red-300" data-testid="book-preview-error">{t.failed} {errorText}</p>
            <button
              type="button"
              onClick={() => { retryNext.current = true; setAttempt(a => a + 1); }}
              className="bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600"
            >
              {t.retry}
            </button>
          </>
        ) : (
          <>
            <div className="animate-spin rounded-full h-10 w-10 border-4 border-indigo-400 border-t-transparent" />
            <p className="max-w-md" aria-live="polite">{stageText(state)}</p>
          </>
        )}
      </div>
    );
  }

  const spread = spreads[Math.min(index, last)];
  const isCoverSpread = spread.length === 1 && spread[0] === 0;
  return (
    <div
      className="fixed inset-0 bg-gray-900 flex flex-col"
      data-testid="book-preview"
      onTouchStart={e => { touchStartX.current = e.touches[0].clientX; }}
      onTouchEnd={e => {
        const x0 = touchStartX.current;
        touchStartX.current = null;
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) >= SWIPE_PX) go(dx < 0 ? 1 : -1);
      }}
    >
      <div className="flex-1 min-h-0 flex items-center justify-center p-2 sm:p-4" aria-label={isCoverSpread ? t.cover : undefined}>
        <div className="flex items-center justify-center shadow-2xl max-h-full max-w-full" data-testid="book-preview-spread">
          {spread.map(pi => {
            const p = manifest.pages[pi];
            return (
              <img
                key={pi}
                src={p.url}
                alt={isCoverSpread ? t.cover : `${t.spread(index + 1, spreads.length)}`}
                width={p.width}
                height={p.height}
                draggable={false}
                className="block min-w-0 object-contain select-none"
                style={{ maxHeight: 'calc(100dvh - 76px)', maxWidth: `${isCoverSpread ? 96 : 48}vw`, height: 'auto', width: 'auto' }}
              />
            );
          })}
        </div>
      </div>
      <div className="shrink-0 flex items-center justify-center gap-3 px-3 py-3 bg-gray-800">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index <= 0}
          className="bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={16} />
          {t.prev}
        </button>
        <span className="text-sm text-gray-200 min-w-[8rem] text-center" data-testid="book-preview-counter">
          {t.spread(index + 1, spreads.length)}
        </span>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={index >= last}
          className="bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t.next}
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}
