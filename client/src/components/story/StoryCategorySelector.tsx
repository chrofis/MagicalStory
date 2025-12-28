import { useState, useEffect } from 'react';
import { ChevronDown, ChevronUp, Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import {
  storyCategories,
  storyTypes,
  realisticSetting,
  lifeChallenges,
  lifeChallengeGroups,
  educationalTopics,
  educationalGroups,
  getLifeChallengesByGroup,
  getEducationalTopicsByGroup,
} from '@/constants/storyTypes';
import type { Language } from '@/types/story';

interface StoryCategorySelectorProps {
  // Current values
  storyCategory: 'adventure' | 'life-challenge' | 'educational' | '';
  storyTopic: string;  // Life challenge or educational topic ID
  storyTheme: string;  // Adventure theme (or 'realistic')
  // Callbacks
  onCategoryChange: (category: 'adventure' | 'life-challenge' | 'educational') => void;
  onTopicChange: (topic: string) => void;
  onThemeChange: (theme: string) => void;
  // For backwards compatibility - sets the legacy storyType
  onLegacyStoryTypeChange: (storyType: string) => void;
}

export function StoryCategorySelector({
  storyCategory,
  storyTopic,
  storyTheme,
  onCategoryChange,
  onTopicChange,
  onThemeChange,
  onLegacyStoryTypeChange,
}: StoryCategorySelectorProps) {
  const { language } = useLanguage();
  const lang = language as Language;

  // Track expanded groups
  const [expandedLifeGroups, setExpandedLifeGroups] = useState<string[]>([]);
  const [expandedEduGroups, setExpandedEduGroups] = useState<string[]>([]);

  // Translations
  const translations = {
    en: {
      chooseStoryType: 'What kind of story?',
      chooseTheme: 'Choose a theme',
      chooseTopic: 'What should the story be about?',
      optionalTheme: 'Optional: Add an adventure theme',
      optionalThemeDesc: 'Make it a pirate, wizard, or other adventure story',
      noTheme: 'No theme (realistic)',
      selectedCategory: 'Story type',
      selectedTopic: 'Topic',
      selectedTheme: 'Theme',
      change: 'Change',
    },
    de: {
      chooseStoryType: 'Welche Art von Geschichte?',
      chooseTheme: 'Wähle ein Thema',
      chooseTopic: 'Worum soll es in der Geschichte gehen?',
      optionalTheme: 'Optional: Abenteuer-Thema hinzufügen',
      optionalThemeDesc: 'Als Piraten-, Zauberer- oder andere Abenteuergeschichte',
      noTheme: 'Kein Thema (realistisch)',
      selectedCategory: 'Geschichtsart',
      selectedTopic: 'Thema',
      selectedTheme: 'Setting',
      change: 'Ändern',
    },
    fr: {
      chooseStoryType: 'Quel type d\'histoire?',
      chooseTheme: 'Choisir un thème',
      chooseTopic: 'De quoi doit parler l\'histoire?',
      optionalTheme: 'Optionnel: Ajouter un thème d\'aventure',
      optionalThemeDesc: 'En faire une histoire de pirate, sorcier, etc.',
      noTheme: 'Pas de thème (réaliste)',
      selectedCategory: 'Type d\'histoire',
      selectedTopic: 'Sujet',
      selectedTheme: 'Thème',
      change: 'Changer',
    },
  };
  const t = translations[lang] || translations.en;

  // Toggle group expansion
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

  // Expand all groups by default when category changes
  useEffect(() => {
    if (storyCategory === 'life-challenge') {
      setExpandedLifeGroups(lifeChallengeGroups.map(g => g.id));
    } else if (storyCategory === 'educational') {
      setExpandedEduGroups(educationalGroups.map(g => g.id));
    }
  }, [storyCategory]);

  // Handle category selection
  const handleCategorySelect = (categoryId: 'adventure' | 'life-challenge' | 'educational') => {
    onCategoryChange(categoryId);
    // Reset topic and theme when changing category
    onTopicChange('');
    if (categoryId === 'adventure') {
      onThemeChange('');
    } else {
      onThemeChange('realistic');  // Default to realistic for non-adventure
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
    const cat = storyCategories.find(c => c.id === id);
    return cat ? cat.name[lang] || cat.name.en : id;
  };

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
    return id;
  };

  // Render step 1: Category selection
  if (!storyCategory) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <Sparkles className="text-indigo-600" size={24} />
          {t.chooseStoryType}
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {storyCategories.map((category) => (
            <button
              key={category.id}
              onClick={() => handleCategorySelect(category.id)}
              className="p-6 rounded-xl border-2 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all text-left"
            >
              <div className="text-4xl mb-3">{category.emoji}</div>
              <div className="font-bold text-lg text-gray-800">
                {category.name[lang] || category.name.en}
              </div>
              <div className="text-sm text-gray-600 mt-1">
                {category.description[lang] || category.description.en}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Render step 2a: Adventure theme selection
  if (storyCategory === 'adventure' && !storyTheme) {
    return (
      <div className="space-y-4">
        {/* Selected category indicator */}
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
            {storyCategories.find(c => c.id === storyCategory)?.emoji} {getCategoryName(storyCategory)}
          </span>
          <button
            onClick={() => onCategoryChange('' as 'adventure' | 'life-challenge' | 'educational')}
            className="text-indigo-600 hover:underline"
          >
            {t.change}
          </button>
        </div>

        <h2 className="text-2xl font-bold text-gray-800">{t.chooseTheme}</h2>

        <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2">
          {storyTypes.map((type) => (
            <button
              key={type.id}
              onClick={() => handleAdventureThemeSelect(type.id)}
              className="p-3 rounded-lg border-2 border-gray-200 hover:border-indigo-400 hover:bg-indigo-50 transition-all"
            >
              <div className="text-2xl mb-1">{type.emoji}</div>
              <div className="font-semibold text-xs">{type.name[lang] || type.name.en}</div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Render step 2b: Life Challenge topic selection
  if (storyCategory === 'life-challenge' && !storyTopic) {
    return (
      <div className="space-y-4">
        {/* Selected category indicator */}
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
            {storyCategories.find(c => c.id === storyCategory)?.emoji} {getCategoryName(storyCategory)}
          </span>
          <button
            onClick={() => onCategoryChange('' as any)}
            className="text-indigo-600 hover:underline"
          >
            {t.change}
          </button>
        </div>

        <h2 className="text-2xl font-bold text-gray-800">{t.chooseTopic}</h2>

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
                  <span className="font-semibold text-gray-700">
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
    return (
      <div className="space-y-4">
        {/* Selected category indicator */}
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
            {storyCategories.find(c => c.id === storyCategory)?.emoji} {getCategoryName(storyCategory)}
          </span>
          <button
            onClick={() => onCategoryChange('' as any)}
            className="text-indigo-600 hover:underline"
          >
            {t.change}
          </button>
        </div>

        <h2 className="text-2xl font-bold text-gray-800">{t.chooseTopic}</h2>

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
                  <span className="font-semibold text-gray-700">
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

  // Render step 3: Optional theme wrapper (for life-challenge and educational with topic selected)
  if ((storyCategory === 'life-challenge' || storyCategory === 'educational') && storyTopic && storyTheme === 'realistic') {
    return (
      <div className="space-y-4">
        {/* Selected category and topic indicator */}
        <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
          <span className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded">
            {storyCategories.find(c => c.id === storyCategory)?.emoji} {getCategoryName(storyCategory)}
          </span>
          <span className="bg-green-100 text-green-700 px-2 py-1 rounded">
            {getTopicName(storyTopic)}
          </span>
          <button
            onClick={() => onTopicChange('')}
            className="text-indigo-600 hover:underline"
          >
            {t.change}
          </button>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
          <h3 className="font-bold text-gray-800 mb-1">{t.optionalTheme}</h3>
          <p className="text-sm text-gray-600 mb-3">{t.optionalThemeDesc}</p>

          <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2">
            {/* Realistic option first */}
            <button
              onClick={() => handleThemeWrapperSelect('realistic')}
              className={`p-2 rounded-lg border-2 transition-all ${
                storyTheme === 'realistic'
                  ? 'border-green-500 bg-green-50'
                  : 'border-gray-200 hover:border-green-300'
              }`}
            >
              <div className="text-2xl mb-1">{realisticSetting.emoji}</div>
              <div className="font-semibold text-xs">{t.noTheme}</div>
            </button>

            {/* Theme options */}
            {storyTypes.map((type) => (
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
        </div>
      </div>
    );
  }

  // Final state: Show selection summary (all selected)
  const categoryData = storyCategories.find(c => c.id === storyCategory);

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
        <Sparkles className="text-indigo-600" size={24} />
        {t.chooseStoryType}
      </h2>

      {/* Selection summary */}
      <div className="bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-200 rounded-xl p-4 space-y-3">
        {/* Category */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{categoryData?.emoji}</span>
            <div>
              <div className="text-xs text-gray-500">{t.selectedCategory}</div>
              <div className="font-semibold">{getCategoryName(storyCategory)}</div>
            </div>
          </div>
          <button
            onClick={() => onCategoryChange('' as any)}
            className="text-indigo-600 hover:underline text-sm"
          >
            {t.change}
          </button>
        </div>

        {/* Topic (for life-challenge and educational) */}
        {storyTopic && (
          <div className="flex items-center justify-between border-t border-indigo-100 pt-3">
            <div className="flex items-center gap-2">
              <span className="text-2xl">
                {lifeChallenges.find(c => c.id === storyTopic)?.emoji ||
                 educationalTopics.find(t => t.id === storyTopic)?.emoji}
              </span>
              <div>
                <div className="text-xs text-gray-500">{t.selectedTopic}</div>
                <div className="font-semibold">{getTopicName(storyTopic)}</div>
              </div>
            </div>
            <button
              onClick={() => onTopicChange('')}
              className="text-indigo-600 hover:underline text-sm"
            >
              {t.change}
            </button>
          </div>
        )}

        {/* Theme */}
        <div className="flex items-center justify-between border-t border-indigo-100 pt-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">
              {storyTheme === 'realistic'
                ? realisticSetting.emoji
                : storyTypes.find(t => t.id === storyTheme)?.emoji}
            </span>
            <div>
              <div className="text-xs text-gray-500">{t.selectedTheme}</div>
              <div className="font-semibold">{getThemeName(storyTheme)}</div>
            </div>
          </div>
          <button
            onClick={() => {
              if (storyCategory === 'adventure') {
                onThemeChange('');
              } else {
                onThemeChange('realistic');
              }
            }}
            className="text-indigo-600 hover:underline text-sm"
          >
            {t.change}
          </button>
        </div>
      </div>
    </div>
  );
}

export default StoryCategorySelector;
