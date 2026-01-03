import { ChangeEvent, useState } from 'react';
import { Upload, Save, Pencil, ChevronRight, ChevronLeft, Check } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import TraitSelector from './TraitSelector';
import CharacterRelationships from './CharacterRelationships';
import { strengths as defaultStrengths, flaws as defaultFlaws, challenges as defaultChallenges } from '@/constants/traits';
import { useAvatarCooldown } from '@/hooks/useAvatarCooldown';
import { getAgeCategory } from '@/services/characterService';
import type { Character, PhysicalTraits, AgeCategory, ChangedTraits, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { CustomRelationshipPair } from '@/constants/relationships';

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

// Hair color options (natural colors)
const HAIR_COLOR_OPTIONS: { value: string; label: string; labelDe: string; labelFr: string }[] = [
  // Dark tones
  { value: 'black', label: 'Black', labelDe: 'Schwarz', labelFr: 'Noir' },
  { value: 'dark brown', label: 'Dark Brown', labelDe: 'Dunkelbraun', labelFr: 'Brun foncé' },
  { value: 'brown', label: 'Brown', labelDe: 'Braun', labelFr: 'Brun' },
  { value: 'light brown', label: 'Light Brown', labelDe: 'Hellbraun', labelFr: 'Châtain clair' },
  { value: 'chestnut', label: 'Chestnut', labelDe: 'Kastanienbraun', labelFr: 'Châtain' },
  // Red tones
  { value: 'auburn', label: 'Auburn', labelDe: 'Rotbraun', labelFr: 'Auburn' },
  { value: 'red', label: 'Red', labelDe: 'Rot', labelFr: 'Roux' },
  { value: 'strawberry blonde', label: 'Strawberry Blonde', labelDe: 'Erdbeerblond', labelFr: 'Blond vénitien' },
  // Blonde tones
  { value: 'dark blonde', label: 'Dark Blonde', labelDe: 'Dunkelblond', labelFr: 'Blond foncé' },
  { value: 'blonde', label: 'Blonde', labelDe: 'Blond', labelFr: 'Blond' },
  { value: 'light blonde', label: 'Light Blonde', labelDe: 'Hellblond', labelFr: 'Blond clair' },
  { value: 'platinum blonde', label: 'Platinum Blonde', labelDe: 'Platinblond', labelFr: 'Blond platine' },
  // Gray/White tones
  { value: 'gray', label: 'Gray', labelDe: 'Grau', labelFr: 'Gris' },
  { value: 'silver', label: 'Silver', labelDe: 'Silber', labelFr: 'Argenté' },
  { value: 'white', label: 'White', labelDe: 'Weiss', labelFr: 'Blanc' },
  { value: 'salt and pepper', label: 'Salt and Pepper', labelDe: 'Graumeliert', labelFr: 'Poivre et sel' },
];

// Hair style options (texture and styling)
const HAIR_STYLE_OPTIONS: { value: string; label: string; labelDe: string; labelFr: string }[] = [
  // Textures
  { value: 'straight', label: 'Straight', labelDe: 'Glatt', labelFr: 'Lisse' },
  { value: 'wavy', label: 'Wavy', labelDe: 'Wellig', labelFr: 'Ondulé' },
  { value: 'curly', label: 'Curly', labelDe: 'Lockig', labelFr: 'Bouclé' },
  { value: 'coily', label: 'Coily', labelDe: 'Kraus', labelFr: 'Crépu' },
  // Styling
  { value: 'messy', label: 'Messy', labelDe: 'Zerzaust', labelFr: 'Ébouriffé' },
  { value: 'spiky', label: 'Spiky', labelDe: 'Stachelig', labelFr: 'En pointes' },
  { value: 'layered', label: 'Layered', labelDe: 'Gestuft', labelFr: 'Dégradé' },
  { value: 'slicked back', label: 'Slicked Back', labelDe: 'Zurückgekämmt', labelFr: 'Plaqué' },
  { value: 'loose', label: 'Loose', labelDe: 'Offen', labelFr: 'Lâche' },
  // Updos
  { value: 'ponytail', label: 'Ponytail', labelDe: 'Pferdeschwanz', labelFr: 'Queue de cheval' },
  { value: 'braids', label: 'Braids', labelDe: 'Zöpfe', labelFr: 'Tresses' },
  { value: 'bun', label: 'Bun', labelDe: 'Dutt', labelFr: 'Chignon' },
  { value: 'pigtails', label: 'Pigtails', labelDe: 'Zöpfchen', labelFr: 'Couettes' },
  // Haircuts
  { value: 'bob', label: 'Bob', labelDe: 'Bob', labelFr: 'Carré' },
  { value: 'afro', label: 'Afro', labelDe: 'Afro', labelFr: 'Afro' },
  { value: 'mohawk', label: 'Mohawk', labelDe: 'Irokese', labelFr: 'Crête' },
  { value: 'mullet', label: 'Mullet', labelDe: 'Vokuhila', labelFr: 'Mulet' },
  { value: 'undercut', label: 'Undercut', labelDe: 'Undercut', labelFr: 'Undercut' },
  // Bangs
  { value: 'bangs', label: 'Bangs', labelDe: 'Pony', labelFr: 'Frange' },
  { value: 'side bangs', label: 'Side Bangs', labelDe: 'Seitenpony', labelFr: 'Frange de côté' },
];

// Facial hair options (for males)
const FACIAL_HAIR_OPTIONS: { value: string; label: string; labelDe: string; labelFr: string }[] = [
  { value: 'none', label: 'None', labelDe: 'Keiner', labelFr: 'Aucune' },
  { value: 'clean-shaven', label: 'Clean Shaven', labelDe: 'Glatt rasiert', labelFr: 'Rasé de près' },
  { value: 'stubble', label: 'Stubble', labelDe: 'Stoppeln', labelFr: 'Barbe de 3 jours' },
  { value: 'mustache', label: 'Mustache', labelDe: 'Schnurrbart', labelFr: 'Moustache' },
  { value: 'goatee', label: 'Goatee', labelDe: 'Ziegenbart', labelFr: 'Bouc' },
  { value: 'short beard', label: 'Short Beard', labelDe: 'Kurzer Bart', labelFr: 'Barbe courte' },
  { value: 'full beard', label: 'Full Beard', labelDe: 'Vollbart', labelFr: 'Barbe complète' },
  { value: 'long beard', label: 'Long Beard', labelDe: 'Langer Bart', labelFr: 'Longue barbe' },
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

export function PhysicalTraitsGrid({ character, language, updatePhysical, updateApparentAge, changedTraits, isAiExtracted }: PhysicalTraitsGridProps) {
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
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Haarfarbe' : language === 'fr' ? 'Couleur' : 'Hair Color'}:
        </span>
        <select
          value={character.physical?.hairColor || ''}
          onChange={(e) => updatePhysical('hairColor', e.target.value)}
          className={selectClass(changedTraits?.hairColor)}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {HAIR_COLOR_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        {changedTraits?.hairColor && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>
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

      {/* Row 4: Face | Facial Hair (males) or Other (females) */}
      <InlineEditField
        label={language === 'de' ? 'Gesicht' : language === 'fr' ? 'Visage' : 'Face'}
        value={character.physical?.face || ''}
        placeholder={language === 'de' ? 'z.B. rund' : 'e.g. round'}
        onChange={(v) => updatePhysical('face', v)}
        isAiExtracted={isAiExtracted}
        isChanged={changedTraits?.face}
      />
      {character.gender === 'male' ? (
        <div className="flex items-center gap-2">
          <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
            {language === 'de' ? 'Bart' : language === 'fr' ? 'Barbe' : 'Facial Hair'}:
          </span>
          <select
            value={character.physical?.facialHair || ''}
            onChange={(e) => updatePhysical('facialHair', e.target.value)}
            className={selectClass(changedTraits?.facialHair)}
          >
            <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
            {FACIAL_HAIR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
              </option>
            ))}
          </select>
          {changedTraits?.facialHair && <span className="text-amber-500 text-xs" title="Changed">●</span>}
        </div>
      ) : (
        <InlineEditField
          label={language === 'de' ? 'Sonstiges' : language === 'fr' ? 'Autre' : 'Other'}
          value={character.physical?.other || ''}
          placeholder={language === 'de' ? 'z.B. Brille' : 'e.g. glasses'}
          onChange={(v) => updatePhysical('other', v)}
          isAiExtracted={isAiExtracted}
          isChanged={changedTraits?.other}
        />
      )}

      {/* Row 5: Other (for males) - spans full width if male */}
      {character.gender === 'male' && (
        <div className="col-span-2">
          <InlineEditField
            label={language === 'de' ? 'Sonstiges' : language === 'fr' ? 'Autre' : 'Other'}
            value={character.physical?.other || ''}
            placeholder={language === 'de' ? 'z.B. Brille' : 'e.g. glasses'}
            onChange={(v) => updatePhysical('other', v)}
            isAiExtracted={isAiExtracted}
            isChanged={changedTraits?.other}
          />
        </div>
      )}
    </div>
  );
}

interface CharacterFormProps {
  character: Character;
  allCharacters?: Character[];  // All characters for relationship editing
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
  photoAnalysisDebug?: { rawResponse?: string; error?: string };  // Debug info for dev mode
  // Relationship props
  relationships?: RelationshipMap;
  relationshipTexts?: RelationshipTextMap;
  onRelationshipChange?: (char1Id: number, char2Id: number, value: string) => void;
  onRelationshipTextChange?: (key: string, text: string) => void;
  customRelationships?: CustomRelationshipPair[];
  onAddCustomRelationship?: (forward: string, inverse: string) => void;
}

export function CharacterForm({
  character,
  allCharacters = [],
  onChange,
  onSave,
  onCancel,
  onPhotoChange,
  onContinueToTraits,
  onSaveAndGenerateAvatar: _onSaveAndGenerateAvatar,
  onSaveAndRegenerateWithTraits: _onSaveAndRegenerateWithTraits,
  onRegenerateAvatars: _onRegenerateAvatars,
  onRegenerateAvatarsWithTraits: _onRegenerateAvatarsWithTraits,
  isLoading,
  isAnalyzingPhoto,
  isGeneratingAvatar: _isGeneratingAvatar,
  isRegeneratingAvatars: _isRegeneratingAvatars,
  isRegeneratingAvatarsWithTraits: _isRegeneratingAvatarsWithTraits,
  step,
  developerMode: _developerMode,
  changedTraits: _changedTraits,
  photoAnalysisDebug: _photoAnalysisDebug,
  relationships = {},
  relationshipTexts = {},
  onRelationshipChange,
  onRelationshipTextChange,
  customRelationships = [],
  onAddCustomRelationship,
}: CharacterFormProps) {
  const { t, language } = useLanguage();
  const [_enlargedAvatar, _setEnlargedAvatar] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [_isModifyingAvatar, _setIsModifyingAvatar] = useState(false);

  // Wizard state for new character creation
  type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;
  type EditSection = 'strengths' | 'weaknesses' | 'conflicts' | 'details' | 'relationships' | null;
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [editingSection, setEditingSection] = useState<EditSection>(null);

  // Determine if character is "new" (needs wizard) or "existing" (compact edit view)
  const isExistingCharacter = !!(
    character.traits?.strengths?.length >= 3 &&
    character.traits?.flaws?.length >= 2
  );

  // Check if there are other characters (for relationships step)
  const hasOtherCharacters = allCharacters.filter(c => c.id !== character.id).length > 0;

  // Calculate total steps (skip relationships if no other characters)
  const totalWizardSteps = hasOtherCharacters ? 6 : 5;

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

  // Avatar cooldown - available for future use
  const { canRegenerate: _canRegenerate, waitSeconds: _waitSeconds, recordRegeneration: _recordRegeneration } = useAvatarCooldown(character.id);

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

  // Wizard navigation functions
  const canProceedFromStep = (stepNum: WizardStep): boolean => {
    switch (stepNum) {
      case 1: return !!(displayPhoto && character.gender && character.age);
      case 2: return (character.traits?.strengths?.length || 0) >= 3;
      case 3: return (character.traits?.flaws?.length || 0) >= 2;
      case 4: case 5: case 6: return true;
      default: return false;
    }
  };

  const goToNextStep = () => {
    if (wizardStep < totalWizardSteps && canProceedFromStep(wizardStep)) {
      setWizardStep((wizardStep + 1) as WizardStep);
    }
  };

  const goToPrevStep = () => {
    if (wizardStep > 1) setWizardStep((wizardStep - 1) as WizardStep);
  };

  // Step 1: Name entry + Avatar placeholder
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
                    className="w-24 h-24 rounded-full object-cover border-4 border-indigo-400 shadow-lg cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setLightboxImage(displayPhoto)}
                    title={language === 'de' ? 'Klicken zum Vergrössern' : 'Click to enlarge'}
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

            {/* Basic Info - Gender, Age, Height */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">
                  {t.gender}
                </label>
                <select
                  value={character.gender}
                  onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
                >
                  <option value="male">{t.male}</option>
                  <option value="female">{t.female}</option>
                  <option value="other">{t.other}</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">
                  {t.age}
                </label>
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
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">
                  {language === 'de' ? 'Größe (cm)' : language === 'fr' ? 'Taille (cm)' : 'Height (cm)'}
                </label>
                <input
                  type="number"
                  value={character.physical?.height || ''}
                  onChange={(e) => updatePhysical('height', e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm focus:border-indigo-500 focus:outline-none"
                  placeholder="170"
                  min="50"
                  max="250"
                />
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
            onClick={onContinueToTraits}
            disabled={!canSaveName || isLoading || isAnalyzingPhoto}
            loading={isLoading}
            icon={Save}
            className={onCancel ? "flex-1" : "w-full"}
          >
            {language === 'de' ? 'Speichern' :
             language === 'fr' ? 'Enregistrer' :
             'Save'}
          </Button>
        </div>
      </div>
    );
  }

  // ============================================================================
  // EXISTING CHARACTER: Compact Edit View
  // ============================================================================
  if (isExistingCharacter && !editingSection) {
    return (
      <div className="space-y-4">
        {/* Header with photo, name, and avatar */}
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0">
            {displayPhoto ? (
              <img src={displayPhoto} alt={character.name}
                className="w-16 h-16 rounded-full object-cover border-2 border-indigo-400 cursor-pointer hover:opacity-80"
                onClick={() => setLightboxImage(displayPhoto)} />
            ) : (
              <div className="w-16 h-16 rounded-full bg-gray-200 border-2 border-gray-300 flex items-center justify-center">
                <Upload size={20} className="text-gray-400" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-xl font-bold text-gray-800">{character.name}</h3>
            <p className="text-sm text-gray-500">
              {character.gender === 'male' ? (language === 'de' ? 'Männlich' : 'Male') :
               character.gender === 'female' ? (language === 'de' ? 'Weiblich' : 'Female') : (language === 'de' ? 'Andere' : 'Other')}
              {character.age && `, ${character.age} ${language === 'de' ? 'Jahre' : 'years'}`}
              {character.physical?.height && `, ${character.physical.height}cm`}
            </p>
          </div>
          {character.avatars?.standard && (
            <img src={character.avatars.standard} alt={`${character.name} avatar`}
              className="w-20 h-28 object-contain rounded-lg border-2 border-indigo-300 bg-white cursor-pointer hover:opacity-90"
              onClick={() => setLightboxImage(character.avatars?.standard || null)} />
          )}
        </div>

        {/* Compact trait sections with edit buttons */}
        <div className="space-y-3">
          {/* Strengths */}
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-green-700">{t.strengths}</h4>
              <button onClick={() => setEditingSection('strengths')} className="text-green-600 hover:text-green-800 p-1"><Pencil size={14} /></button>
            </div>
            <div className="flex flex-wrap gap-1">
              {(character.traits?.strengths || []).map((trait) => (
                <span key={trait} className="px-2 py-0.5 bg-green-100 text-green-800 rounded text-xs">{trait}</span>
              ))}
            </div>
          </div>

          {/* Weaknesses */}
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-red-700">{language === 'de' ? 'Schwächen' : 'Weaknesses'}</h4>
              <button onClick={() => setEditingSection('weaknesses')} className="text-red-600 hover:text-red-800 p-1"><Pencil size={14} /></button>
            </div>
            <div className="flex flex-wrap gap-1">
              {(character.traits?.flaws || []).map((trait) => (
                <span key={trait} className="px-2 py-0.5 bg-red-100 text-red-800 rounded text-xs">{trait}</span>
              ))}
            </div>
          </div>

          {/* Conflicts */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-amber-700">{language === 'de' ? 'Konflikte' : 'Conflicts'}</h4>
              <button onClick={() => setEditingSection('conflicts')} className="text-amber-600 hover:text-amber-800 p-1"><Pencil size={14} /></button>
            </div>
            <div className="flex flex-wrap gap-1">
              {(character.traits?.challenges || []).length > 0 ? (
                (character.traits?.challenges || []).map((trait) => (
                  <span key={trait} className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs">{trait}</span>
                ))
              ) : (<span className="text-xs text-gray-400 italic">{language === 'de' ? 'Keine' : 'None'}</span>)}
            </div>
          </div>

          {/* Special Details */}
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-purple-700">{t.specialDetails}</h4>
              <button onClick={() => setEditingSection('details')} className="text-purple-600 hover:text-purple-800 p-1"><Pencil size={14} /></button>
            </div>
            <p className="text-xs text-gray-600">{character.traits?.specialDetails || <span className="italic text-gray-400">{language === 'de' ? 'Keine' : 'None'}</span>}</p>
          </div>

          {/* Relationships */}
          {hasOtherCharacters && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-blue-700">{language === 'de' ? 'Beziehungen' : 'Relationships'}</h4>
                <button onClick={() => setEditingSection('relationships')} className="text-blue-600 hover:text-blue-800 p-1"><Pencil size={14} /></button>
              </div>
              <p className="text-xs text-gray-600">
                {Object.keys(relationships).length > 0 ? `${Object.keys(relationships).length} ${language === 'de' ? 'definiert' : 'defined'}` : <span className="italic text-gray-400">{language === 'de' ? 'Keine' : 'None'}</span>}
              </p>
            </div>
          )}
        </div>

        {/* Save button */}
        <div className="flex gap-3 max-w-md">
          {onCancel && (<button onClick={onCancel} className="flex-1 bg-gray-200 text-gray-700 px-4 py-3 rounded-lg font-semibold hover:bg-gray-300">{t.cancel}</button>)}
          <Button onClick={onSave} disabled={isLoading} loading={isLoading} icon={Save} className={onCancel ? "flex-1" : "w-full"}>{t.saveCharacter}</Button>
        </div>
        <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />
      </div>
    );
  }

  // ============================================================================
  // EDITING SECTION MODAL (for existing characters)
  // ============================================================================
  if (editingSection) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => setEditingSection(null)} className="p-2 hover:bg-gray-100 rounded-full"><ChevronLeft size={20} /></button>
          <h3 className="text-xl font-bold text-gray-800">
            {editingSection === 'strengths' && t.strengths}
            {editingSection === 'weaknesses' && (language === 'de' ? 'Schwächen' : 'Weaknesses')}
            {editingSection === 'conflicts' && (language === 'de' ? 'Konflikte' : 'Conflicts')}
            {editingSection === 'details' && t.specialDetails}
            {editingSection === 'relationships' && (language === 'de' ? 'Beziehungen' : 'Relationships')}
          </h3>
        </div>
        {editingSection === 'strengths' && <TraitSelector label="" traits={localizedStrengths} selectedTraits={character.traits?.strengths || []} onSelect={(traits) => updateTraits('strengths', traits)} minRequired={3} />}
        {editingSection === 'weaknesses' && <TraitSelector label="" traits={localizedFlaws} selectedTraits={character.traits?.flaws || []} onSelect={(traits) => updateTraits('flaws', traits)} minRequired={2} />}
        {editingSection === 'conflicts' && <TraitSelector label="" traits={localizedChallenges} selectedTraits={character.traits?.challenges || []} onSelect={(traits) => updateTraits('challenges', traits)} />}
        {editingSection === 'details' && (
          <textarea value={character.traits?.specialDetails || ''} onChange={(e) => updateTraits('specialDetails', e.target.value)}
            className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none" placeholder={t.specialDetailsPlaceholder} rows={4} />
        )}
        {editingSection === 'relationships' && onRelationshipChange && onRelationshipTextChange && (
          <CharacterRelationships character={character} allCharacters={allCharacters} relationships={relationships} relationshipTexts={relationshipTexts}
            onRelationshipChange={onRelationshipChange} onRelationshipTextChange={onRelationshipTextChange} customRelationships={customRelationships} onAddCustomRelationship={onAddCustomRelationship} />
        )}
        <button onClick={() => setEditingSection(null)} className="w-full bg-indigo-600 text-white px-4 py-3 rounded-lg font-semibold hover:bg-indigo-700 flex items-center justify-center gap-2">
          <Check size={18} />{language === 'de' ? 'Fertig' : 'Done'}
        </button>
      </div>
    );
  }

  // ============================================================================
  // NEW CHARACTER: Wizard Flow
  // ============================================================================
  return (
    <div className="space-y-4">
      {/* Wizard progress */}
      <div className="flex items-center justify-center gap-2 mb-4">
        {Array.from({ length: totalWizardSteps }, (_, i) => i + 1).map((stepNum) => (
          <div key={stepNum} className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
            stepNum === wizardStep ? 'bg-indigo-600 text-white' : stepNum < wizardStep ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-500'
          }`}>{stepNum < wizardStep ? <Check size={14} /> : stepNum}</div>
        ))}
      </div>

      {/* Step 1: Photo + Info */}
      {wizardStep === 1 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-center">{language === 'de' ? 'Foto & Grunddaten' : 'Photo & Basic Info'}</h3>
          <div className="flex flex-col items-center gap-4">
            {isAnalyzingPhoto ? (
              <div className="w-32 h-32 rounded-full bg-indigo-100 border-4 border-indigo-400 flex items-center justify-center">
                <div className="w-8 h-8 border-3 border-indigo-600 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : displayPhoto ? (
              <img src={displayPhoto} alt={character.name} className="w-32 h-32 rounded-full object-cover border-4 border-indigo-400" />
            ) : (
              <div className="w-32 h-32 rounded-full bg-gray-200 border-4 border-dashed border-gray-300 flex items-center justify-center">
                <Upload size={32} className="text-gray-400" />
              </div>
            )}
            <label className="cursor-pointer bg-indigo-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-indigo-700 flex items-center gap-2">
              <Upload size={16} />{displayPhoto ? (language === 'de' ? 'Foto ändern' : 'Change Photo') : (language === 'de' ? 'Foto hochladen' : 'Upload Photo')}
              <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" />
            </label>
          </div>
          <div className="space-y-3 max-w-sm mx-auto">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.gender}</label>
              <select value={character.gender} onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none">
                <option value="male">{t.male}</option><option value="female">{t.female}</option><option value="other">{t.other}</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t.age}</label>
              <input type="number" value={character.age} onChange={(e) => updateField('age', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" min="1" max="120" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{language === 'de' ? 'Grösse (cm)' : 'Height (cm)'}</label>
              <input type="number" value={character.physical?.height || ''} onChange={(e) => updatePhysical('height', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder="cm" min="50" max="250" />
            </div>
          </div>
        </div>
      )}

      {/* Step 2: Strengths */}
      {wizardStep === 2 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-center">{language === 'de' ? 'Wähle mindestens 3 Stärken' : 'Select at least 3 strengths'}</h3>
          <TraitSelector label="" traits={localizedStrengths} selectedTraits={character.traits?.strengths || []} onSelect={(traits) => updateTraits('strengths', traits)} minRequired={3} />
        </div>
      )}

      {/* Step 3: Weaknesses */}
      {wizardStep === 3 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-center">{language === 'de' ? 'Wähle mindestens 2 Schwächen' : 'Select at least 2 weaknesses'}</h3>
          <TraitSelector label="" traits={localizedFlaws} selectedTraits={character.traits?.flaws || []} onSelect={(traits) => updateTraits('flaws', traits)} minRequired={2} />
        </div>
      )}

      {/* Step 4: Conflicts */}
      {wizardStep === 4 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-center">{language === 'de' ? 'Konflikte (optional)' : 'Conflicts (optional)'}</h3>
          <TraitSelector label="" traits={localizedChallenges} selectedTraits={character.traits?.challenges || []} onSelect={(traits) => updateTraits('challenges', traits)} />
        </div>
      )}

      {/* Step 5: Special Details */}
      {wizardStep === 5 && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-center">{language === 'de' ? 'Besondere Details (optional)' : 'Special Details (optional)'}</h3>
          <p className="text-sm text-gray-500 text-center">{language === 'de' ? 'Hobbys, Interessen...' : 'Hobbies, interests...'}</p>
          <textarea value={character.traits?.specialDetails || ''} onChange={(e) => updateTraits('specialDetails', e.target.value)}
            className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none" placeholder={t.specialDetailsPlaceholder} rows={4} />
        </div>
      )}

      {/* Step 6: Relationships */}
      {wizardStep === 6 && hasOtherCharacters && onRelationshipChange && onRelationshipTextChange && (
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-center">{language === 'de' ? 'Beziehungen' : 'Relationships'}</h3>
          <CharacterRelationships character={character} allCharacters={allCharacters} relationships={relationships} relationshipTexts={relationshipTexts}
            onRelationshipChange={onRelationshipChange} onRelationshipTextChange={onRelationshipTextChange} customRelationships={customRelationships} onAddCustomRelationship={onAddCustomRelationship} />
        </div>
      )}

      {/* Avatar preview */}
      {character.avatars?.standard && wizardStep > 1 && (
        <div className="fixed bottom-24 right-4 z-10">
          <img src={character.avatars.standard} alt={`${character.name} avatar`}
            className="w-16 h-24 object-contain rounded-lg border-2 border-indigo-300 bg-white shadow-lg cursor-pointer hover:scale-105 transition-transform"
            onClick={() => setLightboxImage(character.avatars?.standard || null)} />
        </div>
      )}

      {/* Navigation */}
      <div className="flex gap-3 pt-4">
        {wizardStep > 1 && (
          <button onClick={goToPrevStep} className="flex-1 bg-gray-200 text-gray-700 px-4 py-3 rounded-lg font-semibold hover:bg-gray-300 flex items-center justify-center gap-2">
            <ChevronLeft size={18} />{language === 'de' ? 'Zurück' : 'Back'}
          </button>
        )}
        {wizardStep < totalWizardSteps ? (
          <button onClick={goToNextStep} disabled={!canProceedFromStep(wizardStep)}
            className={`flex-1 px-4 py-3 rounded-lg font-semibold flex items-center justify-center gap-2 ${canProceedFromStep(wizardStep) ? 'bg-indigo-600 text-white hover:bg-indigo-700' : 'bg-gray-300 text-gray-500 cursor-not-allowed'}`}>
            {language === 'de' ? 'Weiter' : 'Next'}<ChevronRight size={18} />
          </button>
        ) : (
          <Button onClick={onSave} disabled={!canSaveCharacter || isLoading} loading={isLoading} icon={Save} className="flex-1">{t.saveCharacter}</Button>
        )}
      </div>
      <ImageLightbox src={lightboxImage} onClose={() => setLightboxImage(null)} />
    </div>
  );
}

export default CharacterForm;
