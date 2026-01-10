import { useState } from 'react';
import { Settings, ChevronRight, ChevronDown, User, Users, Book, Palette, Globe, FileText } from 'lucide-react';
import type { RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { StoryLanguageCode, LanguageLevel } from '@/types/story';

export interface GenerationSettings {
  storyCategory?: 'adventure' | 'life-challenge' | 'educational' | '';
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
  },
  de: {
    adventure: 'Abenteuer',
    'life-challenge': 'Lebensherausforderung',
    educational: 'Bildung',
  },
  fr: {
    adventure: 'Aventure',
    'life-challenge': 'Défi de vie',
    educational: 'Éducatif',
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
        title: 'Generation Settings',
        category: 'Category',
        topic: 'Topic',
        theme: 'Theme',
        storyType: 'Story Type',
        storyDetails: 'Story Details',
        artStyle: 'Art Style',
        language: 'Language',
        readingLevel: 'Reading Level',
        pages: 'Pages',
        dedication: 'Dedication',
        characters: 'Characters',
        mainCharacter: 'Main',
        relationships: 'Relationships',
        noData: 'Not specified',
      },
      de: {
        title: 'Generierungseinstellungen',
        category: 'Kategorie',
        topic: 'Thema',
        theme: 'Thema',
        storyType: 'Story-Typ',
        storyDetails: 'Story-Details',
        artStyle: 'Kunststil',
        language: 'Sprache',
        readingLevel: 'Leseniveau',
        pages: 'Seiten',
        dedication: 'Widmung',
        characters: 'Charaktere',
        mainCharacter: 'Haupt',
        relationships: 'Beziehungen',
        noData: 'Nicht angegeben',
      },
      fr: {
        title: 'Paramètres de génération',
        category: 'Catégorie',
        topic: 'Sujet',
        theme: 'Thème',
        storyType: 'Type d\'histoire',
        storyDetails: 'Détails de l\'histoire',
        artStyle: 'Style artistique',
        language: 'Langue',
        readingLevel: 'Niveau de lecture',
        pages: 'Pages',
        dedication: 'Dédicace',
        characters: 'Personnages',
        mainCharacter: 'Principal',
        relationships: 'Relations',
        noData: 'Non spécifié',
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
          {/* Story Category & Topic/Theme */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                <Book size={12} />
                {t('category')}
              </div>
              <div className="text-sm">
                {settings.storyCategory ? getCategoryLabel(settings.storyCategory) : renderValue(undefined)}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                <FileText size={12} />
                {settings.storyCategory === 'adventure' ? t('theme') : t('topic')}
              </div>
              <div className="text-sm">
                {renderValue(settings.storyCategory === 'adventure' ? settings.storyTheme : settings.storyTopic)}
              </div>
            </div>
          </div>

          {/* Story Type Name (legacy) */}
          {settings.storyTypeName && (
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">{t('storyType')}</div>
              <div className="text-sm">{renderValue(settings.storyTypeName)}</div>
            </div>
          )}

          {/* Story Details */}
          {settings.storyDetails && (
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">{t('storyDetails')}</div>
              <div className="text-sm bg-white/50 p-2 rounded border border-amber-100 whitespace-pre-wrap">
                {settings.storyDetails}
              </div>
            </div>
          )}

          {/* Art Style & Language */}
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-1">
                <Palette size={12} />
                {t('artStyle')}
              </div>
              <div className="text-sm capitalize">{renderValue(settings.artStyle)}</div>
            </div>
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
          </div>

          {/* Pages & Dedication */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-medium text-amber-700 mb-1">{t('pages')}</div>
              <div className="text-sm">{renderValue(settings.pages)}</div>
            </div>
            {settings.dedication && (
              <div>
                <div className="text-xs font-medium text-amber-700 mb-1">{t('dedication')}</div>
                <div className="text-sm italic">"{settings.dedication}"</div>
              </div>
            )}
          </div>

          {/* Characters */}
          {settings.characters && settings.characters.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 mb-2">
                <Users size={12} />
                {t('characters')}
              </div>
              <div className="flex flex-wrap gap-2">
                {settings.characters.map((char) => {
                  const isMain = mainCharacterIds.includes(char.id);
                  return (
                    <div
                      key={char.id}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-xs ${
                        isMain
                          ? 'bg-indigo-100 text-indigo-800 border border-indigo-200'
                          : 'bg-gray-100 text-gray-700 border border-gray-200'
                      }`}
                    >
                      <User size={10} />
                      <span>{char.name}</span>
                      {isMain && (
                        <span className="text-[10px] font-medium text-indigo-600">
                          ({t('mainCharacter')})
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Relationships */}
          {settings.relationshipTexts && Object.keys(settings.relationshipTexts).length > 0 && (
            <div>
              <div className="text-xs font-medium text-amber-700 mb-2">{t('relationships')}</div>
              <div className="text-xs bg-white/50 p-2 rounded border border-amber-100 space-y-1">
                {Object.entries(settings.relationshipTexts).map(([key, text]) => {
                  // Convert ID pair to names (key format: "id1-id2")
                  const [id1, id2] = key.split('-').map(id => parseInt(id, 10));
                  const char1 = settings.characters?.find(c => c.id === id1);
                  const char2 = settings.characters?.find(c => c.id === id2);
                  const displayKey = char1 && char2
                    ? `${char1.name} → ${char2.name}`
                    : key;
                  return (
                    <div key={key} className="flex gap-2">
                      <span className="text-amber-600 font-medium whitespace-nowrap">{displayKey}:</span>
                      <span className="text-gray-700">{text}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
