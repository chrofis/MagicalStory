import { useState } from 'react';
import { CreditCard, Loader2, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { useToast } from '@/context/ToastContext';
import { storyService } from '@/services';

const CREDIT_PACKAGES = [
  { credits: 300,  priceCHF: 5,  label: 'Starter' },
  { credits: 700,  priceCHF: 10, label: 'Popular' },
  { credits: 1500, priceCHF: 20, label: 'Best Value' },
  { credits: 4000, priceCHF: 50, label: 'Pro' },
] as const;

interface CreditsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreditsModal({ isOpen, onClose }: CreditsModalProps) {
  const { language } = useLanguage();
  const { showError } = useToast();
  const [isBuyingCredits, setIsBuyingCredits] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(1); // Default to "Popular"

  if (!isOpen) return null;

  const selectedPkg = CREDIT_PACKAGES[selectedIndex];

  const handleBuyCredits = async () => {
    setIsBuyingCredits(true);
    try {
      const { url } = await storyService.createCreditsCheckout(selectedPkg.credits);
      if (url) {
        window.location.href = url;
      }
    } catch (error) {
      console.error('Failed to create checkout:', error);
      showError(language === 'de'
        ? 'Fehler beim Erstellen der Zahlung. Bitte versuchen Sie es erneut.'
        : language === 'fr'
        ? 'Erreur lors de la création du paiement. Veuillez réessayer.'
        : 'Failed to create payment. Please try again.');
      setIsBuyingCredits(false);
    }
  };

  const texts = {
    title: language === 'de' ? 'Credits kaufen' : language === 'fr' ? 'Acheter des credits' : 'Buy Credits',
    credits: language === 'de' ? 'Credits' : language === 'fr' ? 'credits' : 'credits',
    securePayment: language === 'de'
      ? 'Sichere Zahlung mit Stripe'
      : language === 'fr'
      ? 'Paiement securise avec Stripe'
      : 'Secure payment with Stripe',
    cancel: language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel',
    buyNow: language === 'de' ? 'Jetzt kaufen' : language === 'fr' ? 'Acheter maintenant' : 'Buy Now',
    loading: language === 'de' ? 'Wird geladen...' : language === 'fr' ? 'Chargement...' : 'Loading...'
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={() => !isBuyingCredits && onClose()}
    >
      <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl w-full" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-bold text-gray-900 mb-4">{texts.title}</h2>

        {/* Credit Packages */}
        <div className="space-y-2 mb-5">
          {CREDIT_PACKAGES.map((pkg, idx) => (
            <button
              key={pkg.credits}
              onClick={() => setSelectedIndex(idx)}
              disabled={isBuyingCredits}
              className={`w-full flex items-center justify-between rounded-xl px-4 py-3 border-2 transition-all ${
                idx === selectedIndex
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              } disabled:opacity-60`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
                  idx === selectedIndex ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300'
                }`}>
                  {idx === selectedIndex && <Check size={12} className="text-white" />}
                </div>
                <div className="text-left">
                  <span className="font-semibold text-gray-900">{pkg.credits}</span>
                  <span className="text-gray-500 ml-1">{texts.credits}</span>
                </div>
              </div>
              <span className={`text-lg font-bold ${idx === selectedIndex ? 'text-indigo-500' : 'text-gray-700'}`}>
                CHF {pkg.priceCHF}.-
              </span>
            </button>
          ))}
        </div>

        <p className="text-sm text-gray-500 mb-4 text-center">{texts.securePayment}</p>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            disabled={isBuyingCredits}
            className="flex-1 bg-gray-200 text-gray-700 py-3 px-4 rounded-lg hover:bg-gray-300 font-semibold disabled:opacity-50"
          >
            {texts.cancel}
          </button>
          <button
            onClick={handleBuyCredits}
            disabled={isBuyingCredits}
            className="flex-1 bg-indigo-500 text-white py-3 px-4 rounded-lg hover:bg-indigo-600 font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isBuyingCredits ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                {texts.loading}
              </>
            ) : (
              <>
                <CreditCard size={18} />
                {texts.buyNow} — CHF {selectedPkg.priceCHF}.-
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
