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
  isAnalyzingPhoto?: boolean;
  step: 'name' | 'traits';
  developerMode?: boolean;
}

export function CharacterForm({
  character,
  onChange,
  onSave,
  onCancel,
  onPhotoChange,
  onContinueToTraits,
  isLoading,
  isAnalyzingPhoto,
  step,
  developerMode,
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
        {/* Photo display - show spinner while analyzing */}
        <div className="flex flex-col items-center gap-4">
          {isAnalyzingPhoto ? (
            <div className="w-32 h-32 rounded-full bg-indigo-100 border-4 border-indigo-400 shadow-lg flex items-center justify-center">
              <div className="flex flex-col items-center gap-2">
                <div className="w-8 h-8 border-3 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-indigo-600 font-medium">
                  {language === 'de' ? 'Analysiere...' : language === 'fr' ? 'Analyse...' : 'Analyzing...'}
                </span>
              </div>
            </div>
          ) : character.photoUrl ? (
            <img
              src={character.photoUrl}
              alt="Character"
              className="w-32 h-32 rounded-full object-cover border-4 border-indigo-400 shadow-lg"
            />
          ) : (
            <div className="w-32 h-32 rounded-full bg-gray-200 border-4 border-gray-300 flex items-center justify-center">
              <Upload size={32} className="text-gray-400" />
            </div>
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
      {/* Header with photo and name */}
      <div className="flex items-center gap-4">
        {/* Photo with change option - show spinner while analyzing */}
        <label className="flex-shrink-0 relative group cursor-pointer">
          {isAnalyzingPhoto ? (
            <div className="w-20 h-20 rounded-full bg-indigo-100 border-2 border-indigo-400 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : character.photoUrl ? (
            <img
              src={character.photoUrl}
              alt={character.name}
              className="w-20 h-20 rounded-full object-cover border-2 border-indigo-400"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-gray-200 border-2 border-gray-300 flex items-center justify-center">
              <Upload size={24} className="text-gray-400" />
            </div>
          )}
          {/* Hover overlay for desktop */}
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
            <Upload size={20} className="text-white" />
          </div>
          {/* Always visible badge for mobile/discoverability */}
          <div className="absolute -bottom-1 -right-1 bg-indigo-600 text-white rounded-full p-1.5 shadow-lg border-2 border-white">
            <Upload size={12} />
          </div>
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
        {/* Name */}
        <h3 className="text-2xl font-bold text-gray-800">{character.name}</h3>
      </div>

      {/* Developer Mode: Show body crop with transparent background */}
      {developerMode && character.bodyNoBgUrl && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-yellow-700 mb-2">
            🛠️ Developer Mode: Body Crop (No Background)
          </h4>
          <div className="flex justify-center">
            <img
              src={character.bodyNoBgUrl}
              alt={`${character.name} body crop`}
              className="max-h-48 object-contain rounded border border-gray-300"
              style={{ background: 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 20px 20px' }}
            />
          </div>
        </div>
      )}

      {/* Developer Mode: Style Profile from photo analysis */}
      {developerMode && (console.log('CharacterForm developerMode check:', { developerMode, hasStyleAnalysis: !!character.styleAnalysis, styleAnalysis: character.styleAnalysis }), null)}
      {developerMode && character.styleAnalysis && (
        <div className="bg-purple-50 border border-purple-300 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-purple-700 mb-3">
            👗 Style Profile (from photo analysis)
          </h4>

          {/* Physical Features */}
          <div className="mb-4">
            <h5 className="text-xs font-bold text-purple-600 uppercase mb-2">Physical Features</h5>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
              <div>
                <span className="font-medium text-gray-600">Face:</span>
                <p className="text-gray-800">{character.styleAnalysis.physical?.face || 'Not analyzed'}</p>
              </div>
              <div>
                <span className="font-medium text-gray-600">Hair:</span>
                <p className="text-gray-800">{character.styleAnalysis.physical?.hair || 'Not analyzed'}</p>
              </div>
              <div>
                <span className="font-medium text-gray-600">Build:</span>
                <p className="text-gray-800">{character.styleAnalysis.physical?.build || 'Not analyzed'}</p>
              </div>
            </div>
          </div>

          {/* Reference Outfit */}
          <div className="mb-4">
            <h5 className="text-xs font-bold text-purple-600 uppercase mb-2">Reference Outfit</h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                <span className="font-medium text-gray-600">Type:</span>
                <p className="text-gray-800">{character.styleAnalysis.referenceOutfit?.garmentType || 'Unknown'}</p>
              </div>
              <div>
                <span className="font-medium text-gray-600">Primary Color:</span>
                <p className="text-gray-800">{character.styleAnalysis.referenceOutfit?.primaryColor || 'Unknown'}</p>
              </div>
              <div>
                <span className="font-medium text-gray-600">Pattern:</span>
                <p className="text-gray-800">{character.styleAnalysis.referenceOutfit?.pattern || 'None'}</p>
              </div>
              <div>
                <span className="font-medium text-gray-600">Setting:</span>
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                  character.styleAnalysis.referenceOutfit?.setting === 'outdoor-cold' ? 'bg-blue-100 text-blue-800' :
                  character.styleAnalysis.referenceOutfit?.setting === 'outdoor-warm' ? 'bg-yellow-100 text-yellow-800' :
                  character.styleAnalysis.referenceOutfit?.setting === 'indoor-casual' ? 'bg-green-100 text-green-800' :
                  character.styleAnalysis.referenceOutfit?.setting === 'indoor-formal' ? 'bg-purple-100 text-purple-800' :
                  character.styleAnalysis.referenceOutfit?.setting === 'active' ? 'bg-orange-100 text-orange-800' :
                  character.styleAnalysis.referenceOutfit?.setting === 'sleep' ? 'bg-indigo-100 text-indigo-800' :
                  'bg-gray-100 text-gray-800'
                }`}>
                  {character.styleAnalysis.referenceOutfit?.setting || 'neutral'}
                </span>
              </div>
            </div>
            {character.styleAnalysis.referenceOutfit?.secondaryColors && character.styleAnalysis.referenceOutfit.secondaryColors.length > 0 && (
              <div className="mt-2 text-sm">
                <span className="font-medium text-gray-600">Secondary Colors:</span>
                <span className="text-gray-800 ml-1">{character.styleAnalysis.referenceOutfit.secondaryColors.join(', ')}</span>
              </div>
            )}
            {character.styleAnalysis.referenceOutfit?.accessories && character.styleAnalysis.referenceOutfit.accessories.length > 0 && (
              <div className="mt-1 text-sm">
                <span className="font-medium text-gray-600">Accessories:</span>
                <span className="text-gray-800 ml-1">{character.styleAnalysis.referenceOutfit.accessories.join(', ')}</span>
              </div>
            )}
          </div>

          {/* Style DNA */}
          <div>
            <h5 className="text-xs font-bold text-purple-600 uppercase mb-2">Style DNA</h5>
            <div className="space-y-2 text-sm">
              {character.styleAnalysis.styleDNA?.aesthetic && (
                <div>
                  <span className="font-medium text-gray-600">Aesthetic:</span>
                  <span className="text-gray-800 ml-1 italic">{character.styleAnalysis.styleDNA.aesthetic}</span>
                </div>
              )}
              {character.styleAnalysis.styleDNA?.signatureColors && character.styleAnalysis.styleDNA.signatureColors.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center">
                  <span className="font-medium text-gray-600">Signature Colors:</span>
                  {character.styleAnalysis.styleDNA.signatureColors.map((color, i) => (
                    <span key={i} className="px-2 py-0.5 bg-white border border-gray-300 rounded text-xs">{color}</span>
                  ))}
                </div>
              )}
              {character.styleAnalysis.styleDNA?.signaturePatterns && character.styleAnalysis.styleDNA.signaturePatterns.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center">
                  <span className="font-medium text-gray-600">Patterns:</span>
                  {character.styleAnalysis.styleDNA.signaturePatterns.map((pattern, i) => (
                    <span key={i} className="px-2 py-0.5 bg-white border border-gray-300 rounded text-xs">{pattern}</span>
                  ))}
                </div>
              )}
              {character.styleAnalysis.styleDNA?.signatureDetails && character.styleAnalysis.styleDNA.signatureDetails.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center">
                  <span className="font-medium text-gray-600">Details:</span>
                  {character.styleAnalysis.styleDNA.signatureDetails.map((detail, i) => (
                    <span key={i} className="px-2 py-0.5 bg-white border border-gray-300 rounded text-xs">{detail}</span>
                  ))}
                </div>
              )}
              {character.styleAnalysis.styleDNA?.alwaysPresent && character.styleAnalysis.styleDNA.alwaysPresent.length > 0 && (
                <div className="flex flex-wrap gap-1 items-center">
                  <span className="font-medium text-gray-600">Always Present:</span>
                  {character.styleAnalysis.styleDNA.alwaysPresent.map((item, i) => (
                    <span key={i} className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded text-xs font-medium">{item}</span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Analysis timestamp */}
          {character.styleAnalysis.analyzedAt && (
            <div className="mt-3 pt-2 border-t border-purple-200 text-xs text-purple-500">
              Analyzed: {new Date(character.styleAnalysis.analyzedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Extracted Features - Editable */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-gray-600 mb-3">
          {language === 'de' ? 'Erkannte Eigenschaften (bearbeitbar)' : language === 'fr' ? 'Caractéristiques détectées (modifiables)' : 'Detected Features (editable)'}
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Gender */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">{t.gender}</label>
            <select
              value={character.gender}
              onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="male">{t.male}</option>
              <option value="female">{t.female}</option>
              <option value="other">{t.other}</option>
            </select>
          </div>

          {/* Age */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">{t.age}</label>
            <input
              type="number"
              value={character.age}
              onChange={(e) => updateField('age', e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
              min="1"
              max="120"
            />
          </div>

          {/* Height */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              {language === 'de' ? 'Grösse (cm)' : language === 'fr' ? 'Taille (cm)' : 'Height (cm)'}
            </label>
            <input
              type="number"
              value={character.height || ''}
              onChange={(e) => updateField('height', e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="cm"
              min="50"
              max="250"
            />
          </div>

          {/* Build */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              {language === 'de' ? 'Körperbau' : language === 'fr' ? 'Corpulence' : 'Build'}
            </label>
            <select
              value={character.build || ''}
              onChange={(e) => updateField('build', e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white focus:border-indigo-500 focus:outline-none"
            >
              <option value="">{language === 'de' ? 'Wählen...' : language === 'fr' ? 'Choisir...' : 'Select...'}</option>
              <option value="slim">{language === 'de' ? 'Schlank' : language === 'fr' ? 'Mince' : 'Slim'}</option>
              <option value="average">{language === 'de' ? 'Durchschnittlich' : language === 'fr' ? 'Moyenne' : 'Average'}</option>
              <option value="athletic">{language === 'de' ? 'Athletisch' : language === 'fr' ? 'Athlétique' : 'Athletic'}</option>
              <option value="chubby">{language === 'de' ? 'Mollig' : language === 'fr' ? 'Potelé' : 'Chubby'}</option>
            </select>
          </div>

          {/* Hair Color */}
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1">{t.hairColor}</label>
            <input
              type="text"
              value={character.hairColor || ''}
              onChange={(e) => updateField('hairColor', e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
              placeholder={language === 'de' ? 'z.B. braun, blond' : language === 'fr' ? 'ex. brun, blond' : 'e.g. brown, blonde'}
            />
          </div>

          {/* Other Features */}
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-gray-500 mb-1">{t.otherFeatures}</label>
            <input
              type="text"
              value={character.otherFeatures || ''}
              onChange={(e) => updateField('otherFeatures', e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
              placeholder={language === 'de' ? 'Brille, Bart, etc.' : language === 'fr' ? 'Lunettes, barbe, etc.' : 'Glasses, beard, etc.'}
            />
          </div>

          {/* Clothing */}
          <div className="col-span-2 md:col-span-4">
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              {language === 'de' ? 'Kleidung' : language === 'fr' ? 'Vêtements' : 'Clothing'}
            </label>
            <input
              type="text"
              value={character.clothing || ''}
              onChange={(e) => updateField('clothing', e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
              placeholder={language === 'de' ? 'z.B. blaues T-Shirt, Jeans' : language === 'fr' ? 'ex. t-shirt bleu, jeans' : 'e.g. blue t-shirt, jeans'}
            />
          </div>
        </div>
      </div>

      {/* Trait Selectors - all indigo color */}
      <TraitSelector
        label={t.strengths}
        traits={localizedStrengths}
        selectedTraits={character.strengths || []}
        onSelect={(traits) => updateField('strengths', traits)}
        minRequired={3}
      />

      <TraitSelector
        label={language === 'de' ? 'Schwächen' : language === 'fr' ? 'Défauts' : 'Flaws'}
        traits={localizedFlaws}
        selectedTraits={character.flaws || []}
        onSelect={(traits) => updateField('flaws', traits)}
        minRequired={2}
      />

      <TraitSelector
        label={language === 'de' ? 'Konflikte / Herausforderungen' : language === 'fr' ? 'Conflits / Défis' : 'Conflicts / Challenges'}
        traits={localizedChallenges}
        selectedTraits={character.challenges || []}
        onSelect={(traits) => updateField('challenges', traits)}
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
