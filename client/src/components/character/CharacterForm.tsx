import { ChangeEvent, useState } from 'react';
import { Upload, Save, RefreshCw, Sparkles, Wand2 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import TraitSelector from './TraitSelector';
import { strengths as defaultStrengths, flaws as defaultFlaws, challenges as defaultChallenges } from '@/constants/traits';
import { useAvatarCooldown } from '@/hooks/useAvatarCooldown';
import { getAgeCategory } from '@/services/characterService';
import type { Character, PhysicalTraits, AgeCategory, ChangedTraits } from '@/types/character';

// Age category options for the dropdown (no age numbers - we already have real age field)
const AGE_CATEGORY_OPTIONS: { value: AgeCategory; label: string; labelDe: string; labelFr: string }[] = [
  { value: 'infant', label: 'Infant', labelDe: 'Säugling', labelFr: 'Nourrisson' },
  { value: 'toddler', label: 'Toddler', labelDe: 'Kleinkind', labelFr: 'Bambin' },
  { value: 'preschooler', label: 'Preschooler', labelDe: 'Vorschulkind', labelFr: 'Préscolaire' },
  { value: 'kindergartner', label: 'Kindergartner', labelDe: 'Kindergartenkind', labelFr: 'Maternelle' },
  { value: 'young-school-age', label: 'Young School-Age', labelDe: 'Junges Schulkind', labelFr: 'Jeune écolier' },
  { value: 'school-age', label: 'School-Age', labelDe: 'Schulkind', labelFr: 'Écolier' },
  { value: 'preteen', label: 'Preteen', labelDe: 'Vorpubertär', labelFr: 'Préadolescent' },
  { value: 'young-teen', label: 'Young Teen', labelDe: 'Junger Teen', labelFr: 'Jeune ado' },
  { value: 'teenager', label: 'Teenager', labelDe: 'Teenager', labelFr: 'Adolescent' },
  { value: 'young-adult', label: 'Young Adult', labelDe: 'Junger Erwachsener', labelFr: 'Jeune adulte' },
  { value: 'adult', label: 'Adult', labelDe: 'Erwachsener', labelFr: 'Adulte' },
  { value: 'middle-aged', label: 'Middle-Aged', labelDe: 'Mittleres Alter', labelFr: 'Âge moyen' },
  { value: 'senior', label: 'Senior', labelDe: 'Senior', labelFr: 'Senior' },
  { value: 'elderly', label: 'Elderly', labelDe: 'Hochbetagt', labelFr: 'Âgé' },
];

// Build options for the dropdown (translated)
const BUILD_OPTIONS: { value: string; label: string; labelDe: string; labelFr: string }[] = [
  { value: 'slim', label: 'Slim', labelDe: 'Schlank', labelFr: 'Mince' },
  { value: 'average', label: 'Average', labelDe: 'Durchschnitt', labelFr: 'Moyen' },
  { value: 'athletic', label: 'Athletic', labelDe: 'Athletisch', labelFr: 'Athlétique' },
  { value: 'stocky', label: 'Stocky', labelDe: 'Stämmig', labelFr: 'Trapu' },
  { value: 'petite', label: 'Petite', labelDe: 'Zierlich', labelFr: 'Petit' },
  { value: 'tall', label: 'Tall', labelDe: 'Gross', labelFr: 'Grand' },
  { value: 'heavy', label: 'Heavy', labelDe: 'Kräftig', labelFr: 'Corpulent' },
];

// Hair length options (body reference points)
const HAIR_LENGTH_OPTIONS: { value: string; label: string; labelDe: string; labelFr: string }[] = [
  { value: 'bald', label: 'Bald', labelDe: 'Glatze', labelFr: 'Chauve' },
  { value: 'balding', label: 'Balding', labelDe: 'Halbglatze', labelFr: 'Dégarni' },
  { value: 'thinning', label: 'Thinning', labelDe: 'Dünnes Haar', labelFr: 'Clairsemé' },
  { value: 'buzz cut', label: 'Buzz Cut', labelDe: 'Sehr kurz', labelFr: 'Très court' },
  { value: 'cropped', label: 'Cropped', labelDe: 'Kurz', labelFr: 'Court' },
  { value: 'pixie', label: 'Pixie', labelDe: 'Pixie', labelFr: 'Pixie' },
  { value: 'ear-length', label: 'Ear-Length', labelDe: 'Ohrlang', labelFr: 'Aux oreilles' },
  { value: 'chin-length', label: 'Chin-Length', labelDe: 'Kinnlang', labelFr: 'Au menton' },
  { value: 'neck-length', label: 'Neck-Length', labelDe: 'Nackenlang', labelFr: 'Au cou' },
  { value: 'shoulder-length', label: 'Shoulder-Length', labelDe: 'Schulterlang', labelFr: 'Aux épaules' },
  { value: 'armpit-length', label: 'Armpit-Length', labelDe: 'Achsellang', labelFr: 'Aux aisselles' },
  { value: 'mid-back', label: 'Mid-Back', labelDe: 'Rückenmitte', labelFr: 'Mi-dos' },
  { value: 'waist-length', label: 'Waist-Length', labelDe: 'Hüftlang', labelFr: 'Aux hanches' },
];

// Hair style options (texture and styling)
const HAIR_STYLE_OPTIONS: { value: string; label: string; labelDe: string; labelFr: string }[] = [
  { value: 'straight', label: 'Straight', labelDe: 'Glatt', labelFr: 'Lisse' },
  { value: 'wavy', label: 'Wavy', labelDe: 'Wellig', labelFr: 'Ondulé' },
  { value: 'curly', label: 'Curly', labelDe: 'Lockig', labelFr: 'Bouclé' },
  { value: 'coily', label: 'Coily', labelDe: 'Kraus', labelFr: 'Crépu' },
  { value: 'ponytail', label: 'Ponytail', labelDe: 'Pferdeschwanz', labelFr: 'Queue de cheval' },
  { value: 'braids', label: 'Braids', labelDe: 'Zöpfe', labelFr: 'Tresses' },
  { value: 'bun', label: 'Bun', labelDe: 'Dutt', labelFr: 'Chignon' },
  { value: 'pigtails', label: 'Pigtails', labelDe: 'Zöpfchen', labelFr: 'Couettes' },
  { value: 'loose', label: 'Loose', labelDe: 'Offen', labelFr: 'Lâche' },
  { value: 'slicked back', label: 'Slicked Back', labelDe: 'Zurückgekämmt', labelFr: 'Plaqué' },
];

// Simple inline editable field - click to edit, blur/enter to save
interface InlineEditFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  isChanged?: boolean;  // Highlight if trait changed from previous photo
  isAiExtracted?: boolean;  // Style as AI-extracted (grayed)
}

function InlineEditField({ label, value, placeholder, onChange, isChanged, isAiExtracted }: InlineEditFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <span className={`font-medium text-xs whitespace-nowrap ${isAiExtracted ? 'text-gray-400' : 'text-gray-600'}`}>
        {label}:
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`flex-1 min-w-0 px-2 py-1 text-sm border rounded focus:outline-none focus:border-indigo-400 hover:border-gray-300 ${
          isChanged
            ? 'border-amber-400 bg-amber-50 text-amber-800'
            : isAiExtracted
              ? 'border-gray-200 bg-gray-50 text-gray-500'
              : 'border-gray-200 bg-white'
        }`}
        placeholder={placeholder}
      />
      {isChanged && (
        <span className="text-amber-500 text-xs" title="Changed from previous photo">●</span>
      )}
    </div>
  );
}

// Shared physical traits grid component - used in both step 1 and step 2
interface PhysicalTraitsGridProps {
  character: Character;
  language: string;
  updatePhysical: (field: keyof PhysicalTraits, value: string) => void;
  updateApparentAge: (value: AgeCategory) => void;
  changedTraits?: ChangedTraits;
  isAiExtracted?: boolean;
}

function PhysicalTraitsGrid({ character, language, updatePhysical, updateApparentAge, changedTraits, isAiExtracted }: PhysicalTraitsGridProps) {
  const labelClass = isAiExtracted ? 'text-gray-400' : 'text-gray-600';
  const selectClass = (isChanged?: boolean) => `flex-1 min-w-0 px-2 py-1 text-sm border rounded focus:outline-none focus:border-indigo-400 hover:border-gray-300 ${
    isChanged
      ? 'border-amber-400 bg-amber-50'
      : isAiExtracted
        ? 'border-gray-200 bg-gray-50 text-gray-500'
        : 'border-gray-200 bg-white'
  }`;

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
      {/* Row 1: Eye Color | Visual Age */}
      <InlineEditField
        label={language === 'de' ? 'Augenfarbe' : language === 'fr' ? 'Couleur des yeux' : 'Eye Color'}
        value={character.physical?.eyeColor || ''}
        placeholder={language === 'de' ? 'z.B. blau' : 'e.g. blue'}
        onChange={(v) => updatePhysical('eyeColor', v)}
        isAiExtracted={isAiExtracted}
        isChanged={changedTraits?.eyeColor}
      />
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Visuelles Alter' : language === 'fr' ? 'Âge visuel' : 'Visual Age'}:
        </span>
        <select
          value={character.apparentAge || getAgeCategory(character.age) || ''}
          onChange={(e) => updateApparentAge(e.target.value as AgeCategory)}
          className={selectClass(changedTraits?.apparentAge)}
        >
          <option value="">{language === 'de' ? '— Auto —' : language === 'fr' ? '— Auto —' : '— Auto —'}</option>
          {AGE_CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        {changedTraits?.apparentAge && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>

      {/* Row 2: Hair Color | Hair Length */}
      <InlineEditField
        label={language === 'de' ? 'Haarfarbe' : language === 'fr' ? 'Couleur des cheveux' : 'Hair Color'}
        value={character.physical?.hairColor || ''}
        placeholder={language === 'de' ? 'z.B. blond' : 'e.g. blonde'}
        onChange={(v) => updatePhysical('hairColor', v)}
        isAiExtracted={isAiExtracted}
        isChanged={changedTraits?.hairColor}
      />
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Haarlänge' : language === 'fr' ? 'Longueur' : 'Hair Length'}:
        </span>
        <select
          value={character.physical?.hairLength || ''}
          onChange={(e) => updatePhysical('hairLength', e.target.value)}
          className={selectClass(changedTraits?.hairLength)}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {HAIR_LENGTH_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        {changedTraits?.hairLength && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>

      {/* Row 3: Hair Style | Build */}
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Frisur' : language === 'fr' ? 'Coiffure' : 'Hair Style'}:
        </span>
        <select
          value={character.physical?.hairStyle || ''}
          onChange={(e) => updatePhysical('hairStyle', e.target.value)}
          className={selectClass(changedTraits?.hairStyle)}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {HAIR_STYLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        {changedTraits?.hairStyle && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Körperbau' : language === 'fr' ? 'Corpulence' : 'Build'}:
        </span>
        <select
          value={character.physical?.build || ''}
          onChange={(e) => updatePhysical('build', e.target.value)}
          className={selectClass(changedTraits?.build)}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {BUILD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        {changedTraits?.build && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>

      {/* Row 4: Face | Other */}
      <InlineEditField
        label={language === 'de' ? 'Gesicht' : language === 'fr' ? 'Visage' : 'Face'}
        value={character.physical?.face || ''}
        placeholder={language === 'de' ? 'z.B. rund' : 'e.g. round'}
        onChange={(v) => updatePhysical('face', v)}
        isAiExtracted={isAiExtracted}
        isChanged={changedTraits?.face}
      />
      <InlineEditField
        label={language === 'de' ? 'Sonstiges' : language === 'fr' ? 'Autre' : 'Other'}
        value={character.physical?.other || ''}
        placeholder={language === 'de' ? 'z.B. Brille' : 'e.g. glasses'}
        onChange={(v) => updatePhysical('other', v)}
        isAiExtracted={isAiExtracted}
        isChanged={changedTraits?.other}
      />
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
  onSaveAndGenerateAvatar?: () => void;  // New: triggers avatar generation
  onSaveAndRegenerateWithTraits?: () => void;  // Combined save + regenerate with traits
  onRegenerateAvatars?: () => void;
  onRegenerateAvatarsWithTraits?: () => void;
  isLoading?: boolean;
  isAnalyzingPhoto?: boolean;
  isGeneratingAvatar?: boolean;  // New: background avatar generation in progress
  isRegeneratingAvatars?: boolean;
  isRegeneratingAvatarsWithTraits?: boolean;
  step: 'name' | 'traits';
  developerMode?: boolean;
  changedTraits?: ChangedTraits;  // New: which traits changed from previous photo
}

export function CharacterForm({
  character,
  onChange,
  onSave,
  onCancel,
  onPhotoChange,
  onContinueToTraits,
  onSaveAndGenerateAvatar,
  onSaveAndRegenerateWithTraits,
  onRegenerateAvatars,
  onRegenerateAvatarsWithTraits,
  isLoading,
  isAnalyzingPhoto,
  isGeneratingAvatar,
  isRegeneratingAvatars,
  isRegeneratingAvatarsWithTraits,
  step,
  developerMode,
  changedTraits,
}: CharacterFormProps) {
  const { t, language } = useLanguage();
  const [enlargedAvatar, setEnlargedAvatar] = useState(false);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onPhotoChange(file);
    }
  };

  // Update top-level character fields
  const updateField = <K extends keyof Character>(field: K, value: Character[K]) => {
    // Auto-compute ageCategory when age changes
    if (field === 'age' && typeof value === 'string') {
      onChange({ ...character, [field]: value, ageCategory: getAgeCategory(value) });
    } else {
      onChange({ ...character, [field]: value });
    }
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

  // Avatar cooldown (uses extracted hook)
  const { canRegenerate, waitSeconds, recordRegeneration } = useAvatarCooldown(character.id);

  // Handle avatar regeneration with cooldown
  const handleUserRegenerate = () => {
    if (!canRegenerate) return;
    recordRegeneration();
    onRegenerateAvatarsWithTraits?.();
  };

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

  // Check if any traits changed (for showing indicator)
  const hasChangedTraits = changedTraits && Object.values(changedTraits).some(v => v);

  // Step 1: Name entry + Physical traits (AI-extracted) + Avatar placeholder
  if (step === 'name') {
    return (
      <div className="space-y-6">
        {/* Main content: Photo/Info on left, Avatar placeholder on right */}
        <div className="flex gap-4">
          {/* Left side: Photo, name, basic info, physical traits */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Photo display - show spinner while analyzing */}
            <div className="flex items-start gap-4">
              <div className="flex flex-col items-center gap-2">
                {isAnalyzingPhoto ? (
                  <div className="w-24 h-24 rounded-full bg-indigo-100 border-4 border-indigo-400 shadow-lg flex items-center justify-center">
                    <div className="flex flex-col items-center gap-1">
                      <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                      <span className="text-[10px] text-indigo-600 font-medium">
                        {language === 'de' ? 'Analysiere...' : language === 'fr' ? 'Analyse...' : 'Analyzing...'}
                      </span>
                    </div>
                  </div>
                ) : displayPhoto ? (
                  <img
                    src={displayPhoto}
                    alt="Character"
                    className="w-24 h-24 rounded-full object-cover border-4 border-indigo-400 shadow-lg"
                  />
                ) : (
                  <div className="w-24 h-24 rounded-full bg-gray-200 border-4 border-gray-300 flex items-center justify-center">
                    <Upload size={24} className="text-gray-400" />
                  </div>
                )}

                <label className="cursor-pointer bg-gray-200 text-gray-700 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-300 flex items-center gap-1.5 font-semibold transition-colors">
                  <Upload size={12} />
                  {language === 'de' ? 'Ändern' : language === 'fr' ? 'Changer' : 'Change'}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                </label>
              </div>

              {/* Name input */}
              <div className="flex-1">
                <label className="block text-sm font-semibold mb-1 text-gray-700">
                  {language === 'de' ? 'Name' : language === 'fr' ? 'Nom' : 'Name'}
                </label>
                <input
                  type="text"
                  value={character.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  className="w-full px-3 py-2 border-2 border-gray-300 rounded-lg text-lg focus:border-indigo-500 focus:outline-none"
                  placeholder={t.characterName}
                  autoFocus
                />
              </div>
            </div>

            {/* Basic Info - Gender, Age */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 mb-0.5 flex items-center gap-1">
                  <Sparkles size={10} className="text-gray-300" />
                  {t.gender}
                  {changedTraits?.gender && <span className="text-amber-500">●</span>}
                </label>
                <select
                  value={character.gender}
                  onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                  className={`w-full px-2 py-1.5 border rounded text-sm focus:border-indigo-500 focus:outline-none ${
                    changedTraits?.gender ? 'border-amber-400 bg-amber-50' : 'border-gray-200 bg-gray-50 text-gray-600'
                  }`}
                >
                  <option value="male">{t.male}</option>
                  <option value="female">{t.female}</option>
                  <option value="other">{t.other}</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 mb-0.5 flex items-center gap-1">
                  <Sparkles size={10} className="text-gray-300" />
                  {t.age}
                  {changedTraits?.age && <span className="text-amber-500">●</span>}
                </label>
                <input
                  type="number"
                  value={character.age}
                  onChange={(e) => updateField('age', e.target.value)}
                  className={`w-full px-2 py-1.5 border rounded text-sm focus:border-indigo-500 focus:outline-none ${
                    changedTraits?.age ? 'border-amber-400 bg-amber-50' : 'border-gray-200 bg-gray-50 text-gray-600'
                  }`}
                  min="1"
                  max="120"
                />
              </div>
            </div>

            {/* Physical Features - AI-extracted (grayed, editable) */}
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={14} className="text-gray-400" />
                <span className="text-xs font-medium text-gray-500">
                  {language === 'de' ? 'KI-erkannte Merkmale' : language === 'fr' ? 'Caractéristiques détectées par l\'IA' : 'AI-detected features'}
                </span>
                {hasChangedTraits && (
                  <span className="text-xs text-amber-600 flex items-center gap-1">
                    <span className="text-amber-500">●</span>
                    {language === 'de' ? 'Geändert' : language === 'fr' ? 'Modifié' : 'Changed'}
                  </span>
                )}
              </div>
              <PhysicalTraitsGrid
                character={character}
                language={language}
                updatePhysical={updatePhysical}
                updateApparentAge={(v) => updateField('apparentAge', v)}
                changedTraits={changedTraits}
                isAiExtracted={true}
              />
              <p className="mt-2 text-[10px] text-gray-400 italic">
                {language === 'de' ? 'Diese Merkmale wurden aus dem Foto erkannt. Sie können sie bearbeiten.' :
                 language === 'fr' ? 'Ces caractéristiques ont été détectées à partir de la photo. Vous pouvez les modifier.' :
                 'These features were detected from the photo. You can edit them.'}
              </p>
            </div>
          </div>

          {/* Right side: Avatar placeholder */}
          <div className="flex-shrink-0 w-36">
            <div className="text-center">
              <div className="w-36 h-48 rounded-lg border-2 border-dashed border-gray-300 bg-gray-100 flex flex-col items-center justify-center">
                {(isGeneratingAvatar || character.avatars?.status === 'generating') ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-indigo-600 font-medium px-2 text-center">
                      {language === 'de' ? 'Avatar wird erstellt...' : language === 'fr' ? 'Création de l\'avatar...' : 'Creating avatar...'}
                    </span>
                  </div>
                ) : character.avatars?.standard ? (
                  <img
                    src={character.avatars.standard}
                    alt={`${character.name} avatar`}
                    className="w-full h-full object-contain rounded-lg"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 px-2">
                    <Wand2 size={24} className="text-gray-300" />
                    <span className="text-[10px] text-gray-400 text-center">
                      {language === 'de' ? 'Avatar wird nach dem Speichern erstellt' :
                       language === 'fr' ? 'L\'avatar sera créé après la sauvegarde' :
                       'Avatar will be created after saving'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
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
            onClick={onSaveAndGenerateAvatar || onContinueToTraits}
            disabled={!canSaveName || isLoading || isAnalyzingPhoto}
            loading={isLoading}
            icon={Wand2}
            className={onCancel ? "flex-1" : "w-full"}
          >
            {language === 'de' ? 'Speichern & Avatar erstellen' :
             language === 'fr' ? 'Enregistrer et créer l\'avatar' :
             'Save & Generate Avatar'}
          </Button>
        </div>
      </div>
    );
  }

  // Step 2: Traits and characteristics
  return (
    <div className="space-y-4">
      {/* Top section: Header with photo/name on left, avatar on right */}
      <div className="flex gap-4">
        {/* Left side: Photo, name, and basic info */}
        <div className="flex-1 min-w-0">
          {/* Header with photo and name */}
          <div className="flex items-center gap-3 mb-3">
            {/* Photo with change option */}
            <label className="flex-shrink-0 relative group cursor-pointer">
              {isAnalyzingPhoto ? (
                <div className="w-14 h-14 rounded-full bg-indigo-100 border-2 border-indigo-400 flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : displayPhoto ? (
                <img
                  src={displayPhoto}
                  alt={character.name}
                  className="w-14 h-14 rounded-full object-cover border-2 border-indigo-400"
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-gray-200 border-2 border-gray-300 flex items-center justify-center">
                  <Upload size={18} className="text-gray-400" />
                </div>
              )}
              <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
                <Upload size={14} className="text-white" />
              </div>
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
            <h3 className="text-xl font-bold text-gray-800">{character.name}</h3>
          </div>

          {/* Basic Info - Compact grid */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 mb-0.5">{t.gender}</label>
              <select
                value={character.gender}
                onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                className="w-full px-1.5 py-1 border border-gray-300 rounded text-xs bg-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="male">{t.male}</option>
                <option value="female">{t.female}</option>
                <option value="other">{t.other}</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 mb-0.5">{t.age}</label>
              <input
                type="number"
                value={character.age}
                onChange={(e) => updateField('age', e.target.value)}
                className="w-full px-1.5 py-1 border border-gray-300 rounded text-xs focus:border-indigo-500 focus:outline-none"
                min="1"
                max="120"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 mb-0.5">
                {language === 'de' ? 'Grösse' : language === 'fr' ? 'Taille' : 'Height'}
              </label>
              <input
                type="number"
                value={character.physical?.height || ''}
                onChange={(e) => updatePhysical('height', e.target.value)}
                className="w-full px-1.5 py-1 border border-gray-300 rounded text-xs focus:border-indigo-500 focus:outline-none"
                placeholder="cm"
                min="50"
                max="250"
              />
            </div>
          </div>

          {/* Physical Features - Collapsible */}
          <details className="bg-gray-50 border border-gray-200 rounded-lg mt-2">
            <summary className="px-3 py-2 cursor-pointer hover:bg-gray-100 rounded-lg text-xs font-medium text-gray-600">
              {language === 'de' ? 'Physische Merkmale' : language === 'fr' ? 'Caractéristiques physiques' : 'Physical Features'}
            </summary>
            <div className="px-3 pb-3">
              <PhysicalTraitsGrid
                character={character}
                language={language}
                updatePhysical={updatePhysical}
                updateApparentAge={(v) => updateField('apparentAge', v)}
              />
            </div>
          </details>
        </div>

        {/* Right side: Standard avatar for all users - 25% bigger, object-contain to show full body */}
        <div className="flex-shrink-0 w-40">
          <div className="text-center">
            {character.avatars?.standard ? (
              <div className="relative">
                <img
                  src={character.avatars.standard}
                  alt={`${character.name} avatar`}
                  className={`w-40 h-56 object-contain rounded-lg border-2 bg-white cursor-pointer hover:opacity-90 transition-opacity ${character.avatars?.stale ? 'border-amber-400 opacity-80' : 'border-indigo-300'}`}
                  onClick={() => setEnlargedAvatar(true)}
                  title={language === 'de' ? 'Klicken zum Vergrössern' : 'Click to enlarge'}
                />
                {(isGeneratingAvatar || isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating') && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 rounded-lg">
                    <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  </div>
                )}
              </div>
            ) : (
              <div className="w-40 h-56 rounded-lg border-2 border-dashed border-gray-300 bg-gray-100 flex flex-col items-center justify-center">
                {(isGeneratingAvatar || isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating') ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-indigo-600 font-medium px-2 text-center">
                      {language === 'de' ? 'Avatar wird erstellt...' : language === 'fr' ? 'Création...' : 'Creating...'}
                    </span>
                  </div>
                ) : (
                  <span className="text-[10px] text-gray-400 text-center px-2">
                    {language === 'de' ? 'Kein Avatar' : 'No avatar'}
                  </span>
                )}
              </div>
            )}
            {/* Enlarged avatar modal */}
            {enlargedAvatar && character.avatars?.standard && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75"
                onClick={() => setEnlargedAvatar(false)}
              >
                <img
                  src={character.avatars.standard}
                  alt={`${character.name} avatar`}
                  className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300"
                  onClick={() => setEnlargedAvatar(false)}
                >
                  ×
                </button>
              </div>
            )}
            {/* Regenerate button for all users */}
            <button
              onClick={handleUserRegenerate}
              disabled={!canRegenerate || isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating'}
              className="mt-2 w-full px-2 py-1 text-[10px] font-medium bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
              title={!canRegenerate ? `Wait ${waitSeconds}s` : undefined}
            >
              <RefreshCw size={10} />
              {!canRegenerate ? (
                `${waitSeconds}s`
              ) : (isRegeneratingAvatars || isRegeneratingAvatarsWithTraits) ? (
                language === 'de' ? 'Generiere...' : 'Generating...'
              ) : (
                language === 'de' ? 'Neu generieren' : 'Regenerate'
              )}
            </button>
            {/* Developer mode: show face match score with full details */}
            {developerMode && character.avatars?.faceMatch?.standard && (
              <details className="mt-1 text-left">
                <summary className={`text-[10px] font-medium cursor-pointer ${
                  character.avatars.faceMatch.standard.score >= 6 ? 'text-green-600' : 'text-red-600'
                }`}>
                  Face eval: {character.avatars.faceMatch.standard.score}/10
                </summary>
                <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-48 border bg-gray-100 border-gray-200">
                  {character.avatars.faceMatch.standard.details}
                </pre>
              </details>
            )}
            {/* Developer mode: show extracted clothing per avatar */}
            {developerMode && character.avatars?.clothing && Object.keys(character.avatars.clothing).length > 0 && (
              <details className="mt-1 text-left">
                <summary className="text-[10px] font-medium cursor-pointer text-blue-600">
                  Clothing ({Object.keys(character.avatars.clothing).length} avatars)
                </summary>
                <div className="mt-1 p-2 rounded text-[9px] border bg-gray-100 border-gray-200 space-y-1">
                  {Object.entries(character.avatars.clothing).map(([category, clothing]) => (
                    <div key={category}>
                      <span className="font-semibold">{category}:</span> {clothing}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      </div>

      {/* Developer Mode: Show body crop with transparent background */}
      {developerMode && character.photos?.bodyNoBg && (
        <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-3">
          <h4 className="text-xs font-semibold text-yellow-700 mb-2">
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

      {/* Clothing Avatars (developer only - all 4 variants) */}
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
                    {developerMode && character.avatars?.faceMatch?.[category] && (
                      <div className={`absolute bottom-1 left-1 text-white text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        character.avatars.faceMatch[category].score >= 6 ? 'bg-green-600' : 'bg-red-600'
                      }`}>
                        {character.avatars.faceMatch[category].score}/10
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-full h-64 rounded border border-dashed border-teal-300 bg-teal-100/50 flex items-center justify-center text-teal-400 text-xs">
                    {character.avatars?.status === 'generating' ? '...' : 'Not generated'}
                  </div>
                )}
                {/* Dev mode: Always show clothing description below avatar */}
                {developerMode && character.avatars?.clothing?.[category] && (
                  <div className="mt-1 p-1.5 rounded text-[10px] text-left bg-blue-50 border border-blue-200 text-blue-700">
                    <span className="font-semibold">👕 </span>
                    {character.avatars.clothing[category]}
                  </div>
                )}
                {developerMode && character.avatars?.[category] && !character.avatars?.clothing?.[category] && (
                  <div className="mt-1 p-1.5 rounded text-[10px] text-left bg-amber-50 border border-amber-200 text-amber-600">
                    ⚠️ No clothing data - regenerate avatar
                  </div>
                )}
                {developerMode && (
                  <>
                    {character.avatars?.prompts?.[category] && (
                      <details className="mt-1 text-left">
                        <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">Show prompt</summary>
                        <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-48 border bg-gray-100 border-gray-200">
                          {character.avatars.prompts[category]}
                        </pre>
                      </details>
                    )}
                    {character.avatars?.faceMatch?.[category] && (
                      <details className="mt-1 text-left">
                        <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">
                          Face eval ({character.avatars.faceMatch[category].score}/10)
                        </summary>
                        <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-48 border bg-gray-100 border-gray-200">
                          {character.avatars.faceMatch[category].details}
                        </pre>
                      </details>
                    )}
                  </>
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
          onClick={() => {
            // If no avatars yet and we can generate them, save + generate
            // Otherwise just save
            const hasAvatars = !!(character.avatars?.winter || character.avatars?.standard || character.avatars?.summer || character.avatars?.formal);
            if (!hasAvatars && onSaveAndRegenerateWithTraits) {
              onSaveAndRegenerateWithTraits();
            } else {
              onSave();
            }
          }}
          disabled={!canSaveCharacter || isLoading || isRegeneratingAvatarsWithTraits}
          loading={isLoading || isRegeneratingAvatarsWithTraits}
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
