import { useState } from 'react';
import { Plus, ChevronDown, ChevronRight } from 'lucide-react';
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
  const [isExpanded, setIsExpanded] = useState(false);

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
      {/* Clickable header with chevron */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1 mb-2 group cursor-pointer text-left"
      >
        {isExpanded ? (
          <ChevronDown size={18} className="text-indigo-500" />
        ) : (
          <ChevronRight size={18} className="text-gray-400 group-hover:text-indigo-500" />
        )}
        <span className="text-lg font-semibold text-gray-800">
          {label}
        </span>
        {minRequired > 0 && (
          <span className="text-sm font-normal text-gray-500 ml-1">
            ({t.selectAtLeast} {minRequired})
          </span>
        )}
        {selectedTraits.length > 0 && (
          <span className="text-sm font-normal text-gray-500 ml-1">
            - {selectedTraits.length} {language === 'de' ? 'gewählt' : language === 'fr' ? 'sélectionné' : 'selected'}
          </span>
        )}
      </button>

      {/* Collapsed view: show selected traits as compact chips */}
      {!isExpanded && selectedTraits.length > 0 && (
        <div className="flex flex-wrap gap-1.5 ml-5">
          {selectedTraits.map((trait) => (
            <span
              key={trait}
              className="px-2 py-0.5 rounded-full text-xs bg-indigo-100 text-indigo-700 border border-indigo-200"
            >
              {trait}
            </span>
          ))}
        </div>
      )}

      {/* Collapsed view: no traits selected */}
      {!isExpanded && selectedTraits.length === 0 && (
        <div className="ml-5 text-sm text-gray-400 italic">
          {language === 'de' ? 'Klicken zum Auswählen...' : language === 'fr' ? 'Cliquer pour sélectionner...' : 'Click to select...'}
        </div>
      )}

      {/* Expanded view: show all traits for selection */}
      {isExpanded && (
        <div className="ml-5">
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
            <div className="flex gap-2 items-center">
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
                className="flex-1 min-w-0 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:border-indigo-500 focus:outline-none"
              />
              <button
                onClick={addCustomTrait}
                disabled={!customTrait.trim()}
                className={`flex-shrink-0 w-10 h-10 rounded-lg font-semibold flex items-center justify-center transition-colors ${
                  customTrait.trim()
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                }`}
              >
                <Plus size={18} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TraitSelector;
