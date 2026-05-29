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

  // ── Shared style tokens ───────────────────────────────────────────────
  // One card pattern reused across every section so the page has a
  // consistent rhythm: white surface, subtle shadow, hairline border,
  // generous padding, equal vertical spacing.
  const card = 'bg-white rounded-2xl shadow-sm border border-gray-100 p-6 mb-6';
  const sectionHeader = 'flex items-center gap-2 mb-4';
  const sectionIcon = 'text-indigo-500';
  const sectionTitle = 'text-xl md:text-2xl font-bold text-gray-800';
  // Tables sit inside cards — they don't need their own shadow/rounding.
  // Just a thin top border on the header row + dividers between rows.
  const tableHeaderRow = 'bg-indigo-500 text-white text-sm font-semibold';
  const tableCell = 'p-3';
  const tableBodyRow = 'border-t border-gray-100';

  return (
    <div className="min-h-screen bg-gray-50">
      <Navigation currentStep={0} />

      <div className="px-4 md:px-8 py-8 max-w-3xl mx-auto">
        {/* Back button */}
        <button
          onClick={() => navigate('/stories')}
          className="flex items-center gap-2 text-gray-600 hover:text-indigo-500 mb-6 transition-colors"
        >
          <ArrowLeft size={20} />
          {t.backToStories}
        </button>

        {/* Page title (no card — conventional page header) */}
        <div className="text-center mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-800 mb-3">{t.title}</h1>
          <p className="text-lg text-gray-600">{t.subtitle}</p>
        </div>

        {/* ── Credits card ──────────────────────────────────────────────── */}
        <section className={card}>
          <div className={sectionHeader}>
            <Coins size={22} className={sectionIcon} />
            <h2 className={sectionTitle}>{t.creditsTitle}</h2>
          </div>
          <p className="text-gray-600 mb-5">{t.creditsIntro}</p>
          <div className="rounded-lg overflow-hidden border border-gray-200">
            <div className={`grid grid-cols-2 ${tableHeaderRow}`}>
              <div className={tableCell}>{t.creditsTableCredits}</div>
              <div className={`${tableCell} text-center border-l border-indigo-400`}>{t.creditsTablePrice}</div>
            </div>
            {creditPackages.map((pkg) => (
              <div key={pkg.credits} className={`grid grid-cols-2 bg-white ${tableBodyRow}`}>
                <div className={`${tableCell} font-medium text-gray-700`}>{pkg.credits}</div>
                <div className={`${tableCell} text-center border-l border-gray-100 font-semibold text-gray-800`}>
                  CHF {pkg.amountCHF}.-
                </div>
              </div>
            ))}
          </div>
          <p className="text-sm text-gray-500 flex items-center gap-1.5 mt-4">
            <Sparkles size={14} className={sectionIcon} />
            {t.creditsNote}
          </p>
        </section>

        {/* ── Book pricing card ─────────────────────────────────────────── */}
        <section className={`${card} relative`}>
          {isLoading && (
            <div className="absolute inset-0 bg-white/60 flex items-center justify-center rounded-2xl z-10">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
            </div>
          )}
          <div className={sectionHeader}>
            <Book size={22} className={sectionIcon} />
            <h2 className={sectionTitle}>{t.bookTitle}</h2>
          </div>
          <p className="text-gray-600 mb-1">{t.bookSubtitle}</p>
          <p className="text-sm text-gray-500 mb-5">{t.internationalNote}</p>
          <div className="rounded-lg overflow-hidden border border-gray-200">
            <div className={`grid grid-cols-3 ${tableHeaderRow}`}>
              <div className={tableCell}>{t.pages}</div>
              <div className={`${tableCell} text-center border-l border-indigo-400`}>
                <div className="flex flex-col items-center gap-0.5">
                  <Book size={18} />
                  <span>{t.softcover}</span>
                  <span className="text-xs font-normal text-indigo-100">{t.softcoverSize}</span>
                </div>
              </div>
              <div className={`${tableCell} text-center border-l border-indigo-400`}>
                <div className="flex flex-col items-center gap-0.5">
                  <BookOpen size={18} />
                  <span>{t.hardcover}</span>
                  <span className="text-xs font-normal text-indigo-100">{t.hardcoverSize}</span>
                </div>
              </div>
            </div>
            {pricingTiers.map((tier) => (
              <div key={tier.label} className={`grid grid-cols-3 bg-white ${tableBodyRow}`}>
                <div className={`${tableCell} font-medium text-gray-700`}>{tier.label}</div>
                <div className={`${tableCell} text-center border-l border-gray-100 font-semibold text-gray-800`}>
                  CHF {tier.softcover}.-
                </div>
                <div className={`${tableCell} text-center border-l border-gray-100 font-semibold text-indigo-700`}>
                  CHF {tier.hardcover}.-
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Credit-back reward card ───────────────────────────────────── */}
        <section className={card}>
          <div className={sectionHeader}>
            <Gift size={22} className={sectionIcon} />
            <h2 className={sectionTitle}>{t.rewardTitle}</h2>
          </div>
          <p className="text-gray-600">{t.rewardBody}</p>
        </section>

        {/* ── Features card ─────────────────────────────────────────────── */}
        <section className={card}>
          <div className={sectionHeader}>
            <Check size={22} className={sectionIcon} />
            <h2 className={sectionTitle}>{t.features}</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {[t.feature1, t.feature2, t.feature3, t.feature4].map((feature) => (
              <div key={feature} className="flex items-center gap-2 text-gray-700">
                <Check size={18} className="text-indigo-500 shrink-0" />
                <span>{feature}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Combine note card ─────────────────────────────────────────── */}
        <section className={card}>
          <p className="text-gray-700 text-center">{t.combineNote}</p>
        </section>

        {/* CTA (no card — single action button) */}
        <div className="text-center mt-8">
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
