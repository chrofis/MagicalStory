import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Check, Gift, Coins, Package, User, Mail, ShieldCheck } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useAuth } from '@/context/AuthContext';
import { Navigation, LoadingSpinner } from '@/components/common';
import { storyService } from '@/services';

const texts = {
  en: {
    title: 'My Account',
    referralTitle: 'Refer a Friend',
    referralDesc: 'Share your code — your friend gets CHF 10 off their book, and you get 350 credits!',
    yourCode: 'Your referral code',
    copied: 'Copied!',
    copy: 'Copy',
    totalReferrals: 'Successful referrals',
    creditsEarned: 'Credits earned from referrals',
    credits: 'Story Credits',
    buyMore: 'Buy more credits',
    accountInfo: 'Account Info',
    username: 'Username',
    email: 'Email',
    verified: 'Verified',
    notVerified: 'Not verified',
    myOrders: 'My Orders',
    viewOrders: 'View order history',
  },
  de: {
    title: 'Mein Konto',
    referralTitle: 'Freunde einladen',
    referralDesc: 'Teile deinen Code — dein Freund erhält CHF 10 Rabatt auf sein Buch, und du bekommst 350 Credits!',
    yourCode: 'Dein Empfehlungscode',
    copied: 'Kopiert!',
    copy: 'Kopieren',
    totalReferrals: 'Erfolgreiche Empfehlungen',
    creditsEarned: 'Verdiente Credits aus Empfehlungen',
    credits: 'Story Credits',
    buyMore: 'Mehr Credits kaufen',
    accountInfo: 'Kontoinformationen',
    username: 'Benutzername',
    email: 'E-Mail',
    verified: 'Verifiziert',
    notVerified: 'Nicht verifiziert',
    myOrders: 'Meine Bestellungen',
    viewOrders: 'Bestellverlauf anzeigen',
  },
  fr: {
    title: 'Mon compte',
    referralTitle: 'Parrainage',
    referralDesc: 'Partagez votre code — votre ami obtient CHF 10 de réduction sur son livre, et vous recevez 350 crédits !',
    yourCode: 'Votre code de parrainage',
    copied: 'Copié !',
    copy: 'Copier',
    totalReferrals: 'Parrainages réussis',
    creditsEarned: 'Crédits gagnés par parrainage',
    credits: 'Crédits Story',
    buyMore: 'Acheter plus de crédits',
    accountInfo: 'Informations du compte',
    username: "Nom d'utilisateur",
    email: 'E-mail',
    verified: 'Vérifié',
    notVerified: 'Non vérifié',
    myOrders: 'Mes commandes',
    viewOrders: "Voir l'historique des commandes",
  },
};

export default function AccountPage() {
  const { language } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const t = texts[language as keyof typeof texts] || texts.en;

  const [referralData, setReferralData] = useState<{
    code: string; credits: number; referredBy: string | null;
    referrals: number; creditsEarned: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) { navigate('/'); return; }
    storyService.getMyReferralCode()
      .then(setReferralData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isAuthenticated, navigate]);

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

            <div className="grid grid-cols-2 gap-4 text-center">
              <div className="bg-indigo-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-indigo-700">{referralData.referrals}</div>
                <div className="text-xs text-gray-500">{t.totalReferrals}</div>
              </div>
              <div className="bg-indigo-50 rounded-lg p-3">
                <div className="text-2xl font-bold text-indigo-700">{referralData.creditsEarned}</div>
                <div className="text-xs text-gray-500">{t.creditsEarned}</div>
              </div>
            </div>
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
    </div>
  );
}
