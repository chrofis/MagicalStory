import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { artStyles } from '@/constants/artStyles';

interface ArtStyleSelectorProps {
  selectedStyle: string;
  onSelect: (styleId: string) => void;
}

const categoryLabels = {
  popular: { en: 'Popular', de: 'Beliebt', fr: 'Populaire' },
  realistic: { en: 'Realistic', de: 'Realistisch', fr: 'Réaliste' },
  illustrated: { en: 'Illustrated', de: 'Illustriert', fr: 'Illustré' },
  creative: { en: 'Creative', de: 'Kreativ', fr: 'Créatif' },
};

const categoryOrder: Array<'realistic' | 'illustrated' | 'creative'> = ['realistic', 'illustrated', 'creative'];

// Highlighted styles shown in the always-visible "Popular" section at the top.
const POPULAR_STYLE_IDS = ['watercolor', 'anime', 'comic', 'pixar'];

export function ArtStyleSelector({ selectedStyle, onSelect }: ArtStyleSelectorProps) {
  const { language } = useLanguage();
  const lang = language as 'en' | 'de' | 'fr';

  // All non-popular categories start collapsed.
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  };

  const popularStyles = POPULAR_STYLE_IDS
    .map((id) => artStyles.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  const renderStyleButton = (style: typeof artStyles[number]) => (
    <button
      key={style.id}
      onClick={() => onSelect(style.id)}
      className={`rounded-lg border-2 transition-all overflow-hidden flex flex-col bg-white ${
        selectedStyle === style.id
          ? 'border-indigo-500 shadow-lg ring-2 ring-indigo-200'
          : 'border-gray-200 hover:border-indigo-300'
      }`}
    >
      <div className="relative w-full h-32 overflow-hidden">
        <img
          src={style.image}
          alt={style.name[lang] || style.name.en}
          className="w-full h-full object-contain"
        />
      </div>
      <div className="p-1.5 flex flex-col items-center text-center">
        <div className="font-bold text-xs text-gray-800">{style.name[lang] || style.name.en}</div>
      </div>
    </button>
  );

  return (
    <div id="art-style-section" className="space-y-4">
      {/* Popular section — always visible at top */}
      {popularStyles.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
            <span>⭐</span>
            {categoryLabels.popular[lang] || categoryLabels.popular.en}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-2">
            {popularStyles.map(renderStyleButton)}
          </div>
        </div>
      )}

      {/* Other categories — collapsed by default */}
      <div className="space-y-3 border-t border-gray-200 pt-3">
        {categoryOrder.map((category) => {
          const styles = artStyles.filter((s) => s.category === category);
          if (styles.length === 0) return null;
          const isExpanded = expandedCategories.includes(category);

          return (
            <div key={category} className="border border-gray-200 rounded-lg overflow-hidden">
              <button
                onClick={() => toggleCategory(category)}
                className="w-full flex items-center justify-between p-3 bg-gray-50 hover:bg-gray-100 transition-colors"
              >
                <span className="font-semibold text-gray-700">
                  {categoryLabels[category][lang] || categoryLabels[category].en}
                </span>
                {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
              </button>

              {isExpanded && (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-2 p-3">
                  {styles.map(renderStyleButton)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ArtStyleSelector;
