import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Gift } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useLangPath } from '@/hooks/useLangPath';
import { storyService } from '@/services';
import type { MyVoucher } from '@/services/storyService';
import { localizedApiError } from '@/utils/apiErrors';
import { normalizeVoucherCode } from '@/utils/voucherCode';

const texts = {
  en: {
    title: 'Gift vouchers',
    empty: 'You have no vouchers yet.',
    buy: 'Buy a voucher',
    bought: 'Bought',
    redeemed: 'Redeemed',
    status: { active: 'Valid', redeemed: 'Redeemed', void: 'Void', expired: 'Expired' } as Record<string, string>,
    credits: (n: number) => `${n} credits`,
    bookUsed: 'Book ordered',
    bookOpen: 'Order your book',
    bookNone: 'Book not redeemed yet',
    never: 'Never expires',
    until: (d: string) => `Valid until ${d}`,
    pdf: 'PDF',
    redeemTitle: 'Redeem a voucher',
    redeemPlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    redeemButton: 'Redeem',
  },
  de: {
    title: 'Gutscheine',
    empty: 'Du hast noch keine Gutscheine.',
    buy: 'Gutschein kaufen',
    bought: 'Gekauft',
    redeemed: 'Eingelöst',
    status: { active: 'Gültig', redeemed: 'Eingelöst', void: 'Ungültig', expired: 'Abgelaufen' } as Record<string, string>,
    credits: (n: number) => `${n} Credits`,
    bookUsed: 'Buch bestellt',
    bookOpen: 'Buch bestellen',
    bookNone: 'Buch noch nicht eingelöst',
    never: 'Läuft nie ab',
    until: (d: string) => `Gültig bis ${d}`,
    pdf: 'PDF',
    redeemTitle: 'Gutschein einlösen',
    redeemPlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    redeemButton: 'Einlösen',
  },
  fr: {
    title: 'Bons cadeaux',
    empty: "Vous n'avez pas encore de bon cadeau.",
    buy: 'Acheter un bon',
    bought: 'Acheté',
    redeemed: 'Utilisé',
    status: { active: 'Valable', redeemed: 'Utilisé', void: 'Annulé', expired: 'Expiré' } as Record<string, string>,
    credits: (n: number) => `${n} crédits`,
    bookUsed: 'Livre commandé',
    bookOpen: 'Commander le livre',
    bookNone: 'Livre pas encore utilisé',
    never: "N'expire jamais",
    until: (d: string) => `Valable jusqu'au ${d}`,
    pdf: 'PDF',
    redeemTitle: 'Utiliser un bon cadeau',
    redeemPlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    redeemButton: 'Utiliser',
  },
  it: {
    title: 'Buoni regalo',
    empty: 'Non hai ancora buoni regalo.',
    buy: 'Acquista un buono',
    bought: 'Acquistato',
    redeemed: 'Riscattato',
    status: { active: 'Valido', redeemed: 'Riscattato', void: 'Annullato', expired: 'Scaduto' } as Record<string, string>,
    credits: (n: number) => `${n} crediti`,
    bookUsed: 'Libro ordinato',
    bookOpen: 'Ordina il libro',
    bookNone: 'Libro non ancora riscattato',
    never: 'Non scade mai',
    until: (d: string) => `Valido fino al ${d}`,
    pdf: 'PDF',
    redeemTitle: 'Riscatta un buono',
    redeemPlaceholder: 'MS-XXXXX-XXXXX-XXXXX-XXXXX',
    redeemButton: 'Riscatta',
  },
};

export default function AccountVouchers() {
  const { language } = useLanguage();
  const lp = useLangPath();
  const navigate = useNavigate();
  const t = texts[language as keyof typeof texts] || texts.en;
  const [vouchers, setVouchers] = useState<MyVoucher[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    storyService.getMyVouchers()
      .then(r => setVouchers(r.vouchers))
      .catch(err => { setVouchers([]); setError(localizedApiError(err, language)); });
  }, [language]);

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(language === 'de' ? 'de-CH' : language);

  const handlePdf = async (id: string | number) => {
    setError('');
    try { await storyService.downloadVoucherPdf(id); }
    catch (err) { setError(localizedApiError(err, language)); }
  };

  const handleRedeem = () => {
    const c = normalizeVoucherCode(code);
    if (c) navigate(lp(`/gutschein/einloesen/${encodeURIComponent(c)}`));
  };

  return (
    <div className="bg-white rounded-xl shadow-md border border-indigo-100 p-6 mb-6">
      <div className="flex items-center gap-2 mb-4">
        <Gift size={20} className="text-indigo-600" />
        <h2 className="text-xl font-bold text-gray-800">{t.title}</h2>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-2 mb-3 text-sm">{error}</div>}

      {vouchers && vouchers.length === 0 && (
        <p className="text-sm text-gray-500 mb-4">
          {t.empty}{' '}
          <Link to={lp('/gutschein/kaufen')} className="text-indigo-600 hover:text-indigo-700 font-medium">{t.buy}</Link>
        </p>
      )}

      {vouchers && vouchers.length > 0 && (
        <ul className="space-y-3 mb-4">
          {vouchers.map(v => (
            <li key={`${v.role}-${v.id}`} className="border border-gray-200 rounded-lg p-3 text-sm">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-xs uppercase tracking-wide text-gray-500">{v.role === 'bought' ? t.bought : t.redeemed}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${v.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
                  {t.status[v.status] || v.status}
                </span>
              </div>
              <div className="font-mono font-semibold text-indigo-700 break-all select-all">{v.code || `${v.codePrefix}…`}</div>
              <div className="text-gray-600 mt-1">
                {t.credits(v.credits)} · {v.expiresAt ? t.until(fmtDate(v.expiresAt)) : t.never}
              </div>
              {v.role === 'redeemed' && (
                <div className="mt-1 flex items-center gap-2 text-gray-600">
                  {v.bookUsed ? (
                    <span>{t.bookUsed}</span>
                  ) : (
                    <>
                      <span>{t.bookNone}</span>
                      <Link to={lp('/gutschein/buch')} className="text-indigo-600 hover:text-indigo-700 font-medium">{t.bookOpen} →</Link>
                    </>
                  )}
                </div>
              )}
              {v.role === 'bought' && v.code && (
                <button
                  onClick={() => handlePdf(v.id)}
                  className="mt-2 bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-600"
                >
                  {t.pdf}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1">{t.redeemTitle}</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleRedeem(); }}
          placeholder={t.redeemPlaceholder}
          className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg font-mono text-sm"
        />
        <button
          onClick={handleRedeem}
          disabled={!code.trim()}
          className="shrink-0 bg-indigo-500 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-600 disabled:opacity-50"
        >
          {t.redeemButton}
        </button>
      </div>
    </div>
  );
}
