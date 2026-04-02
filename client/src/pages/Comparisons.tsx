import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowRight, Shield, Trophy, ChevronRight } from 'lucide-react';
import { comparisons } from '@/constants/comparisonData';

const pageTexts: Record<string, {
  heroTitle: string;
  heroSubtitle: string;
  comparisonsTitle: string;
  listiclesTitle: string;
  viewComparison: string;
  viewRanking: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
}> = {
  en: {
    heroTitle: 'MagicalStory Compared',
    heroSubtitle: 'Honest comparisons of MagicalStory with other personalized children\'s book platforms. We acknowledge competitor strengths — choose what fits your family best.',
    comparisonsTitle: '1-on-1 Comparisons',
    listiclesTitle: 'Roundup Rankings',
    viewComparison: 'View comparison',
    viewRanking: 'View ranking',
    ctaTitle: 'See the Difference Yourself',
    ctaSubtitle: 'Your first story is free — no credit card needed. Compare the quality with any competitor.',
    ctaButton: 'Create Your Free Story',
  },
  de: {
    heroTitle: 'MagicalStory im Vergleich',
    heroSubtitle: 'Ehrliche Vergleiche von MagicalStory mit anderen personalisierten Kinderbuch-Plattformen. Wir erkennen die Stärken der Mitbewerber an — wähle, was am besten zu deiner Familie passt.',
    comparisonsTitle: '1-gegen-1 Vergleiche',
    listiclesTitle: 'Ranking-Übersichten',
    viewComparison: 'Vergleich ansehen',
    viewRanking: 'Ranking ansehen',
    ctaTitle: 'Überzeuge dich selbst',
    ctaSubtitle: 'Deine erste Geschichte ist gratis — keine Kreditkarte nötig. Vergleiche die Qualität mit jedem Mitbewerber.',
    ctaButton: 'Gratis-Geschichte erstellen',
  },
  fr: {
    heroTitle: 'MagicalStory en comparaison',
    heroSubtitle: 'Comparaisons honnêtes de MagicalStory avec d\'autres plateformes de livres pour enfants personnalisés. Nous reconnaissons les forces des concurrents — choisissez ce qui convient le mieux à votre famille.',
    comparisonsTitle: 'Comparaisons 1 contre 1',
    listiclesTitle: 'Classements',
    viewComparison: 'Voir la comparaison',
    viewRanking: 'Voir le classement',
    ctaTitle: 'Voyez la différence vous-même',
    ctaSubtitle: 'Votre première histoire est gratuite — aucune carte de crédit requise. Comparez la qualité avec n\'importe quel concurrent.',
    ctaButton: 'Créer votre histoire gratuite',
  },
};

const competitorDescriptions: Record<string, Record<string, string>> = {
  wonderbly: {
    en: 'The template giant (11M+ books, Penguin Random House)',
    de: 'Der Vorlagen-Riese (11 Mio.+ Bücher, Penguin Random House)',
    fr: 'Le géant des modèles (11M+ livres, Penguin Random House)',
  },
  'hooray-heroes': {
    en: 'The emotional gifting specialists (3M+ books)',
    de: 'Die Spezialisten für emotionale Geschenke (3 Mio.+ Bücher)',
    fr: 'Les spécialistes des cadeaux émotionnels (3M+ livres)',
  },
  librio: {
    en: 'The Swiss classic (sustainability, Globi books)',
    de: 'Der Schweizer Klassiker (Nachhaltigkeit, Globi-Bücher)',
    fr: 'Le classique suisse (durabilité, livres Globi)',
  },
  framily: {
    en: 'The licensed character specialist (PAW Patrol, Disney)',
    de: 'Der Spezialist für lizenzierte Figuren (PAW Patrol, Disney)',
    fr: 'Le spécialiste des personnages sous licence (PAW Patrol, Disney)',
  },
  'lullaby-ink': {
    en: 'The budget AI option ($5/story)',
    de: 'Die günstige KI-Option ($5/Geschichte)',
    fr: 'L\'option IA économique (5$/histoire)',
  },
  lovetoread: {
    en: 'The education-focused AI platform (K-5 reading levels)',
    de: 'Die bildungsfokussierte KI-Plattform (K-5 Lesestufen)',
    fr: 'La plateforme IA éducative (niveaux de lecture K-5)',
  },
  'beste-personalisierte-kinderbuecher': {
    en: 'Top 5 personalized children\'s book platforms for Swiss families',
    de: 'Top 5 personalisierte Kinderbuch-Plattformen für Schweizer Familien',
    fr: 'Top 5 des plateformes de livres personnalisés pour les familles suisses',
  },
  'beste-ki-kinderbuch-generatoren': {
    en: 'Top 6 AI-powered children\'s book generators reviewed',
    de: 'Top 6 KI-Kinderbuch-Generatoren im Test',
    fr: 'Top 6 des générateurs de livres pour enfants par IA testés',
  },
};

export default function Comparisons() {
  const { language } = useLanguage();
  const t = pageTexts[language] || pageTexts.en;

  const oneOnOne = comparisons.filter((c) => !c.isListicle);
  const listicles = comparisons.filter((c) => c.isListicle);

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Hero */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-indigo-50 mb-5">
            <Shield size={28} className="text-indigo-500" />
          </div>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-4">
            {t.heroTitle}
          </h1>
          <p className="text-stone-500 text-lg max-w-xl mx-auto">{t.heroSubtitle}</p>
        </div>
      </div>

      <div className="flex-1 max-w-4xl mx-auto px-4 py-10 w-full">
        {/* 1-on-1 Comparisons */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
            {t.comparisonsTitle}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {oneOnOne.map((comp) => {
              const lang = language as 'en' | 'de' | 'fr';
              const desc = competitorDescriptions[comp.id]?.[language] || competitorDescriptions[comp.id]?.en || '';
              return (
                <Link
                  key={comp.id}
                  to={`/vergleich/${comp.id}`}
                  className="bg-white rounded-2xl shadow-sm border border-stone-100 p-5 hover:shadow-md hover:border-indigo-200 transition-all group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Shield size={18} className="text-indigo-500" />
                    <h3 className="font-semibold text-stone-800 group-hover:text-indigo-500 transition-colors text-sm">
                      {comp.title[lang] || comp.title.en}
                    </h3>
                  </div>
                  <p className="text-xs text-stone-500 mb-3">{desc}</p>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-indigo-500">
                    {t.viewComparison} <ChevronRight size={12} />
                  </span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Listicle Rankings */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">
            {t.listiclesTitle}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {listicles.map((comp) => {
              const lang = language as 'en' | 'de' | 'fr';
              const desc = competitorDescriptions[comp.id]?.[language] || competitorDescriptions[comp.id]?.en || '';
              return (
                <Link
                  key={comp.id}
                  to={`/vergleich/${comp.id}`}
                  className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6 hover:shadow-md hover:border-amber-200 transition-all group"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Trophy size={18} className="text-amber-500" />
                    <h3 className="font-semibold text-stone-800 group-hover:text-amber-600 transition-colors text-sm">
                      {comp.title[lang] || comp.title.en}
                    </h3>
                  </div>
                  <p className="text-xs text-stone-500 mb-3">{desc}</p>
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
                    {t.viewRanking} <ChevronRight size={12} />
                  </span>
                </Link>
              );
            })}
          </div>
        </div>

        {/* CTA */}
        <div className="bg-indigo-500 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-500 font-semibold hover:bg-indigo-50 transition-colors"
          >
            {t.ctaButton} <ArrowRight size={18} />
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
