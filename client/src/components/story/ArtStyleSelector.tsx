import { useLanguage } from '@/context/LanguageContext';
import { artStyles } from '@/constants/artStyles';

interface ArtStyleSelectorProps {
  selectedStyle: string;
  onSelect: (styleId: string) => void;
}

const categoryLabels = {
  realistic: { en: 'Realistic', de: 'Realistisch', fr: 'Réaliste' },
  illustrated: { en: 'Illustrated', de: 'Illustriert', fr: 'Illustré' },
  creative: { en: 'Creative', de: 'Kreativ', fr: 'Créatif' },
};

const categoryOrder: Array<'realistic' | 'illustrated' | 'creative'> = ['realistic', 'illustrated', 'creative'];

export function ArtStyleSelector({ selectedStyle, onSelect }: ArtStyleSelectorProps) {
  const { language } = useLanguage();
  const lang = language as 'en' | 'de' | 'fr';

  return (
    <div id="art-style-section" className="space-y-4">
      {categoryOrder.map((category) => {
        const styles = artStyles.filter((s) => s.category === category);
        if (styles.length === 0) return null;
        return (
          <div key={category}>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">
              {categoryLabels[category][lang] || categoryLabels[category].en}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-2">
              {styles.map((style) => (
                <button
                  key={style.id}
                  onClick={() => onSelect(style.id)}
                  className={`rounded-lg border-2 transition-all overflow-hidden flex flex-col bg-white ${
                    selectedStyle === style.id
                      ? 'border-indigo-500 shadow-lg ring-2 ring-indigo-200'
                      : 'border-gray-200 hover:border-indigo-300'
                  }`}
                >
                  {/* Image preview */}
                  <div className="relative w-full h-32 overflow-hidden">
                    <img
                      src={style.image}
                      alt={style.name[lang] || style.name.en}
                      className="w-full h-full object-contain"
                    />
                  </div>

                  {/* Style name */}
                  <div className="p-1.5 flex flex-col items-center text-center">
                    <div className="font-bold text-xs text-gray-800">{style.name[lang] || style.name.en}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default ArtStyleSelector;
