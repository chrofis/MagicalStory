import { ChangeEvent, useState, useCallback } from 'react';
import { Upload, Save, ArrowRight, Edit3, X, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import TraitSelector from './TraitSelector';
import { strengths as defaultStrengths, flaws as defaultFlaws, challenges as defaultChallenges } from '@/constants/traits';
import type { Character, StyleAnalysis } from '@/types/character';

// Editable field component - defined outside to prevent re-creation on each render
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
            className="flex-1 px-2 py-1 text-sm border border-indigo-300 rounded focus:outline-none focus:border-indigo-500"
            autoFocus
            placeholder={placeholder}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave();
              if (e.key === 'Escape') onCancel();
            }}
          />
          <button onClick={onSave} className="p-1 text-green-600 hover:bg-green-100 rounded">
            <Check size={14} />
          </button>
          <button onClick={onCancel} className="p-1 text-gray-500 hover:bg-gray-100 rounded">
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

  // Style profile editing state
  const [editingStyleField, setEditingStyleField] = useState<string | null>(null);
  const [editStyleValue, setEditStyleValue] = useState('');

  // Helper to update styleAnalysis fields
  const updateStyleAnalysis = (path: string, value: string) => {
    const currentStyle = character.styleAnalysis || {
      physical: { face: '', hair: '', build: '' },
      referenceOutfit: {
        garmentType: '', primaryColor: '', secondaryColors: [], pattern: '',
        patternScale: '', seamColor: '', seamStyle: '', fabric: '',
        neckline: '', sleeves: '', accessories: [], setting: 'neutral' as const
      },
      styleDNA: {
        signatureColors: [], signaturePatterns: [], signatureDetails: [],
        aesthetic: '', alwaysPresent: []
      },
      analyzedAt: new Date().toISOString()
    };

    const parts = path.split('.');
    const updated = JSON.parse(JSON.stringify(currentStyle)) as StyleAnalysis;

    if (parts[0] === 'physical') {
      if (parts[1] === 'face') updated.physical.face = value;
      else if (parts[1] === 'hair') updated.physical.hair = value;
      else if (parts[1] === 'build') updated.physical.build = value;
    } else if (parts[0] === 'styleDNA') {
      if (parts[1] === 'aesthetic') updated.styleDNA.aesthetic = value;
      else if (parts[1] === 'signatureColors') updated.styleDNA.signatureColors = value.split(',').map(s => s.trim()).filter(Boolean);
      else if (parts[1] === 'signaturePatterns') updated.styleDNA.signaturePatterns = value.split(',').map(s => s.trim()).filter(Boolean);
      else if (parts[1] === 'alwaysPresent') updated.styleDNA.alwaysPresent = value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (parts[0] === 'referenceOutfit') {
      if (parts[1] === 'garmentType') updated.referenceOutfit.garmentType = value;
      else if (parts[1] === 'primaryColor') updated.referenceOutfit.primaryColor = value;
      else if (parts[1] === 'pattern') updated.referenceOutfit.pattern = value;
      else if (parts[1] === 'setting') updated.referenceOutfit.setting = value as typeof updated.referenceOutfit.setting;
    }

    onChange({ ...character, styleAnalysis: updated });
  };

  const startEditingStyle = (field: string, currentValue: string) => {
    setEditingStyleField(field);
    setEditStyleValue(currentValue || '');
  };

  const saveStyleEdit = () => {
    if (editingStyleField) {
      updateStyleAnalysis(editingStyleField, editStyleValue);
    }
    setEditingStyleField(null);
    setEditStyleValue('');
  };

  const cancelStyleEdit = () => {
    setEditingStyleField(null);
    setEditStyleValue('');
  };

  // Stable callback for starting edit
  const handleStartEdit = useCallback((path: string, value: string) => {
    setEditingStyleField(path);
    setEditStyleValue(value || '');
  }, []);

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

      {/* Basic Info - Gender, Age */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-gray-600 mb-3">
          {language === 'de' ? 'Grundinformationen' : language === 'fr' ? 'Informations de base' : 'Basic Info'}
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
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
        </div>
      </div>

      {/* Physical Features - from Style Analysis (editable) */}
      <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-purple-700 mb-3 flex items-center gap-2">
          👤 {language === 'de' ? 'Physische Merkmale' : language === 'fr' ? 'Caractéristiques physiques' : 'Physical Features'}
          <span className="text-xs font-normal text-purple-500">
            ({language === 'de' ? 'klicken zum Bearbeiten' : language === 'fr' ? 'cliquez pour modifier' : 'click to edit'})
          </span>
        </h4>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <EditableStyleField
            label={language === 'de' ? 'Gesicht' : language === 'fr' ? 'Visage' : 'Face'}
            value={character.styleAnalysis?.physical?.face || ''}
            placeholder={language === 'de' ? 'z.B. rund, oval, eckig' : 'e.g. round, oval, square'}
            isEditing={editingStyleField === 'physical.face'}
            editValue={editStyleValue}
            onEditValueChange={setEditStyleValue}
            onStartEdit={() => handleStartEdit('physical.face', character.styleAnalysis?.physical?.face || '')}
            onSave={saveStyleEdit}
            onCancel={cancelStyleEdit}
          />
          <EditableStyleField
            label={language === 'de' ? 'Haare' : language === 'fr' ? 'Cheveux' : 'Hair'}
            value={character.styleAnalysis?.physical?.hair || ''}
            placeholder={language === 'de' ? 'z.B. braun, kurz, lockig' : 'e.g. brown, short, curly'}
            isEditing={editingStyleField === 'physical.hair'}
            editValue={editStyleValue}
            onEditValueChange={setEditStyleValue}
            onStartEdit={() => handleStartEdit('physical.hair', character.styleAnalysis?.physical?.hair || '')}
            onSave={saveStyleEdit}
            onCancel={cancelStyleEdit}
          />
          <EditableStyleField
            label={language === 'de' ? 'Körperbau' : language === 'fr' ? 'Corpulence' : 'Build'}
            value={character.styleAnalysis?.physical?.build || ''}
            placeholder={language === 'de' ? 'z.B. schlank, athletisch' : 'e.g. slim, athletic'}
            isEditing={editingStyleField === 'physical.build'}
            editValue={editStyleValue}
            onEditValueChange={setEditStyleValue}
            onStartEdit={() => handleStartEdit('physical.build', character.styleAnalysis?.physical?.build || '')}
            onSave={saveStyleEdit}
            onCancel={cancelStyleEdit}
          />
        </div>

        {/* Other Features - additional details */}
        <div className="mt-3 pt-3 border-t border-purple-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{t.otherFeatures}</label>
              <input
                type="text"
                value={character.otherFeatures || ''}
                onChange={(e) => updateField('otherFeatures', e.target.value)}
                className="w-full px-2 py-1.5 border border-purple-200 rounded text-sm focus:border-purple-500 focus:outline-none bg-white"
                placeholder={language === 'de' ? 'Brille, Bart, Sommersprossen...' : language === 'fr' ? 'Lunettes, barbe, taches de rousseur...' : 'Glasses, beard, freckles...'}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                {language === 'de' ? 'Style-Ästhetik' : language === 'fr' ? 'Esthétique de style' : 'Style Aesthetic'}
              </label>
              {editingStyleField === 'styleDNA.aesthetic' ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={editStyleValue}
                    onChange={(e) => setEditStyleValue(e.target.value)}
                    className="flex-1 px-2 py-1.5 text-sm border border-purple-300 rounded focus:outline-none focus:border-purple-500"
                    autoFocus
                    placeholder={language === 'de' ? 'z.B. casual, sportlich, elegant' : 'e.g. casual, sporty, elegant'}
                  />
                  <button onClick={saveStyleEdit} className="p-1 text-green-600 hover:bg-green-100 rounded">
                    <Check size={14} />
                  </button>
                  <button onClick={cancelStyleEdit} className="p-1 text-gray-500 hover:bg-gray-100 rounded">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div
                  onClick={() => startEditingStyle('styleDNA.aesthetic', character.styleAnalysis?.styleDNA?.aesthetic || '')}
                  className="w-full px-2 py-1.5 border border-purple-200 rounded text-sm bg-white cursor-pointer hover:border-purple-400 flex items-center justify-between group"
                >
                  <span className={character.styleAnalysis?.styleDNA?.aesthetic ? 'text-gray-800' : 'text-gray-400 italic'}>
                    {character.styleAnalysis?.styleDNA?.aesthetic || (language === 'de' ? 'Klicken zum Setzen...' : 'Click to set...')}
                  </span>
                  <Edit3 size={12} className="text-gray-400 opacity-0 group-hover:opacity-100" />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Clothing Avatars - generated for different settings (developer only) */}
      {developerMode && character.clothingAvatars && (
        <div className="bg-teal-50 border border-teal-300 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-teal-700 mb-3 flex items-center gap-2">
            👔 {language === 'de' ? 'Kleidungs-Avatare' : language === 'fr' ? 'Avatars vestimentaires' : 'Clothing Avatars'}
            {character.clothingAvatars.status === 'generating' && (
              <span className="text-xs font-normal text-teal-500 flex items-center gap-1">
                <div className="w-3 h-3 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
                {language === 'de' ? 'Generierung läuft...' : 'Generating...'}
              </span>
            )}
            {character.clothingAvatars.status === 'complete' && (
              <span className="text-xs font-normal text-green-600">✓ Complete</span>
            )}
            {character.clothingAvatars.status === 'failed' && (
              <span className="text-xs font-normal text-red-600">✗ Failed</span>
            )}
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(['winter', 'standard', 'summer', 'formal'] as const).map((category) => (
              <div key={category} className="text-center">
                <div className="text-xs font-medium text-gray-600 mb-1 capitalize">
                  {category === 'winter' ? '❄️ ' : category === 'summer' ? '☀️ ' : category === 'formal' ? '👔 ' : '👕 '}
                  {language === 'de'
                    ? (category === 'winter' ? 'Winter' : category === 'summer' ? 'Sommer' : category === 'formal' ? 'Formal' : 'Standard')
                    : category}
                </div>
                {character.clothingAvatars?.[category] ? (
                  <img
                    src={character.clothingAvatars[category]}
                    alt={`${character.name} - ${category}`}
                    className="w-full h-24 object-contain rounded border border-teal-200 bg-white"
                  />
                ) : (
                  <div className="w-full h-24 rounded border border-dashed border-teal-300 bg-teal-100/50 flex items-center justify-center text-teal-400 text-xs">
                    {character.clothingAvatars?.status === 'generating' ? '...' : 'Not generated'}
                  </div>
                )}
              </div>
            ))}
          </div>
          {character.clothingAvatars.generatedAt && (
            <div className="mt-2 text-xs text-teal-500">
              Generated: {new Date(character.clothingAvatars.generatedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Reference Outfit - from Style Analysis (editable, collapsed by default, developer only) */}
      {developerMode && (
      <details className="bg-indigo-50 border border-indigo-200 rounded-lg">
        <summary className="p-4 cursor-pointer text-sm font-semibold text-indigo-700 flex items-center gap-2 hover:bg-indigo-100 rounded-lg transition-colors">
          👗 {language === 'de' ? 'Referenz-Outfit (aus Foto)' : language === 'fr' ? 'Tenue de référence (de la photo)' : 'Reference Outfit (from photo)'}
          <span className="text-xs font-normal text-indigo-500">
            ({language === 'de' ? 'klicken zum Erweitern' : language === 'fr' ? 'cliquez pour développer' : 'click to expand'})
          </span>
        </summary>
        <div className="px-4 pb-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <EditableStyleField
            label={language === 'de' ? 'Kleidungsart' : language === 'fr' ? 'Type de vêtement' : 'Garment Type'}
            value={character.styleAnalysis?.referenceOutfit?.garmentType || ''}
            placeholder="e.g. t-shirt, dress"
            isEditing={editingStyleField === 'referenceOutfit.garmentType'}
            editValue={editStyleValue}
            onEditValueChange={setEditStyleValue}
            onStartEdit={() => handleStartEdit('referenceOutfit.garmentType', character.styleAnalysis?.referenceOutfit?.garmentType || '')}
            onSave={saveStyleEdit}
            onCancel={cancelStyleEdit}
          />
          <EditableStyleField
            label={language === 'de' ? 'Hauptfarbe' : language === 'fr' ? 'Couleur principale' : 'Primary Color'}
            value={character.styleAnalysis?.referenceOutfit?.primaryColor || ''}
            placeholder="e.g. blue, red"
            isEditing={editingStyleField === 'referenceOutfit.primaryColor'}
            editValue={editStyleValue}
            onEditValueChange={setEditStyleValue}
            onStartEdit={() => handleStartEdit('referenceOutfit.primaryColor', character.styleAnalysis?.referenceOutfit?.primaryColor || '')}
            onSave={saveStyleEdit}
            onCancel={cancelStyleEdit}
          />
          <EditableStyleField
            label={language === 'de' ? 'Muster' : language === 'fr' ? 'Motif' : 'Pattern'}
            value={character.styleAnalysis?.referenceOutfit?.pattern || ''}
            placeholder="e.g. stripes, solid"
            isEditing={editingStyleField === 'referenceOutfit.pattern'}
            editValue={editStyleValue}
            onEditValueChange={setEditStyleValue}
            onStartEdit={() => handleStartEdit('referenceOutfit.pattern', character.styleAnalysis?.referenceOutfit?.pattern || '')}
            onSave={saveStyleEdit}
            onCancel={cancelStyleEdit}
          />
          <div>
            <span className="font-medium text-gray-600 text-xs">
              {language === 'de' ? 'Umgebung' : language === 'fr' ? 'Contexte' : 'Setting'}:
            </span>
            <select
              value={character.styleAnalysis?.referenceOutfit?.setting || 'neutral'}
              onChange={(e) => updateStyleAnalysis('referenceOutfit.setting', e.target.value)}
              className={`w-full mt-0.5 px-2 py-1 text-xs border rounded focus:outline-none ${
                character.styleAnalysis?.referenceOutfit?.setting === 'outdoor-cold' ? 'bg-blue-100 border-blue-300 text-blue-800' :
                character.styleAnalysis?.referenceOutfit?.setting === 'outdoor-warm' ? 'bg-yellow-100 border-yellow-300 text-yellow-800' :
                character.styleAnalysis?.referenceOutfit?.setting === 'indoor-casual' ? 'bg-green-100 border-green-300 text-green-800' :
                character.styleAnalysis?.referenceOutfit?.setting === 'indoor-formal' ? 'bg-purple-100 border-purple-300 text-purple-800' :
                character.styleAnalysis?.referenceOutfit?.setting === 'active' ? 'bg-orange-100 border-orange-300 text-orange-800' :
                character.styleAnalysis?.referenceOutfit?.setting === 'sleep' ? 'bg-indigo-100 border-indigo-300 text-indigo-800' :
                'bg-gray-100 border-gray-300 text-gray-800'
              }`}
            >
              <option value="neutral">Neutral</option>
              <option value="outdoor-warm">{language === 'de' ? 'Draussen (warm)' : 'Outdoor (warm)'}</option>
              <option value="outdoor-cold">{language === 'de' ? 'Draussen (kalt)' : 'Outdoor (cold)'}</option>
              <option value="indoor-casual">{language === 'de' ? 'Drinnen (casual)' : 'Indoor (casual)'}</option>
              <option value="indoor-formal">{language === 'de' ? 'Drinnen (formal)' : 'Indoor (formal)'}</option>
              <option value="active">{language === 'de' ? 'Aktiv/Sport' : 'Active/Sports'}</option>
              <option value="sleep">{language === 'de' ? 'Schlaf' : 'Sleep'}</option>
            </select>
          </div>
        </div>

        {/* Signature colors (editable as comma-separated) */}
        <div className="mt-3 pt-3 border-t border-indigo-200">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                {language === 'de' ? 'Signaturfarben' : language === 'fr' ? 'Couleurs signature' : 'Signature Colors'}
                <span className="font-normal text-gray-400 ml-1">(comma-separated)</span>
              </label>
              {editingStyleField === 'styleDNA.signatureColors' ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={editStyleValue}
                    onChange={(e) => setEditStyleValue(e.target.value)}
                    className="flex-1 px-2 py-1.5 text-sm border border-indigo-300 rounded focus:outline-none focus:border-indigo-500"
                    autoFocus
                    placeholder="blue, white, navy"
                  />
                  <button onClick={saveStyleEdit} className="p-1 text-green-600 hover:bg-green-100 rounded">
                    <Check size={14} />
                  </button>
                  <button onClick={cancelStyleEdit} className="p-1 text-gray-500 hover:bg-gray-100 rounded">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div
                  onClick={() => startEditingStyle('styleDNA.signatureColors', character.styleAnalysis?.styleDNA?.signatureColors?.join(', ') || '')}
                  className="w-full px-2 py-1.5 border border-indigo-200 rounded text-sm bg-white cursor-pointer hover:border-indigo-400 flex items-center gap-1 flex-wrap group min-h-[34px]"
                >
                  {character.styleAnalysis?.styleDNA?.signatureColors?.length ? (
                    character.styleAnalysis.styleDNA.signatureColors.map((color, i) => (
                      <span key={i} className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-xs">{color}</span>
                    ))
                  ) : (
                    <span className="text-gray-400 italic text-xs">{language === 'de' ? 'Klicken zum Setzen...' : 'Click to set...'}</span>
                  )}
                  <Edit3 size={12} className="text-gray-400 opacity-0 group-hover:opacity-100 ml-auto" />
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">
                {language === 'de' ? 'Immer dabei' : language === 'fr' ? 'Toujours présent' : 'Always Present'}
                <span className="font-normal text-gray-400 ml-1">(comma-separated)</span>
              </label>
              {editingStyleField === 'styleDNA.alwaysPresent' ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    value={editStyleValue}
                    onChange={(e) => setEditStyleValue(e.target.value)}
                    className="flex-1 px-2 py-1.5 text-sm border border-indigo-300 rounded focus:outline-none focus:border-indigo-500"
                    autoFocus
                    placeholder="glasses, watch, bracelet"
                  />
                  <button onClick={saveStyleEdit} className="p-1 text-green-600 hover:bg-green-100 rounded">
                    <Check size={14} />
                  </button>
                  <button onClick={cancelStyleEdit} className="p-1 text-gray-500 hover:bg-gray-100 rounded">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div
                  onClick={() => startEditingStyle('styleDNA.alwaysPresent', character.styleAnalysis?.styleDNA?.alwaysPresent?.join(', ') || '')}
                  className="w-full px-2 py-1.5 border border-indigo-200 rounded text-sm bg-white cursor-pointer hover:border-indigo-400 flex items-center gap-1 flex-wrap group min-h-[34px]"
                >
                  {character.styleAnalysis?.styleDNA?.alwaysPresent?.length ? (
                    character.styleAnalysis.styleDNA.alwaysPresent.map((item, i) => (
                      <span key={i} className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">{item}</span>
                    ))
                  ) : (
                    <span className="text-gray-400 italic text-xs">{language === 'de' ? 'Klicken zum Setzen...' : 'Click to set...'}</span>
                  )}
                  <Edit3 size={12} className="text-gray-400 opacity-0 group-hover:opacity-100 ml-auto" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Analysis timestamp */}
        {character.styleAnalysis?.analyzedAt && (
          <div className="mt-3 pt-2 border-t border-indigo-200 text-xs text-indigo-500">
            {language === 'de' ? 'Analysiert' : 'Analyzed'}: {new Date(character.styleAnalysis.analyzedAt).toLocaleString()}
          </div>
        )}
        </div>
      </details>
      )}

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
