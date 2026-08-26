import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';

// The footer is the site's internal link architecture: it renders on all ~999
// pre-rendered pages, so every destination listed here is reachable from every
// page. Before 2026-08-25 it linked only 6 legal/support pages, which left
// /kinderbuch-erstellen with zero inbound internal links (0 impressions in 90
// days despite being indexable and in the sitemap) and buried /vergleich, whose
// AI-generator roundup is the best-ranking URL on the site.
const footerTexts = {
  en: {
    createHeading: 'Create',
    create: 'Create a book with AI',
    guides: 'Guides',
    themes: 'Themes',
    pricing: 'Pricing',
    tryFree: 'Try it free',
    discoverHeading: 'Discover',
    cities: 'Swiss cities',
    occasions: 'Occasions',
    gifts: 'Gift ideas',
    science: 'The research',
    compareHeading: 'Compare',
    comparisons: 'All comparisons',
    aiGenerators: 'Best AI book generators',
    personalised: 'Best personalized books',
    companyHeading: 'Company',
    about: 'About',
    faq: 'FAQ',
    contact: 'Contact',
    terms: 'Terms of Service',
    privacy: 'Privacy Policy',
    imprint: 'Imprint',
    tagline: 'Your child\'s own story — written and illustrated by AI, then yours to edit.',
    copyright: 'Magical Story. All rights reserved.',
  },
  de: {
    createHeading: 'Erstellen',
    create: 'Kinderbuch erstellen mit KI',
    guides: 'Ratgeber',
    themes: 'Themen',
    pricing: 'Preise',
    tryFree: 'Gratis ausprobieren',
    discoverHeading: 'Entdecken',
    cities: 'Schweizer Städte',
    occasions: 'Anlässe',
    gifts: 'Geschenkideen',
    science: 'Die Forschung',
    compareHeading: 'Vergleichen',
    comparisons: 'Alle Vergleiche',
    aiGenerators: 'Beste KI-Kinderbuch-Generatoren',
    personalised: 'Beste personalisierte Bücher',
    companyHeading: 'Unternehmen',
    about: 'Über uns',
    faq: 'FAQ',
    contact: 'Kontakt',
    terms: 'Nutzungsbedingungen',
    privacy: 'Datenschutz',
    imprint: 'Impressum',
    tagline: 'Die eigene Geschichte deines Kindes — von der KI geschrieben und illustriert, von dir bearbeitet.',
    copyright: 'Magical Story. Alle Rechte vorbehalten.',
  },
  fr: {
    createHeading: 'Créer',
    create: 'Créer un livre avec l\'IA',
    guides: 'Guides',
    themes: 'Thèmes',
    pricing: 'Tarifs',
    tryFree: 'Essayer gratuitement',
    discoverHeading: 'Découvrir',
    cities: 'Villes suisses',
    occasions: 'Occasions',
    gifts: 'Idées cadeaux',
    science: 'La recherche',
    compareHeading: 'Comparer',
    comparisons: 'Tous les comparatifs',
    aiGenerators: 'Meilleurs générateurs IA',
    personalised: 'Meilleurs livres personnalisés',
    companyHeading: 'Entreprise',
    about: 'À propos',
    faq: 'FAQ',
    contact: 'Contact',
    terms: 'Conditions d\'Utilisation',
    privacy: 'Confidentialité',
    imprint: 'Mentions légales',
    tagline: 'L\'histoire de votre enfant — écrite et illustrée par l\'IA, puis modifiable par vous.',
    copyright: 'Magical Story. Tous droits réservés.',
  },
};

const linkClass = 'hover:text-indigo-500 hover:underline';

export function Footer() {
  const { language } = useLanguage();
  const texts = footerTexts[language as keyof typeof footerTexts] || footerTexts.en;
  const currentYear = new Date().getFullYear();

  // Language is carried on the query string (?lang=en); the default (de) omits it,
  // matching the canonical URLs emitted by server/lib/seoMeta.js.
  const suffix = language && language !== 'de' ? `?lang=${language}` : '';
  const to = (path: string) => `${path}${suffix}`;

  const columns = [
    {
      heading: texts.createHeading,
      links: [
        { to: '/kinderbuch-erstellen', label: texts.create },
        { to: '/ratgeber', label: texts.guides },
        { to: '/themes', label: texts.themes },
        { to: '/pricing', label: texts.pricing },
        { to: '/try', label: texts.tryFree },
      ],
    },
    {
      heading: texts.discoverHeading,
      links: [
        { to: '/stadt', label: texts.cities },
        { to: '/anlass', label: texts.occasions },
        { to: '/geschenk', label: texts.gifts },
        { to: '/science', label: texts.science },
      ],
    },
    {
      heading: texts.compareHeading,
      links: [
        { to: '/vergleich/beste-ki-kinderbuch-generatoren', label: texts.aiGenerators },
        { to: '/vergleich/beste-personalisierte-kinderbuecher', label: texts.personalised },
        { to: '/vergleich', label: texts.comparisons },
      ],
    },
    {
      heading: texts.companyHeading,
      links: [
        { to: '/about', label: texts.about },
        { to: '/faq', label: texts.faq },
        { to: '/contact', label: texts.contact },
      ],
    },
  ];

  return (
    <footer className="bg-stone-100 border-t border-stone-200 px-4 pt-10 pb-4 text-sm text-stone-600">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-8">
          {columns.map((col) => (
            <div key={col.heading}>
              <h2 className="text-stone-900 font-semibold mb-3">{col.heading}</h2>
              <ul className="space-y-2">
                {col.links.map((link) => (
                  <li key={link.to}>
                    <Link to={to(link.to)} className={linkClass}>
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-8 text-stone-500 max-w-2xl">{texts.tagline}</p>

        <div className="mt-4 pt-4 border-t border-stone-200 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-4 flex-wrap">
            <Link to={to('/terms')} className={linkClass}>{texts.terms}</Link>
            <span className="text-stone-300">|</span>
            <Link to={to('/privacy')} className={linkClass}>{texts.privacy}</Link>
            <span className="text-stone-300">|</span>
            <Link to={to('/impressum')} className={linkClass}>{texts.imprint}</Link>
          </div>
          <div>
            © {currentYear} {texts.copyright}
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
