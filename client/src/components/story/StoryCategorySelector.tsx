import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, Sparkles, Pencil, MapPin } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import {
  storyCategories,
  storyTypes,
  realisticSetting,
  lifeChallenges,
  lifeChallengeGroups,
  educationalTopics,
  educationalGroups,
  adventureThemeGroups,
  historicalEvents,
  historicalEventGroups,
  getStoryTypesByGroup,
  getLifeChallengesByGroup,
  getEducationalTopicsByGroup,
  getHistoricalEventsByGroup,
} from '@/constants/storyTypes';
import { storyService } from '@/services/storyService';
import type { Language, SwissCity, SwissStoriesData } from '@/types/story';

type StoryCategoryId = 'adventure' | 'life-challenge' | 'educational' | 'historical' | 'swiss-stories' | 'custom' | '';

// Swiss flag inline SVG — Windows renders 🇨🇭 as "CH" text
const SwissFlag = ({ className = '' }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={`inline-block ${className}`} style={{ width: '1em', height: '1em' }}>
    <rect width="32" height="32" rx="4" fill="#FF0000"/>
    <rect x="13" y="6" width="6" height="20" fill="white"/>
    <rect x="6" y="13" width="20" height="6" fill="white"/>
  </svg>
);

// Render emoji, replacing 🇨🇭 with proper SVG flag
const renderEmoji = (emoji: string) => emoji === '🇨🇭' ? <SwissFlag /> : emoji;

interface StoryCategorySelectorProps {
  // Current values
  storyCategory: StoryCategoryId;
  storyTopic: string;  // Life challenge, educational topic, or historical event ID
  storyTheme: string;  // Adventure theme (or 'realistic')
  customThemeText?: string;  // Custom theme description when theme is 'custom'
  userLocation?: { city: string | null; region: string | null; country: string | null } | null;
  // Callbacks
  onCategoryChange: (category: StoryCategoryId) => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  onCustomThemeTextChange?: (text: string) => void;
  // For backwards compatibility - sets the legacy storyType
  onLegacyStoryTypeChange: (storyType: string) => void;
}

// Haversine distance in km
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Auto-assign emoji based on story idea keywords
function getIdeaEmoji(title: string, description: string): string {
  const text = (title + ' ' + description).toLowerCase();
  if (text.includes('bear') || text.includes('bär')) return '🐻';
  if (text.includes('clock') || text.includes('uhr') || text.includes('zyt') || text.includes('time')) return '🕰️';
  if (text.includes('fire') || text.includes('feuer') || text.includes('brand')) return '🔥';
  if (text.includes('roman') || text.includes('röm')) return '🏛️';
  if (text.includes('castle') || text.includes('burg') || text.includes('schloss')) return '🏰';
  if (text.includes('dragon') || text.includes('drach')) return '🐉';
  if (text.includes('bridge') || text.includes('brücke')) return '🌉';
  if (text.includes('lake') || text.includes('see') || text.includes('swim') || text.includes('water')) return '🏊';
  if (text.includes('mountain') || text.includes('berg') || text.includes('alp') || text.includes('climb')) return '🏔️';
  if (text.includes('train') || text.includes('bahn') || text.includes('tunnel')) return '🚂';
  if (text.includes('cheese') || text.includes('käse')) return '🧀';
  if (text.includes('chocolate') || text.includes('schoko')) return '🍫';
  if (text.includes('ghost') || text.includes('geist') || text.includes('spuk')) return '👻';
  if (text.includes('secret') || text.includes('geheim') || text.includes('mystery')) return '🔍';
  if (text.includes('treasure') || text.includes('schatz') || text.includes('gold')) return '💎';
  if (text.includes('church') || text.includes('münster') || text.includes('cathedral') || text.includes('abbey')) return '⛪';
  if (text.includes('fountain') || text.includes('brunnen')) return '⛲';
  if (text.includes('einstein') || text.includes('science') || text.includes('light')) return '💡';
  if (text.includes('knight') || text.includes('ritter') || text.includes('battle') || text.includes('schlacht')) return '⚔️';
  if (text.includes('lost') || text.includes('escape') || text.includes('adventure')) return '🗺️';
  if (text.includes('night') || text.includes('nacht') || text.includes('moon')) return '🌙';
  if (text.includes('music') || text.includes('musik') || text.includes('festival')) return '🎵';
  if (text.includes('paint') || text.includes('art') || text.includes('kunst')) return '🎨';
  if (text.includes('book') || text.includes('buch') || text.includes('library')) return '📚';
  if (text.includes('flower') || text.includes('garden') || text.includes('blume')) return '🌸';
  if (text.includes('snow') || text.includes('schnee') || text.includes('winter') || text.includes('ski')) return '❄️';
  return '📖';
}

export function StoryCategorySelector({
  storyCategory,
  storyTopic,
  storyTheme,
  customThemeText = '',
  userLocation,
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onCustomThemeTextChange,
  onLegacyStoryTypeChange,
}: StoryCategorySelectorProps) {
  const { language } = useLanguage();
  const lang = language as Language;

  // Track expanded groups
  const [expandedAdventureGroups, setExpandedAdventureGroups] = useState<string[]>([]);
  const [expandedLifeGroups, setExpandedLifeGroups] = useState<string[]>([]);
  const [expandedEduGroups, setExpandedEduGroups] = useState<string[]>([]);
  const [expandedHistoricalGroups, setExpandedHistoricalGroups] = useState<string[]>([]);

  // Swiss stories state
  const [swissData, setSwissData] = useState<SwissStoriesData | null>(null);
  const [swissLoading, setSwissLoading] = useState(false);
  const [expandedSwissCities, setExpandedSwissCities] = useState<string[]>([]);
  const [expandedSwissCantons, setExpandedSwissCantons] = useState<string[]>([]);
  const [expandedSwissSection, setExpandedSwissSection] = useState<'nearby' | 'cantons' | null>(null);

  // Translations
  const translations = {
    en: {
      storyType: 'Story Type',
      theme: 'Theme',
      topic: 'Topic',
      setting: 'Setting',
      optionalTheme: 'Optional: Add an adventure theme',
      optionalThemeDesc: 'Make it a pirate, wizard, or other adventure story',
      noTheme: 'No theme (realistic)',
      selectedCategory: 'Story type',
      selectedTopic: 'Topic',
      selectedTheme: 'Theme',
      change: 'Change',
      customThemePlaceholder: 'Describe your story idea in detail...\n\nFor example:\n- A story about learning to ride a bike\n- An adventure in the Swiss mountains\n- Meeting a friendly dragon who helps with homework',
      customThemeLabel: 'Your custom theme:',
      currentSelection: 'Current Selection',
      changeStory: 'Choose Different Story',
      category: 'Category',
      storiesFrom: 'Stories from',
      swissStories: 'Swiss Stories',
      yourCity: 'Your City',
      nearby: 'Nearby',
      byCanton: 'By Canton',
      ideas: 'ideas',
      km: 'km',
      loading: 'Loading...',
    },
    de: {
      storyType: 'Geschichte',
      theme: 'Thema',
      topic: 'Thema',
      setting: 'Setting',
      optionalTheme: 'Optional: Abenteuer-Thema hinzufügen',
      optionalThemeDesc: 'Als Piraten-, Zauberer- oder andere Abenteuergeschichte',
      noTheme: 'Kein Thema (realistisch)',
      selectedCategory: 'Geschichtsart',
      selectedTopic: 'Thema',
      selectedTheme: 'Setting',
      change: 'Ändern',
      customThemePlaceholder: 'Beschreibe deine Geschichte hier...\n\nZum Beispiel:\n- Eine Geschichte über das Fahrradfahren lernen\n- Ein Abenteuer in den Schweizer Bergen\n- Ein freundlicher Drache, der bei den Hausaufgaben hilft',
      customThemeLabel: 'Dein eigenes Thema:',
      currentSelection: 'Aktuelle Auswahl',
      changeStory: 'Andere Geschichte wählen',
      category: 'Kategorie',
      storiesFrom: 'Geschichten aus',
      swissStories: 'Schweizer Geschichten',
      yourCity: 'Deine Stadt',
      nearby: 'In der Nähe',
      byCanton: 'Nach Kanton',
      ideas: 'Ideen',
      km: 'km',
      loading: 'Laden...',
    },
    fr: {
      storyType: 'Histoire',
      theme: 'Thème',
      topic: 'Sujet',
      setting: 'Cadre',
      optionalTheme: 'Optionnel: Ajouter un thème d\'aventure',
      optionalThemeDesc: 'En faire une histoire de pirate, sorcier, etc.',
      noTheme: 'Pas de thème (réaliste)',
      selectedCategory: 'Type d\'histoire',
      selectedTopic: 'Sujet',
      selectedTheme: 'Thème',
      change: 'Changer',
      customThemePlaceholder: 'Décris ton idée d\'histoire ici...\n\nPar exemple:\n- Une histoire sur l\'apprentissage du vélo\n- Une aventure dans les montagnes suisses\n- Un dragon amical qui aide aux devoirs',
      customThemeLabel: 'Ton thème personnalisé:',
      currentSelection: 'Sélection actuelle',
      changeStory: 'Choisir une autre histoire',
      category: 'Catégorie',
      storiesFrom: 'Histoires de',
      swissStories: 'Histoires Suisses',
      yourCity: 'Votre ville',
      nearby: 'À proximité',
      byCanton: 'Par canton',
      ideas: 'idées',
      km: 'km',
      loading: 'Chargement...',
    },
  };
  const t = translations[lang] || translations.en;

  // Toggle group expansion
  const toggleAdventureGroup = (groupId: string) => {
    setExpandedAdventureGroups(prev =>
      prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId]
    );
  };

  const toggleLifeGroup = (groupId: string) => {
    setExpandedLifeGroups(prev =>
      prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId]
    );
  };

  const toggleEduGroup = (groupId: string) => {
    setExpandedEduGroups(prev =>
      prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId]
    );
  };

  const toggleHistoricalGroup = (groupId: string) => {
    setExpandedHistoricalGroups(prev =>
      prev.includes(groupId) ? prev.filter(g => g !== groupId) : [...prev, groupId]
    );
  };

  // Fetch swiss stories data when needed
  const fetchSwissData = useCallback(async () => {
    if (swissData || swissLoading) return;
    setSwissLoading(true);
    try {
      const data = await storyService.getSwissStories();
      setSwissData(data);
    } catch (err) {
      console.error('Failed to load Swiss stories:', err);
    } finally {
      setSwissLoading(false);
    }
  }, [swissData, swissLoading]);

  // Expand only "popular" group by default when category changes (others collapsed)
  useEffect(() => {
    if (storyCategory === 'adventure') {
      setExpandedAdventureGroups(['popular']);
    } else if (storyCategory === 'life-challenge') {
      setExpandedLifeGroups(['popular']);
    } else if (storyCategory === 'educational') {
      setExpandedEduGroups(['popular']);
    } else if (storyCategory === 'historical') {
      setExpandedHistoricalGroups(['popular']);
    } else if (storyCategory === 'swiss-stories') {
      fetchSwissData();
    }
  }, [storyCategory, fetchSwissData]);

  // Handle category selection
  const handleCategorySelect = (categoryId: StoryCategoryId) => {
    onCategoryChange(categoryId);
    // Reset topic and theme when changing category
    onTopicChange('');
    if (categoryId === 'adventure') {
      onThemeChange('');
    } else if (categoryId === 'custom') {
      onThemeChange('custom');  // Set theme to 'custom' to show custom theme input
      onLegacyStoryTypeChange('custom');
    } else {
      onThemeChange('realistic');  // Default to realistic for non-adventure (including historical, swiss-stories)
    }
  };

  // Handle theme selection for adventure
  const handleAdventureThemeSelect = (themeId: string) => {
    onThemeChange(themeId);
    onLegacyStoryTypeChange(themeId);  // For backwards compatibility
  };

  // Handle topic selection for life challenge/educational
  const handleTopicSelect = (topicId: string) => {
    onTopicChange(topicId);
    // Set legacy storyType to the topic for basic compatibility
    if (storyTheme === 'realistic') {
      onLegacyStoryTypeChange(topicId);
    } else {
      onLegacyStoryTypeChange(storyTheme);
    }
  };

  // Handle optional theme wrapper for life challenge/educational
  const handleThemeWrapperSelect = (themeId: string) => {
    onThemeChange(themeId);
    // Update legacy storyType
    if (themeId === 'realistic') {
      onLegacyStoryTypeChange(storyTopic || 'adventure');
    } else {
      onLegacyStoryTypeChange(themeId);
    }
  };

  // Get display names
  const getCategoryName = (id: string) => {
    if (id === 'swiss-stories') {
      // Dynamic name based on user location
      const userCity = findUserSwissCity();
      if (userCity) {
        const cityName = userCity.name[lang] || userCity.name.en;
        return `${t.storiesFrom} ${cityName}`;
      }
      return t.swissStories;
    }
    const cat = storyCategories.find(c => c.id === id);
    return cat ? cat.name[lang] || cat.name.en : id;
  };

  // Find user's Swiss city match
  const findUserSwissCity = useCallback((): SwissCity | null => {
    if (!swissData || !userLocation?.city) return null;
    const userCityLower = userLocation.city.toLowerCase();
    return swissData.cities.find(c =>
      c.name.en.toLowerCase() === userCityLower ||
      c.name.de.toLowerCase() === userCityLower ||
      c.name.fr.toLowerCase() === userCityLower ||
      c.id === userCityLower.replace(/\s+/g, '-')
    ) || null;
  }, [swissData, userLocation]);

  const getThemeName = (id: string) => {
    if (id === 'realistic') return realisticSetting.name[lang] || realisticSetting.name.en;
    const theme = storyTypes.find(t => t.id === id);
    return theme ? theme.name[lang] || theme.name.en : id;
  };

  const getTopicName = (id: string) => {
    const challenge = lifeChallenges.find(c => c.id === id);
    if (challenge) return challenge.name[lang] || challenge.name.en;
    const topic = educationalTopics.find(t => t.id === id);
    if (topic) return topic.name[lang] || topic.name.en;
    const event = historicalEvents.find(e => e.id === id);
    if (event) return event.name[lang] || event.name.en;
    // Swiss story idea: parse "cityId-N" and look up title
    if (id.match(/-\d+$/) && swissData) {
      const cityId = id.replace(/-\d+$/, '');
      const city = swissData.cities.find(c => c.id === cityId);
      const idea = city?.ideas.find(i => i.id === id);
      if (idea) return idea.title;
    }
    return id;
  };

  // Render step 1: Category selection
  if (!storyCategory) {
    return (
      <div className="space-y-4">
        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Sparkles className="text-indigo-600" size={24} />
          {t.storyType}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
          {storyCategories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategorySelect(category.id as StoryCategoryId)}
              className={`p-3 md:p-6 rounded-xl border-2 transition-all ${
                category.id === 'custom'
                  ? 'border-dashed border-indigo-300 hover:border-indigo-500 hover:bg-indigo-50'
                  : 'border-gray-200 hover:border-indigo-400 hover:bg-indigo-50'
              }`}
            >
              {/* Mobile: horizontal layout with emoji left, title centered */}
              <div className="flex md:hidden items-center gap-3">
                <div className="text-3xl flex-shrink-0">{renderEmoji(category.emoji)}</div>
                <div className={`flex-1 text-center font-bold text-lg ${category.id === 'custom' ? 'text-indigo-700' : 'text-gray-800'}`}>
                  {category.name[lang] || category.name.en}
                </div>
              </div>
              {/* Desktop: vertical layout with emoji, title, description */}
              <div className="hidden md:block text-left">
                <div className="text-4xl mb-3">{renderEmoji(category.emoji)}</div>
                <div className={`font-bold text-lg ${category.id === 'custom' ? 'text-indigo-700' : 'text-gray-800'}`}>
                  {category.name[lang] || category.name.en}
                </div>
                <div className="text-sm text-gray-600 mt-1">
                  {category.description[lang] || category.description.en}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Render step 2a: Adventure theme selection (grouped)
  if (storyCategory === 'adventure' && !storyTheme) {
    const catData = storyCategories.find(c => c.id === storyCategory);
    return (
      <div className="space-y-4">
        {/* Selected category chip */}
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{catData?.emoji && renderEmoji(catData.emoji)}</span>
            <div>
              <div className="text-[10px] text-gray-400 uppercase">{t.category}</div>
              <div className="font-semibold text-sm">{getCategoryName(storyCategory)}</div>
            </div>
            <button
              onClick={() => onCategoryChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>
        </div>

        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Sparkles className="text-indigo-600" size={24} />
          {t.theme}
        </h2>

        <div className="space-y-3">
          {adventureThemeGroups.filter(g => g.id !== 'custom').map((group) => {
            const themes = getStoryTypesByGroup(group.id);
            const isExpanded = expandedAdventureGroups.includes(group.id);

            return (
              <div key={group.id} className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleAdventureGroup(group.id)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="font-semibold text-gray-700 flex items-center gap-2">
                    {group.id === 'popular' && <span>⭐</span>}
                    {group.name[lang] || group.name.en}
                  </span>
                  {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </button>

                {isExpanded && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 p-3">
                    {themes.map((type) => (
                      <button
                        key={type.id}
                        onClick={() => handleAdventureThemeSelect(type.id)}
                        className="p-2 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-center"
                      >
                        <div className="text-2xl mb-1">{type.emoji}</div>
                        <div className="font-semibold text-xs">{type.name[lang] || type.name.en}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Render step 2b: Life Challenge topic selection
  if (storyCategory === 'life-challenge' && !storyTopic) {
    const catData = storyCategories.find(c => c.id === storyCategory);
    return (
      <div className="space-y-4">
        {/* Selected category chip */}
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{catData?.emoji && renderEmoji(catData.emoji)}</span>
            <div>
              <div className="text-[10px] text-gray-400 uppercase">{t.category}</div>
              <div className="font-semibold text-sm">{getCategoryName(storyCategory)}</div>
            </div>
            <button
              onClick={() => onCategoryChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>
        </div>

        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Sparkles className="text-indigo-600" size={24} />
          {t.topic}
        </h2>

        <div className="space-y-3">
          {lifeChallengeGroups.map((group) => {
            const challenges = getLifeChallengesByGroup(group.id);
            const isExpanded = expandedLifeGroups.includes(group.id);

            return (
              <div key={group.id} className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleLifeGroup(group.id)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="font-semibold text-gray-700 flex items-center gap-2">
                    {group.id === 'popular' && <span>⭐</span>}
                    {group.name[lang] || group.name.en}
                  </span>
                  {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </button>

                {isExpanded && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 p-3">
                    {challenges.map((challenge) => (
                      <button
                        key={challenge.id}
                        onClick={() => handleTopicSelect(challenge.id)}
                        className="p-2 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left"
                      >
                        <span className="text-xl mr-2">{challenge.emoji}</span>
                        <span className="text-sm font-medium">
                          {challenge.name[lang] || challenge.name.en}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Render step 2c: Educational topic selection
  if (storyCategory === 'educational' && !storyTopic) {
    const catData = storyCategories.find(c => c.id === storyCategory);
    return (
      <div className="space-y-4">
        {/* Selected category chip */}
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{catData?.emoji && renderEmoji(catData.emoji)}</span>
            <div>
              <div className="text-[10px] text-gray-400 uppercase">{t.category}</div>
              <div className="font-semibold text-sm">{getCategoryName(storyCategory)}</div>
            </div>
            <button
              onClick={() => onCategoryChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>
        </div>

        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Sparkles className="text-indigo-600" size={24} />
          {t.topic}
        </h2>

        <div className="space-y-3">
          {educationalGroups.map((group) => {
            const topics = getEducationalTopicsByGroup(group.id);
            const isExpanded = expandedEduGroups.includes(group.id);

            return (
              <div key={group.id} className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleEduGroup(group.id)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="font-semibold text-gray-700 flex items-center gap-2">
                    {group.id === 'popular' && <span>⭐</span>}
                    {group.name[lang] || group.name.en}
                  </span>
                  {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </button>

                {isExpanded && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 p-3">
                    {topics.map((topic) => (
                      <button
                        key={topic.id}
                        onClick={() => handleTopicSelect(topic.id)}
                        className="p-2 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left"
                      >
                        <span className="text-xl mr-2">{topic.emoji}</span>
                        <span className="text-sm font-medium">
                          {topic.name[lang] || topic.name.en}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Render step 2d: Historical event selection
  if (storyCategory === 'historical' && !storyTopic) {
    const catData = storyCategories.find(c => c.id === storyCategory);
    return (
      <div className="space-y-4">
        {/* Selected category chip */}
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{catData?.emoji && renderEmoji(catData.emoji)}</span>
            <div>
              <div className="text-[10px] text-gray-400 uppercase">{t.category}</div>
              <div className="font-semibold text-sm">{getCategoryName(storyCategory)}</div>
            </div>
            <button
              onClick={() => onCategoryChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>
        </div>

        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Sparkles className="text-indigo-600" size={24} />
          {lang === 'de' ? 'Historisches Ereignis' : lang === 'fr' ? 'Événement Historique' : 'Historical Event'}
        </h2>

        <div className="space-y-3">
          {historicalEventGroups.map((group) => {
            const events = getHistoricalEventsByGroup(group.id);
            const isExpanded = expandedHistoricalGroups.includes(group.id);

            return (
              <div key={group.id} className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => toggleHistoricalGroup(group.id)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="font-semibold text-gray-700 flex items-center gap-2">
                    {group.id === 'swiss' ? (
                      <svg width="20" height="20" viewBox="0 0 32 32" className="rounded-sm">
                        <rect width="32" height="32" fill="#FF0000"/>
                        <rect x="13" y="6" width="6" height="20" fill="white"/>
                        <rect x="6" y="13" width="20" height="6" fill="white"/>
                      </svg>
                    ) : (
                      <span>{group.icon}</span>
                    )}
                    {group.name[lang] || group.name.en}
                  </span>
                  {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </button>

                {isExpanded && (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 p-3">
                    {events.map((event) => (
                      <button
                        key={event.id}
                        onClick={() => handleTopicSelect(event.id)}
                        className="p-3 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left"
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-xl">{event.emoji}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">
                              {event.shortName[lang] || event.shortName.en}
                            </div>
                            <div className="text-xs text-gray-500">
                              {typeof event.year === 'string' && event.year.startsWith('-')
                                ? `${event.year.slice(1)} BC`
                                : event.year}
                              {event.mainPerson && ` • ${event.mainPerson}`}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Render step 2e: Swiss stories — city and story idea selection
  if (storyCategory === 'swiss-stories' && !storyTopic) {
    const catData = storyCategories.find(c => c.id === 'swiss-stories');
    const userCity = findUserSwissCity();

    // Compute proximity data
    let nearbyCities: (SwissCity & { distance: number })[] = [];
    const cantonGroups: Record<string, SwissCity[]> = {};

    if (swissData) {
      // Build canton groups
      for (const city of swissData.cities) {
        if (!cantonGroups[city.canton]) cantonGroups[city.canton] = [];
        cantonGroups[city.canton].push(city);
      }

      // Compute nearby cities if user location matches
      if (userCity) {
        nearbyCities = swissData.cities
          .filter(c => c.id !== userCity.id)
          .map(c => ({ ...c, distance: haversineDistance(userCity.lat, userCity.lon, c.lat, c.lon) }))
          .filter(c => c.distance <= 50)
          .sort((a, b) => a.distance - b.distance);
      }
    }

    // Render a city's story ideas as cards
    const renderCityIdeas = (city: SwissCity) => (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3">
        {city.ideas.map((idea) => (
          <button
            key={idea.id}
            onClick={() => {
              onTopicChange(idea.id);
              onLegacyStoryTypeChange(idea.id);
            }}
            className="p-3 rounded-lg border border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left"
          >
            <div className="flex items-start gap-2">
              <span className="text-xl flex-shrink-0">{getIdeaEmoji(idea.title, idea.description)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-gray-800 line-clamp-1">{idea.title}</div>
                <div className="text-xs text-gray-500 line-clamp-2 mt-0.5">{idea.description}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
    );

    return (
      <div className="space-y-4">
        {/* Selected category chip */}
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{catData?.emoji && renderEmoji(catData.emoji)}</span>
            <div>
              <div className="text-[10px] text-gray-400 uppercase">{t.category}</div>
              <div className="font-semibold text-sm">{getCategoryName('swiss-stories')}</div>
            </div>
            <button
              onClick={() => onCategoryChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>
        </div>

        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Sparkles className="text-indigo-600" size={24} />
          {getCategoryName('swiss-stories')}
        </h2>

        {swissLoading ? (
          <div className="text-center py-8 text-gray-500">{t.loading}</div>
        ) : swissData ? (
          <div className="space-y-3">
            {/* User's city (auto-expanded) */}
            {userCity && (
              <div className="border-2 border-indigo-200 rounded-lg overflow-hidden bg-indigo-50/30">
                <div className="flex items-center gap-2 p-3 bg-indigo-50">
                  <MapPin size={18} className="text-indigo-600" />
                  <span className="font-semibold text-indigo-700">
                    {t.yourCity}: {userCity.name[lang] || userCity.name.en}
                  </span>
                  <span className="text-xs text-indigo-500 ml-auto">{userCity.ideas.length} {t.ideas}</span>
                </div>
                {renderCityIdeas(userCity)}
              </div>
            )}

            {/* Nearby cities (expandable) */}
            {nearbyCities.length > 0 && (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <button
                  onClick={() => setExpandedSwissSection(prev => prev === 'nearby' ? null : 'nearby')}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="font-semibold text-gray-700 flex items-center gap-2">
                    <span>🏘️</span> {t.nearby}
                    <span className="text-xs text-gray-500 font-normal">({nearbyCities.length} {lang === 'de' ? 'Städte' : lang === 'fr' ? 'villes' : 'cities'})</span>
                  </span>
                  {expandedSwissSection === 'nearby' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
                </button>
                {expandedSwissSection === 'nearby' && (
                  <div className="divide-y divide-gray-100">
                    {nearbyCities.map(city => (
                      <div key={city.id}>
                        <button
                          onClick={() => setExpandedSwissCities(prev =>
                            prev.includes(city.id) ? prev.filter(c => c !== city.id) : [...prev, city.id]
                          )}
                          className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition-colors"
                        >
                          <span className="text-sm font-medium text-gray-700">
                            {city.name[lang] || city.name.en}
                            <span className="text-xs text-gray-400 ml-2">{Math.round(city.distance)} {t.km}</span>
                          </span>
                          <span className="text-xs text-gray-400">{city.ideas.length} {t.ideas}</span>
                        </button>
                        {expandedSwissCities.includes(city.id) && renderCityIdeas(city)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* All cities by canton (expandable) */}
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => setExpandedSwissSection(prev => prev === 'cantons' ? null : 'cantons')}
                className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
              >
                <span className="font-semibold text-gray-700 flex items-center gap-2">
                  <span>🏛️</span> {t.byCanton}
                </span>
                {expandedSwissSection === 'cantons' ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </button>
              {expandedSwissSection === 'cantons' && (
                <div className="divide-y divide-gray-100">
                  {Object.entries(cantonGroups)
                    .sort(([a], [b]) => {
                      const nameA = swissData.cantons[a]?.[lang] || swissData.cantons[a]?.en || a;
                      const nameB = swissData.cantons[b]?.[lang] || swissData.cantons[b]?.en || b;
                      return nameA.localeCompare(nameB);
                    })
                    .map(([cantonCode, cities]) => {
                      const cantonName = swissData.cantons[cantonCode]?.[lang] || swissData.cantons[cantonCode]?.en || cantonCode;
                      const isCantonExpanded = expandedSwissCantons.includes(cantonCode);

                      return (
                        <div key={cantonCode}>
                          <button
                            onClick={() => setExpandedSwissCantons(prev =>
                              prev.includes(cantonCode) ? prev.filter(c => c !== cantonCode) : [...prev, cantonCode]
                            )}
                            className="w-full flex items-center justify-between p-3 hover:bg-gray-50 transition-colors"
                          >
                            <span className="text-sm font-medium text-gray-700">
                              {cantonName}
                              <span className="text-xs text-gray-400 ml-2">({cities.length} {lang === 'de' ? 'Städte' : lang === 'fr' ? 'villes' : 'cities'})</span>
                            </span>
                            {isCantonExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                          </button>
                          {isCantonExpanded && (
                            <div className="pl-4 divide-y divide-gray-50">
                              {cities
                                .sort((a, b) => (a.name[lang] || a.name.en).localeCompare(b.name[lang] || b.name.en))
                                .map(city => (
                                  <div key={city.id}>
                                    <button
                                      onClick={() => setExpandedSwissCities(prev =>
                                        prev.includes(city.id) ? prev.filter(c => c !== city.id) : [...prev, city.id]
                                      )}
                                      className="w-full flex items-center justify-between p-2.5 hover:bg-gray-50 transition-colors"
                                    >
                                      <span className="text-sm text-gray-600">{city.name[lang] || city.name.en}</span>
                                      <span className="text-xs text-gray-400">{city.ideas.length} {t.ideas}</span>
                                    </button>
                                    {expandedSwissCities.includes(city.id) && renderCityIdeas(city)}
                                  </div>
                                ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // Render step 3: Optional theme wrapper (for life-challenge and educational with topic selected)
  // Show popular themes first, then all other themes in collapsed groups
  if ((storyCategory === 'life-challenge' || storyCategory === 'educational') && storyTopic && storyTheme === 'realistic') {
    const popularThemes = getStoryTypesByGroup('popular');
    const catData = storyCategories.find(c => c.id === storyCategory);
    const topEmoji = lifeChallenges.find(c => c.id === storyTopic)?.emoji ||
                     educationalTopics.find(t => t.id === storyTopic)?.emoji;

    return (
      <div className="space-y-4">
        {/* Selected category and topic chips */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{catData?.emoji && renderEmoji(catData.emoji)}</span>
            <div>
              <div className="text-[10px] text-gray-400 uppercase">{t.category}</div>
              <div className="font-semibold text-sm">{getCategoryName(storyCategory)}</div>
            </div>
            <button
              onClick={() => onCategoryChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>
          <div className="inline-flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{topEmoji}</span>
            <div>
              <div className="text-[10px] text-gray-400 uppercase">{t.selectedTopic}</div>
              <div className="font-semibold text-sm">{getTopicName(storyTopic)}</div>
            </div>
            <button
              onClick={() => onTopicChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold text-gray-700 mb-2 flex items-center gap-2">
            <Sparkles className="text-indigo-500" size={20} />
            {t.optionalTheme}
          </h3>
          <p className="text-sm text-gray-600 mb-3">{t.optionalThemeDesc}</p>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2 mb-4">
            {/* Realistic option first */}
            <button
              onClick={() => handleThemeWrapperSelect('realistic')}
              className={`p-2 rounded-lg border-2 transition-all ${
                storyTheme === 'realistic'
                  ? 'border-indigo-500 bg-indigo-50'
                  : 'border-gray-200 hover:border-indigo-300'
              }`}
            >
              <div className="text-2xl mb-1">{realisticSetting.emoji}</div>
              <div className="font-semibold text-xs">{t.noTheme}</div>
            </button>

            {/* Popular theme options */}
            {popularThemes.map((type) => (
              <button
                key={type.id}
                onClick={() => handleThemeWrapperSelect(type.id)}
                className={`p-2 rounded-lg border-2 transition-all ${
                  storyTheme === type.id
                    ? 'border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 hover:border-indigo-300'
                }`}
              >
                <div className="text-2xl mb-1">{type.emoji}</div>
                <div className="font-semibold text-xs">{type.name[lang] || type.name.en}</div>
              </button>
            ))}
          </div>

          {/* All other theme groups (collapsed) */}
          <div className="space-y-2 border-t border-gray-200 pt-3">
            {adventureThemeGroups.filter(g => g.id !== 'popular' && g.id !== 'custom').map((group) => {
              const themes = getStoryTypesByGroup(group.id);
              const isExpanded = expandedAdventureGroups.includes(group.id);

              return (
                <div key={group.id} className="border border-gray-200 rounded-lg overflow-hidden bg-white">
                  <button
                    onClick={() => toggleAdventureGroup(group.id)}
                    className="w-full flex items-center justify-between p-2 bg-gray-50 hover:bg-gray-100 transition-colors"
                  >
                    <span className="font-medium text-sm text-gray-700">
                      {group.name[lang] || group.name.en}
                    </span>
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>

                  {isExpanded && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 p-2">
                      {themes.map((type) => (
                        <button
                          key={type.id}
                          onClick={() => handleThemeWrapperSelect(type.id)}
                          className={`p-2 rounded-lg border-2 transition-all text-center ${
                            storyTheme === type.id
                              ? 'border-indigo-500 bg-indigo-50'
                              : 'border-gray-200 hover:border-indigo-300'
                          }`}
                        >
                          <div className="text-xl mb-1">{type.emoji}</div>
                          <div className="font-semibold text-xs">{type.name[lang] || type.name.en}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // Final state: Show current selection + full selection UI below
  const categoryData = storyCategories.find(c => c.id === storyCategory);
  const topicEmoji = (() => {
    if (storyCategory === 'swiss-stories' && storyTopic && swissData) {
      const cityId = storyTopic.replace(/-\d+$/, '');
      const city = swissData.cities.find(c => c.id === cityId);
      const idea = city?.ideas.find(i => i.id === storyTopic);
      if (idea) return getIdeaEmoji(idea.title, idea.description);
    }
    return lifeChallenges.find(c => c.id === storyTopic)?.emoji ||
           educationalTopics.find(t => t.id === storyTopic)?.emoji ||
           historicalEvents.find(e => e.id === storyTopic)?.emoji;
  })();
  const themeEmoji = storyTheme === 'realistic'
    ? realisticSetting.emoji
    : storyTypes.find(t => t.id === storyTheme)?.emoji;

  // Count how many chips we'll show
  const showTopic = !!storyTopic;
  const showTheme = storyCategory !== 'historical' && storyCategory !== 'swiss-stories' && storyCategory !== 'custom' && !!storyTheme;
  const chipCount = 1 + (showTopic ? 1 : 0) + (showTheme ? 1 : 0);

  return (
    <div className="space-y-6">
      {/* Current Selection - same style as Change Story section */}
      <div>
        <h3 className="text-lg font-semibold text-gray-700 mb-4 flex items-center gap-2">
          <Sparkles className="text-indigo-500" size={20} />
          {t.currentSelection}
        </h3>

        {/* Selections in evenly spaced grid */}
        <div className={`grid gap-4 ${chipCount === 1 ? 'grid-cols-1 max-w-xs' : chipCount === 2 ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {/* Category chip */}
          <div className="relative flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
            <span className="text-2xl">{categoryData?.emoji && renderEmoji(categoryData.emoji)}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] text-gray-400 uppercase">{t.category}</div>
              <div className="font-semibold text-sm truncate">{getCategoryName(storyCategory)}</div>
            </div>
            <button
              onClick={() => onCategoryChange('')}
              className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
              title={t.change}
            >
              <Pencil size={14} />
            </button>
          </div>

          {/* Topic chip (for life-challenge, educational, historical) */}
          {showTopic && (
            <div className="relative flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
              <span className="text-2xl">{topicEmoji}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-gray-400 uppercase">{t.selectedTopic}</div>
                <div className="font-semibold text-sm truncate">{getTopicName(storyTopic)}</div>
              </div>
              <button
                onClick={() => onTopicChange('')}
                className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
                title={t.change}
              >
                <Pencil size={14} />
              </button>
            </div>
          )}

          {/* Theme chip - hide for historical and custom */}
          {showTheme && (
            <div className="relative flex items-center gap-3 bg-white px-4 py-3 rounded-xl border-2 border-indigo-200 shadow-sm">
              <span className="text-2xl">{themeEmoji}</span>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-gray-400 uppercase">{t.selectedTheme}</div>
                <div className="font-semibold text-sm truncate">{getThemeName(storyTheme)}</div>
              </div>
              <button
                onClick={() => {
                  if (storyCategory === 'adventure') {
                    onThemeChange('');
                  } else {
                    onThemeChange('realistic');
                  }
                }}
                className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-500 transition-colors"
                title={t.change}
              >
                <Pencil size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Custom theme input - shown when 'custom' is selected */}
        {storyTheme === 'custom' && (
          <div className="mt-4">
            <textarea
              value={customThemeText}
              onChange={(e) => onCustomThemeTextChange?.(e.target.value)}
              placeholder={t.customThemePlaceholder}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-base resize-none"
              rows={6}
            />
          </div>
        )}
      </div>

      {/* Change Story section - show full category selection */}
      <div className="border-t border-gray-200 pt-6">
        <h3 className="text-lg font-semibold text-gray-700 mb-4 flex items-center gap-2">
          <Sparkles className="text-indigo-500" size={20} />
          {t.changeStory}
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {storyCategories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategorySelect(category.id as StoryCategoryId)}
              className={`p-4 rounded-xl border-2 transition-all ${
                category.id === storyCategory
                  ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-200'
                  : category.id === 'custom'
                    ? 'border-dashed border-indigo-300 hover:border-indigo-500 hover:bg-indigo-50'
                    : 'border-gray-200 hover:border-indigo-400 hover:bg-indigo-50'
              }`}
            >
              {/* Horizontal layout: large emoji left, title + description right */}
              <div className="flex items-center gap-3 text-left">
                <div className="text-4xl flex-shrink-0">{renderEmoji(category.emoji)}</div>
                <div>
                  <div className={`font-bold text-lg ${category.id === 'custom' ? 'text-indigo-700' : 'text-gray-800'}`}>
                    {category.name[lang] || category.name.en}
                  </div>
                  <div className="text-sm text-gray-600">
                    {category.description[lang] || category.description.en}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default StoryCategorySelector;
