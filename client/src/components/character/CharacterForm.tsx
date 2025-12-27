import { ChangeEvent, useState, useCallback, useEffect } from 'react';
import { Upload, Save, ArrowRight, Edit3, X, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import TraitSelector from './TraitSelector';
import { strengths as defaultStrengths, flaws as defaultFlaws, challenges as defaultChallenges } from '@/constants/traits';
import type { Character, PhysicalTraits } from '@/types/character';
import { api } from '@/services/api';

// Component to fetch and display avatar prompt from server
function AvatarPromptDisplay({ category, gender, physical }: {
  category: string;
  gender: string | undefined;
  physical?: PhysicalTraits;
}) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWithTraits, setShowWithTraits] = useState(false);

  useEffect(() => {
    const fetchPrompt = async () => {
      setLoading(true);
      setError(null);
      try {
        // Build query params
        let url = `/api/avatar-prompt?category=${category}&gender=${gender || 'male'}`;
        if (showWithTraits && physical) {
          url += `&withTraits=true`;
          if (physical.hair) url += `&hair=${encodeURIComponent(physical.hair)}`;
          if (physical.face) url += `&face=${encodeURIComponent(physical.face)}`;
          if (physical.other) url += `&other=${encodeURIComponent(physical.other)}`;
          if (physical.height) url += `&height=${encodeURIComponent(physical.height)}`;
        }
        const response = await api.get<{ success: boolean; prompt: string }>(url);
        if (response.success) {
          setPrompt(response.prompt);
        } else {
          setError('Failed to load prompt');
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    };
    fetchPrompt();
  }, [category, gender, showWithTraits, physical]);

  const hasTraits = physical && (physical.hair || physical.face || physical.other || physical.height);

  return (
    <div>
      {hasTraits && (
        <label className="flex items-center gap-1 text-[9px] text-gray-500 mb-1 cursor-pointer">
          <input
            type="checkbox"
            checked={showWithTraits}
            onChange={(e) => setShowWithTraits(e.target.checked)}
            className="w-3 h-3"
          />
          Show with traits
        </label>
      )}
      {loading ? (
        <div className="text-[9px] text-gray-400">Loading...</div>
      ) : error ? (
        <div className="text-[9px] text-red-400">{error}</div>
      ) : (
        <pre className={`mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-48 border ${showWithTraits ? 'bg-amber-50 border-amber-300' : 'bg-gray-100 border-gray-200'}`}>
          {prompt}
        </pre>
      )}
    </div>
  );
}

// Editable field component
interface EditableStyleFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  isEditing: boolean;
  editValue: string;
  onEditValueChange: (value: string) => void;
  onStartEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}

function EditableStyleField({
  label,
  value,
  placeholder,
  isEditing,
  editValue,
  onEditValueChange,
  onStartEdit,
  onSave,
  onCancel,
}: EditableStyleFieldProps) {
  return (
    <div>
      <span className="font-medium text-gray-600 text-xs">{label}:</span>
      {isEditing ? (
        <div className="flex items-center gap-1 mt-0.5">
          <input
            type="text"
            value={editValue}
            onChange={(e) => onEditValueChange(e.target.value)}
            className="flex-1 min-w-0 px-2 py-1 text-sm border border-indigo-300 rounded focus:outline-none focus:border-indigo-500"
            autoFocus
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave();
              if (e.key === 'Escape') onCancel();
            }}
          />
          <button onClick={onSave} className="flex-shrink-0 p-1 text-green-600 hover:bg-green-100 rounded">
            <Check size={14} />
          </button>
          <button onClick={onCancel} className="flex-shrink-0 p-1 text-gray-500 hover:bg-gray-100 rounded">
            <X size={14} />
          </button>
        </div>
      ) : (
        <div
          onClick={onStartEdit}
          className="flex items-center gap-1 cursor-pointer hover:bg-purple-100 rounded px-2 py-1 -mx-2 -my-1 group"
        >
          <p className="text-gray-800 text-sm flex-1">{value || <span className="text-gray-400 italic">{placeholder || 'Click to set'}</span>}</p>
          <Edit3 size={12} className="text-purple-400 group-hover:text-purple-600" />
        </div>
      )}
    </div>
  );
}

interface CharacterFormProps {
  character: Character;
  onChange: (character: Character) => void;
  onSave: () => void;
  onCancel?: () => void;
  onPhotoChange: (file: File) => void;
  onContinueToTraits?: () => void;
  onRegenerateAvatars?: () => void;
  onRegenerateAvatarsWithTraits?: () => void;
  isLoading?: boolean;
  isAnalyzingPhoto?: boolean;
  isRegeneratingAvatars?: boolean;
  isRegeneratingAvatarsWithTraits?: boolean;
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
  onRegenerateAvatars,
  onRegenerateAvatarsWithTraits,
  isLoading,
  isAnalyzingPhoto,
  isRegeneratingAvatars,
  isRegeneratingAvatarsWithTraits,
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

  // Update top-level character fields
  const updateField = <K extends keyof Character>(field: K, value: Character[K]) => {
    onChange({ ...character, [field]: value });
  };

  // Update physical traits
  const updatePhysical = (field: keyof PhysicalTraits, value: string) => {
    onChange({
      ...character,
      physical: {
        ...character.physical,
        [field]: value,
      },
    });
  };

  // Update psychological traits
  const updateTraits = (field: keyof Character['traits'], value: string[] | string) => {
    onChange({
      ...character,
      traits: {
        ...character.traits,
        [field]: value,
      },
    });
  };

  // Style profile editing state
  const [editingStyleField, setEditingStyleField] = useState<string | null>(null);
  const [editStyleValue, setEditStyleValue] = useState('');

  const saveStyleEdit = () => {
    if (editingStyleField) {
      const parts = editingStyleField.split('.');
      if (parts[0] === 'physical') {
        updatePhysical(parts[1] as keyof PhysicalTraits, editStyleValue);
      } else if (parts[0] === 'clothing') {
        // Update clothing fields (e.g., clothing.colors)
        onChange({
          ...character,
          clothing: {
            ...character.clothing,
            [parts[1]]: editStyleValue,
          },
        });
      }
    }
    setEditingStyleField(null);
    setEditStyleValue('');
  };

  const cancelStyleEdit = () => {
    setEditingStyleField(null);
    setEditStyleValue('');
  };

  const handleStartEdit = useCallback((path: string, value: string) => {
    setEditingStyleField(path);
    setEditStyleValue(value || '');
  }, []);

  const canSaveName = character.name && character.name.trim().length >= 2;

  const canSaveCharacter =
    character.name &&
    character.traits?.strengths &&
    character.traits.strengths.length >= 3 &&
    character.traits?.flaws &&
    character.traits.flaws.length >= 2;

  // Get localized traits
  const localizedStrengths = defaultStrengths[language] || defaultStrengths.en;
  const localizedFlaws = defaultFlaws[language] || defaultFlaws.en;
  const localizedChallenges = defaultChallenges[language] || defaultChallenges.en;

  // Get display photo URL
  const displayPhoto = character.photos?.face || character.photos?.original;

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
          ) : displayPhoto ? (
            <img
              src={displayPhoto}
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
        {/* Photo with change option */}
        <label className="flex-shrink-0 relative group cursor-pointer">
          {isAnalyzingPhoto ? (
            <div className="w-20 h-20 rounded-full bg-indigo-100 border-2 border-indigo-400 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : displayPhoto ? (
            <img
              src={displayPhoto}
              alt={character.name}
              className="w-20 h-20 rounded-full object-cover border-2 border-indigo-400"
            />
          ) : (
            <div className="w-20 h-20 rounded-full bg-gray-200 border-2 border-gray-300 flex items-center justify-center">
              <Upload size={24} className="text-gray-400" />
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
            <Upload size={20} className="text-white" />
          </div>
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
        <h3 className="text-2xl font-bold text-gray-800">{character.name}</h3>
      </div>

      {/* Developer Mode: Show body crop with transparent background */}
      {developerMode && character.photos?.bodyNoBg && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-yellow-700 mb-2">
            Body Crop (No Background)
          </h4>
          <div className="flex justify-center">
            <img
              src={character.photos.bodyNoBg}
              alt={`${character.name} body crop`}
              className="max-h-48 object-contain rounded border border-gray-300"
              style={{ background: 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 20px 20px' }}
            />
          </div>
        </div>
      )}

      {/* Basic Info - Gender, Age, Height */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-gray-600 mb-3">
          {language === 'de' ? 'Grundinformationen' : language === 'fr' ? 'Informations de base' : 'Basic Info'}
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
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
          <div>
            <label className="block text-xs font-semibold text-gray-500 mb-1">
              {language === 'de' ? 'Grösse (cm)' : language === 'fr' ? 'Taille (cm)' : 'Height (cm)'}
            </label>
            <input
              type="number"
              value={character.physical?.height || ''}
              onChange={(e) => updatePhysical('height', e.target.value)}
              className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="cm"
              min="50"
              max="250"
            />
          </div>
        </div>
      </div>

      {/* Physical Features */}
      <details className="bg-gray-50 border border-gray-200 rounded-lg">
        <summary className="p-4 cursor-pointer hover:bg-gray-100 rounded-lg">
          <span className="text-sm font-semibold text-gray-600 inline-flex items-center gap-2">
            {language === 'de' ? 'Physische Merkmale' : language === 'fr' ? 'Caractéristiques physiques' : 'Physical Features'}
            <span className="text-xs font-normal text-gray-500">
              ({language === 'de' ? 'klicken zum Bearbeiten' : language === 'fr' ? 'cliquez pour modifier' : 'click to edit'})
            </span>
          </span>
        </summary>
        <div className="px-4 pb-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <EditableStyleField
              label={language === 'de' ? 'Gesicht' : language === 'fr' ? 'Visage' : 'Face'}
              value={character.physical?.face || ''}
              placeholder={language === 'de' ? 'z.B. rund, oval, eckig' : 'e.g. round, oval, square'}
              isEditing={editingStyleField === 'physical.face'}
              editValue={editStyleValue}
              onEditValueChange={setEditStyleValue}
              onStartEdit={() => handleStartEdit('physical.face', character.physical?.face || '')}
              onSave={saveStyleEdit}
              onCancel={cancelStyleEdit}
            />
            <EditableStyleField
              label={language === 'de' ? 'Haare' : language === 'fr' ? 'Cheveux' : 'Hair'}
              value={character.physical?.hair || ''}
              placeholder={language === 'de' ? 'z.B. braun, kurz, lockig' : 'e.g. brown, short, curly'}
              isEditing={editingStyleField === 'physical.hair'}
              editValue={editStyleValue}
              onEditValueChange={setEditStyleValue}
              onStartEdit={() => handleStartEdit('physical.hair', character.physical?.hair || '')}
              onSave={saveStyleEdit}
              onCancel={cancelStyleEdit}
            />
            <EditableStyleField
              label={language === 'de' ? 'Körperbau' : language === 'fr' ? 'Corpulence' : 'Build'}
              value={character.physical?.build || ''}
              placeholder={language === 'de' ? 'z.B. schlank, athletisch' : 'e.g. slim, athletic'}
              isEditing={editingStyleField === 'physical.build'}
              editValue={editStyleValue}
              onEditValueChange={setEditStyleValue}
              onStartEdit={() => handleStartEdit('physical.build', character.physical?.build || '')}
              onSave={saveStyleEdit}
              onCancel={cancelStyleEdit}
            />
            <EditableStyleField
              label={language === 'de' ? 'Sonstiges' : language === 'fr' ? 'Autre' : 'Other'}
              value={character.physical?.other || ''}
              placeholder={language === 'de' ? 'z.B. Brille, Muttermal' : language === 'fr' ? 'ex. lunettes, grain de beauté' : 'e.g. glasses, birthmark'}
              isEditing={editingStyleField === 'physical.other'}
              editValue={editStyleValue}
              onEditValueChange={setEditStyleValue}
              onStartEdit={() => handleStartEdit('physical.other', character.physical?.other || '')}
              onSave={saveStyleEdit}
              onCancel={cancelStyleEdit}
            />
            <EditableStyleField
              label={language === 'de' ? 'Kleidungsstil' : language === 'fr' ? 'Style vestimentaire' : 'Clothing Style'}
              value={character.clothing?.style || ''}
              placeholder={language === 'de' ? 'z.B. schwarz mit Dino-Muster' : language === 'fr' ? 'ex. noir avec motif dinosaure' : 'e.g. black with dinosaur print'}
              isEditing={editingStyleField === 'clothing.style'}
              editValue={editStyleValue}
              onEditValueChange={setEditStyleValue}
              onStartEdit={() => handleStartEdit('clothing.style', character.clothing?.style || '')}
              onSave={saveStyleEdit}
              onCancel={cancelStyleEdit}
            />
          </div>
        </div>
      </details>

      {/* Clothing Avatars (developer only) */}
      {developerMode && (
        <div className="bg-teal-50 border border-teal-300 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-teal-700 mb-3 flex items-center gap-2">
            {language === 'de' ? 'Kleidungs-Avatare' : language === 'fr' ? 'Avatars vestimentaires' : 'Clothing Avatars'}
            {character.avatars?.status === 'generating' && (
              <span className="text-xs font-normal text-teal-500 flex items-center gap-1">
                <div className="w-3 h-3 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                {language === 'de' ? 'Generierung läuft...' : 'Generating...'}
              </span>
            )}
            {character.avatars?.status === 'complete' && !character.avatars?.stale && (
              <span className="text-xs font-normal text-green-600">
                {language === 'de' ? 'Fertig' : language === 'fr' ? 'Terminé' : 'Complete'}
              </span>
            )}
            {character.avatars?.stale && (
              <span className="text-xs font-normal text-amber-600">
                ⚠️ {language === 'de' ? 'Von altem Foto' : language === 'fr' ? 'De l\'ancienne photo' : 'From previous photo'}
              </span>
            )}
            {character.avatars?.status === 'failed' && (
              <span className="text-xs font-normal text-red-600">
                {language === 'de' ? 'Fehlgeschlagen' : language === 'fr' ? 'Échoué' : 'Failed'}
              </span>
            )}
          </h4>
          <div className="grid grid-cols-2 gap-4">
            {(['winter', 'standard', 'summer', 'formal'] as const).map((category) => (
              <div key={category} className="text-center">
                <div className="text-sm font-medium text-gray-600 mb-2 capitalize">
                  {category === 'winter' ? '❄️ ' : category === 'summer' ? '☀️ ' : category === 'formal' ? '👔 ' : '👕 '}
                  {language === 'de'
                    ? (category === 'winter' ? 'Winter' : category === 'summer' ? 'Sommer' : category === 'formal' ? 'Formal' : 'Standard')
                    : category}
                </div>
                {character.avatars?.[category] ? (
                  <div className="relative">
                    <img
                      src={character.avatars[category]}
                      alt={`${character.name} - ${category}`}
                      className={`w-full h-64 object-contain rounded border bg-white ${character.avatars?.stale ? 'border-amber-400 opacity-75' : 'border-teal-200'}`}
                    />
                    {character.avatars?.stale && (
                      <div className="absolute top-1 right-1 bg-amber-500 text-white text-[10px] px-1.5 py-0.5 rounded">
                        {language === 'de' ? 'Altes Foto' : language === 'fr' ? 'Ancienne' : 'Old photo'}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-full h-64 rounded border border-dashed border-teal-300 bg-teal-100/50 flex items-center justify-center text-teal-400 text-xs">
                    {character.avatars?.status === 'generating' ? '...' : 'Not generated'}
                  </div>
                )}
                {developerMode && (
                  <details className="mt-1 text-left">
                    <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">Show prompt</summary>
                    <AvatarPromptDisplay category={category} gender={character.gender} physical={character.physical} />
                  </details>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {character.avatars?.generatedAt && (
              <div className="text-xs text-teal-500">
                Generated: {new Date(character.avatars.generatedAt).toLocaleString()}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              {onRegenerateAvatarsWithTraits && (
                <button
                  onClick={onRegenerateAvatarsWithTraits}
                  disabled={isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating'}
                  className="px-3 py-1.5 text-xs font-medium bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  title={language === 'de' ? 'Generiert Avatare mit allen physischen Merkmalen (Brille, Haarfarbe, etc.)' : 'Generates avatars with all physical traits (glasses, hair color, etc.)'}
                >
                  {isRegeneratingAvatarsWithTraits ? (
                    <>
                      <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      {language === 'de' ? 'Generiere...' : 'Generating...'}
                    </>
                  ) : (
                    <>{language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}</>
                  )}
                </button>
              )}
              {onRegenerateAvatars && (
                <button
                  onClick={onRegenerateAvatars}
                  disabled={isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating'}
                  className="px-3 py-1.5 text-xs font-medium bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  title={language === 'de' ? 'Alte Methode ohne physische Merkmale' : 'Old method without physical traits'}
                >
                  {isRegeneratingAvatars ? (
                    <>
                      <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      {language === 'de' ? 'Generiere...' : 'Generating...'}
                    </>
                  ) : (
                    <>{language === 'de' ? 'Ohne Merkmale (alt)' : language === 'fr' ? 'Sans traits (ancien)' : 'Without Traits (old)'}</>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trait Selectors */}
      <TraitSelector
        label={t.strengths}
        traits={localizedStrengths}
        selectedTraits={character.traits?.strengths || []}
        onSelect={(traits) => updateTraits('strengths', traits)}
        minRequired={3}
      />

      <TraitSelector
        label={language === 'de' ? 'Schwächen' : language === 'fr' ? 'Défauts' : 'Flaws'}
        traits={localizedFlaws}
        selectedTraits={character.traits?.flaws || []}
        onSelect={(traits) => updateTraits('flaws', traits)}
        minRequired={2}
      />

      <TraitSelector
        label={language === 'de' ? 'Konflikte / Herausforderungen' : language === 'fr' ? 'Conflits / Défis' : 'Conflicts / Challenges'}
        traits={localizedChallenges}
        selectedTraits={character.traits?.challenges || []}
        onSelect={(traits) => updateTraits('challenges', traits)}
      />

      {/* Special Details */}
      <div>
        <label className="block text-lg font-semibold mb-2 text-indigo-700">{t.specialDetails}</label>
        <textarea
          value={character.traits?.specialDetails || ''}
          onChange={(e) => updateTraits('specialDetails', e.target.value)}
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
          {t.selectStrengthsFlaws}
        </p>
      )}
    </div>
  );
}

export default CharacterForm;
