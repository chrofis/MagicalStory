import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Gift, Loader2, BookOpen, Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { useLangPath } from '@/hooks/useLangPath';
import { Navigation } from '@/components/common';
import { storyService } from '@/services';
import type { VoucherLookup } from '@/services/storyService';
import { localizedApiError } from '@/utils/apiErrors';
import { normalizeVoucherCode } from '@/utils/voucherCode';

const texts = {
  en: {
    docTitle: 'Redeem voucher | Magical Story',
    title: 'Redeem your gift voucher',
    codeLabel: 'Voucher code',
    codePlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    check: 'Continue',
    contents: 'This voucher contains',
    credits: (n: number) => `${n} story credits (two stories of up to 25 pages)`,
    book: 'One printed softcover book of up to 50 pages, shipping within Switzerland included',
    never: 'Never expires',
    until: (d: string) => `Valid until ${d}`,
    redeem: 'Redeem',
    redeeming: 'Redeeming…',
    loginHint: 'You need an account to redeem. You will come back to this page afterwards.',
    status: { redeemed: 'This voucher has already been redeemed.', void: 'This voucher is no longer valid.', expired: 'This voucher has expired.' },
    successTitle: 'Voucher redeemed!',
    successBalance: (n: number) => `Your new balance: ${n} credits.`,
    bookNote: 'Your book is waiting for you. Choose the stories and order it here.',
    createStory: 'Create a story',
    orderBook: 'Order the book',
  },
  de: {
    docTitle: 'Gutschein einlösen | Magical Story',
    title: 'Löse deinen Geschenkgutschein ein',
    codeLabel: 'Gutscheincode',
    codePlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    check: 'Weiter',
    contents: 'Das ist im Gutschein enthalten',
    credits: (n: number) => `${n} Credits für Geschichten (zwei Geschichten mit je bis zu 25 Seiten)`,
    book: 'Ein gedrucktes Softcover-Buch mit bis zu 50 Seiten, Versand innerhalb der Schweiz inklusive',
    never: 'Läuft nie ab',
    until: (d: string) => `Gültig bis ${d}`,
    redeem: 'Einlösen',
    redeeming: 'Wird eingelöst…',
    loginHint: 'Zum Einlösen brauchst du ein Konto. Danach kommst du zu dieser Seite zurück.',
    status: { redeemed: 'Dieser Gutschein wurde bereits eingelöst.', void: 'Dieser Gutschein ist nicht mehr gültig.', expired: 'Dieser Gutschein ist abgelaufen.' },
    successTitle: 'Gutschein eingelöst!',
    successBalance: (n: number) => `Dein neues Guthaben: ${n} Credits.`,
    bookNote: 'Dein Buch wartet auf dich. Wähle die Geschichten aus und bestelle es hier.',
    createStory: 'Geschichte erstellen',
    orderBook: 'Buch bestellen',
  },
  fr: {
    docTitle: 'Utiliser un bon cadeau | Magical Story',
    title: 'Utilisez votre bon cadeau',
    codeLabel: 'Code du bon',
    codePlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    check: 'Continuer',
    contents: 'Ce bon contient',
    credits: (n: number) => `${n} crédits pour des histoires (deux histoires de 25 pages au maximum)`,
    book: 'Un livre imprimé à couverture souple de 50 pages au maximum, livraison en Suisse incluse',
    never: "N'expire jamais",
    until: (d: string) => `Valable jusqu'au ${d}`,
    redeem: 'Utiliser',
    redeeming: 'En cours…',
    loginHint: 'Un compte est nécessaire pour utiliser le bon. Vous reviendrez ensuite sur cette page.',
    status: { redeemed: 'Ce bon cadeau a déjà été utilisé.', void: "Ce bon cadeau n'est plus valable.", expired: 'Ce bon cadeau a expiré.' },
    successTitle: 'Bon cadeau utilisé !',
    successBalance: (n: number) => `Votre nouveau solde : ${n} crédits.`,
    bookNote: 'Votre livre vous attend. Choisissez les histoires et commandez-le ici.',
    createStory: 'Créer une histoire',
    orderBook: 'Commander le livre',
  },
  it: {
    docTitle: 'Riscatta il buono | Magical Story',
    title: 'Riscatta il tuo buono regalo',
    codeLabel: 'Codice del buono',
    codePlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    check: 'Avanti',
    contents: 'Questo buono contiene',
    credits: (n: number) => `${n} crediti per le storie (due storie di al massimo 25 pagine)`,
    book: 'Un libro stampato con copertina morbida di al massimo 50 pagine, spedizione in Svizzera inclusa',
    never: 'Non scade mai',
    until: (d: string) => `Valido fino al ${d}`,
    redeem: 'Riscatta',
    redeeming: 'Riscatto in corso…',
    loginHint: 'Per riscattare serve un account. Poi tornerai a questa pagina.',
    status: { redeemed: 'Questo buono regalo è già stato riscattato.', void: 'Questo buono regalo non è più valido.', expired: 'Questo buono regalo è scaduto.' },
    successTitle: 'Buono riscattato!',
    successBalance: (n: number) => `Il tuo nuovo saldo: ${n} crediti.`,
    bookNote: 'Il tuo libro ti aspetta. Scegli le storie e ordinalo qui.',
    createStory: 'Crea una storia',
    orderBook: 'Ordina il libro',
  },
};

export default function VoucherRedeem() {
  const { code: codeParam } = useParams<{ code?: string }>();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const lp = useLangPath();
  const { isAuthenticated, updateCredits } = useAuth();
  const t = texts[language as keyof typeof texts] || texts.en;

  const code = codeParam ? normalizeVoucherCode(codeParam) : '';
  const [input, setInput] = useState('');
  const [voucher, setVoucher] = useState<VoucherLookup | null>(null);
  const [loading, setLoading] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ balanceAfter: number } | null>(null);

  useEffect(() => { document.title = t.docTitle; }, [t.docTitle]);

  useEffect(() => {
    setVoucher(null);
    setError('');
    setResult(null);
    if (!code) return;
    let cancelled = false;
    setLoading(true);
    storyService.lookupVoucher(code)
      .then(v => { if (!cancelled) setVoucher(v); })
      .catch(err => { if (!cancelled) setError(localizedApiError(err, language)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [code, language]);

  const handleContinue = () => {
    const c = normalizeVoucherCode(input);
    if (c) navigate(lp(`/gutschein/einloesen/${encodeURIComponent(c)}`));
  };

  const handleRedeem = async () => {
    if (!isAuthenticated) {
      // Same mechanism as the other return-after-login flows: the landing page opens the login
      // dialog and navigates to ?redirect= once it succeeds.
      const back = `/gutschein/einloesen/${encodeURIComponent(code)}`;
      navigate(`/?login=true&redirect=${encodeURIComponent(back)}`);
      return;
    }
    setRedeeming(true);
    setError('');
    try {
      const r = await storyService.redeemVoucher(code);
      updateCredits(r.balanceAfter);
      setResult({ balanceAfter: r.balanceAfter });
    } catch (err) {
      setError(localizedApiError(err, language));
    } finally {
      setRedeeming(false);
    }
  };

  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6';
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(language === 'de' ? 'de-CH' : language);
  const unusable = voucher && voucher.status !== 'active' ? t.status[voucher.status] : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />
      <div className="px-4 md:px-8 py-8 max-w-2xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-4">
            <Gift className="w-8 h-8 text-indigo-500" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800">{t.title}</h1>
        </div>

        {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-6 text-sm">{error}</div>}

        {!code && (
          <section className={card}>
            <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1">{t.codeLabel}</label>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleContinue(); }}
              placeholder={t.codePlaceholder}
              className="w-full px-3 py-3 border border-gray-300 rounded-lg font-mono text-base tracking-wide mb-4"
            />
            <button
              onClick={handleContinue}
              disabled={!input.trim()}
              className="w-full bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-600 disabled:opacity-50"
            >
              {t.check}
            </button>
          </section>
        )}

        {code && loading && <div className="flex justify-center py-8"><Loader2 className="w-8 h-8 animate-spin text-indigo-500" /></div>}

        {voucher && !result && (
          <section className={card}>
            <div className="font-mono text-sm text-gray-500 mb-3 break-all">{code}</div>
            <h2 className="text-lg font-bold text-gray-800 mb-3">{t.contents}</h2>
            <div className="space-y-2 mb-4 text-gray-700">
              <div className="flex items-start gap-2"><Sparkles size={18} className="text-indigo-500 shrink-0 mt-0.5" /><span>{t.credits(voucher.credits)}</span></div>
              <div className="flex items-start gap-2"><BookOpen size={18} className="text-indigo-500 shrink-0 mt-0.5" /><span>{t.book}</span></div>
              <div className="flex items-start gap-2"><Check size={18} className="text-indigo-500 shrink-0 mt-0.5" /><span>{voucher.expiresAt ? t.until(fmtDate(voucher.expiresAt)) : t.never}</span></div>
            </div>
            {unusable ? (
              <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 text-sm">{unusable}</div>
            ) : (
              <>
                {!isAuthenticated && <p className="text-sm text-gray-500 mb-3">{t.loginHint}</p>}
                <button
                  onClick={handleRedeem}
                  disabled={redeeming}
                  className="w-full bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600 disabled:opacity-50"
                >
                  {redeeming && <Loader2 size={16} className="animate-spin" />}
                  {redeeming ? t.redeeming : t.redeem}
                </button>
              </>
            )}
          </section>
        )}

        {result && (
          <section className={`${card} border-green-200 bg-green-50`}>
            <h2 className="text-xl font-bold text-green-800 mb-1">{t.successTitle}</h2>
            <p className="text-green-700 mb-3">{t.successBalance(result.balanceAfter)}</p>
            <p className="text-sm text-green-700 mb-4">{t.bookNote}</p>
            <div className="flex flex-col sm:flex-row gap-2">
              <Link
                to={lp('/create')}
                className="flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600"
              >
                <Sparkles size={16} />
                {t.createStory}
              </Link>
              <Link
                to={lp('/gutschein/buch')}
                className="flex-1 bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-indigo-600"
              >
                <BookOpen size={16} />
                {t.orderBook}
              </Link>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
