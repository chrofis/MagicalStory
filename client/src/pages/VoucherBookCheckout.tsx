import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Book, BookOpen, Info, Loader2, ShoppingCart } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useLangPath } from '@/hooks/useLangPath';
import { Navigation, LoadingSpinner } from '@/components/common';
import BlankPagesPreview from '@/components/book/BlankPagesPreview';
import AddStoryNudge from '@/components/book/AddStoryNudge';
import { storyService } from '@/services';
import type { BookPageInfo, VoucherBookCredit } from '@/services/storyService';
import { createLogger } from '@/services/logger';
import { localizedApiError } from '@/utils/apiErrors';
import { VOUCHER_BOOK_MAX_PAGES, VOUCHER_HARDCOVER_SURCHARGE_CHF } from '@/constants/voucher';

const log = createLogger('VoucherBookCheckout');

interface PickableStory {
  id: string;
  title: string;
  pages: number;
}

const texts = {
  en: {
    docTitle: 'Your voucher book | Magical Story',
    title: 'Your voucher book',
    subtitle: 'Choose the stories for your printed book. Shipping within Switzerland is included.',
    notAvailable: 'You have no voucher book to order right now.',
    redeemLink: 'Redeem a voucher',
    cancelled: 'The order was cancelled. Nothing was charged.',
    storiesTitle: 'Stories in your book',
    noStories: 'You have no finished stories yet.',
    createStory: 'Create a story',
    pages: 'pages',
    pageCount: (n: number, max: number) => `${n} of ${max} pages`,
    tooLong: (max: number) => `A voucher book can have at most ${max} pages. Please remove a story.`,
    coverTitle: 'Cover',
    softcover: 'Softcover',
    softcoverPrice: 'free',
    hardcover: 'Hardcover',
    hardcoverPrice: (chf: string) => `+ CHF ${chf}`,
    size: '21 × 28 cm',
    blankPagesTitle: 'Your book has room for another story',
    blankPagesDesc: (printed: number, content: number, blank: number) => `Your book has ${printed} pages. Your stories fill ${content} of them, ${blank} ${blank === 1 ? 'page' : 'pages'} will stay blank.`,
    blankPreviewTitle: 'Your printed book',
    blankPreviewSummary: (f: number, p: number, b: number) => `${f} of ${p} pages filled, ${b} blank`,
    blankLegendFilled: 'Page with content',
    blankLegendBlank: 'Blank page',
    blankAck: (b: number) => `I understand that my book has ${b} blank ${b === 1 ? 'page' : 'pages'}`,
    totalLabel: 'To pay now',
    free: 'CHF 0.00',
    addressHint: 'You enter the delivery address in the next step.',
    order: 'Order book',
    processing: 'Processing…',
  },
  de: {
    docTitle: 'Dein Gutschein-Buch | Magical Story',
    title: 'Dein Gutschein-Buch',
    subtitle: 'Wähle die Geschichten für dein gedrucktes Buch. Der Versand innerhalb der Schweiz ist inklusive.',
    notAvailable: 'Du hast im Moment kein Gutschein-Buch offen.',
    redeemLink: 'Gutschein einlösen',
    cancelled: 'Die Bestellung wurde abgebrochen. Es wurde nichts abgebucht.',
    storiesTitle: 'Geschichten in deinem Buch',
    noStories: 'Du hast noch keine fertigen Geschichten.',
    createStory: 'Geschichte erstellen',
    pages: 'Seiten',
    pageCount: (n: number, max: number) => `${n} von ${max} Seiten`,
    tooLong: (max: number) => `Ein Gutschein-Buch darf höchstens ${max} Seiten haben. Bitte entferne eine Geschichte.`,
    coverTitle: 'Einband',
    softcover: 'Softcover',
    softcoverPrice: 'gratis',
    hardcover: 'Hardcover',
    hardcoverPrice: (chf: string) => `+ CHF ${chf}`,
    size: '21 × 28 cm',
    blankPagesTitle: 'In deinem Buch ist Platz für eine weitere Geschichte',
    blankPagesDesc: (printed: number, content: number, blank: number) => `Dein Buch hat ${printed} Seiten. Deine Geschichten füllen ${content} davon, ${blank} ${blank === 1 ? 'Seite bleibt' : 'Seiten bleiben'} leer.`,
    blankPreviewTitle: 'Dein gedrucktes Buch',
    blankPreviewSummary: (f: number, p: number, b: number) => `${f} von ${p} Seiten gefüllt, ${b} leer`,
    blankLegendFilled: 'Seite mit Inhalt',
    blankLegendBlank: 'Leere Seite',
    blankAck: (b: number) => `Ich habe verstanden, dass mein Buch ${b} ${b === 1 ? 'leere Seite' : 'leere Seiten'} hat`,
    totalLabel: 'Jetzt zu bezahlen',
    free: 'CHF 0.00',
    addressHint: 'Die Lieferadresse gibst du im nächsten Schritt ein.',
    order: 'Buch bestellen',
    processing: 'Wird verarbeitet…',
  },
  fr: {
    docTitle: 'Votre livre du bon cadeau | Magical Story',
    title: 'Votre livre du bon cadeau',
    subtitle: 'Choisissez les histoires de votre livre imprimé. La livraison en Suisse est incluse.',
    notAvailable: "Vous n'avez actuellement aucun livre de bon cadeau à commander.",
    redeemLink: 'Utiliser un bon cadeau',
    cancelled: "La commande a été annulée. Rien n'a été débité.",
    storiesTitle: 'Histoires de votre livre',
    noStories: "Vous n'avez pas encore d'histoire terminée.",
    createStory: 'Créer une histoire',
    pages: 'pages',
    pageCount: (n: number, max: number) => `${n} sur ${max} pages`,
    tooLong: (max: number) => `Le livre d'un bon cadeau peut compter ${max} pages au maximum. Veuillez retirer une histoire.`,
    coverTitle: 'Couverture',
    softcover: 'Couverture souple',
    softcoverPrice: 'gratuite',
    hardcover: 'Couverture rigide',
    hardcoverPrice: (chf: string) => `+ CHF ${chf}`,
    size: '21 × 28 cm',
    blankPagesTitle: 'Votre livre a de la place pour une autre histoire',
    blankPagesDesc: (printed: number, content: number, blank: number) => `Votre livre compte ${printed} pages. Vos histoires en remplissent ${content}, ${blank} ${blank === 1 ? 'page restera vierge' : 'pages resteront vierges'}.`,
    blankPreviewTitle: 'Votre livre imprimé',
    blankPreviewSummary: (f: number, p: number, b: number) => `${f} pages sur ${p} remplies, ${b} ${b === 1 ? 'vierge' : 'vierges'}`,
    blankLegendFilled: 'Page avec contenu',
    blankLegendBlank: 'Page vierge',
    blankAck: (b: number) => `Je comprends que mon livre contient ${b} ${b === 1 ? 'page vierge' : 'pages vierges'}`,
    totalLabel: 'À payer maintenant',
    free: 'CHF 0.00',
    addressHint: "Vous saisissez l'adresse de livraison à l'étape suivante.",
    order: 'Commander le livre',
    processing: 'Traitement en cours…',
  },
  it: {
    docTitle: 'Il tuo libro del buono | Magical Story',
    title: 'Il tuo libro del buono',
    subtitle: 'Scegli le storie per il tuo libro stampato. La spedizione in Svizzera è inclusa.',
    notAvailable: 'Al momento non hai nessun libro del buono da ordinare.',
    redeemLink: 'Riscatta un buono regalo',
    cancelled: "L'ordine è stato annullato. Non è stato addebitato nulla.",
    storiesTitle: 'Storie nel tuo libro',
    noStories: 'Non hai ancora storie completate.',
    createStory: 'Crea una storia',
    pages: 'pagine',
    pageCount: (n: number, max: number) => `${n} di ${max} pagine`,
    tooLong: (max: number) => `Il libro di un buono può avere al massimo ${max} pagine. Rimuovi una storia.`,
    coverTitle: 'Copertina',
    softcover: 'Copertina morbida',
    softcoverPrice: 'gratis',
    hardcover: 'Copertina rigida',
    hardcoverPrice: (chf: string) => `+ CHF ${chf}`,
    size: '21 × 28 cm',
    blankPagesTitle: 'Nel tuo libro c’è spazio per un’altra storia',
    blankPagesDesc: (printed: number, content: number, blank: number) => `Il tuo libro ha ${printed} pagine. Le tue storie ne riempiono ${content}, ${blank} ${blank === 1 ? 'pagina resterà vuota' : 'pagine resteranno vuote'}.`,
    blankPreviewTitle: 'Il tuo libro stampato',
    blankPreviewSummary: (f: number, p: number, b: number) => `${f} pagine su ${p} riempite, ${b} ${b === 1 ? 'vuota' : 'vuote'}`,
    blankLegendFilled: 'Pagina con contenuto',
    blankLegendBlank: 'Pagina vuota',
    blankAck: (b: number) => `Ho capito che il mio libro ha ${b} ${b === 1 ? 'pagina vuota' : 'pagine vuote'}`,
    totalLabel: 'Da pagare ora',
    free: 'CHF 0.00',
    addressHint: "L'indirizzo di consegna lo inserisci nel passaggio successivo.",
    order: 'Ordina il libro',
    processing: 'Elaborazione...',
  },
};

export default function VoucherBookCheckout() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const lp = useLangPath();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  const t = texts[language as keyof typeof texts] || texts.en;

  const [credit, setCredit] = useState<VoucherBookCredit | null>(null);
  const [stories, setStories] = useState<PickableStory[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [coverType, setCoverType] = useState<'softcover' | 'hardcover'>('softcover');
  const [pageInfo, setPageInfo] = useState<BookPageInfo | null>(null);
  const [blankAck, setBlankAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const maxPages = credit?.maxPages ?? VOUCHER_BOOK_MAX_PAGES;
  const surchargeChf = ((credit?.hardcoverSurchargeCents ?? VOUCHER_HARDCOVER_SURCHARGE_CHF * 100) / 100).toFixed(2);
  const bookFormat = 'A4' as const;

  useEffect(() => { document.title = t.docTitle; }, [t.docTitle]);

  const loadCredit = () => storyService.getVoucherBookCredit().then(setCredit);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!isAuthenticated) {
      navigate(`/?login=true&redirect=${encodeURIComponent('/gutschein/buch')}`, { replace: true });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const c = await storyService.getVoucherBookCredit();
        if (cancelled) return;
        setCredit(c);
        if (c.available) {
          const { stories: list } = await storyService.getStories({ limit: 100 });
          if (cancelled) return;
          setStories(list.filter(s => !s.isPartial && s.pages > 0).map(s => ({ id: s.id, title: s.title, pages: s.pages })));
        }
      } catch (err) {
        log.error('Failed to load voucher book credit:', err);
        if (!cancelled) setError(localizedApiError(err, language));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAuthenticated, isAuthLoading, navigate, language]);

  // Story-list page sum: quick pre-check only. The server's contentPages (same function the order
  // uses) is the number that counts, exactly like BookBuilder.
  const listedPages = useMemo(
    () => stories.filter(s => selected.includes(s.id)).reduce((sum, s) => sum + s.pages, 0),
    [stories, selected],
  );

  const selectedKey = selected.join(',');
  useEffect(() => {
    if (!selectedKey) { setPageInfo(null); return; }
    let cancelled = false;
    storyService.getBookPageInfo(selectedKey.split(','), coverType, bookFormat)
      .then(info => { if (!cancelled) setPageInfo(info); })
      .catch(err => {
        log.error('Failed to fetch book page info:', err);
        if (!cancelled) { setPageInfo(null); setError(localizedApiError(err, language)); }
      });
    return () => { cancelled = true; };
  }, [selectedKey, coverType, language]);

  const pageCount = pageInfo?.contentPages ?? listedPages;
  const isTooLong = pageCount > maxPages;
  const needsBlankAck = !!pageInfo && !isTooLong && pageInfo.blankPages >= pageInfo.blankAckFrom;
  useEffect(() => { setBlankAck(false); }, [pageInfo?.blankPages, selectedKey]);

  // "Add another story": the picker is this page's own story list. Unselected stories exist ->
  // scroll to the list; otherwise the user has none left, so go to the story wizard.
  const handleAddStory = () => {
    if (stories.some(s => !selected.includes(s.id))) {
      document.getElementById('voucher-story-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      navigate(lp('/create'));
    }
  };

  const toggle = (id: string) => {
    setError('');
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const canOrder = selected.length > 0 && !!pageInfo && !isTooLong && !busy && (!needsBlankAck || blankAck);

  const handleOrder = async () => {
    if (!canOrder) return;
    setBusy(true);
    setError('');
    try {
      const { url } = await storyService.createVoucherBookCheckout({
        storyIds: selected,
        coverType,
        bookFormat,
        blankPagesAcknowledged: needsBlankAck ? true : undefined,
      });
      // Stay disabled while the browser navigates to Stripe; only a failure re-enables.
      window.location.href = url;
    } catch (err) {
      setBusy(false);
      setError(localizedApiError(err, language));
      const code = (err as { code?: string } | null)?.code;
      if (code === 'VOUCHER_BOOK_ALREADY_USED' || code === 'VOUCHER_BOOK_NOT_AVAILABLE') {
        loadCredit().catch(() => { /* the message above already explains */ });
      }
    }
  };

  if (isAuthLoading || !isAuthenticated || loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Navigation currentStep={0} />
        <LoadingSpinner />
      </div>
    );
  }

  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6';
  const coverCard = (type: 'softcover' | 'hardcover', icon: React.ReactNode, label: string, price: string) => (
    <button
      type="button"
      onClick={() => setCoverType(type)}
      className={`text-left p-4 rounded-xl border-2 transition-all ${coverType === type ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:border-indigo-200'}`}
    >
      <div className="flex items-center gap-2 mb-1 text-gray-800 font-semibold">{icon}{label}</div>
      <div className="text-xs text-gray-500 mb-2">{t.size}</div>
      <div className="font-bold text-indigo-700">{price}</div>
    </button>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />
      <div className="px-4 md:px-8 py-8 max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-3">{t.title}</h1>
          <p className="text-lg text-gray-600">{t.subtitle}</p>
        </div>

        {searchParams.get('payment') === 'cancelled' && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 mb-6 text-sm">{t.cancelled}</div>
        )}
        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-6 text-sm">{error}</div>}

        {!credit?.available ? (
          <section className={`${card} text-center`}>
            <Book className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-700 mb-4">{t.notAvailable}</p>
            <Link
              to={lp('/gutschein/einloesen')}
              className="inline-flex bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold items-center justify-center gap-1.5 hover:bg-indigo-600"
            >
              {t.redeemLink}
            </Link>
          </section>
        ) : (
          <>
            <section className={card}>
              <h2 id="voucher-story-list" className="text-xl font-bold text-gray-800 mb-3">{t.storiesTitle}</h2>
              {stories.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-gray-500 mb-3">{t.noStories}</p>
                  <Link
                    to={lp('/create')}
                    className="inline-flex bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold items-center justify-center gap-1.5 hover:bg-indigo-600"
                  >
                    {t.createStory}
                  </Link>
                </div>
              ) : (
                <div className="space-y-2">
                  {stories.map(s => (
                    <label
                      key={s.id}
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${selected.includes(s.id) ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200'}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.includes(s.id)}
                        onChange={() => toggle(s.id)}
                        className="w-4 h-4 accent-indigo-500"
                      />
                      <span className="flex-1 min-w-0 font-medium text-gray-800 truncate">{s.title}</span>
                      <span className="text-sm text-gray-500 shrink-0">{s.pages} {t.pages}</span>
                    </label>
                  ))}
                </div>
              )}
              {selected.length > 0 && (
                <div className={`mt-3 text-sm font-medium ${isTooLong ? 'text-red-700' : 'text-gray-700'}`}>
                  {t.pageCount(pageCount, maxPages)}
                </div>
              )}
              {isTooLong && (
                <div className="mt-2 flex items-center gap-2 text-red-700">
                  <AlertTriangle size={16} />
                  <span className="text-sm">{t.tooLong(maxPages)}</span>
                </div>
              )}
              {needsBlankAck && pageInfo && (
                <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <div className="flex items-start gap-2 text-amber-700">
                    <Info size={18} className="flex-shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold text-sm">{t.blankPagesTitle}</div>
                      <span className="text-sm">{t.blankPagesDesc(pageInfo.printedPages, pageInfo.contentPages, pageInfo.blankPages)}</span>
                      <AddStoryNudge language={language} layout={pageInfo.layout} onAdd={handleAddStory} />
                    </div>
                  </div>
                  <BlankPagesPreview
                    sequence={pageInfo.sequence}
                    storyIds={selected}
                    filledPages={pageInfo.contentPages}
                    printedPages={pageInfo.printedPages}
                    blankPages={pageInfo.blankPages}
                    title={t.blankPreviewTitle}
                    summary={t.blankPreviewSummary}
                    legendFilled={t.blankLegendFilled}
                    legendBlank={t.blankLegendBlank}
                  />
                  <label className="mt-3 flex items-start gap-2 text-sm font-medium text-gray-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={blankAck}
                      onChange={e => setBlankAck(e.target.checked)}
                      className="mt-0.5 h-4 w-4 flex-shrink-0 accent-indigo-600"
                    />
                    <span>{t.blankAck(pageInfo.blankPages)}</span>
                  </label>
                </div>
              )}
            </section>

            <section className={card}>
              <h2 className="text-xl font-bold text-gray-800 mb-3">{t.coverTitle}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {coverCard('softcover', <Book size={18} />, t.softcover, t.softcoverPrice)}
                {coverCard('hardcover', <BookOpen size={18} />, t.hardcover, t.hardcoverPrice(surchargeChf))}
              </div>
            </section>

            <div className="bg-gradient-to-r from-indigo-50 to-indigo-50 rounded-xl p-4 sm:p-6 mb-6">
              <div className="flex items-center justify-between">
                <span className="text-gray-700 font-semibold">{t.totalLabel}</span>
                <span className="text-3xl font-bold text-indigo-700">{coverType === 'hardcover' ? `CHF ${surchargeChf}` : t.free}</span>
              </div>
              <p className="text-sm text-gray-500 mt-2">{t.addressHint}</p>
            </div>

            <button
              onClick={handleOrder}
              disabled={!canOrder}
              className="w-full py-4 bg-gradient-to-r from-indigo-600 to-indigo-600 text-white rounded-xl font-bold text-lg hover:from-indigo-700 hover:to-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {busy ? <Loader2 size={20} className="animate-spin" /> : <ShoppingCart size={20} />}
              {busy ? t.processing : t.order}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
