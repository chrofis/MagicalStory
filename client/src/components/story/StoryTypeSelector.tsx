import { Plus } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { storyTypes } from '@/constants/storyTypes';
import type { StoryType } from '@/types/story';

interface StoryTypeSelectorProps {
  selectedType: string;
  onSelect: (typeId: string) => void;
  customTypes?: StoryType[];
  onAddCustom?: () => void;
}

export function StoryTypeSelector({
  selectedType,
  onSelect,
  customTypes = [],
  onAddCustom,
}: StoryTypeSelectorProps) {
  const { t, language } = useLanguage();

  const allTypes = [...storyTypes, ...customTypes];

  return (
    <div className="space-y-4">
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        {t.chooseStoryType}
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2">
        {allTypes.map((type) => (
          <button
            key={type.id}
            onClick={() => onSelect(type.id)}
            className={`p-2 rounded-lg border-2 transition-all ${
              selectedType === type.id
                ? 'border-indigo-600 bg-indigo-50 shadow-lg'
                : 'border-gray-200 hover:border-indigo-300'
            }`}
          >
            <div className="text-2xl mb-1">{type.emoji}</div>
            <div className="font-semibold text-xs">{type.name[language as keyof typeof type.name]}</div>
          </button>
        ))}

        {/* Add Custom Type Button */}
        {onAddCustom && (
          <button
            onClick={onAddCustom}
            className="p-2 rounded-lg border-2 border-dashed border-indigo-300 hover:border-indigo-600 transition-all hover:bg-indigo-50"
          >
            <div className="text-2xl mb-1">
              <Plus size={24} className="mx-auto text-indigo-600" />
            </div>
            <div className="font-semibold text-xs text-indigo-600">{t.addCustomStoryType}</div>
          </button>
        )}
      </div>
    </div>
  );
}

export default StoryTypeSelector;
