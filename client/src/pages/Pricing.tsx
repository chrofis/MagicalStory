import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Book, BookOpen, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';

// Pricing tiers based on page count
const pricingTiers = [
  { maxPages: 30, label: '1-30', softcover: 38, hardcover: 53 },
  { maxPages: 40, label: '31-40', softcover: 45, hardcover: 60 },
  { maxPages: 50, label: '41-50', softcover: 51, hardcover: 66 },
  { maxPages: 60, label: '51-60', softcover: 57, hardcover: 72 },
  { maxPages: 70, label: '61-70', softcover: 63, hardcover: 78 },
  { maxPages: 80, label: '71-80', softcover: 69, hardcover: 84 },
  { maxPages: 90, label: '81-90', softcover: 75, hardcover: 90 },
  { maxPages: 100, label: '91-100', softcover: 81, hardcover: 96 },
];

export function getPriceForPages(pageCount: number, isHardcover: boolean): number | null {
  const tier = pricingTiers.find(t => pageCount <= t.maxPages);
  if (!tier) return null; // Exceeds maximum
  return isHardcover ? tier.hardcover : tier.softcover;
}

export const MAX_BOOK_PAGES = 100;

export default function Pricing() {
  const navigate = useNavigate();
  const { language } = useLanguage();

  const translations = {
    en: {
      title: 'Book Pricing',
      subtitle: 'Price includes shipping and taxes within Switzerland',
      internationalNote: 'International shipping available at additional cost',
      softcover: 'Softcover',
      hardcover: 'Hardcover',
      softcoverSize: '20 × 20 cm',
      hardcoverSize: '20 × 20 cm',
      pages: 'Pages',
      features: 'What\'s included',
      feature1: 'High-quality print',
      feature2: 'Durable binding',
      feature3: 'Vibrant colors',
      feature4: 'Personal dedication page',
      combineNote: 'You can combine multiple stories into one book!',
      backToStories: 'Back to My Stories',
      createStory: 'Create a Story',
    },
    de: {
      title: 'Buchpreise',
      subtitle: 'Preis inkl. Versand und Steuern innerhalb der Schweiz',
      internationalNote: 'Internationaler Versand gegen Aufpreis möglich',
      softcover: 'Softcover',
      hardcover: 'Hardcover',
      softcoverSize: '20 × 20 cm',
      hardcoverSize: '20 × 20 cm',
      pages: 'Seiten',
      features: 'Was enthalten ist',
      feature1: 'Hochwertiger Druck',
      feature2: 'Langlebige Bindung',
      feature3: 'Lebendige Farben',
      feature4: 'Persönliche Widmungsseite',
      combineNote: 'Du kannst mehrere Geschichten zu einem Buch kombinieren!',
      backToStories: 'Zurück zu Meine Geschichten',
      createStory: 'Geschichte erstellen',
    },
    fr: {
      title: 'Tarifs des livres',
      subtitle: 'Prix incluant livraison et taxes en Suisse',
      internationalNote: 'Livraison internationale disponible avec supplément',
      softcover: 'Couverture souple',
      hardcover: 'Couverture rigide',
      softcoverSize: '20 × 20 cm',
      hardcoverSize: '20 × 20 cm',
      pages: 'Pages',
      features: 'Ce qui est inclus',
      feature1: 'Impression haute qualité',
      feature2: 'Reliure durable',
      feature3: 'Couleurs vives',
      feature4: 'Page de dédicace personnelle',
      combineNote: 'Vous pouvez combiner plusieurs histoires en un seul livre !',
      backToStories: 'Retour à Mes histoires',
      createStory: 'Créer une histoire',
    },
  };

  const t = translations[language as keyof typeof translations] || translations.en;

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />

      <div className="px-4 md:px-8 py-8 max-w-4xl mx-auto">
        {/* Back button */}
        <button
          onClick={() => navigate('/stories')}
          className="flex items-center gap-2 text-gray-600 hover:text-indigo-600 mb-6 transition-colors"
        >
          <ArrowLeft size={20} />
          {t.backToStories}
        </button>

        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-3">
            {t.title}
          </h1>
          <p className="text-lg text-gray-600">{t.subtitle}</p>
          <p className="text-sm text-gray-500 mt-1">{t.internationalNote}</p>
        </div>

        {/* Pricing Table */}
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden mb-8">
          {/* Table Header */}
          <div className="grid grid-cols-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white">
            <div className="p-4 font-semibold">{t.pages}</div>
            <div className="p-4 text-center border-l border-indigo-500">
              <div className="flex flex-col items-center gap-1">
                <Book size={24} />
                <span className="font-semibold">{t.softcover}</span>
                <span className="text-xs text-indigo-200">{t.softcoverSize}</span>
              </div>
            </div>
            <div className="p-4 text-center border-l border-indigo-500">
              <div className="flex flex-col items-center gap-1">
                <BookOpen size={24} />
                <span className="font-semibold">{t.hardcover}</span>
                <span className="text-xs text-indigo-200">{t.hardcoverSize}</span>
              </div>
            </div>
          </div>

          {/* Table Body */}
          {pricingTiers.map((tier, index) => (
            <div
              key={tier.label}
              className={`grid grid-cols-3 ${index % 2 === 0 ? 'bg-gray-50' : 'bg-white'} hover:bg-indigo-50 transition-colors`}
            >
              <div className="p-4 font-medium text-gray-700">
                {tier.label}
              </div>
              <div className="p-4 text-center border-l border-gray-200 font-semibold text-gray-800">
                CHF {tier.softcover}.-
              </div>
              <div className="p-4 text-center border-l border-gray-200 font-semibold text-indigo-700">
                CHF {tier.hardcover}.-
              </div>
            </div>
          ))}
        </div>

        {/* Features */}
        <div className="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-2xl p-6 mb-8">
          <h2 className="text-xl font-bold text-gray-800 mb-4">{t.features}</h2>
          <div className="grid md:grid-cols-2 gap-3">
            {[t.feature1, t.feature2, t.feature3, t.feature4].map((feature, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Check size={20} className="text-green-600" />
                <span className="text-gray-700">{feature}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Combine Stories Note */}
        <div className="bg-amber-50 border-2 border-amber-200 rounded-xl p-4 text-center mb-8">
          <p className="text-amber-800 font-medium">
            {t.combineNote}
          </p>
        </div>

        {/* CTA */}
        <div className="text-center">
          <button
            onClick={() => navigate('/create')}
            className="px-8 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
          >
            {t.createStory}
          </button>
        </div>
      </div>
    </div>
  );
}
