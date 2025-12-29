import { useState } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { storyService } from '@/services';

interface CreditsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreditsModal({ isOpen, onClose }: CreditsModalProps) {
  const { language } = useLanguage();
  const [isBuyingCredits, setIsBuyingCredits] = useState(false);

  if (!isOpen) return null;

  const handleBuyCredits = async () => {
    setIsBuyingCredits(true);
    try {
      const { url } = await storyService.createCreditsCheckout(100, 500);
      if (url) {
        window.location.href = url;
      }
    } catch (error) {
      console.error('Failed to create checkout:', error);
      alert(language === 'de'
        ? 'Fehler beim Erstellen der Zahlung. Bitte versuchen Sie es erneut.'
        : language === 'fr'
        ? 'Erreur lors de la creation du paiement. Veuillez reessayer.'
        : 'Failed to create payment. Please try again.');
      setIsBuyingCredits(false);
    }
  };

  const texts = {
    title: language === 'de' ? 'Credits kaufen' : language === 'fr' ? 'Acheter des credits' : 'Buy Credits',
    credits: language === 'de' ? 'Credits' : language === 'fr' ? 'credits' : 'credits',
    description: language === 'de'
      ? '100 Credits reichen fuer etwa 3-4 Geschichten'
      : language === 'fr'
      ? '100 credits suffisent pour environ 3-4 histoires'
      : '100 credits are enough for about 3-4 stories',
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
      <div className="bg-white rounded-lg p-6 max-w-md mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-xl font-bold text-gray-900 mb-4">{texts.title}</h2>

        {/* Credit Package */}
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-6 mb-6 border-2 border-indigo-200">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <CreditCard className="text-indigo-600" size={24} />
              <span className="text-2xl font-bold text-gray-900">100</span>
              <span className="text-gray-600">{texts.credits}</span>
            </div>
            <div className="text-right">
              <span className="text-3xl font-bold text-indigo-600">CHF 5.-</span>
            </div>
          </div>
          <p className="text-sm text-gray-500">{texts.description}</p>
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
            className="flex-1 bg-indigo-600 text-white py-3 px-4 rounded-lg hover:bg-indigo-700 font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isBuyingCredits ? (
              <>
                <Loader2 size={18} className="animate-spin" />
                {texts.loading}
              </>
            ) : (
              texts.buyNow
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
