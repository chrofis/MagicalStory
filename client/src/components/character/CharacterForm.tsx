import { ChangeEvent } from 'react';
import { Upload, Save, ArrowRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import TraitSelector from './TraitSelector';
import { strengths as defaultStrengths, flaws as defaultFlaws, challenges as defaultChallenges } from '@/constants/traits';
import type { Character } from '@/types/character';

interface CharacterFormProps {
  character: Character;
  onChange: (character: Character) => void;
  onSave: () => void;
  onCancel?: () => void;
  onPhotoChange: (file: File) => void;
  onContinueToTraits?: () => void;
  isLoading?: boolean;
  step: 'name' | 'traits';
}

export function CharacterForm({
  character,
  onChange,
  onSave,
  onCancel,
  onPhotoChange,
  onContinueToTraits,
  isLoading,
  step,
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

  const canSaveName = character.name && character.name.trim().length >= 2;

  const canSaveCharacter =
    character.name &&
    character.strengths &&
    character.strengths.length >= 3 &&
    character.flaws &&
    character.flaws.length >= 2;

  // Get localized traits
  const localizedStrengths = defaultStrengths[language] || defaultStrengths.en;
  const localizedFlaws = defaultFlaws[language] || defaultFlaws.en;
  const localizedChallenges = defaultChallenges[language] || defaultChallenges.en;

  // Step 1: Name entry only
  if (step === 'name') {
    return (
      <div className="space-y-6">
        {/* Photo display */}
        <div className="flex flex-col items-center gap-4">
          {character.photoUrl && (
            <img
              src={character.photoUrl}
              alt="Character"
              className="w-32 h-32 rounded-full object-cover border-4 border-indigo-400 shadow-lg"
            />
          )}

          <label className="cursor-pointer bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-300 flex items-center gap-2 font-semibold transition-colors">
            <Upload size={16} />
            {language === 'de' ? 'Anderes Foto' : language === 'fr' ? 'Autre photo' : 'Change Photo'}
            <input
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
        </div>

        {/* Name input */}
        <div>
          <label className="block text-lg font-semibold mb-2 text-center">
            {language === 'de' ? 'Wie heisst diese Person?' : language === 'fr' ? 'Comment s\'appelle cette personne?' : 'What is this person\'s name?'}
          </label>
          <input
            type="text"
            value={character.name}
            onChange={(e) => updateField('name', e.target.value)}
            className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg text-lg text-center focus:border-indigo-500 focus:outline-none"
            placeholder={t.characterName}
            autoFocus
          />
        </div>

        {/* Buttons */}
        <div className="flex gap-3">
          {onCancel && (
            <button
              onClick={onCancel}
              className="flex-1 bg-gray-200 text-gray-700 px-4 py-3 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
            >
              {t.cancel}
            </button>
          )}
          <Button
            onClick={onContinueToTraits}
            disabled={!canSaveName || isLoading}
            loading={isLoading}
            icon={ArrowRight}
            className={onCancel ? "flex-1" : "w-full"}
          >
            {language === 'de' ? 'Weiter' : language === 'fr' ? 'Continuer' : 'Continue'}
          </Button>
        </div>
      </div>
    );
  }

  // Step 2: Traits and characteristics
  return (
    <div className="space-y-6">
      {/* Header with photo and basic info */}
      <div className="flex items-start gap-4">
        {/* Photo */}
        <div className="flex-shrink-0">
          {character.photoUrl && (
            <img
              src={character.photoUrl}
              alt={character.name}
              className="w-20 h-20 rounded-full object-cover border-2 border-indigo-400"
            />
          )}
        </div>

        {/* Name and basic attributes */}
        <div className="flex-1">
          <h3 className="text-2xl font-bold text-gray-800 mb-2">{character.name}</h3>

          {/* Extracted attributes in a clean row */}
          <div className="flex flex-wrap gap-3 text-sm text-gray-600">
            {/* Gender */}
            <div className="flex items-center gap-1">
              <span className="font-semibold">{t.gender}:</span>
              <select
                value={character.gender}
                onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                className="px-2 py-1 border border-gray-300 rounded text-sm bg-white"
              >
                <option value="male">{t.male}</option>
                <option value="female">{t.female}</option>
                <option value="other">{t.other}</option>
              </select>
            </div>

            {/* Age */}
            <div className="flex items-center gap-1">
              <span className="font-semibold">{t.age}:</span>
              <input
                type="number"
                value={character.age}
                onChange={(e) => updateField('age', e.target.value)}
                className="w-16 px-2 py-1 border border-gray-300 rounded text-sm"
                min="1"
                max="120"
              />
            </div>

            {/* Height (optional) */}
            {character.height && (
              <div className="flex items-center gap-1">
                <span className="font-semibold">
                  {language === 'de' ? 'Grösse' : language === 'fr' ? 'Taille' : 'Height'}:
                </span>
                <span>{character.height}</span>
              </div>
            )}

            {/* Hair color (optional) */}
            {character.hairColor && (
              <div className="flex items-center gap-1">
                <span className="font-semibold">{t.hairColor}:</span>
                <span>{character.hairColor}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Trait Selectors - clean layout without blue boxes */}
      <TraitSelector
        label={t.strengths}
        traits={localizedStrengths}
        selectedTraits={character.strengths || []}
        onSelect={(traits) => updateField('strengths', traits)}
        minRequired={3}
        color="green"
      />

      <TraitSelector
        label={language === 'de' ? 'Schwächen' : language === 'fr' ? 'Défauts' : 'Flaws'}
        traits={localizedFlaws}
        selectedTraits={character.flaws || []}
        onSelect={(traits) => updateField('flaws', traits)}
        minRequired={2}
        color="orange"
      />

      <TraitSelector
        label={language === 'de' ? 'Konflikte / Herausforderungen' : language === 'fr' ? 'Conflits / Défis' : 'Conflicts / Challenges'}
        traits={localizedChallenges}
        selectedTraits={character.challenges || []}
        onSelect={(traits) => updateField('challenges', traits)}
        color="purple"
      />

      {/* Special Details */}
      <div>
        <label className="block text-lg font-semibold mb-2">{t.specialDetails}</label>
        <textarea
          value={character.specialDetails || ''}
          onChange={(e) => updateField('specialDetails', e.target.value)}
          className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none"
          placeholder={t.specialDetailsPlaceholder}
          rows={3}
        />
      </div>

      {/* Save/Cancel Buttons */}
      <div className="flex gap-3">
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex-1 bg-gray-200 text-gray-700 px-4 py-3 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
          >
            {t.cancel}
          </button>
        )}
        <Button
          onClick={onSave}
          disabled={!canSaveCharacter || isLoading}
          loading={isLoading}
          icon={Save}
          className={onCancel ? "flex-1" : "w-full"}
        >
          {t.saveCharacter}
        </Button>
      </div>

      {!canSaveCharacter && (
        <p className="text-sm text-red-500 text-center">
          {language === 'de'
            ? 'Bitte mindestens 3 Stärken und 2 Schwächen wählen'
            : language === 'fr'
            ? 'Veuillez sélectionner au moins 3 forces et 2 défauts'
            : 'Please select at least 3 strengths and 2 flaws'}
        </p>
      )}
    </div>
  );
}

export default CharacterForm;
