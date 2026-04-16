import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Check, Gift, Coins, Package, User, Mail, ShieldCheck, X, ArrowRightLeft, CreditCard, Clock } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation, LoadingSpinner } from '@/components/common';
import { storyService } from '@/services';

const texts = {
  en: {
    title: 'My Account',
    referralTitle: 'Refer a Friend',
    referralDesc: 'Share your code — your friend gets CHF 10 off their first book, and you get CHF 10 cashback you can spend on a book, convert to story credits, or cash out to your card.',
    yourCode: 'Your referral code',
    copied: 'Copied!',
    copy: 'Copy',
    totalReferrals: 'Successful referrals',
    balanceTitle: 'Referral balance',
    available: 'Available',
    pending: 'pending in checkout',
    convertBtn: 'Convert to credits',
    cashoutBtn: 'Cash out to card',
    historyTitle: 'Recent activity',
    historyEmpty: 'No activity yet — share your code to get started.',
    credits: 'Story Credits',
    buyMore: 'Buy more credits',
    accountInfo: 'Account Info',
    username: 'Username',
    email: 'Email',
    verified: 'Verified',
    notVerified: 'Not verified',
    myOrders: 'My Orders',
    viewOrders: 'View order history',
    // Modals
    convertTitle: 'Convert balance to credits',
    convertDesc: 'CHF 1 = {credits} credits. Use credits to generate more stories.',
    cashoutTitle: 'Cash out to card',
    cashoutDesc: 'Refunds go to the original card you used. Capped at your lifetime spend.',
    cashoutMin: 'Minimum cashout: CHF {min}.',
    convertMin: 'Minimum: CHF {min}.',
    amountLabel: 'Amount in CHF',
    creditsPreview: '→ {credits} credits',
    confirm: 'Confirm',
    cancel: 'Cancel',
    processing: 'Processing…',
    convertSuccess: 'Added {credits} credits to your account.',
    cashoutSuccess: 'Refunded CHF {amount} to your card.',
    cashoutPartial: 'Refunded CHF {amount}. Some refunds failed — check below.',
    cashoutNoneRefundable: 'No card refunds available right now. Use your balance as a discount on your next book or convert to credits.',
    insufficientBalance: 'Insufficient available balance.',
  },
  de: {
    title: 'Mein Konto',
    referralTitle: 'Freunde einladen',
    referralDesc: 'Teile deinen Code — dein Freund erhält CHF 10 Rabatt auf sein erstes Buch, und du bekommst CHF 10 Cashback, den du auf ein Buch anrechnen, in Story-Credits umwandeln oder dir auf deine Karte auszahlen lassen kannst.',
    yourCode: 'Dein Empfehlungscode',
    copied: 'Kopiert!',
    copy: 'Kopieren',
    totalReferrals: 'Erfolgreiche Empfehlungen',
    balanceTitle: 'Empfehlungs-Guthaben',
    available: 'Verfügbar',
    pending: 'im Checkout reserviert',
    convertBtn: 'In Credits umwandeln',
    cashoutBtn: 'Auf Karte auszahlen',
    historyTitle: 'Letzte Aktivität',
    historyEmpty: 'Noch keine Aktivität — teile deinen Code, um zu starten.',
    credits: 'Story Credits',
    buyMore: 'Mehr Credits kaufen',
    accountInfo: 'Kontoinformationen',
    username: 'Benutzername',
    email: 'E-Mail',
    verified: 'Verifiziert',
    notVerified: 'Nicht verifiziert',
    myOrders: 'Meine Bestellungen',
    viewOrders: 'Bestellverlauf anzeigen',
    convertTitle: 'Guthaben in Credits umwandeln',
    convertDesc: 'CHF 1 = {credits} Credits. Mit Credits kannst du weitere Geschichten erstellen.',
    cashoutTitle: 'Auf Karte auszahlen',
    cashoutDesc: 'Rückerstattungen gehen an die ursprüngliche Karte. Begrenzt auf deine bisherigen Zahlungen.',
    cashoutMin: 'Mindest-Auszahlung: CHF {min}.',
    convertMin: 'Minimum: CHF {min}.',
    amountLabel: 'Betrag in CHF',
    creditsPreview: '→ {credits} Credits',
    confirm: 'Bestätigen',
    cancel: 'Abbrechen',
    processing: 'Verarbeite…',
    convertSuccess: '{credits} Credits zu deinem Konto hinzugefügt.',
    cashoutSuccess: 'CHF {amount} auf deine Karte zurückerstattet.',
    cashoutPartial: 'CHF {amount} erstattet. Einige Rückerstattungen sind fehlgeschlagen — siehe unten.',
    cashoutNoneRefundable: 'Im Moment sind keine Karten-Rückerstattungen möglich. Nutze dein Guthaben als Rabatt für dein nächstes Buch oder wandle es in Credits um.',
    insufficientBalance: 'Nicht genügend verfügbares Guthaben.',
  },
  fr: {
    title: 'Mon compte',
    referralTitle: 'Parrainage',
    referralDesc: 'Partagez votre code — votre ami obtient CHF 10 de réduction sur son premier livre, et vous recevez CHF 10 de cashback à utiliser comme rabais sur un livre, à convertir en crédits ou à virer sur votre carte.',
    yourCode: 'Votre code de parrainage',
    copied: 'Copié !',
    copy: 'Copier',
    totalReferrals: 'Parrainages réussis',
    balanceTitle: 'Solde de parrainage',
    available: 'Disponible',
    pending: 'réservé pour un paiement en cours',
    convertBtn: 'Convertir en crédits',
    cashoutBtn: 'Virer sur la carte',
    historyTitle: 'Activité récente',
    historyEmpty: 'Pas encore d\'activité — partagez votre code pour commencer.',
    credits: 'Crédits Story',
    buyMore: 'Acheter plus de crédits',
    accountInfo: 'Informations du compte',
    username: "Nom d'utilisateur",
    email: 'E-mail',
    verified: 'Vérifié',
    notVerified: 'Non vérifié',
    myOrders: 'Mes commandes',
    viewOrders: "Voir l'historique des commandes",
    convertTitle: 'Convertir le solde en crédits',
    convertDesc: 'CHF 1 = {credits} crédits. Utilisez les crédits pour générer d\'autres histoires.',
    cashoutTitle: 'Virer sur la carte',
    cashoutDesc: 'Les remboursements vont sur la carte d\'origine. Plafonné à vos dépenses cumulées.',
    cashoutMin: 'Virement minimum : CHF {min}.',
    convertMin: 'Minimum : CHF {min}.',
    amountLabel: 'Montant en CHF',
    creditsPreview: '→ {credits} crédits',
    confirm: 'Confirmer',
    cancel: 'Annuler',
    processing: 'En cours…',
    convertSuccess: '{credits} crédits ajoutés à votre compte.',
    cashoutSuccess: 'CHF {amount} remboursés sur votre carte.',
    cashoutPartial: 'CHF {amount} remboursés. Certains remboursements ont échoué — voir ci-dessous.',
    cashoutNoneRefundable: 'Aucun remboursement carte possible pour le moment. Utilisez votre solde comme rabais ou convertissez-le en crédits.',
    insufficientBalance: 'Solde disponible insuffisant.',
  },
};

type ReferralBalance = Awaited<ReturnType<typeof storyService.getReferralBalance>>;

function fmtChf(cents: number): string {
  return (cents / 100).toFixed(2);
}

function fmtType(type: string, lang: string): string {
  const labels: Record<string, Record<string, string>> = {
    en: {
      earned: 'Cashback earned',
      pending_checkout: 'Held for checkout',
      spent_discount: 'Discount applied',
      spent_credits: 'Converted to credits',
      spent_refund: 'Cashed out to card',
      restored: 'Hold released',
      admin_adjust: 'Adjustment',
    },
    de: {
      earned: 'Cashback erhalten',
      pending_checkout: 'Für Checkout reserviert',
      spent_discount: 'Rabatt angewendet',
      spent_credits: 'In Credits umgewandelt',
      spent_refund: 'Auf Karte ausgezahlt',
      restored: 'Reservierung aufgehoben',
      admin_adjust: 'Anpassung',
    },
    fr: {
      earned: 'Cashback gagné',
      pending_checkout: 'Réservé pour paiement',
      spent_discount: 'Rabais appliqué',
      spent_credits: 'Converti en crédits',
      spent_refund: 'Viré sur la carte',
      restored: 'Réservation libérée',
      admin_adjust: 'Ajustement',
    },
  };
  return labels[lang]?.[type] || labels.en[type] || type;
}

export default function AccountPage() {
  const { language } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const t = texts[language as keyof typeof texts] || texts.en;

  const [referralData, setReferralData] = useState<{
    code: string; credits: number; referredBy: string | null;
    referrals: number; creditsEarned: number;
  } | null>(null);
  const [balance, setBalance] = useState<ReferralBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const [convertOpen, setConvertOpen] = useState(false);
  const [cashoutOpen, setCashoutOpen] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) { navigate('/'); return; }
    Promise.all([
      storyService.getMyReferralCode(),
      storyService.getReferralBalance().catch(() => null),
    ]).then(([code, bal]) => {
      setReferralData(code);
      setBalance(bal);
    }).catch(() => {})
      .finally(() => setLoading(false));
  }, [isAuthenticated, navigate]);

  const refreshBalance = async () => {
    try { setBalance(await storyService.getReferralBalance()); } catch { /* ignore */ }
  };

  const handleCopy = async () => {
    if (!referralData?.code) return;
    try {
      await navigator.clipboard.writeText(referralData.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard may fail in non-secure contexts */ }
  };

  if (loading) return <><Navigation /><LoadingSpinner fullScreen /></>;
  if (!user) return null;

  const hasBalance = balance && (balance.balanceCents > 0 || balance.pendingCents > 0 || balance.history.length > 0);

  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-white">
      <Navigation />
      <div className="max-w-2xl mx-auto px-4 py-8 pt-24">
        <h1 className="text-3xl font-bold text-gray-800 mb-6">{t.title}</h1>

        {/* Referral card */}
        {referralData && (
          <div className="bg-white rounded-xl shadow-md border border-indigo-100 p-6 mb-6">
            <div className="flex items-center gap-2 mb-2">
              <Gift size={20} className="text-indigo-600" />
              <h2 className="text-xl font-bold text-gray-800">{t.referralTitle}</h2>
            </div>
            <p className="text-sm text-gray-600 mb-4">{t.referralDesc}</p>

            <div className="mb-4">
              <label className="text-xs text-gray-500 uppercase tracking-wide">{t.yourCode}</label>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 font-mono text-xl font-bold text-indigo-700 tracking-widest text-center select-all">
                  {referralData.code}
                </div>
                <button
                  onClick={handleCopy}
                  className="px-4 py-3 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors flex items-center gap-1.5"
                >
                  {copied ? <Check size={18} /> : <Copy size={18} />}
                  <span className="text-sm font-medium">{copied ? t.copied : t.copy}</span>
                </button>
              </div>
            </div>

            <div className="bg-indigo-50 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-indigo-700">{referralData.referrals}</div>
              <div className="text-xs text-gray-500">{t.totalReferrals}</div>
            </div>
          </div>
        )}

        {/* Referral balance card */}
        {balance && (
          <div className="bg-white rounded-xl shadow-md border border-emerald-100 p-6 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <CreditCard size={20} className="text-emerald-600" />
              <h2 className="text-xl font-bold text-gray-800">{t.balanceTitle}</h2>
            </div>

            <div className="mb-4">
              <div className="flex items-baseline gap-3">
                <span className="text-4xl font-bold text-emerald-700">CHF {fmtChf(balance.availableCents)}</span>
                <span className="text-sm text-gray-500">{t.available}</span>
              </div>
              {balance.pendingCents > 0 && (
                <div className="text-sm text-amber-600 italic mt-1">
                  CHF {fmtChf(balance.pendingCents)} {t.pending}
                </div>
              )}
            </div>

            {balance.availableCents > 0 && (
              <div className="grid grid-cols-2 gap-2 mb-4">
                <button
                  onClick={() => setConvertOpen(true)}
                  disabled={balance.availableCents < balance.convertMinCents}
                  className="bg-amber-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  <ArrowRightLeft size={16} />
                  {t.convertBtn}
                </button>
                <button
                  onClick={() => setCashoutOpen(true)}
                  disabled={balance.availableCents < balance.cashoutMinCents}
                  className="bg-emerald-500 text-white px-3 py-2 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 hover:bg-emerald-600 disabled:bg-gray-300 disabled:cursor-not-allowed"
                >
                  <CreditCard size={16} />
                  {t.cashoutBtn}
                </button>
              </div>
            )}

            {/* History */}
            {hasBalance && (
              <div>
                <div className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-wide mb-2">
                  <Clock size={12} /> {t.historyTitle}
                </div>
                {balance.history.length === 0 ? (
                  <p className="text-sm text-gray-400 italic">{t.historyEmpty}</p>
                ) : (
                  <ul className="space-y-1.5 max-h-80 overflow-y-auto">
                    {balance.history.map(h => (
                      <li key={h.id} className="flex items-center justify-between text-sm border-b border-gray-100 pb-1.5 last:border-0">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-gray-700 truncate">{fmtType(h.type, language)}</div>
                          <div className="text-xs text-gray-400">
                            {new Date(h.createdAt).toLocaleDateString(language === 'de' ? 'de-CH' : language === 'fr' ? 'fr-CH' : 'en-CH', { year: 'numeric', month: 'short', day: 'numeric' })}
                          </div>
                        </div>
                        <span className={`font-mono font-semibold ml-2 ${h.amountCents > 0 ? 'text-emerald-600' : 'text-gray-700'}`}>
                          {h.amountCents > 0 ? '+' : ''}CHF {fmtChf(h.amountCents)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {/* Credits */}
        <div className="bg-white rounded-xl shadow-md border border-gray-100 p-6 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Coins size={20} className="text-amber-500" />
            <h2 className="text-xl font-bold text-gray-800">{t.credits}</h2>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-3xl font-bold text-gray-800">
              {user.credits === -1 ? '∞' : user.credits}
            </span>
            <button
              onClick={() => navigate('/pricing')}
              className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
            >
              {t.buyMore} →
            </button>
          </div>
        </div>

        {/* Account info */}
        <div className="bg-white rounded-xl shadow-md border border-gray-100 p-6 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <User size={20} className="text-gray-500" />
            <h2 className="text-xl font-bold text-gray-800">{t.accountInfo}</h2>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">{t.username}</span>
              <span className="font-medium text-gray-800">{user.username}</span>
            </div>
            {user.email && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500 flex items-center gap-1"><Mail size={14} /> {t.email}</span>
                <span className="font-medium text-gray-800">{user.email}</span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-gray-500 flex items-center gap-1"><ShieldCheck size={14} /> Status</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${user.emailVerified ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                {user.emailVerified ? t.verified : t.notVerified}
              </span>
            </div>
          </div>
        </div>

        {/* Orders link */}
        <button
          onClick={() => navigate('/orders')}
          className="w-full bg-white rounded-xl shadow-md border border-gray-100 p-6 text-left hover:border-indigo-200 transition-colors flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <Package size={20} className="text-gray-500" />
            <div>
              <h2 className="text-lg font-bold text-gray-800">{t.myOrders}</h2>
              <p className="text-sm text-gray-500">{t.viewOrders}</p>
            </div>
          </div>
          <span className="text-gray-400">→</span>
        </button>
      </div>

      {convertOpen && balance && (
        <ConvertModal
          balance={balance}
          t={t}
          onClose={() => setConvertOpen(false)}
          onSuccess={refreshBalance}
        />
      )}
      {cashoutOpen && balance && (
        <CashoutModal
          balance={balance}
          t={t}
          onClose={() => setCashoutOpen(false)}
          onSuccess={refreshBalance}
        />
      )}
    </div>
  );
}

interface ModalProps {
  balance: ReferralBalance;
  t: typeof texts.en;
  onClose: () => void;
  onSuccess: () => void;
}

function ConvertModal({ balance, t, onClose, onSuccess }: ModalProps) {
  const [chf, setChf] = useState((balance.availableCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cents = Math.round(parseFloat(chf || '0') * 100);
  const validAmount = cents >= balance.convertMinCents && cents <= balance.availableCents;
  const creditsPreview = Math.floor((cents * balance.creditsPerChf) / 100);

  const submit = async () => {
    if (!validAmount) return;
    setBusy(true);
    setError(null);
    try {
      const r = await storyService.convertReferralToCredits(cents);
      if (r.ok) {
        setResult(t.convertSuccess.replace('{credits}', String(r.creditsAdded)));
        onSuccess();
      } else {
        setError(r.error || 'Failed');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <div className="flex justify-between items-start mb-3">
          <h3 className="text-lg font-bold text-gray-800">{t.convertTitle}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          {t.convertDesc.replace('{credits}', String(balance.creditsPerChf))}
        </p>
        {result ? (
          <>
            <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg p-3 mb-4 text-sm">{result}</div>
            <button onClick={onClose} className="w-full bg-gray-100 text-gray-700 px-3 py-2 rounded-lg font-semibold hover:bg-gray-200">{t.cancel}</button>
          </>
        ) : (
          <>
            <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1">{t.amountLabel}</label>
            <input
              type="number"
              step="0.01"
              min={(balance.convertMinCents / 100).toFixed(2)}
              max={(balance.availableCents / 100).toFixed(2)}
              value={chf}
              onChange={(e) => { setChf(e.target.value); setError(null); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-lg font-mono mb-2"
            />
            <div className="text-sm text-gray-600 mb-4">
              {validAmount ? t.creditsPreview.replace('{credits}', String(creditsPreview)) : t.convertMin.replace('{min}', (balance.convertMinCents / 100).toFixed(2))}
            </div>
            {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-2 mb-3 text-sm">{error}</div>}
            <div className="flex gap-2">
              <button onClick={onClose} disabled={busy} className="flex-1 bg-gray-100 text-gray-700 px-3 py-2 rounded-lg font-semibold hover:bg-gray-200">{t.cancel}</button>
              <button onClick={submit} disabled={!validAmount || busy} className="flex-1 bg-amber-500 text-white px-3 py-2 rounded-lg font-semibold hover:bg-amber-600 disabled:bg-gray-300">
                {busy ? t.processing : t.confirm}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CashoutModal({ balance, t, onClose, onSuccess }: ModalProps) {
  const [chf, setChf] = useState((balance.availableCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState<Array<{ orderId: number; error: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  const cents = Math.round(parseFloat(chf || '0') * 100);
  const validAmount = cents >= balance.cashoutMinCents && cents <= balance.availableCents;

  const submit = async () => {
    if (!validAmount) return;
    setBusy(true);
    setError(null);
    setFailed([]);
    try {
      const r = await storyService.cashOutReferral(cents);
      if (r.ok && r.refundedCents > 0) {
        const partialMsg = r.failed?.length > 0
          ? t.cashoutPartial.replace('{amount}', fmtChf(r.refundedCents))
          : t.cashoutSuccess.replace('{amount}', fmtChf(r.refundedCents));
        setResult(partialMsg);
        setFailed(r.failed || []);
        onSuccess();
      } else if (typeof r.refundableCents === 'number' && r.refundableCents === 0) {
        setError(t.cashoutNoneRefundable);
      } else {
        setError(r.error || 'Failed');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <div className="flex justify-between items-start mb-3">
          <h3 className="text-lg font-bold text-gray-800">{t.cashoutTitle}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <p className="text-sm text-gray-600 mb-2">{t.cashoutDesc}</p>
        <p className="text-xs text-gray-500 mb-4">{t.cashoutMin.replace('{min}', (balance.cashoutMinCents / 100).toFixed(2))}</p>
        {result ? (
          <>
            <div className="bg-green-50 border border-green-200 text-green-700 rounded-lg p-3 mb-4 text-sm">{result}</div>
            {failed.length > 0 && (
              <ul className="text-xs text-red-600 mb-4 space-y-1">
                {failed.map((f, i) => <li key={i}>Order #{f.orderId}: {f.error}</li>)}
              </ul>
            )}
            <button onClick={onClose} className="w-full bg-gray-100 text-gray-700 px-3 py-2 rounded-lg font-semibold hover:bg-gray-200">{t.cancel}</button>
          </>
        ) : (
          <>
            <label className="block text-xs text-gray-500 uppercase tracking-wide mb-1">{t.amountLabel}</label>
            <input
              type="number"
              step="0.01"
              min={(balance.cashoutMinCents / 100).toFixed(2)}
              max={(balance.availableCents / 100).toFixed(2)}
              value={chf}
              onChange={(e) => { setChf(e.target.value); setError(null); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-lg font-mono mb-4"
            />
            {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-2 mb-3 text-sm">{error}</div>}
            <div className="flex gap-2">
              <button onClick={onClose} disabled={busy} className="flex-1 bg-gray-100 text-gray-700 px-3 py-2 rounded-lg font-semibold hover:bg-gray-200">{t.cancel}</button>
              <button onClick={submit} disabled={!validAmount || busy} className="flex-1 bg-emerald-500 text-white px-3 py-2 rounded-lg font-semibold hover:bg-emerald-600 disabled:bg-gray-300">
                {busy ? t.processing : t.confirm}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
