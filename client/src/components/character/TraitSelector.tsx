import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface TraitSelectorProps {
  label: string;
  traits: string[];
  selectedTraits: string[];
  onSelect: (traits: string[]) => void;
  minRequired?: number;
  allowCustom?: boolean;
}

export function TraitSelector({
  label,
  traits,
  selectedTraits,
  onSelect,
  minRequired = 0,
  allowCustom = true,
}: TraitSelectorProps) {
  const { t, language } = useLanguage();
  const [customTrait, setCustomTrait] = useState('');

  // Track custom traits added via the input field
  const [localCustomTraits, setLocalCustomTraits] = useState<string[]>([]);

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
      setLocalCustomTraits([...localCustomTraits, newTrait]);
      onSelect([...selectedTraits, newTrait]);
      setCustomTrait('');
    }
  };

  // Include: default traits + locally added custom traits + any selected traits not in defaults
  // This ensures custom traits from saved data are visible and can be removed
  const customTraitsFromSelected = selectedTraits.filter(trait => !traits.includes(trait));
  const allCustomTraits = [...new Set([...localCustomTraits, ...customTraitsFromSelected])];
  const allTraits = [...traits, ...allCustomTraits];

  return (
    <div>
      {/* Label */}
      <label className="block text-lg font-semibold mb-2 text-indigo-700">
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
                ? 'bg-indigo-500 text-white'
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
