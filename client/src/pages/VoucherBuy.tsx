import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Gift, Loader2, Mail, BookOpen, Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useLangPath } from '@/hooks/useLangPath';
import { Navigation } from '@/components/common';
import { storyService } from '@/services';
import { localizedApiError } from '@/utils/apiErrors';
import { VOUCHER_PRICE_CHF } from '@/constants/voucher';

const texts = {
  en: {
    docTitle: 'Gift voucher | Magical Story',
    title: 'Give a story and a printed book',
    subtitle: "The gift voucher for personalised children's books",
    contentsTitle: 'What the gift contains',
    item1: 'Credits for two stories of up to 25 pages each',
    item2: 'One printed softcover book of up to 50 pages, shipping within Switzerland included',
    item3: 'Never expires',
    item4: 'Arrives by email as a PDF to print or forward, with a QR code for easy redeeming',
    note: 'A hardcover or a longer book is possible too: only the difference is paid.',
    buy: 'Buy voucher',
    redirecting: 'Redirecting…',
    haveCode: 'You already have a voucher?',
    redeem: 'Redeem it here',
    successTitle: 'Thank you!',
    successBody: 'The voucher is on its way to your email, as a PDF to print or forward.',
    cancelled: 'The payment was cancelled. No money was taken.',
    again: 'Buy another voucher',
  },
  de: {
    docTitle: 'Geschenkgutschein | Magical Story',
    title: 'Schenke eine Geschichte und ein gedrucktes Buch',
    subtitle: 'Der Geschenkgutschein für personalisierte Kinderbücher',
    contentsTitle: 'Das ist im Geschenk enthalten',
    item1: 'Credits für zwei Geschichten mit je bis zu 25 Seiten',
    item2: 'Ein gedrucktes Softcover-Buch mit bis zu 50 Seiten, Versand innerhalb der Schweiz inklusive',
    item3: 'Läuft nie ab',
    item4: 'Kommt per E-Mail als PDF zum Ausdrucken oder Weiterleiten, mit QR-Code zum einfachen Einlösen',
    note: 'Ein Hardcover oder ein längeres Buch ist ebenfalls möglich: Es wird nur die Differenz bezahlt.',
    buy: 'Gutschein kaufen',
    redirecting: 'Weiterleitung…',
    haveCode: 'Du hast bereits einen Gutschein?',
    redeem: 'Hier einlösen',
    successTitle: 'Vielen Dank!',
    successBody: 'Der Gutschein ist unterwegs an deine E-Mail, als PDF zum Ausdrucken oder Weiterleiten.',
    cancelled: 'Die Zahlung wurde abgebrochen. Es wurde nichts abgebucht.',
    again: 'Weiteren Gutschein kaufen',
  },
  fr: {
    docTitle: 'Bon cadeau | Magical Story',
    title: 'Offrez une histoire et un livre imprimé',
    subtitle: "Le bon cadeau pour des livres d'enfants personnalisés",
    contentsTitle: 'Ce que contient le cadeau',
    item1: 'Des crédits pour deux histoires de 25 pages chacune au maximum',
    item2: 'Un livre imprimé à couverture souple de 50 pages au maximum, livraison en Suisse incluse',
    item3: "N'expire jamais",
    item4: "Reçu par e-mail en PDF à imprimer ou à transférer, avec un code QR pour l'utiliser facilement",
    note: 'Une couverture rigide ou un livre plus long est aussi possible : seule la différence est à payer.',
    buy: 'Acheter le bon',
    redirecting: 'Redirection…',
    haveCode: 'Vous avez déjà un bon ?',
    redeem: "L'utiliser ici",
    successTitle: 'Merci !',
    successBody: 'Le bon cadeau est en route vers votre e-mail, en PDF à imprimer ou à transférer.',
    cancelled: "Le paiement a été annulé. Rien n'a été débité.",
    again: 'Acheter un autre bon',
  },
  it: {
    docTitle: 'Buono regalo | Magical Story',
    title: 'Regala una storia e un libro stampato',
    subtitle: 'Il buono regalo per libri personalizzati per bambini',
    contentsTitle: 'Cosa contiene il regalo',
    item1: 'Crediti per due storie di al massimo 25 pagine ciascuna',
    item2: 'Un libro stampato con copertina morbida di al massimo 50 pagine, spedizione in Svizzera inclusa',
    item3: 'Non scade mai',
    item4: 'Arriva via e-mail in PDF da stampare o inoltrare, con codice QR per riscattarlo facilmente',
    note: 'Sono possibili anche una copertina rigida o un libro più lungo: si paga solo la differenza.',
    buy: 'Acquista il buono',
    redirecting: 'Reindirizzamento…',
    haveCode: 'Hai già un buono?',
    redeem: 'Riscattalo qui',
    successTitle: 'Grazie!',
    successBody: 'Il buono regalo è in viaggio verso la tua e-mail, in PDF da stampare o inoltrare.',
    cancelled: 'Il pagamento è stato annullato. Non è stato addebitato nulla.',
    again: 'Acquista un altro buono',
  },
};

export default function VoucherBuy() {
  const { language } = useLanguage();
  const lp = useLangPath();
  const [searchParams] = useSearchParams();
  const t = texts[language as keyof typeof texts] || texts.en;
  const payment = searchParams.get('payment');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { document.title = t.docTitle; }, [t.docTitle]);

  const handleBuy = async () => {
    setBusy(true);
    setError('');
    try {
      const { url } = await storyService.createVoucherCheckout(language);
      // Stay disabled while the browser navigates to Stripe (a second click would create a second session).
      window.location.href = url;
    } catch (err) {
      setBusy(false);
      setError(localizedApiError(err, language));
    }
  };

  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6';
  const items = [t.item1, t.item2, t.item3, t.item4];

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />
      <div className="px-4 md:px-8 py-8 max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-4">
            <Gift className="w-8 h-8 text-indigo-500" />
          </div>
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-3">{t.title}</h1>
          <p className="text-lg text-gray-600">{t.subtitle}</p>
        </div>

        {payment === 'success' && (
          <section className={`${card} border-green-200 bg-green-50 text-center`}>
            <Mail className="w-10 h-10 text-green-600 mx-auto mb-3" />
            <h2 className="text-xl font-bold text-green-800 mb-2">{t.successTitle}</h2>
            <p className="text-green-700">{t.successBody}</p>
          </section>
        )}
        {payment === 'cancelled' && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3 mb-6 text-sm">{t.cancelled}</div>
        )}

        <section className={card}>
          <div className="flex items-center gap-2 mb-4">
            <BookOpen size={22} className="text-indigo-500" />
            <h2 className="text-xl md:text-2xl font-bold text-gray-800">{t.contentsTitle}</h2>
          </div>
          <div className="space-y-3 mb-4">
            {items.map((item) => (
              <div key={item} className="flex items-start gap-2 text-gray-700">
                <Check size={18} className="text-indigo-500 shrink-0 mt-0.5" />
                <span>{item}</span>
              </div>
            ))}
          </div>
          <p className="text-sm text-gray-500 flex items-start gap-1.5">
            <Sparkles size={18} className="text-indigo-500 shrink-0" />
            {t.note}
          </p>
        </section>

        <div className="text-center">
          <div className="text-4xl font-bold text-indigo-700 mb-4">CHF {VOUCHER_PRICE_CHF}</div>
          {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm">{error}</div>}
          <button
            onClick={handleBuy}
            disabled={busy}
            className="px-8 py-3 bg-indigo-500 text-white rounded-lg font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50 inline-flex items-center gap-2"
          >
            {busy && <Loader2 size={18} className="animate-spin" />}
            {busy ? t.redirecting : payment === 'success' ? t.again : t.buy}
          </button>
          <p className="text-sm text-gray-500 mt-6">
            {t.haveCode}{' '}
            <Link to={lp('/gutschein/einloesen')} className="text-indigo-600 font-medium hover:text-indigo-700">{t.redeem}</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
