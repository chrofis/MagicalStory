import { ChangeEvent } from 'react';
import { Upload, Save } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Input } from '@/components/common/Input';
import { Textarea } from '@/components/common/Textarea';
import { Button } from '@/components/common/Button';
import TraitSelector from './TraitSelector';
import { strengths as defaultStrengths, weaknesses as defaultWeaknesses, fears as defaultFears } from '@/constants/traits';
import type { Character } from '@/types/character';

// Auto-detect gender from name
function detectGender(name: string): 'male' | 'female' | 'other' {
  const femaleSuffixes = ['a', 'e', 'ie', 'ine', 'elle'];
  const femaleNames = ['sophia', 'emma', 'olivia', 'ava', 'isabella', 'mia', 'charlotte', 'amelia', 'marie', 'anna', 'lisa', 'julia', 'sarah', 'laura', 'lena', 'lea', 'emily', 'sophie', 'nina', 'nora'];
  const maleNames = ['liam', 'noah', 'oliver', 'james', 'lucas', 'max', 'leon', 'paul', 'ben', 'tom', 'felix', 'lukas', 'tim', 'jan', 'finn', 'david', 'michael', 'daniel', 'alexander', 'william'];

  const lowerName = name.toLowerCase().trim();
  if (!lowerName) return 'other';

  if (femaleNames.some(n => lowerName.includes(n))) return 'female';
  if (maleNames.some(n => lowerName.includes(n))) return 'male';
  if (femaleSuffixes.some(suffix => lowerName.endsWith(suffix))) return 'female';

  return 'other';
}

interface CharacterFormProps {
  character: Character;
  onChange: (character: Character) => void;
  onSave: () => void;
  onCancel?: () => void;
  onPhotoChange: (file: File) => void;
  isLoading?: boolean;
}

export function CharacterForm({
  character,
  onChange,
  onSave,
  onCancel,
  onPhotoChange,
  isLoading,
}: CharacterFormProps) {
  const { t, language } = useLanguage();

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onPhotoChange(file);
    }
  };

  const updateField = <K extends keyof Character>(field: K, value: Character[K]) => {
    onChange({ ...character, [field]: value });
  };

  const canSave =
    character.name &&
    character.strengths &&
    character.strengths.length >= 3 &&
    character.weaknesses &&
    character.weaknesses.length >= 2;

  // Get localized traits
  const localizedStrengths = defaultStrengths[language] || defaultStrengths.en;
  const localizedWeaknesses = defaultWeaknesses[language] || defaultWeaknesses.en;
  const localizedFears = defaultFears[language] || defaultFears.en;

  return (
    <div className="bg-white border-2 border-indigo-200 rounded-lg p-3 space-y-3">
      <h3 className="text-base font-bold text-gray-800">
        {character.id ? t.editCharacter : t.startCreating}
      </h3>

      {/* Character Name */}
      <Input
        label={`${t.characterName} *`}
        value={character.name}
        onChange={(e) => {
          const newName = e.target.value;
          updateField('name', newName);
          // Auto-detect gender from name if gender is still 'other'
          if (character.gender === 'other' && newName.length >= 2) {
            const detectedGender = detectGender(newName);
            if (detectedGender !== 'other') {
              updateField('gender', detectedGender);
            }
          }
        }}
        placeholder={t.characterName}
      />

      <div className="grid md:grid-cols-2 gap-3">
        {/* Photo section */}
        <div className="md:border md:border-indigo-300 md:rounded-lg p-2 md:bg-indigo-50">
          <label className="block text-xs font-semibold mb-2 text-center">{t.characterPhoto}</label>
          <div className="flex flex-col items-center gap-2">
            {character.photoUrl && (
              <img
                src={character.photoUrl}
                alt="Character"
                className="w-20 h-20 rounded-full object-cover border-2 border-indigo-400"
              />
            )}

            <label className="cursor-pointer bg-indigo-600 text-white px-3 py-1.5 rounded text-xs hover:bg-indigo-700 flex items-center gap-1 font-semibold transition-colors">
              <Upload size={14} /> {t.uploadPhoto}
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          </div>
        </div>

        {/* Character attributes - from photo analysis or manual entry */}
        <div className="md:border md:border-indigo-300 md:rounded-lg p-4 md:bg-indigo-50">
          <label className="block text-xs font-semibold mb-3 text-center">
            {language === 'de' ? 'Eigenschaften' : language === 'fr' ? 'Caractéristiques' : 'Attributes'}
          </label>
          <div className="space-y-2">
            {/* Gender */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold whitespace-nowrap min-w-[60px]">
                {t.gender}:
              </label>
              <select
                value={character.gender}
                onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm"
              >
                <option value="male">{t.male}</option>
                <option value="female">{t.female}</option>
                <option value="other">{t.other}</option>
              </select>
            </div>

            {/* Age and Height */}
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold whitespace-nowrap">{t.age}:</label>
                <input
                  type="number"
                  value={character.age}
                  onChange={(e) => updateField('age', e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                  min="1"
                  max="120"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold whitespace-nowrap">
                  {language === 'de' ? 'Grosse' : language === 'fr' ? 'Taille' : 'Height'}:
                </label>
                <input
                  type="text"
                  value={character.height || ''}
                  onChange={(e) => updateField('height', e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                  placeholder="cm"
                />
              </div>
            </div>

            {/* Hair Color */}
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold whitespace-nowrap min-w-[60px]">
                {t.hairColor}:
              </label>
              <input
                type="text"
                value={character.hairColor || ''}
                onChange={(e) => updateField('hairColor', e.target.value)}
                className="flex-1 px-2 py-1.5 border border-gray-300 rounded text-sm"
              />
            </div>

            {/* Other Features */}
            <div>
              <label className="text-xs font-semibold block mb-1">{t.otherFeatures}:</label>
              <input
                type="text"
                value={character.otherFeatures || ''}
                onChange={(e) => updateField('otherFeatures', e.target.value)}
                className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm"
                placeholder={t.descriptionPlaceholder}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Trait Selectors */}
      <div className="space-y-3">
        <TraitSelector
          label={t.strengths}
          traits={localizedStrengths}
          selectedTraits={character.strengths || []}
          onSelect={(traits) => updateField('strengths', traits)}
          minRequired={3}
          variant="success"
        />

        <TraitSelector
          label={t.weaknesses}
          traits={localizedWeaknesses}
          selectedTraits={character.weaknesses || []}
          onSelect={(traits) => updateField('weaknesses', traits)}
          minRequired={2}
          variant="warning"
        />

        <TraitSelector
          label={t.fears}
          traits={localizedFears}
          selectedTraits={character.fears || []}
          onSelect={(traits) => updateField('fears', traits)}
          variant="danger"
        />
      </div>

      {/* Special Details */}
      <Textarea
        label={t.specialDetails}
        value={character.specialDetails || ''}
        onChange={(e) => updateField('specialDetails', e.target.value)}
        placeholder={t.specialDetailsPlaceholder}
        rows={3}
      />

      {/* Cancel and Save Buttons - Side by Side */}
      <div className="flex gap-3">
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex-1 bg-gray-200 text-gray-700 px-4 py-2 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
          >
            {t.cancel}
          </button>
        )}
        <Button
          onClick={onSave}
          disabled={!canSave || isLoading}
          loading={isLoading}
          icon={Save}
          className={onCancel ? "flex-1" : "w-full"}
        >
          {t.saveCharacter}
        </Button>
      </div>

      {!canSave && (
        <p className="text-xs text-red-500 text-center">
          {language === 'de'
            ? 'Bitte Name eingeben, mind. 3 Starken und 2 Schwachen wahlen'
            : language === 'fr'
            ? 'Veuillez entrer un nom, selectionner au moins 3 forces et 2 faiblesses'
            : 'Please enter a name, select at least 3 strengths and 2 weaknesses'}
        </p>
      )}
    </div>
  );
}

export default CharacterForm;
