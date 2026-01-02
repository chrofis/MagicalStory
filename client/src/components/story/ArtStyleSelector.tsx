import { useLanguage } from '@/context/LanguageContext';
import { artStyles } from '@/constants/artStyles';

interface ArtStyleSelectorProps {
  selectedStyle: string;
  onSelect: (styleId: string) => void;
}

export function ArtStyleSelector({ selectedStyle, onSelect }: ArtStyleSelectorProps) {
  const { language } = useLanguage();

  return (
    <div id="art-style-section">
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
