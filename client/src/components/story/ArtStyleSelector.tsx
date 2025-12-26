import { Palette } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { artStyles } from '@/constants/artStyles';

interface ArtStyleSelectorProps {
  selectedStyle: string;
  onSelect: (styleId: string) => void;
}

export function ArtStyleSelector({ selectedStyle, onSelect }: ArtStyleSelectorProps) {
  const { t, language } = useLanguage();

  return (
    <div id="art-style-section" className="md:bg-indigo-50 md:border-2 md:border-indigo-200 md:rounded-lg md:p-4">
      <div className="flex items-center gap-2 mb-2">
        <Palette size={18} className="text-indigo-600" />
        <h2 className="text-lg md:text-xl font-bold text-gray-800">{t.chooseArtStyle}</h2>
      </div>
      <p className="text-sm text-gray-500 mb-2 md:mb-3">{t.artStyleDescription}</p>

      <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-2">
        {artStyles.map((style) => (
          <button
            key={style.id}
            onClick={() => onSelect(style.id)}
            className={`rounded-lg border-2 transition-all overflow-hidden flex flex-col bg-white ${
              selectedStyle === style.id
                ? 'border-indigo-600 shadow-lg ring-2 ring-indigo-200'
                : 'border-gray-200 hover:border-indigo-300'
            }`}
          >
            {/* Image preview */}
            <div className="relative w-full h-32 overflow-hidden">
              <img
                src={style.image}
                alt={style.name[language as keyof typeof style.name]}
                className="w-full h-full object-contain"
              />
            </div>

            {/* Style name */}
            <div className="p-1.5 flex flex-col items-center text-center">
              <div className="font-bold text-xs text-gray-800">{style.name[language as keyof typeof style.name]}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default ArtStyleSelector;
