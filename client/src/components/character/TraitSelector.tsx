import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface TraitSelectorProps {
  label: string;
  traits: string[];
  selectedTraits: string[];
  onSelect: (traits: string[]) => void;
  minRequired?: number;
  variant?: 'success' | 'warning' | 'danger';
  allowCustom?: boolean;
}

const variantStyles = {
  success: {
    bg: 'bg-indigo-100',
    selected: 'bg-indigo-600 text-white',
    hover: 'hover:bg-indigo-200',
    text: 'text-indigo-700',
    border: 'border-indigo-300',
  },
  warning: {
    bg: 'bg-indigo-100',
    selected: 'bg-indigo-600 text-white',
    hover: 'hover:bg-indigo-200',
    text: 'text-indigo-700',
    border: 'border-indigo-300',
  },
  danger: {
    bg: 'bg-indigo-100',
    selected: 'bg-indigo-600 text-white',
    hover: 'hover:bg-indigo-200',
    text: 'text-indigo-700',
    border: 'border-indigo-300',
  },
};

export function TraitSelector({
  label,
  traits,
  selectedTraits,
  onSelect,
  minRequired = 0,
  variant = 'success',
  allowCustom = true,
}: TraitSelectorProps) {
  const { t, language } = useLanguage();
  const [customTrait, setCustomTrait] = useState('');
  const [customTraits, setCustomTraits] = useState<string[]>([]);
  const styles = variantStyles[variant];

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
    <div className={`border ${styles.border} rounded-lg p-3 ${styles.bg.replace('100', '50')}`}>
      <label className={`block text-sm font-semibold mb-2 ${styles.text}`}>
        {label}{' '}
        {minRequired > 0 && (
          <span className="text-xs font-normal">
            ({t.selectAtLeast} {minRequired})
          </span>
        )}
        {selectedTraits.length > 0 && (
          <span className="ml-2 text-xs">
            ({t.selected}: {selectedTraits.length})
          </span>
        )}
      </label>

      <div className="flex flex-wrap gap-1.5">
        {allTraits.map((trait) => (
          <button
            key={trait}
            onClick={() => toggleTrait(trait)}
            className={`px-2 py-1 rounded text-xs transition-colors ${
              selectedTraits.includes(trait)
                ? styles.selected
                : `${styles.bg} ${styles.hover} text-gray-700`
            }`}
          >
            {trait}
          </button>
        ))}
      </div>

      {/* Custom trait input */}
      {allowCustom && (
        <div className="flex gap-2 mt-2">
          <input
            type="text"
            value={customTrait}
            onChange={(e) => setCustomTrait(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustomTrait()}
            placeholder={
              language === 'de'
                ? 'Eigene hinzufugen...'
                : language === 'fr'
                ? 'Ajouter personnalise...'
                : 'Add custom...'
            }
            className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs"
          />
          <button
            onClick={addCustomTrait}
            disabled={!customTrait.trim()}
            className={`px-2 py-1 rounded text-xs font-semibold flex items-center gap-1 ${
              customTrait.trim()
                ? `${styles.selected.split(' ')[0]} text-white hover:opacity-90`
                : 'bg-gray-200 text-gray-400 cursor-not-allowed'
            }`}
          >
            <Plus size={12} />
            {language === 'de' ? 'Hinzufugen' : language === 'fr' ? 'Ajouter' : 'Add'}
          </button>
        </div>
      )}
    </div>
  );
}

export default TraitSelector;
