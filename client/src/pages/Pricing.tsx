import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Book, BookOpen, Check, Coins, Gift, Loader2, Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation } from '@/components/common';
import { storyService } from '@/services';

// Type for pricing tier
interface PricingTier {
  maxPages: number;
  label: string;
  softcover: number;
  hardcover: number;
}

interface CreditPackage {
  credits: number;
  amountCHF: number;
}

// Fallback credit packages (mirrors server/config/credits.js PRICING.PACKAGES)
// — used until /api/pricing responds.
const fallbackCreditPackages: CreditPackage[] = [
  { credits: 150, amountCHF: 5 },
  { credits: 350, amountCHF: 10 },
  { credits: 750, amountCHF: 20 },
  { credits: 2000, amountCHF: 50 },
];
const FALLBACK_CREDITS_PER_PAGE = 10;

// Fallback pricing tiers (used while loading or if API fails)
// Prices are PER BOOK, shipping (CHF 10) is added once at checkout
const fallbackPricingTiers: PricingTier[] = [
  { maxPages: 30, label: '1-30', softcover: 28, hardcover: 43 },
  { maxPages: 40, label: '31-40', softcover: 35, hardcover: 50 },
  { maxPages: 50, label: '41-50', softcover: 41, hardcover: 56 },
  { maxPages: 60, label: '51-60', softcover: 47, hardcover: 62 },
  { maxPages: 70, label: '61-70', softcover: 53, hardcover: 68 },
  { maxPages: 80, label: '71-80', softcover: 59, hardcover: 74 },
  { maxPages: 90, label: '81-90', softcover: 65, hardcover: 80 },
  { maxPages: 100, label: '91-100', softcover: 71, hardcover: 86 },
];

// Flat shipping cost per order (Switzerland), regardless of quantity
export const SHIPPING_COST_CHF = 10;

// Helper function to get price for a page count (uses fallback if tiers not loaded)
export function getPriceForPages(pageCount: number, isHardcover: boolean, tiers?: PricingTier[]): number | null {
  const pricingTiers = tiers || fallbackPricingTiers;
  const tier = pricingTiers.find(t => pageCount <= t.maxPages);
  if (!tier) return null; // Exceeds maximum
  return isHardcover ? tier.hardcover : tier.softcover;
}

export const MAX_BOOK_PAGES = 100;

export default function Pricing() {
  const navigate = useNavigate();
  const { language } = useLanguage();
  const [pricingTiers, setPricingTiers] = useState<PricingTier[]>(fallbackPricingTiers);
  const [creditPackages, setCreditPackages] = useState<CreditPackage[]>(fallbackCreditPackages);
  const [creditsPerPage, setCreditsPerPage] = useState<number>(FALLBACK_CREDITS_PER_PAGE);
  // Book-purchase reward multiplier (1 normally, 2 during promo). Drives the
  // "you earn 2× credits back" copy. Server reads it from DB at order time.
  const [bookCreditMultiplier, setBookCreditMultiplier] = useState<number>(1);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch pricing from API on mount
  useEffect(() => {
    async function fetchPricing() {
      try {
        const data = await storyService.getPricing();
        setPricingTiers(data.tiers);
        if (data.creditPackages?.length) setCreditPackages(data.creditPackages);
        if (data.creditsPerPage) setCreditsPerPage(data.creditsPerPage);
        if (typeof data.tokenPromoMultiplier === 'number') {
          setBookCreditMultiplier(data.tokenPromoMultiplier);
        }
      } catch (err) {
        console.error('Failed to fetch pricing, using fallback:', err);
        // Keep using fallback tiers
      } finally {
        setIsLoading(false);
      }
    }
    fetchPricing();
  }, []);

  // Derived values for the credit-back callout.
  // 10 credits/page × multiplier = credits returned per page of book purchase.
  // Example: 10-page book with 2× promo → 200 credits back (= 2 more stories).
  const creditsBackPerPage = creditsPerPage * bookCreditMultiplier;
  const exampleStoryPages = 10;
  const exampleCreditsBack = exampleStoryPages * creditsBackPerPage;

  const translations = {
    en: {
      title: 'Pricing',
      subtitle: 'Buy credits to create stories. Print your book and get credits back.',
      // Credits section
      creditsTitle: 'Credits — to create your stories',
      creditsIntro: `Stories are paid for with credits. ${creditsPerPage} credits = 1 page. A typical 10-page story = ${creditsPerPage * 10} credits.`,
      creditsTableCredits: 'Credits',
      creditsTablePrice: 'Price',
      creditsTablePerPage: 'Per page',
      creditsNote: `New accounts start with free credits — enough to try a full story.`,
      // Book section
      bookTitle: 'Print your book',
      bookSubtitle: `Per book — plus CHF ${SHIPPING_COST_CHF} flat shipping per order (Switzerland)`,
      internationalNote: 'Order multiple books and pay shipping only once',
      softcover: 'Softcover',
      hardcover: 'Hardcover',
      softcoverSize: '21 × 28 cm',
      hardcoverSize: '21 × 28 cm',
      pages: 'Pages',
      // Credit-back callout
      rewardTitle: bookCreditMultiplier > 1
        ? `Earn ${bookCreditMultiplier}× credits back when you order the book`
        : 'Earn credits back when you order the book',
      rewardBody: bookCreditMultiplier > 1
        ? `Every printed page rewards you with ${creditsBackPerPage} credits — a ${exampleStoryPages}-page book returns ${exampleCreditsBack} credits, enough for another full story.`
        : `Every printed page rewards you with ${creditsBackPerPage} credits — a ${exampleStoryPages}-page book returns ${exampleCreditsBack} credits.`,
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
      title: 'Preise',
      subtitle: 'Kaufe Credits, um Geschichten zu erstellen. Bestelle dein Buch und erhalte Credits zurück.',
      creditsTitle: 'Credits — für deine Geschichten',
      creditsIntro: `Geschichten werden mit Credits bezahlt. ${creditsPerPage} Credits = 1 Seite. Eine typische 10-Seiten-Geschichte = ${creditsPerPage * 10} Credits.`,
      creditsTableCredits: 'Credits',
      creditsTablePrice: 'Preis',
      creditsTablePerPage: 'Pro Seite',
      creditsNote: 'Neue Konten erhalten Gratis-Credits — genug für eine ganze Geschichte zum Ausprobieren.',
      bookTitle: 'Dein Buch drucken lassen',
      bookSubtitle: `Pro Buch — zzgl. CHF ${SHIPPING_COST_CHF} Pauschalversand pro Bestellung (Schweiz)`,
      internationalNote: 'Mehrere Bücher bestellen und Versand nur einmal zahlen',
      softcover: 'Softcover',
      hardcover: 'Hardcover',
      softcoverSize: '21 × 28 cm',
      hardcoverSize: '21 × 28 cm',
      pages: 'Seiten',
      rewardTitle: bookCreditMultiplier > 1
        ? `${bookCreditMultiplier}× Credits zurück beim Bestellen des Buches`
        : 'Credits zurück beim Bestellen des Buches',
      rewardBody: bookCreditMultiplier > 1
        ? `Pro gedruckter Seite gibt es ${creditsBackPerPage} Credits zurück — ein ${exampleStoryPages}-seitiges Buch bringt dir ${exampleCreditsBack} Credits, genug für eine weitere komplette Geschichte.`
        : `Pro gedruckter Seite gibt es ${creditsBackPerPage} Credits zurück — ein ${exampleStoryPages}-seitiges Buch bringt dir ${exampleCreditsBack} Credits.`,
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
      title: 'Tarifs',
      subtitle: 'Achetez des crédits pour créer des histoires. Commandez votre livre et récupérez des crédits.',
      creditsTitle: 'Crédits — pour créer vos histoires',
      creditsIntro: `Les histoires sont payées en crédits. ${creditsPerPage} crédits = 1 page. Une histoire typique de 10 pages = ${creditsPerPage * 10} crédits.`,
      creditsTableCredits: 'Crédits',
      creditsTablePrice: 'Prix',
      creditsTablePerPage: 'Par page',
      creditsNote: 'Les nouveaux comptes reçoivent des crédits gratuits — de quoi essayer une histoire complète.',
      bookTitle: 'Imprimez votre livre',
      bookSubtitle: `Par livre — plus CHF ${SHIPPING_COST_CHF} de livraison forfaitaire par commande (Suisse)`,
      internationalNote: 'Commandez plusieurs livres et ne payez la livraison qu\'une fois',
      softcover: 'Couverture souple',
      hardcover: 'Couverture rigide',
      softcoverSize: '21 × 28 cm',
      hardcoverSize: '21 × 28 cm',
      pages: 'Pages',
      rewardTitle: bookCreditMultiplier > 1
        ? `${bookCreditMultiplier}× crédits récupérés à la commande du livre`
        : 'Récupérez des crédits à la commande du livre',
      rewardBody: bookCreditMultiplier > 1
        ? `Chaque page imprimée rapporte ${creditsBackPerPage} crédits — un livre de ${exampleStoryPages} pages vous rend ${exampleCreditsBack} crédits, de quoi créer une autre histoire complète.`
        : `Chaque page imprimée rapporte ${creditsBackPerPage} crédits — un livre de ${exampleStoryPages} pages vous rend ${exampleCreditsBack} crédits.`,
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
          className="flex items-center gap-2 text-gray-600 hover:text-indigo-500 mb-6 transition-colors"
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
        </div>

        {/* ── Credits section ── */}
        <div className="mb-10">
          <div className="flex items-center gap-2 mb-3">
            <Coins size={22} className="text-indigo-500" />
            <h2 className="text-xl md:text-2xl font-bold text-gray-800">{t.creditsTitle}</h2>
          </div>
          <p className="text-gray-600 mb-4">{t.creditsIntro}</p>
          <div className="bg-white rounded-2xl shadow-lg overflow-hidden mb-3">
            <div className="grid grid-cols-3 bg-gradient-to-r from-indigo-500 to-indigo-600 text-white">
              <div className="p-3 font-semibold text-sm">{t.creditsTableCredits}</div>
              <div className="p-3 text-center font-semibold text-sm border-l border-indigo-400">{t.creditsTablePrice}</div>
              <div className="p-3 text-center font-semibold text-sm border-l border-indigo-400">{t.creditsTablePerPage}</div>
            </div>
            {creditPackages.map((pkg, index) => {
              // Cost per page in rappen (1 CHF = 100 Rp), rounded.
              const perPageRp = Math.round((pkg.amountCHF * 100) / (pkg.credits / creditsPerPage));
              return (
                <div
                  key={pkg.credits}
                  className={`grid grid-cols-3 ${index % 2 === 0 ? 'bg-gray-50' : 'bg-white'} hover:bg-indigo-50 transition-colors`}
                >
                  <div className="p-3 font-medium text-gray-700">{pkg.credits}</div>
                  <div className="p-3 text-center border-l border-gray-200 font-semibold text-gray-800">CHF {pkg.amountCHF}.-</div>
                  <div className="p-3 text-center border-l border-gray-200 text-sm text-gray-600">
                    {perPageRp} Rp.
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-sm text-gray-500 flex items-center gap-1.5">
            <Sparkles size={14} className="text-amber-500" />
            {t.creditsNote}
          </p>
        </div>

        {/* ── Book section header ── */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2">
            <Book size={22} className="text-indigo-500" />
            <h2 className="text-xl md:text-2xl font-bold text-gray-800">{t.bookTitle}</h2>
          </div>
          <p className="text-gray-600">{t.bookSubtitle}</p>
          <p className="text-sm text-gray-500 mt-1">{t.internationalNote}</p>
        </div>

        {/* Pricing Table */}
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden mb-6 relative">
          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 bg-white/50 flex items-center justify-center z-10">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
            </div>
          )}
          {/* Table Header */}
          <div className="grid grid-cols-3 bg-gradient-to-r from-indigo-600 to-indigo-600 text-white">
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

        {/* Credit-back reward callout — the headline incentive for printing.
            Uses warm amber when the promo multiplier is active (2× currently),
            falls back to neutral indigo when multiplier == 1. */}
        <div
          className={`rounded-2xl p-5 mb-8 border-2 ${
            bookCreditMultiplier > 1
              ? 'bg-gradient-to-r from-amber-50 to-amber-100 border-amber-300'
              : 'bg-indigo-50 border-indigo-200'
          }`}
        >
          <div className="flex items-start gap-3">
            <Gift
              size={28}
              className={bookCreditMultiplier > 1 ? 'text-amber-600' : 'text-indigo-500'}
            />
            <div>
              <h3
                className={`font-bold text-lg mb-1 ${
                  bookCreditMultiplier > 1 ? 'text-amber-900' : 'text-indigo-900'
                }`}
              >
                {t.rewardTitle}
              </h3>
              <p className={bookCreditMultiplier > 1 ? 'text-amber-800' : 'text-gray-700'}>
                {t.rewardBody}
              </p>
            </div>
          </div>
        </div>

        {/* Features */}
        <div className="bg-gradient-to-r from-indigo-50 to-indigo-50 rounded-2xl p-6 mb-8">
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
            className="px-8 py-3 bg-indigo-500 text-white rounded-lg font-semibold hover:bg-indigo-600 transition-colors"
          >
            {t.createStory}
          </button>
        </div>
      </div>
    </div>
  );
}
