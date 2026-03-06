import { useState } from 'react';
import { Settings, ChevronRight, ChevronDown, User, Users, Book, Palette, Globe, FileText } from 'lucide-react';
import type { RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { StoryLanguageCode, LanguageLevel } from '@/types/story';

export interface GenerationSettings {
  storyCategory?: 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'custom' | '';
  storyTopic?: string;
  storyTheme?: string;
  storyTypeName?: string;
  storyDetails?: string;
  artStyle?: string;
  language?: StoryLanguageCode;
  languageLevel?: LanguageLevel;
  pages?: number;
  dedication?: string;
  characters?: Array<{ id: number; name: string; isMain?: boolean }>;
  mainCharacters?: number[];
  relationships?: RelationshipMap;
  relationshipTexts?: RelationshipTextMap;
  season?: string;
  userLocation?: { city: string | null; region: string | null; country: string | null } | null;
}

interface GenerationSettingsPanelProps {
  settings: GenerationSettings;
  language: string;
}

const categoryLabels: Record<string, Record<string, string>> = {
  en: {
    adventure: 'Adventure',
    'life-challenge': 'Life Challenge',
    educational: 'Educational',
    historical: 'Historical',
  },
  de: {
    adventure: 'Abenteuer',
    'life-challenge': 'Lebensherausforderung',
    educational: 'Bildung',
    historical: 'Historisch',
  },
  fr: {
    adventure: 'Aventure',
    'life-challenge': 'Défi de vie',
    educational: 'Éducatif',
    historical: 'Historique',
  },
};

const levelLabels: Record<string, Record<string, string>> = {
  en: {
    '1st-grade': 'Picture Book (1st Grade)',
    standard: 'Standard',
    advanced: 'Advanced',
  },
  de: {
    '1st-grade': 'Bilderbuch (1. Klasse)',
    standard: 'Standard',
    advanced: 'Fortgeschritten',
  },
  fr: {
    '1st-grade': 'Livre illustré (1ère année)',
    standard: 'Standard',
    advanced: 'Avancé',
  },
};

const languageLabels: Record<string, string> = {
  'de-CH': 'Schweizerdeutsch',
  'de-DE': 'Deutsch (Deutschland)',
  'en': 'English',
  'fr': 'Français',
};

export function GenerationSettingsPanel({ settings, language }: GenerationSettingsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const t = (key: string) => {
    const labels: Record<string, Record<string, string>> = {
      en: {
        title: 'Story Info',
        category: 'Category',
        topic: 'Topic',
        theme: 'Theme',
        storyType: 'Story Type',
        storyDetails: 'Story Idea',
        artStyle: 'Art Style',
        language: 'Language',
        readingLevel: 'Reading Level',
        pages: 'Length',
        dedication: 'Dedication',
        mainCharacters: 'Main Characters',
        otherCharacters: 'Other Characters',
        relationships: 'Relationships',
        season: 'Season',
        location: 'Location',
        noData: 'Not specified',
        spring: 'Spring',
        summer: 'Summer',
        autumn: 'Autumn',
        winter: 'Winter',
      },
      de: {
        title: 'Story-Info',
        category: 'Kategorie',
        topic: 'Thema',
        theme: 'Thema',
        storyType: 'Story-Typ',
        storyDetails: 'Story-Idee',
        artStyle: 'Kunststil',
        language: 'Sprache',
        readingLevel: 'Lesestufe',
        pages: 'Länge',
        dedication: 'Widmung',
        mainCharacters: 'Hauptfiguren',
        otherCharacters: 'Andere Figuren',
        relationships: 'Beziehungen',
        season: 'Jahreszeit',
        location: 'Ort',
        noData: 'Nicht angegeben',
        spring: 'Frühling',
        summer: 'Sommer',
        autumn: 'Herbst',
        winter: 'Winter',
      },
      fr: {
        title: 'Info histoire',
        category: 'Catégorie',
        topic: 'Sujet',
        theme: 'Thème',
        storyType: 'Type d\'histoire',
        storyDetails: 'Idée d\'histoire',
        artStyle: 'Style artistique',
        language: 'Langue',
        readingLevel: 'Niveau de lecture',
        pages: 'Longueur',
        dedication: 'Dédicace',
        mainCharacters: 'Personnages principaux',
        otherCharacters: 'Autres personnages',
        relationships: 'Relations',
        season: 'Saison',
        location: 'Lieu',
        noData: 'Non spécifié',
        spring: 'Printemps',
        summer: 'Été',
        autumn: 'Automne',
        winter: 'Hiver',
      },
    };
    return (labels[language] || labels.en)[key] || key;
  };

  const getCategoryLabel = (cat: string) => {
    return (categoryLabels[language] || categoryLabels.en)[cat] || cat;
  };

  const getLevelLabel = (level: string) => {
    return (levelLabels[language] || levelLabels.en)[level] || level;
  };

  const renderValue = (value: string | number | undefined, fallback?: string) => {
    if (value === undefined || value === null || value === '') {
      return <span className="text-gray-400 italic">{fallback || t('noData')}</span>;
    }
    return <span className="text-gray-800">{value}</span>;
  };

  const mainCharacterIds = settings.mainCharacters || [];
  const mainChars = settings.characters?.filter(c => mainCharacterIds.includes(c.id)) || [];
  const otherChars = settings.characters?.filter(c => !mainCharacterIds.includes(c.id)) || [];

  // Get season label
  const getSeasonLabel = (season: string) => {
    return t(season) || season;
  };

  // Format location string
  const getLocationString = () => {
    if (!settings.userLocation) return null;
    const parts = [
      settings.userLocation.city,
      settings.userLocation.region,
      settings.userLocation.country
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  };

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg overflow-hidden">
      {/* Header - always visible */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-amber-100 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Settings size={16} className="text-amber-600" />
          <span className="font-medium text-amber-800">{t('title')}</span>
          <span className="text-xs bg-amber-200 text-amber-700 px-2 py-0.5 rounded">DEV</span>
        </div>
        {isExpanded ? (
          <ChevronDown size={18} className="text-amber-600" />
        ) : (
          <ChevronRight size={18} className="text-amber-600" />
        )}
      </button>

      {/* Expandable content */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-4">
          {/* 1. Main Characters */}
          {mainChars.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-2">
                <User size={12} />
                {t('mainCharacters')}
              </div>
              <div className="flex flex-wrap gap-2">
                {mainChars.map((char) => (
                  <div
                    key={char.id}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs bg-indigo-100 text-indigo-800 border border-indigo-200"
                  >
                    <User size={10} />
                    <span>{char.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 2. Other Characters */}
          {otherChars.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-2">
                <Users size={12} />
                {t('otherCharacters')}
              </div>
              <div className="flex flex-wrap gap-2">
                {otherChars.map((char) => (
                  <div
                    key={char.id}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-full text-xs bg-gray-100 text-gray-700 border border-gray-200"
                  >
                    <User size={10} />
                    <span>{char.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 3. Relationships - show relationship types with names */}
          {settings.relationships && Object.keys(settings.relationships).length > 0 && (
            <div>
              <div className="text-xs font-medium text-amber-700 mb-2">{t('relationships')}</div>
              <div className="text-xs bg-white/50 p-2 rounded border border-amber-100 space-y-1">
                {Object.entries(settings.relationships).map(([key, relationshipType]) => {
                  const [id1, id2] = key.split('-').map(id => parseInt(id, 10));
                  const char1 = settings.characters?.find(c => c.id === id1);
                  const char2 = settings.characters?.find(c => c.id === id2);
                  if (!char1 || !char2) return null;
                  return (
                    <div key={key} className="flex gap-2">
                      <span className="text-amber-600 font-medium whitespace-nowrap">
                        {char1.name} → {char2.name}:
                      </span>
                      <span className="text-gray-700">{relationshipType}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 4-6. Language, Reading Level, Length */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                <Globe size={12} />
                {t('language')}
              </div>
              <div className="text-sm">
                {settings.language ? languageLabels[settings.language] || settings.language : renderValue(undefined)}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">{t('readingLevel')}</div>
              <div className="text-sm">
                {settings.languageLevel ? getLevelLabel(settings.languageLevel) : renderValue(undefined)}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">{t('pages')}</div>
              <div className="text-sm">
                {settings.pages ? `${settings.pages} ${language === 'de' ? 'Seiten' : 'pages'}` : renderValue(undefined)}
              </div>
            </div>
          </div>

          {/* 7-9. Season, Location, Art Style */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">{t('season')}</div>
              <div className="text-sm">
                {settings.season ? getSeasonLabel(settings.season) : renderValue(undefined)}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">{t('location')}</div>
              <div className="text-sm">
                {getLocationString() || renderValue(undefined)}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                <Palette size={12} />
                {t('artStyle')}
              </div>
              <div className="text-sm capitalize">{renderValue(settings.artStyle)}</div>
            </div>
          </div>

          {/* 10. Story Idea/Details */}
          {settings.storyDetails && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                <FileText size={12} />
                {t('storyDetails')}
              </div>
              <div className="text-sm bg-white/50 p-2 rounded border border-amber-100 whitespace-pre-wrap">
                {settings.storyDetails}
              </div>
            </div>
          )}

          {/* Category & Theme (optional - for context) */}
          {(settings.storyCategory || settings.storyTheme || settings.storyTopic) && (
            <div className="grid grid-cols-2 gap-4 pt-2 border-t border-amber-100">
              {settings.storyCategory && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                    <Book size={12} />
                    {t('category')}
                  </div>
                  <div className="text-sm">{getCategoryLabel(settings.storyCategory)}</div>
                </div>
              )}
              {(settings.storyTheme || settings.storyTopic) && (
                <div>
                  <div className="text-xs font-medium text-amber-700 mb-1">
                    {settings.storyCategory === 'adventure' ? t('theme') : t('topic')}
                  </div>
                  <div className="text-sm">
                    {settings.storyCategory === 'adventure' ? settings.storyTheme : settings.storyTopic}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
