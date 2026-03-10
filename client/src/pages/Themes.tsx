import { Link } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { Compass, ArrowRight } from 'lucide-react';
import {
  storyTypes,
  lifeChallenges,
  educationalTopics,
  historicalEvents,
  popularAdventureThemeIds,
  popularLifeChallengeIds,
  popularEducationalTopicIds,
  popularHistoricalEventIds,
} from '@/constants/storyTypes';

const texts: Record<string, {
  title: string;
  subtitle: string;
  popularTitle: string;
  popularSubtitle: string;
  browseAll: string;
  themesLabel: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
}> = {
  en: {
    title: 'Story Themes',
    subtitle: 'Explore over 170 unique story themes across four categories. Each theme creates a one-of-a-kind personalized adventure for your child.',
    popularTitle: 'Popular Themes',
    popularSubtitle: 'Our most-loved themes across all categories',
    browseAll: 'Browse all',
    themesLabel: 'themes',
    ctaTitle: 'Create Your Free Story',
    ctaSubtitle: 'Choose any theme and create a personalized story in minutes. Your first story is completely free.',
    ctaButton: 'Start Creating',
  },
  de: {
    title: 'Story-Themen',
    subtitle: 'Entdecke über 170 einzigartige Story-Themen in vier Kategorien. Jedes Thema erschafft ein einzigartiges personalisiertes Abenteuer für dein Kind.',
    popularTitle: 'Beliebte Themen',
    popularSubtitle: 'Unsere beliebtesten Themen aus allen Kategorien',
    browseAll: 'Alle ansehen',
    themesLabel: 'Themen',
    ctaTitle: 'Erstelle deine Gratis-Geschichte',
    ctaSubtitle: 'Wähle ein Thema und erstelle eine personalisierte Geschichte in wenigen Minuten. Deine erste Geschichte ist komplett kostenlos.',
    ctaButton: 'Jetzt starten',
  },
  fr: {
    title: 'Thèmes d\'histoires',
    subtitle: 'Explorez plus de 170 thèmes uniques répartis en quatre catégories. Chaque thème crée une aventure personnalisée unique pour votre enfant.',
    popularTitle: 'Thèmes populaires',
    popularSubtitle: 'Nos thèmes les plus appréciés dans toutes les catégories',
    browseAll: 'Voir tout',
    themesLabel: 'thèmes',
    ctaTitle: 'Créez votre histoire gratuite',
    ctaSubtitle: 'Choisissez un thème et créez une histoire personnalisée en quelques minutes. Votre première histoire est entièrement gratuite.',
    ctaButton: 'Commencer',
  },
};

interface CategoryCardData {
  id: string;
  path: string;
  emoji: string;
  gradient: string;
  borderColor: string;
  name: Record<string, string>;
  description: Record<string, string>;
  count: number;
  popularIds: string[];
  getThemeName: (id: string) => string;
  getThemeEmoji: (id: string) => string;
}

export default function Themes() {
  const { language } = useLanguage();
  const t = texts[language] || texts.en;

  const categories: CategoryCardData[] = [
    {
      id: 'adventure',
      path: '/themes/adventure',
      emoji: '\u{1F5E1}\u{FE0F}',
      gradient: 'from-indigo-500 to-indigo-600',
      borderColor: 'border-stone-200',
      name: { en: 'Adventure', de: 'Abenteuer', fr: 'Aventure' },
      description: {
        en: 'Exciting journeys and heroic quests — pirates, knights, wizards, and more',
        de: 'Spannende Reisen und heldenhafte Abenteuer — Piraten, Ritter, Zauberer und mehr',
        fr: 'Voyages passionnants et quêtes héroïques — pirates, chevaliers, sorciers et plus',
      },
      count: storyTypes.filter(s => s.id !== 'custom').length,
      popularIds: popularAdventureThemeIds.slice(0, 6),
      getThemeName: (id) => storyTypes.find(s => s.id === id)?.name[language] || storyTypes.find(s => s.id === id)?.name.en || id,
      getThemeEmoji: (id) => storyTypes.find(s => s.id === id)?.emoji || '',
    },
    {
      id: 'life-challenges',
      path: '/themes/life-challenges',
      emoji: '\u{1F4AA}',
      gradient: 'from-indigo-500 to-indigo-600',
      borderColor: 'border-stone-200',
      name: { en: 'Life Skills', de: 'Lebenskompetenzen', fr: 'Compétences de vie' },
      description: {
        en: 'Help your child overcome everyday challenges with empowering stories',
        de: 'Hilf deinem Kind, alltägliche Herausforderungen mit stärkenden Geschichten zu meistern',
        fr: 'Aidez votre enfant à surmonter les défis quotidiens avec des histoires positives',
      },
      count: lifeChallenges.length,
      popularIds: popularLifeChallengeIds.slice(0, 6),
      getThemeName: (id) => lifeChallenges.find(c => c.id === id)?.name[language] || lifeChallenges.find(c => c.id === id)?.name.en || id,
      getThemeEmoji: (id) => lifeChallenges.find(c => c.id === id)?.emoji || '',
    },
    {
      id: 'educational',
      path: '/themes/educational',
      emoji: '\u{1F4DA}',
      gradient: 'from-indigo-500 to-indigo-600',
      borderColor: 'border-stone-200',
      name: { en: 'Learning', de: 'Lernen', fr: 'Apprentissage' },
      description: {
        en: 'Fun stories that teach something new — letters, numbers, science, and more',
        de: 'Lustige Geschichten, die etwas Neues lehren — Buchstaben, Zahlen, Wissenschaft und mehr',
        fr: 'Des histoires amusantes pour apprendre — lettres, nombres, sciences et plus',
      },
      count: educationalTopics.length,
      popularIds: popularEducationalTopicIds.slice(0, 6),
      getThemeName: (id) => educationalTopics.find(t => t.id === id)?.name[language] || educationalTopics.find(t => t.id === id)?.name.en || id,
      getThemeEmoji: (id) => educationalTopics.find(t => t.id === id)?.emoji || '',
    },
    {
      id: 'historical',
      path: '/themes/historical',
      emoji: '\u{1F3DB}\u{FE0F}',
      gradient: 'from-indigo-500 to-indigo-600',
      borderColor: 'border-stone-200',
      name: { en: 'History', de: 'Geschichte', fr: 'Histoire' },
      description: {
        en: 'Experience real historical events — from ancient times to the modern era',
        de: 'Erlebe echte historische Ereignisse — von der Antike bis zur Moderne',
        fr: 'Vivez de vrais événements historiques — de l\'Antiquité à l\'ère moderne',
      },
      count: historicalEvents.length,
      popularIds: popularHistoricalEventIds.slice(0, 6),
      getThemeName: (id) => historicalEvents.find(e => e.id === id)?.name[language] || historicalEvents.find(e => e.id === id)?.name.en || id,
      getThemeEmoji: (id) => historicalEvents.find(e => e.id === id)?.emoji || '',
    },
  ];

  // Collect 12 popular themes across all categories (3 from each)
  const popularThemes = [
    ...popularAdventureThemeIds.slice(0, 3).map(id => {
      const theme = storyTypes.find(s => s.id === id);
      return theme ? { id, name: theme.name[language] || theme.name.en, emoji: theme.emoji, path: `/themes/adventure/${id}` } : null;
    }),
    ...popularLifeChallengeIds.slice(0, 3).map(id => {
      const theme = lifeChallenges.find(c => c.id === id);
      return theme ? { id, name: theme.name[language] || theme.name.en, emoji: theme.emoji, path: `/themes/life-challenges/${id}` } : null;
    }),
    ...popularEducationalTopicIds.slice(0, 3).map(id => {
      const theme = educationalTopics.find(t => t.id === id);
      return theme ? { id, name: theme.name[language] || theme.name.en, emoji: theme.emoji, path: `/themes/educational/${id}` } : null;
    }),
    ...popularHistoricalEventIds.slice(0, 3).map(id => {
      const theme = historicalEvents.find(e => e.id === id);
      return theme ? { id, name: theme.name[language] || theme.name.en, emoji: theme.emoji, path: `/themes/historical/${id}` } : null;
    }),
  ].filter(Boolean) as { id: string; name: string; emoji: string; path: string }[];

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Header */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-10 pb-8 text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-50 mb-5">
            <Compass className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-3">{t.title}</h1>
          <p className="text-stone-500 text-lg max-w-2xl mx-auto">{t.subtitle}</p>
        </div>
      </div>

      <div className="flex-1 max-w-5xl mx-auto px-4 py-10 w-full">
        {/* Category Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-16">
          {categories.map((cat) => (
            <Link
              key={cat.id}
              to={cat.path}
              className={`bg-white rounded-2xl shadow-sm border ${cat.borderColor} overflow-hidden hover:shadow-md transition-shadow group`}
            >
              {/* Gradient top border */}
              <div className={`h-1.5 bg-gradient-to-r ${cat.gradient}`} />
              <div className="p-6">
                <div className="flex items-start gap-4 mb-4">
                  <span className="text-3xl">{cat.emoji}</span>
                  <div className="flex-1">
                    <h2 className="font-title text-xl font-bold text-stone-900 group-hover:text-indigo-600 transition-colors">
                      {cat.name[language] || cat.name.en}
                    </h2>
                    <p className="text-stone-500 text-sm mt-1">
                      {cat.description[language] || cat.description.en}
                    </p>
                  </div>
                </div>

                <div className="text-sm text-stone-400 mb-3">
                  {cat.count} {t.themesLabel}
                </div>

                {/* Popular theme pills */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {cat.popularIds.map((themeId) => (
                    <span
                      key={themeId}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-stone-50 text-xs text-stone-600 border border-stone-100"
                    >
                      <span>{cat.getThemeEmoji(themeId)}</span>
                      {cat.getThemeName(themeId)}
                    </span>
                  ))}
                </div>

                <span className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 group-hover:gap-2 transition-all">
                  {t.browseAll} <ArrowRight size={16} />
                </span>
              </div>
            </Link>
          ))}
        </div>

        {/* Popular Across All */}
        <div className="mb-16">
          <div className="text-center mb-8">
            <h2 className="font-title text-2xl font-bold text-stone-900 mb-2">{t.popularTitle}</h2>
            <p className="text-stone-500">{t.popularSubtitle}</p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {popularThemes.map((theme) => (
              <Link
                key={theme.id}
                to={theme.path}
                className="bg-white rounded-2xl shadow-sm border border-stone-100 p-4 text-center hover:shadow-md hover:border-indigo-200 transition-all group"
              >
                <span className="text-3xl block mb-2">{theme.emoji}</span>
                <span className="text-sm font-medium text-stone-700 group-hover:text-indigo-600 transition-colors">
                  {theme.name}
                </span>
              </Link>
            ))}
          </div>
        </div>

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
