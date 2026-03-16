import { useState, useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowRight, ChevronRight, ChevronDown, Check, Clock, Gift, Lightbulb } from 'lucide-react';
import { occasions } from '@/constants/occasionData';
import {
  storyTypes,
  lifeChallenges,
  educationalTopics,
  historicalEvents,
} from '@/constants/storyTypes';
import type { LocalizedString } from '@/types/character';

type CategorySlug = 'adventure' | 'life-challenges' | 'educational' | 'historical';

const pageTexts: Record<string, {
  breadcrumbRoot: string;
  createButton: string;
  whyTitle: string;
  tipsTitle: string;
  themesTitle: string;
  themesSubtitle: string;
  deliveryTitle: string;
  faqTitle: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
  viewTheme: string;
}> = {
  en: {
    breadcrumbRoot: 'Occasions',
    createButton: 'Create Your Story Now',
    whyTitle: 'Why a Personalized Story?',
    tipsTitle: 'Gift Tips',
    themesTitle: 'Recommended Themes',
    themesSubtitle: 'Our best themes for this occasion',
    deliveryTitle: 'Delivery Timeline',
    faqTitle: 'Frequently Asked Questions',
    ctaTitle: 'Create Your Free Story',
    ctaSubtitle: 'Your child as the main character in their very own story. Try it free — no account needed.',
    ctaButton: 'Start Creating Now',
    viewTheme: 'View theme',
  },
  de: {
    breadcrumbRoot: 'Anlässe',
    createButton: 'Jetzt Geschichte erstellen',
    whyTitle: 'Warum ein personalisiertes Buch?',
    tipsTitle: 'Geschenk-Tipps',
    themesTitle: 'Empfohlene Themen',
    themesSubtitle: 'Unsere besten Themen für diesen Anlass',
    deliveryTitle: 'Lieferzeit',
    faqTitle: 'Häufige Fragen',
    ctaTitle: 'Erstelle deine Gratis-Geschichte',
    ctaSubtitle: 'Dein Kind als Hauptfigur in seiner eigenen Geschichte. Jetzt kostenlos testen — kein Konto nötig.',
    ctaButton: 'Jetzt starten',
    viewTheme: 'Thema ansehen',
  },
  fr: {
    breadcrumbRoot: 'Occasions',
    createButton: 'Créer votre histoire',
    whyTitle: 'Pourquoi un livre personnalisé ?',
    tipsTitle: 'Conseils cadeaux',
    themesTitle: 'Thèmes recommandés',
    themesSubtitle: 'Nos meilleurs thèmes pour cette occasion',
    deliveryTitle: 'Délai de livraison',
    faqTitle: 'Questions fréquentes',
    ctaTitle: 'Créez votre histoire gratuite',
    ctaSubtitle: 'Votre enfant comme personnage principal de sa propre histoire. Essayez gratuitement — aucun compte requis.',
    ctaButton: 'Commencer maintenant',
    viewTheme: 'Voir le thème',
  },
};

function getThemeInfo(themeId: string, category: CategorySlug): { name: LocalizedString; emoji: string } | null {
  switch (category) {
    case 'adventure': {
      const t = storyTypes.find(s => s.id === themeId);
      return t ? { name: t.name, emoji: t.emoji } : null;
    }
    case 'life-challenges': {
      const c = lifeChallenges.find(c => c.id === themeId);
      return c ? { name: c.name, emoji: c.emoji } : null;
    }
    case 'educational': {
      const t = educationalTopics.find(t => t.id === themeId);
      return t ? { name: t.name, emoji: t.emoji } : null;
    }
    case 'historical': {
      const e = historicalEvents.find(e => e.id === themeId);
      return e ? { name: e.name, emoji: e.emoji } : null;
    }
    default:
      return null;
  }
}

export default function OccasionPage() {
  const { occasionSlug } = useParams<{ occasionSlug: string }>();
  const { language } = useLanguage();
  const t = pageTexts[language] || pageTexts.en;
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const occasion = useMemo(() => {
    return occasions.find(o => o.id === occasionSlug) || null;
  }, [occasionSlug]);

  if (!occasion) {
    return <Navigate to="/anlaesse" replace />;
  }

  const name = occasion.name[language] || occasion.name.en;
  const title = occasion.title[language] || occasion.title.en;
  const description = occasion.description[language] || occasion.description.en;
  const intro = occasion.intro[language] || occasion.intro.en;
  const tips = occasion.tips[language] || occasion.tips.en;
  const deliveryNote = occasion.deliveryNote[language] || occasion.deliveryNote.en;
  const faq = occasion.faq;

  const themeCards = occasion.recommendedThemes
    .map(rt => {
      const info = getThemeInfo(rt.id, rt.category);
      if (!info) return null;
      return { ...rt, name: info.name[language] || info.name.en, emoji: info.emoji };
    })
    .filter(Boolean) as { id: string; category: CategorySlug; name: string; emoji: string }[];

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Breadcrumb */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-4 pb-0">
          <nav className="flex items-center gap-1.5 text-sm text-stone-500">
            <Link to="/anlaesse" className="hover:text-indigo-600 transition-colors">{t.breadcrumbRoot}</Link>
            <ChevronRight size={14} className="text-stone-300" />
            <span className="text-stone-800 font-medium">{name}</span>
          </nav>
        </div>
      </div>

      {/* Hero Section */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-3xl mx-auto px-4 pt-10 pb-10 text-center">
          <span className="text-6xl block mb-5">{occasion.emoji}</span>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-4">{title}</h1>
          <p className="text-stone-500 text-lg max-w-xl mx-auto mb-6">{description}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-8 py-3.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 transition-colors text-lg"
          >
            {t.createButton} <ArrowRight size={20} />
          </Link>
        </div>
      </div>

      <div className="flex-1 max-w-4xl mx-auto px-4 py-10 w-full">
        {/* Why Section */}
        <div className="mb-12">
          <h2 className="font-title text-xl font-bold text-stone-900 mb-5 text-center">{t.whyTitle}</h2>
          <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6 md:p-8">
            <p className="text-stone-600 leading-relaxed">{intro}</p>
          </div>
        </div>

        {/* Gift Tips */}
        <div className="mb-12">
          <div className="flex items-center justify-center gap-2 mb-5">
            <Gift size={20} className="text-indigo-600" />
            <h2 className="font-title text-xl font-bold text-stone-900">{t.tipsTitle}</h2>
          </div>
          <div className="bg-white rounded-2xl shadow-sm border border-stone-100 p-6">
            <div className="space-y-3">
              {tips.map((tip, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-indigo-50 flex items-center justify-center mt-0.5">
                    <Check size={14} className="text-indigo-600" />
                  </div>
                  <span className="text-stone-700">{tip}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recommended Themes */}
        {themeCards.length > 0 && (
          <div className="mb-12">
            <div className="text-center mb-5">
              <h2 className="font-title text-xl font-bold text-stone-900 mb-1">{t.themesTitle}</h2>
              <p className="text-sm text-stone-500">{t.themesSubtitle}</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {themeCards.map((theme) => (
                <Link
                  key={`${theme.category}-${theme.id}`}
                  to={`/themes/${theme.category}/${theme.id}`}
                  className="bg-white rounded-2xl shadow-sm border border-stone-100 p-4 text-center hover:shadow-md hover:border-indigo-200 transition-all group"
                >
                  <span className="text-3xl block mb-2">{theme.emoji}</span>
                  <span className="text-sm font-medium text-stone-700 group-hover:text-indigo-600 transition-colors">
                    {theme.name}
                  </span>
                  <span className="block text-xs text-stone-400 mt-1 group-hover:text-indigo-400 transition-colors">
                    {t.viewTheme} &rarr;
                  </span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Delivery Note */}
        <div className="mb-12">
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-5 md:p-6 flex items-start gap-4">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
              <Clock size={20} className="text-amber-700" />
            </div>
            <div>
              <h3 className="font-semibold text-amber-900 mb-1">{t.deliveryTitle}</h3>
              <p className="text-amber-800 text-sm">{deliveryNote}</p>
            </div>
          </div>
        </div>

        {/* FAQ Section */}
        {faq.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-center gap-2 mb-5">
              <Lightbulb size={20} className="text-indigo-600" />
              <h2 className="font-title text-xl font-bold text-stone-900">{t.faqTitle}</h2>
            </div>
            <div className="space-y-3">
              {faq.map((item, i) => {
                const question = item.q[language] || item.q.en;
                const answer = item.a[language] || item.a.en;
                const isOpen = openFaq === i;
                return (
                  <div
                    key={i}
                    className="bg-white rounded-2xl shadow-sm border border-stone-100 overflow-hidden"
                  >
                    <button
                      onClick={() => setOpenFaq(isOpen ? null : i)}
                      className="w-full flex items-center justify-between p-5 text-left hover:bg-stone-50 transition-colors"
                    >
                      <span className="font-medium text-stone-800 pr-4">{question}</span>
                      <ChevronDown
                        size={18}
                        className={`text-stone-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-5 pb-5 pt-0">
                        <p className="text-stone-600 text-sm leading-relaxed">{answer}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* CTA Section */}
        <div className="bg-indigo-600 rounded-2xl p-8 md:p-12 text-center text-white">
          <h2 className="font-title text-2xl md:text-3xl font-bold mb-3">{t.ctaTitle}</h2>
          <p className="text-indigo-100 mb-6 max-w-lg mx-auto">{t.ctaSubtitle}</p>
          <Link
            to="/try"
            className="inline-flex items-center gap-2 px-8 py-3 rounded-lg bg-white text-indigo-600 font-semibold hover:bg-indigo-50 transition-colors"
          >
            {t.ctaButton} <ArrowRight size={18} />
          </Link>
        </div>
      </div>

      <Footer />
    </div>
  );
}
