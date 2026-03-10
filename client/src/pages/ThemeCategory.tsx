import { useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { useLanguage } from '@/context/LanguageContext';
import { Navigation, Footer } from '@/components/common';
import { ArrowRight, ChevronRight } from 'lucide-react';
import {
  storyTypes,
  lifeChallenges,
  educationalTopics,
  historicalEvents,
  adventureThemeGroups,
  lifeChallengeGroups,
  educationalGroups,
  historicalEventGroups,
  getStoryTypesByGroup,
  getLifeChallengesByGroup,
  getEducationalTopicsByGroup,
  getHistoricalEventsByGroup,
} from '@/constants/storyTypes';
import type { AdventureThemeGroupId } from '@/types/story';
import type { LocalizedString } from '@/types/character';

type CategorySlug = 'adventure' | 'life-challenges' | 'educational' | 'historical';

interface ThemeItem {
  id: string;
  name: LocalizedString;
  emoji: string;
  year?: number | string;
  mainPerson?: string;
}

interface GroupItem {
  id: string;
  name: LocalizedString;
  icon?: string;
}

interface CategoryConfig {
  emoji: string;
  name: Record<string, string>;
  description: Record<string, string>;
  groups: GroupItem[];
  getThemesByGroup: (groupId: string) => ThemeItem[];
  totalCount: number;
}

const texts: Record<string, {
  breadcrumbRoot: string;
  ctaTitle: string;
  ctaSubtitle: string;
  ctaButton: string;
  create: string;
}> = {
  en: {
    breadcrumbRoot: 'Themes',
    ctaTitle: 'Ready to create?',
    ctaSubtitle: 'Pick any theme above and create a personalized story for your child in minutes.',
    ctaButton: 'Start Creating',
    create: 'Create',
  },
  de: {
    breadcrumbRoot: 'Themen',
    ctaTitle: 'Bereit zum Erstellen?',
    ctaSubtitle: 'Wähle ein Thema und erstelle eine personalisierte Geschichte für dein Kind in wenigen Minuten.',
    ctaButton: 'Jetzt starten',
    create: 'Erstellen',
  },
  fr: {
    breadcrumbRoot: 'Thèmes',
    ctaTitle: 'Prêt à créer ?',
    ctaSubtitle: 'Choisissez un thème ci-dessus et créez une histoire personnalisée pour votre enfant en quelques minutes.',
    ctaButton: 'Commencer',
    create: 'Créer',
  },
};

function getCategoryConfig(category: CategorySlug): CategoryConfig | null {
  switch (category) {
    case 'adventure':
      return {
        emoji: '\u{1F5E1}\u{FE0F}',
        name: { en: 'Adventure Themes', de: 'Abenteuer-Themen', fr: 'Thèmes d\'aventure' },
        description: {
          en: 'From pirates and knights to wizards and space explorers — choose the perfect adventure setting for your child\'s personalized story.',
          de: 'Von Piraten und Rittern bis zu Zauberern und Weltraum-Entdeckern — wähle das perfekte Abenteuer-Setting für die personalisierte Geschichte deines Kindes.',
          fr: 'Des pirates et chevaliers aux sorciers et explorateurs de l\'espace — choisissez le cadre d\'aventure parfait pour l\'histoire personnalisée de votre enfant.',
        },
        groups: adventureThemeGroups
          .filter(g => g.id !== 'popular' && g.id !== 'custom')
          .map(g => ({ id: g.id, name: g.name })),
        getThemesByGroup: (groupId: string) =>
          getStoryTypesByGroup(groupId as AdventureThemeGroupId).filter(t => t.id !== 'custom'),
        totalCount: storyTypes.filter(t => t.id !== 'custom').length,
      };
    case 'life-challenges':
      return {
        emoji: '\u{1F4AA}',
        name: { en: 'Life Skills Themes', de: 'Lebenskompetenz-Themen', fr: 'Thèmes compétences de vie' },
        description: {
          en: 'Help your child navigate everyday challenges — from potty training and first school days to dealing with emotions and family changes.',
          de: 'Hilf deinem Kind, alltägliche Herausforderungen zu meistern — vom Töpfchentraining und ersten Schultag bis zum Umgang mit Emotionen und familiären Veränderungen.',
          fr: 'Aidez votre enfant à surmonter les défis quotidiens — de l\'apprentissage du pot aux premiers jours d\'école, en passant par la gestion des émotions.',
        },
        groups: lifeChallengeGroups
          .filter(g => g.id !== 'popular')
          .map(g => ({ id: g.id, name: g.name })),
        getThemesByGroup: (groupId: string) => getLifeChallengesByGroup(groupId),
        totalCount: lifeChallenges.length,
      };
    case 'educational':
      return {
        emoji: '\u{1F4DA}',
        name: { en: 'Learning Themes', de: 'Lern-Themen', fr: 'Thèmes d\'apprentissage' },
        description: {
          en: 'Make learning fun with personalized stories about letters, numbers, science, animals, and more. Your child discovers new concepts on every page.',
          de: 'Mach Lernen zum Spaß mit personalisierten Geschichten über Buchstaben, Zahlen, Wissenschaft, Tiere und mehr. Dein Kind entdeckt auf jeder Seite neue Konzepte.',
          fr: 'Rendez l\'apprentissage amusant avec des histoires personnalisées sur les lettres, les nombres, les sciences, les animaux et plus. Votre enfant découvre de nouveaux concepts à chaque page.',
        },
        groups: educationalGroups
          .filter(g => g.id !== 'popular')
          .map(g => ({ id: g.id, name: g.name })),
        getThemesByGroup: (groupId: string) => getEducationalTopicsByGroup(groupId),
        totalCount: educationalTopics.length,
      };
    case 'historical':
      return {
        emoji: '\u{1F3DB}\u{FE0F}',
        name: { en: 'History Themes', de: 'Geschichts-Themen', fr: 'Thèmes historiques' },
        description: {
          en: 'Travel through time! Your child witnesses real historical events — from ancient pyramids to the moon landing and beyond.',
          de: 'Reise durch die Zeit! Dein Kind erlebt echte historische Ereignisse — von den Pyramiden bis zur Mondlandung und darüber hinaus.',
          fr: 'Voyagez dans le temps ! Votre enfant est témoin de vrais événements historiques — des pyramides à l\'alunissage et au-delà.',
        },
        groups: historicalEventGroups
          .filter(g => g.id !== 'popular')
          .map(g => ({ id: g.id, name: g.name, icon: g.icon })),
        getThemesByGroup: (groupId: string) => getHistoricalEventsByGroup(groupId),
        totalCount: historicalEvents.length,
      };
    default:
      return null;
  }
}

export default function ThemeCategory() {
  const { category } = useParams<{ category: string }>();
  const { language } = useLanguage();
  const t = texts[language] || texts.en;

  const config = useMemo(() => {
    if (!category) return null;
    return getCategoryConfig(category as CategorySlug);
  }, [category]);

  if (!config) {
    return <Navigate to="/themes" replace />;
  }

  const categoryName = config.name[language] || config.name.en;

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col">
      <Navigation currentStep={0} />

      {/* Header */}
      <div className="bg-white border-b border-stone-100">
        <div className="max-w-4xl mx-auto px-4 pt-10 pb-8 text-center">
          <span className="text-5xl block mb-4">{config.emoji}</span>
          <h1 className="font-title text-3xl md:text-4xl font-bold text-stone-900 mb-3">{categoryName}</h1>
          <p className="text-stone-500 text-lg max-w-2xl mx-auto">
            {config.description[language] || config.description.en}
          </p>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="max-w-5xl mx-auto px-4 pt-6 w-full">
        <nav className="flex items-center gap-1.5 text-sm text-stone-500">
          <Link to="/themes" className="hover:text-indigo-600 transition-colors">{t.breadcrumbRoot}</Link>
          <ChevronRight size={14} className="text-stone-300" />
          <span className="text-stone-800 font-medium">{categoryName}</span>
        </nav>
      </div>

      {/* Subcategory sections */}
      <div className="flex-1 max-w-5xl mx-auto px-4 py-8 w-full">
        <div className="space-y-10">
          {config.groups.map((group) => {
            const themes = config.getThemesByGroup(group.id);
            if (themes.length === 0) return null;

            const groupIcon = 'icon' in group ? (group as { icon?: string }).icon : undefined;

            return (
              <div key={group.id}>
                <div className="flex items-center gap-2 mb-4">
                  {groupIcon && <span className="text-lg">{groupIcon}</span>}
                  <h2 className="font-title text-lg font-semibold text-stone-800">
                    {group.name[language] || group.name.en}
                  </h2>
                  <span className="text-sm text-stone-400">({themes.length})</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  {themes.map((theme) => (
                    <Link
                      key={theme.id}
                      to={`/themes/${category}/${theme.id}`}
                      className="bg-white rounded-2xl shadow-sm border border-stone-100 px-4 py-3.5 flex items-center gap-3 hover:shadow-md hover:border-indigo-200 transition-all group"
                    >
                      <span className="text-2xl flex-shrink-0">{theme.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-stone-700 group-hover:text-indigo-600 transition-colors block truncate">
                          {theme.name[language] || theme.name.en}
                        </span>
                        {category === 'historical' && 'year' in theme && (
                          <span className="text-xs text-stone-400">{theme.year}</span>
                        )}
                      </div>
                      <span className="text-xs text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 flex-shrink-0">
                        {t.create} <ArrowRight size={12} />
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {/* CTA Section */}
        <div className="mt-16 bg-indigo-600 rounded-2xl p-8 md:p-12 text-center text-white">
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
