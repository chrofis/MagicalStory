import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface TraitSelectorProps {
  label: string;
  traits: string[];
  selectedTraits: string[];
  onSelect: (traits: string[]) => void;
  minRequired?: number;
  color?: 'green' | 'orange' | 'purple' | 'blue';
  allowCustom?: boolean;
}

const colorStyles = {
  green: {
    selected: 'bg-green-500 text-white',
    label: 'text-green-700',
  },
  orange: {
    selected: 'bg-orange-500 text-white',
    label: 'text-orange-700',
  },
  purple: {
    selected: 'bg-purple-500 text-white',
    label: 'text-purple-700',
  },
  blue: {
    selected: 'bg-indigo-500 text-white',
    label: 'text-indigo-700',
  },
};

export function TraitSelector({
  label,
  traits,
  selectedTraits,
  onSelect,
  minRequired = 0,
  color = 'green',
  allowCustom = true,
}: TraitSelectorProps) {
  const { t, language } = useLanguage();
  const [customTrait, setCustomTrait] = useState('');
  const [customTraits, setCustomTraits] = useState<string[]>([]);
  const styles = colorStyles[color];

  const toggleTrait = (trait: string) => {
    if (selectedTraits.includes(trait)) {
      onSelect(selectedTraits.filter((t) => t !== trait));
    } else {
      onSelect([...selectedTraits, trait]);
    }
  };

  const addCustomTrait = () => {
    if (customTrait.trim() && !selectedTraits.includes(customTrait.trim())) {
      const newTrait = customTrait.trim();
      setCustomTraits([...customTraits, newTrait]);
      onSelect([...selectedTraits, newTrait]);
      setCustomTrait('');
    }
  };

  const allTraits = [...traits, ...customTraits];

  return (
    <div>
      {/* Label */}
      <label className={`block text-lg font-semibold mb-2 ${styles.label}`}>
        {label}
        {minRequired > 0 && (
          <span className="text-sm font-normal text-gray-500 ml-2">
            ({t.selectAtLeast} {minRequired})
          </span>
        )}
        {selectedTraits.length > 0 && (
          <span className="text-sm font-normal text-gray-500 ml-2">
            - {t.selected}: {selectedTraits.length}
          </span>
        )}
      </label>

      {/* Trait pills */}
      <div className="flex flex-wrap gap-2 mb-3">
        {allTraits.map((trait) => (
          <button
            key={trait}
            onClick={() => toggleTrait(trait)}
            className={`px-3 py-1 rounded-full text-sm transition-colors ${
              selectedTraits.includes(trait)
                ? styles.selected
                : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
            }`}
          >
            {trait}
          </button>
        ))}
      </div>

      {/* Custom trait input */}
      {allowCustom && (
        <div className="flex gap-2">
          <input
            type="text"
            value={customTrait}
            onChange={(e) => setCustomTrait(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustomTrait()}
            placeholder={
              language === 'de'
                ? 'Eigene hinzufügen...'
                : language === 'fr'
                ? 'Ajouter personnalisé...'
                : 'Add custom...'
            }
            className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={addCustomTrait}
            disabled={!customTrait.trim()}
            className={`px-4 py-2 rounded-lg font-semibold flex items-center gap-1 transition-colors ${
              customTrait.trim()
                ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            <Plus size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export default TraitSelector;
