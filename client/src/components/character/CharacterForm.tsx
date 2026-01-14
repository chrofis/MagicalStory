import { ChangeEvent, useState, useEffect } from 'react';
import { Upload, Save, RefreshCw, Pencil, X, ArrowRight, Check, Camera } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common/Button';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import TraitSelector from './TraitSelector';
import CharacterRelationships from './CharacterRelationships';
import { strengths as defaultStrengths, flaws as defaultFlaws, challenges as defaultChallenges } from '@/constants/traits';
import { useAvatarCooldown } from '@/hooks/useAvatarCooldown';
import { getAgeCategory, characterService } from '@/services/characterService';
import type { Character, PhysicalTraits, PhysicalTraitsSource, AgeCategory, ChangedTraits, RelationshipMap, RelationshipTextMap } from '@/types/character';
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
  isUserEdited?: boolean;  // User has manually edited this field (will be enforced)
  language?: string;  // For tooltip translation
}

function InlineEditField({ label, value, placeholder, onChange, isChanged, isAiExtracted, isUserEdited, language }: InlineEditFieldProps) {
  const userEditedTooltip = language === 'de'
    ? 'Von dir bearbeitet - wird bei Neugenerierung beibehalten'
    : language === 'fr'
      ? 'Modifié par vous - sera conservé lors de la régénération'
      : 'Edited by you - will be enforced on regeneration';

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
          isUserEdited
            ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200'
            : isChanged
              ? 'border-amber-400 bg-amber-50 text-amber-800'
              : isAiExtracted
                ? 'border-gray-200 bg-gray-50 text-gray-500'
                : 'border-gray-200 bg-white'
        }`}
        placeholder={placeholder}
      />
      {isUserEdited && (
        <span className="text-blue-500 text-xs cursor-help" title={userEditedTooltip}>✎</span>
      )}
      {isChanged && !isUserEdited && (
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

  // Check if a trait is user-edited (will be enforced during regeneration)
  const isUserEdited = (field: keyof PhysicalTraitsSource) =>
    character.physicalTraitsSource?.[field] === 'user';

  const selectClass = (isChanged?: boolean, field?: keyof PhysicalTraitsSource) => {
    const userEdited = field && isUserEdited(field);
    return `flex-1 min-w-0 px-2 py-1 text-sm border rounded focus:outline-none focus:border-indigo-400 hover:border-gray-300 ${
      userEdited
        ? 'border-blue-400 bg-blue-50 ring-1 ring-blue-200'
        : isChanged
          ? 'border-amber-400 bg-amber-50'
          : isAiExtracted
            ? 'border-gray-200 bg-gray-50 text-gray-500'
            : 'border-gray-200 bg-white'
    }`;
  };

  // User-edited indicator (blue dot with tooltip)
  const UserEditedIndicator = ({ field }: { field: keyof PhysicalTraitsSource }) => {
    if (!isUserEdited(field)) return null;
    const tooltip = language === 'de'
      ? 'Von dir bearbeitet - wird bei Neugenerierung beibehalten'
      : language === 'fr'
        ? 'Modifié par vous - sera conservé lors de la régénération'
        : 'Edited by you - will be enforced on regeneration';
    return (
      <span
        className="text-blue-500 text-xs cursor-help"
        title={tooltip}
      >
        ✎
      </span>
    );
  };

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
        isUserEdited={isUserEdited('eyeColor')}
        language={language}
      />
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Visuelles Alter' : language === 'fr' ? 'Âge visuel' : 'Visual Age'}:
        </span>
        <select
          value={character.physical?.apparentAge || getAgeCategory(character.age) || ''}
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
          className={selectClass(changedTraits?.hairColor, 'hairColor')}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {HAIR_COLOR_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        <UserEditedIndicator field="hairColor" />
        {changedTraits?.hairColor && !isUserEdited('hairColor') && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Haarlänge' : language === 'fr' ? 'Longueur' : 'Hair Length'}:
        </span>
        <select
          value={character.physical?.hairLength || ''}
          onChange={(e) => updatePhysical('hairLength', e.target.value)}
          className={selectClass(changedTraits?.hairLength, 'hairLength')}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {HAIR_LENGTH_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        <UserEditedIndicator field="hairLength" />
        {changedTraits?.hairLength && !isUserEdited('hairLength') && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>

      {/* Row 3: Hair Style | Build */}
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Frisur' : language === 'fr' ? 'Coiffure' : 'Hair Style'}:
        </span>
        <select
          value={character.physical?.hairStyle || ''}
          onChange={(e) => updatePhysical('hairStyle', e.target.value)}
          className={selectClass(changedTraits?.hairStyle, 'hairStyle')}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {HAIR_STYLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        <UserEditedIndicator field="hairStyle" />
        {changedTraits?.hairStyle && !isUserEdited('hairStyle') && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Körperbau' : language === 'fr' ? 'Corpulence' : 'Build'}:
        </span>
        <select
          value={character.physical?.build || ''}
          onChange={(e) => updatePhysical('build', e.target.value)}
          className={selectClass(changedTraits?.build, 'build')}
        >
          <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
          {BUILD_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
            </option>
          ))}
        </select>
        <UserEditedIndicator field="build" />
        {changedTraits?.build && !isUserEdited('build') && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>

      {/* Row 4: Skin Tone | Facial Hair (non-females) or Other (females) */}
      <div className="flex items-center gap-2">
        <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
          {language === 'de' ? 'Hautton' : language === 'fr' ? 'Teint' : 'Skin Tone'}:
        </span>
        <input
          type="text"
          value={character.physical?.skinTone || ''}
          placeholder={language === 'de' ? 'z.B. hell, mittel' : 'e.g. fair, medium'}
          onChange={(e) => updatePhysical('skinTone', e.target.value)}
          className={`flex-1 min-w-0 px-2 py-1 text-sm border rounded ${
            changedTraits?.skinTone && !isUserEdited('skinTone')
              ? 'border-amber-400 bg-amber-50'
              : 'border-gray-300'
          } ${isUserEdited('skinTone') ? 'ring-2 ring-blue-400' : ''}`}
        />
        <UserEditedIndicator field="skinTone" />
        {changedTraits?.skinTone && !isUserEdited('skinTone') && <span className="text-amber-500 text-xs" title="Changed">●</span>}
      </div>
      {character.gender !== 'female' ? (
        <div className="flex items-center gap-2">
          <span className={`font-medium text-xs whitespace-nowrap ${labelClass}`}>
            {language === 'de' ? 'Bart' : language === 'fr' ? 'Barbe' : 'Facial Hair'}:
          </span>
          <select
            value={character.physical?.facialHair || ''}
            onChange={(e) => updatePhysical('facialHair', e.target.value)}
            className={selectClass(changedTraits?.facialHair, 'facialHair')}
          >
            <option value="">{language === 'de' ? '— Wählen —' : language === 'fr' ? '— Choisir —' : '— Select —'}</option>
            {FACIAL_HAIR_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {language === 'de' ? opt.labelDe : language === 'fr' ? opt.labelFr : opt.label}
              </option>
            ))}
          </select>
          <UserEditedIndicator field="facialHair" />
          {changedTraits?.facialHair && !isUserEdited('facialHair') && <span className="text-amber-500 text-xs" title="Changed">●</span>}
        </div>
      ) : (
        <InlineEditField
          label={language === 'de' ? 'Sonstiges' : language === 'fr' ? 'Autre' : 'Other'}
          value={character.physical?.other || ''}
          placeholder={language === 'de' ? 'z.B. Brille' : 'e.g. glasses'}
          onChange={(v) => updatePhysical('other', v)}
          isAiExtracted={isAiExtracted}
          isChanged={changedTraits?.other}
          isUserEdited={isUserEdited('other')}
          language={language}
        />
      )}

      {/* Row 5: Other (for non-females) - spans full width */}
      {character.gender !== 'female' && (
        <div className="col-span-2">
          <InlineEditField
            label={language === 'de' ? 'Sonstiges' : language === 'fr' ? 'Autre' : 'Other'}
            value={character.physical?.other || ''}
            placeholder={language === 'de' ? 'z.B. Brille' : 'e.g. glasses'}
            onChange={(v) => updatePhysical('other', v)}
            isAiExtracted={isAiExtracted}
            isChanged={changedTraits?.other}
            isUserEdited={isUserEdited('other')}
            language={language}
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
  onPhotoChange: (file: File, keepOldClothing?: boolean) => void;
  onSaveAndTryNewPhoto?: () => void;  // Save character and go to photo change
  onContinueToTraits?: () => void;
  onContinueToCharacteristics?: () => void;
  onContinueToRelationships?: () => void;
  onContinueToAvatar?: () => void;
  isNewCharacter?: boolean;  // Show simplified traits view for new characters
  onSaveAndGenerateAvatar?: () => void;  // New: triggers avatar generation
  onSaveAndRegenerateWithTraits?: () => void;  // Combined save + regenerate with traits
  onRegenerateAvatars?: () => void;
  onRegenerateAvatarsWithTraits?: () => void;
  isLoading?: boolean;
  isAnalyzingPhoto?: boolean;
  isGeneratingAvatar?: boolean;  // New: background avatar generation in progress
  isRegeneratingAvatars?: boolean;
  isRegeneratingAvatarsWithTraits?: boolean;
  step: 'name' | 'traits' | 'characteristics' | 'relationships' | 'avatar';
  developerMode?: boolean;
  isImpersonating?: boolean;  // Admin impersonating a user (should show dev features)
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
  onSaveAndTryNewPhoto,
  onContinueToTraits,
  onContinueToCharacteristics,
  onContinueToRelationships,
  onContinueToAvatar,
  isNewCharacter = false,
  onSaveAndGenerateAvatar: _onSaveAndGenerateAvatar,  // No longer used - avatar auto-generates on photo upload
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
  isImpersonating = false,
  changedTraits: _changedTraits,  // Unused but kept for future use
  photoAnalysisDebug,
  relationships = {},
  relationshipTexts = {},
  onRelationshipChange,
  onRelationshipTextChange,
  customRelationships = [],
  onAddCustomRelationship,
}: CharacterFormProps) {
  const { t, language } = useLanguage();
  const [enlargedAvatar, setEnlargedAvatar] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [isModifyingAvatar, setIsModifyingAvatar] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  // Clothing choice modal state
  const [showClothingChoiceModal, setShowClothingChoiceModal] = useState(false);
  const [pendingPhotoFile, setPendingPhotoFile] = useState<File | null>(null);
  // Avatar options selection state
  const [avatarOptions, setAvatarOptions] = useState<Array<{ id: number; imageData: string }> | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<number | null>(null);
  const [isGeneratingOptions, setIsGeneratingOptions] = useState(false);

  // Lock body scroll when modal is open
  useEffect(() => {
    if (isModifyingAvatar || showClothingChoiceModal) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isModifyingAvatar, showClothingChoiceModal]);

  // Check if character has existing clothing data
  const hasExistingClothing = !!(
    character.clothing?.structured?.upperBody ||
    character.clothing?.structured?.lowerBody ||
    character.clothing?.structured?.shoes ||
    character.clothing?.structured?.fullBody
  );

  // Check if character already has avatars (meaning this is a photo change, not initial upload)
  const hasExistingAvatars = !!(
    character.avatars?.winter ||
    character.avatars?.standard ||
    character.avatars?.summer
  );

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // If character has existing clothing AND avatars, show choice modal
      if (hasExistingClothing && hasExistingAvatars) {
        setPendingPhotoFile(file);
        setShowClothingChoiceModal(true);
      } else {
        // No existing clothing or first photo - just proceed
        onPhotoChange(file, false);
      }
    }
    // Reset the input so the same file can be selected again
    e.target.value = '';
  };

  // Handle clothing choice from modal
  const handleClothingChoice = (keepOldClothing: boolean) => {
    if (pendingPhotoFile) {
      onPhotoChange(pendingPhotoFile, keepOldClothing);
    }
    setShowClothingChoiceModal(false);
    setPendingPhotoFile(null);
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

  // Update physical traits and mark as 'user' source
  const updatePhysical = (field: keyof PhysicalTraits, value: string) => {
    onChange({
      ...character,
      physical: {
        ...character.physical,
        [field]: value,
      },
      // Mark this trait as user-edited so it will be sent during regeneration
      physicalTraitsSource: {
        ...character.physicalTraitsSource,
        [field]: 'user' as const,
      } as PhysicalTraitsSource,
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

  // Generate 3 avatar options for user to choose from
  const handleGenerateAvatarOptions = async () => {
    const bodyPhoto = character.photos?.body || character.photos?.original;
    if (!bodyPhoto) return;

    const gender = character.gender === 'female' ? 'female' : 'male';

    setIsGeneratingOptions(true);
    setAvatarOptions(null);
    setSelectedOptionId(null);

    try {
      const result = await characterService.generateAvatarOptions(bodyPhoto, gender);
      if (result.success && result.options.length > 0) {
        setAvatarOptions(result.options);
        setSelectedOptionId(result.options[0].id);
      }
    } catch (error) {
      console.error('Failed to generate avatar options:', error);
    } finally {
      setIsGeneratingOptions(false);
    }
  };

  // Save the selected avatar option
  const handleSaveSelectedAvatar = () => {
    if (avatarOptions && selectedOptionId !== null) {
      const selected = avatarOptions.find(o => o.id === selectedOptionId);
      if (selected) {
        // Update character with selected avatar
        onChange({
          ...character,
          avatars: {
            ...character.avatars,
            standard: selected.imageData,
            status: 'complete',
            generatedAt: new Date().toISOString(),
          },
        });
        setAvatarOptions(null);
        setSelectedOptionId(null);
      }
    }
  };

  const canSaveName = character.name && character.name.trim().length >= 2 && character.gender && character.age;

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

  // Get display photo URL - prefer avatar face thumbnail over original photo
  const displayPhoto = character.avatars?.faceThumbnails?.standard || character.photos?.face || character.photos?.original;

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

            {/* Basic Info - Gender, Age, Height - stack on mobile */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">
                  {t.gender} <span className="text-red-500">*</span>
                </label>
                <select
                  value={character.gender || ''}
                  onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                  className={`w-full px-2 py-1.5 border rounded text-base focus:border-indigo-500 focus:outline-none ${!character.gender ? 'border-red-300' : 'border-gray-300'}`}
                >
                  <option value="">{language === 'de' ? '— Bitte wählen —' : language === 'fr' ? '— Veuillez choisir —' : '— Please select —'}</option>
                  <option value="male">{t.male}</option>
                  <option value="female">{t.female}</option>
                  <option value="other">{t.other}</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">
                  {t.age} <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  value={character.age}
                  onChange={(e) => updateField('age', e.target.value)}
                  className={`w-full px-2 py-1.5 border rounded text-base focus:border-indigo-500 focus:outline-none ${!character.age ? 'border-red-300' : 'border-gray-300'}`}
                  min="1"
                  max="120"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-gray-600 mb-0.5">
                  {language === 'de' ? 'Grösse (cm)' : language === 'fr' ? 'Taille (cm)' : 'Height (cm)'}
                </label>
                <input
                  type="number"
                  value={character.physical?.height || ''}
                  onChange={(e) => updatePhysical('height', e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-base focus:border-indigo-500 focus:outline-none"
                  placeholder="170"
                  min="50"
                  max="250"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Required fields message */}
        {!canSaveName && (character.name?.trim().length >= 2) && (
          <p className="text-sm text-red-500 text-center">
            {language === 'de' ? 'Bitte Geschlecht und Alter eingeben' :
             language === 'fr' ? 'Veuillez entrer le sexe et l\'âge' :
             'Please enter gender and age'}
          </p>
        )}

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
            icon={ArrowRight}
            className={onCancel ? "flex-1" : "w-full"}
          >
            {language === 'de' ? 'Weiter' :
             language === 'fr' ? 'Suivant' :
             'Next'}
          </Button>
        </div>
      </div>
    );
  }

  // Step 2a: Simplified traits view for NEW characters (just strengths, weaknesses, conflicts)
  if (isNewCharacter && step === 'traits') {
    return (
      <div className="space-y-6">
        {/* Header with character info */}
        <div className="flex items-center gap-4 pb-4 border-b border-gray-200">
          {displayPhoto && (
            <img
              src={displayPhoto}
              alt={character.name}
              className="w-16 h-16 rounded-full object-cover border-2 border-indigo-400"
            />
          )}
          <div>
            <h3 className="text-2xl font-bold text-gray-800">{character.name}</h3>
            <p className="text-sm text-gray-500">
              {character.gender === 'male' ? (language === 'de' ? 'Männlich' : 'Male') :
               character.gender === 'female' ? (language === 'de' ? 'Weiblich' : 'Female') :
               (language === 'de' ? 'Andere' : 'Other')}, {character.age} {language === 'de' ? 'Jahre' : 'years'}
            </p>
          </div>
        </div>

        {/* Trait Selectors - expanded by default for new characters */}
        <div className="space-y-4">
          <TraitSelector
            label={t.strengths}
            traits={localizedStrengths}
            selectedTraits={character.traits?.strengths || []}
            onSelect={(traits) => updateTraits('strengths', traits)}
            minRequired={3}
            defaultExpanded={true}
          />

          <TraitSelector
            label={language === 'de' ? 'Schwächen' : language === 'fr' ? 'Défauts' : 'Flaws'}
            traits={localizedFlaws}
            selectedTraits={character.traits?.flaws || []}
            onSelect={(traits) => updateTraits('flaws', traits)}
            minRequired={2}
            defaultExpanded={true}
          />

          <TraitSelector
            label={language === 'de' ? 'Konflikte / Herausforderungen' : language === 'fr' ? 'Conflits / Défis' : 'Conflicts / Challenges'}
            traits={localizedChallenges}
            selectedTraits={character.traits?.challenges || []}
            onSelect={(traits) => updateTraits('challenges', traits)}
            defaultExpanded={true}
          />
        </div>

        {/* Next/Cancel Buttons - Sticky on mobile */}
        <div className="sticky bottom-0 left-0 right-0 bg-white pt-4 pb-2 -mx-4 px-4 md:relative md:mx-0 md:px-0 md:bg-transparent border-t border-gray-200 md:border-0 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)] md:shadow-none">
          {!canSaveCharacter && (
            <p className="text-sm text-red-500 text-center mb-3">
              {t.selectStrengthsFlaws}
            </p>
          )}
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
              onClick={onContinueToCharacteristics}
              disabled={!canSaveCharacter || isLoading}
              loading={isLoading}
              icon={ArrowRight}
              className={onCancel ? "flex-1" : "w-full"}
            >
              {language === 'de' ? 'Weiter' :
               language === 'fr' ? 'Suivant' :
               'Next'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Step 3: Characteristics/Special Details for NEW characters
  if (isNewCharacter && step === 'characteristics') {
    return (
      <div className="space-y-6">
        {/* Header with character info */}
        <div className="flex items-center gap-4 pb-4 border-b border-gray-200">
          {displayPhoto && (
            <img
              src={displayPhoto}
              alt={character.name}
              className="w-16 h-16 rounded-full object-cover border-2 border-indigo-400"
            />
          )}
          <div>
            <h3 className="text-2xl font-bold text-gray-800">{character.name}</h3>
            <p className="text-sm text-gray-500">
              {character.gender === 'male' ? (language === 'de' ? 'Männlich' : 'Male') :
               character.gender === 'female' ? (language === 'de' ? 'Weiblich' : 'Female') :
               (language === 'de' ? 'Andere' : 'Other')}, {character.age} {language === 'de' ? 'Jahre' : 'years'}
            </p>
          </div>
        </div>

        {/* Special Details */}
        <div>
          <label className="block text-lg font-semibold mb-2 text-gray-800">{t.specialDetails}</label>
          <textarea
            value={character.traits?.specialDetails || ''}
            onChange={(e) => updateTraits('specialDetails', e.target.value)}
            className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none"
            placeholder={t.specialDetailsPlaceholder}
            rows={5}
          />
          <p className="text-sm text-gray-500 mt-2">
            {language === 'de'
              ? 'Füge hier besondere Details hinzu, die den Charakter einzigartig machen (optional).'
              : language === 'fr'
              ? 'Ajoutez ici des détails spéciaux qui rendent le personnage unique (facultatif).'
              : 'Add any special details that make this character unique (optional).'}
          </p>
        </div>

        {/* Next/Cancel Buttons */}
        <div className="flex gap-3 pt-4">
          {onCancel && (
            <button
              onClick={onCancel}
              className="flex-1 bg-gray-200 text-gray-700 px-4 py-3 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
            >
              {t.cancel}
            </button>
          )}
          <Button
            onClick={allCharacters.length > 0 ? onContinueToRelationships : onContinueToAvatar}
            disabled={isLoading}
            loading={isLoading}
            icon={ArrowRight}
            className={onCancel ? "flex-1" : "w-full"}
          >
            {language === 'de' ? 'Weiter' : language === 'fr' ? 'Suivant' : 'Next'}
          </Button>
        </div>
      </div>
    );
  }

  // Step 4: Relationships for NEW characters (only if there are other characters)
  if (isNewCharacter && step === 'relationships') {
    return (
      <div className="space-y-6">
        {/* Header with character info */}
        <div className="flex items-center gap-4 pb-4 border-b border-gray-200">
          {displayPhoto && (
            <img
              src={displayPhoto}
              alt={character.name}
              className="w-16 h-16 rounded-full object-cover border-2 border-indigo-400"
            />
          )}
          <div>
            <h3 className="text-2xl font-bold text-gray-800">{character.name}</h3>
            <p className="text-sm text-gray-500">
              {character.gender === 'male' ? (language === 'de' ? 'Männlich' : 'Male') :
               character.gender === 'female' ? (language === 'de' ? 'Weiblich' : 'Female') :
               (language === 'de' ? 'Andere' : 'Other')}, {character.age} {language === 'de' ? 'Jahre' : 'years'}
            </p>
          </div>
        </div>

        {/* Relationships with other characters */}
        {allCharacters.length > 0 && onRelationshipChange && onRelationshipTextChange ? (
          <CharacterRelationships
            character={character}
            allCharacters={allCharacters}
            relationships={relationships}
            relationshipTexts={relationshipTexts}
            onRelationshipChange={onRelationshipChange}
            onRelationshipTextChange={onRelationshipTextChange}
            customRelationships={customRelationships}
            onAddCustomRelationship={onAddCustomRelationship}
          />
        ) : (
          <p className="text-center text-gray-500 py-8">
            {language === 'de'
              ? 'Erstelle weitere Charaktere, um Beziehungen hinzuzufügen.'
              : language === 'fr'
              ? 'Créez d\'autres personnages pour ajouter des relations.'
              : 'Create more characters to add relationships.'}
          </p>
        )}

        {/* Save/Cancel Buttons */}
        <div className="flex gap-3 pt-4">
          {onCancel && (
            <button
              onClick={onCancel}
              className="flex-1 bg-gray-200 text-gray-700 px-4 py-3 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
            >
              {t.cancel}
            </button>
          )}
          <Button
            onClick={onContinueToAvatar}
            disabled={isLoading}
            loading={isLoading}
            icon={ArrowRight}
            className={onCancel ? "flex-1" : "w-full"}
          >
            {language === 'de' ? 'Weiter' : language === 'fr' ? 'Suivant' : 'Next'}
          </Button>
        </div>
      </div>
    );
  }

  // Step 5: Avatar Review for NEW characters
  if (isNewCharacter && step === 'avatar') {
    const avatarStatus = character.avatars?.status;
    // Use faceThumbnails.standard for display (lightweight), fall back to full avatars if available
    const displayAvatar = character.avatars?.faceThumbnails?.standard ||
                          character.avatars?.standard ||
                          character.avatars?.winter ||
                          character.avatars?.summer;
    const hasAvatar = !!displayAvatar || character.avatars?.hasFullAvatars;
    const isStillGenerating = isGeneratingAvatar || isRegeneratingAvatarsWithTraits || avatarStatus === 'generating';
    const hasFailed = avatarStatus === 'failed';

    return (
      <div className="space-y-6">
        {/* Header - only show when not generating */}
        {!isStillGenerating && (
          <div className="text-center">
            <h3 className="text-2xl font-bold text-gray-800">
              {hasFailed
                ? (language === 'de' ? 'Erstellung fehlgeschlagen' : language === 'fr' ? 'Échec de la création' : 'Creation failed')
                : (language === 'de' ? `${character.name}` : language === 'fr' ? `${character.name}` : `${character.name}`)
              }
            </h3>
          </div>
        )}

        {/* Avatar Display - centered, prominent, clickable for lightbox */}
        <div className="flex justify-center">
          {hasAvatar ? (
            <div className="relative">
              <img
                src={displayAvatar}
                alt={`${character.name} avatar`}
                className="w-64 h-80 object-contain rounded-lg bg-white shadow-lg border-2 border-indigo-200 cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setLightboxImage(displayAvatar || null)}
                title={language === 'de' ? 'Klicken zum Vergrössern' : language === 'fr' ? 'Cliquer pour agrandir' : 'Click to enlarge'}
              />
              {isStillGenerating && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 rounded-lg pointer-events-none">
                  <div className="w-8 h-8 border-3 border-white border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
          ) : isStillGenerating ? (
            <div className="w-64 h-80 rounded-lg border-2 border-dashed border-indigo-300 bg-indigo-50 flex flex-col items-center justify-center p-4 text-center">
              <span className="text-indigo-700 font-medium mb-2">
                {language === 'de'
                  ? `So wird ${character.name} in deiner Geschichte aussehen`
                  : language === 'fr'
                  ? `Voici comment ${character.name} apparaîtra dans ton histoire`
                  : `This is how ${character.name} will look in your story`
                }
              </span>
              <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin my-4" />
              <span className="text-indigo-500 text-sm">
                {language === 'de'
                  ? 'Du kannst warten oder direkt weiterfahren'
                  : language === 'fr'
                  ? 'Tu peux attendre ou continuer'
                  : 'You can wait or continue'
                }
              </span>
            </div>
          ) : (
            <div className="w-64 h-80 rounded-lg border-2 border-dashed border-gray-300 bg-gray-100 flex flex-col items-center justify-center">
              <span className="text-gray-400">
                {hasFailed
                  ? (language === 'de' ? 'Erstellung fehlgeschlagen' : language === 'fr' ? 'Échec de génération' : 'Creation failed')
                  : (language === 'de' ? 'Kein Bild' : language === 'fr' ? 'Pas d\'image' : 'No image')
                }
              </span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col gap-3 max-w-md mx-auto">
          {/* When avatar is ready: Primary "Use Avatar" button */}
          {hasAvatar && !isStillGenerating && (
            <>
              {/* Primary: Accept & Save - Large and prominent */}
              <button
                onClick={onSave}
                disabled={isLoading}
                className="w-full px-6 py-4 text-lg font-bold bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3 shadow-lg"
              >
                {isLoading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Check size={24} />
                )}
                {language === 'de' ? 'Weiter' : language === 'fr' ? 'Continuer' : 'Continue'}
              </button>

              {/* Hint about modifying later */}
              <p className="text-xs text-gray-500 text-center">
                {language === 'de'
                  ? 'Du kannst das Aussehen später jederzeit anpassen'
                  : language === 'fr'
                  ? 'Tu peux modifier l\'apparence plus tard'
                  : 'You can modify the look later anytime'}
              </p>

              {/* Try with new photo */}
              {onSaveAndTryNewPhoto && (
                <button
                  onClick={onSaveAndTryNewPhoto}
                  className="w-full px-4 py-2 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <Camera size={16} />
                  {language === 'de' ? 'Mit neuem Foto versuchen' : language === 'fr' ? 'Essayer avec une nouvelle photo' : 'Try with a new photo'}
                </button>
              )}
            </>
          )}

          {/* When avatar is still generating: Show continue button */}
          {isStillGenerating && !hasFailed && (
            <button
              onClick={onSave}
              disabled={isLoading}
              className="w-full px-6 py-4 text-base font-semibold bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <ArrowRight size={20} />
              )}
              {language === 'de' ? 'Weiter ohne zu warten' : language === 'fr' ? 'Continuer sans attendre' : 'Continue without waiting'}
            </button>
          )}

          {/* When generation failed: Show save anyway */}
          {hasFailed && (
            <button
              onClick={onSave}
              disabled={isLoading}
              className="w-full px-6 py-4 text-base font-semibold bg-gray-600 text-white rounded-xl hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Save size={20} />
              )}
              {language === 'de' ? 'Charakter trotzdem speichern' : language === 'fr' ? 'Enregistrer quand même' : 'Save character anyway'}
            </button>
          )}
        </div>

        {/* Lightbox for enlarged avatar view */}
        <ImageLightbox
          src={lightboxImage}
          onClose={() => setLightboxImage(null)}
        />
      </div>
    );
  }

  // Step 2b: Full traits and characteristics view (for editing existing characters)
  return (
    <div className="space-y-4">
      {/* Main two-column layout on PC: left (photo/info/avatar) | right (traits) */}
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6">
        {/* Left column: Photo, info, avatar - fixed width on PC */}
        <div className="lg:w-60 flex-shrink-0">
          {/* Photo, name, and basic info */}
          <div className="space-y-3">
          {/* Header with photo and name */}
          <div className="flex items-center gap-3 mb-3">
            {/* Photo thumbnail */}
            <div className="flex-shrink-0">
              {isAnalyzingPhoto ? (
                <div className="w-14 h-14 rounded-full bg-indigo-100 border-2 border-indigo-400 flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : displayPhoto ? (
                <img
                  src={displayPhoto}
                  alt={character.name}
                  className="w-14 h-14 rounded-full object-cover border-2 border-indigo-400 cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={() => setLightboxImage(character.avatars?.standard || displayPhoto)}
                  title={language === 'de' ? 'Klicken zum Vergrössern' : 'Click to enlarge'}
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-gray-200 border-2 border-gray-300 flex items-center justify-center">
                  <Upload size={18} className="text-gray-400" />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-1">
              {/* Click-to-edit name */}
              {isEditingName ? (
                <input
                  type="text"
                  value={character.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  onBlur={() => setIsEditingName(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setIsEditingName(false);
                    if (e.key === 'Escape') setIsEditingName(false);
                  }}
                  className="text-xl font-bold text-gray-800 border-b-2 border-indigo-500 bg-transparent focus:outline-none px-0 py-0"
                  autoFocus
                />
              ) : (
                <h3
                  className="text-xl font-bold text-gray-800 cursor-pointer hover:text-indigo-600 flex items-center gap-1 group"
                  onClick={() => setIsEditingName(true)}
                  title={language === 'de' ? 'Klicken zum Bearbeiten' : 'Click to edit'}
                >
                  {character.name}
                  <Pencil size={14} className="text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </h3>
              )}

            </div>
          </div>

          {/* Basic Info - Stacked vertically */}
          <div className="space-y-2 mb-3">
            <div>
              <label className="block text-[10px] font-semibold text-gray-500 mb-0.5">{t.gender}</label>
              <select
                value={character.gender || ''}
                onChange={(e) => updateField('gender', e.target.value as 'male' | 'female' | 'other')}
                className="w-full px-1.5 py-1 border border-gray-300 rounded text-xs bg-white focus:border-indigo-500 focus:outline-none"
              >
                <option value="">{language === 'de' ? '— Unbekannt —' : language === 'fr' ? '— Inconnu —' : '— Unknown —'}</option>
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

          {/* Avatar section - full width of left column, centered on mobile */}
          <div className="flex flex-col items-center lg:items-start">
            {(() => {
              // Show full avatar (standard) when available
              // If hasFullAvatars but no standard loaded yet, show loading state
              const avatarToShow = character.avatars?.standard;
              const isLoadingFullAvatar = character.avatars?.hasFullAvatars && !character.avatars?.standard;
              const isGenerating = isGeneratingAvatar || isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating';

              if (avatarToShow) {
                return (
                  <div className="relative">
                    <img
                      src={avatarToShow}
                      alt={`${character.name} avatar`}
                      className={`w-full max-w-[180px] lg:max-w-full aspect-[3/4] object-contain rounded-lg bg-white cursor-pointer hover:opacity-90 transition-opacity ${character.avatars?.stale ? 'opacity-80' : ''}`}
                      onClick={() => setEnlargedAvatar(true)}
                      title={language === 'de' ? 'Klicken zum Vergrössern' : 'Click to enlarge'}
                    />
                    {isGenerating && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-40 rounded-lg">
                        <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <div className="w-full max-w-[180px] lg:max-w-full aspect-[3/4] rounded-lg border-2 border-dashed border-gray-300 bg-gray-100 flex flex-col items-center justify-center">
                  {(isGenerating || isLoadingFullAvatar) ? (
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs text-indigo-600 font-medium px-2 text-center">
                        {language === 'de' ? (isLoadingFullAvatar ? 'Lädt...' : 'Wird erstellt...') : (isLoadingFullAvatar ? 'Loading...' : 'Creating...')}
                      </span>
                    </div>
                  ) : (
                    <span className="text-[10px] text-gray-400 text-center px-2">
                      {language === 'de' ? 'Kein Bild' : 'No image'}
                    </span>
                  )}
                </div>
              );
            })()}
            {/* Enlarged avatar modal - show full avatar */}
            {enlargedAvatar && (character.avatars?.standard || character.avatars?.faceThumbnails?.standard) && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-75"
                onClick={() => setEnlargedAvatar(false)}
              >
                <img
                  src={character.avatars?.standard || character.avatars?.faceThumbnails?.standard}
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
            {/* Avatar action buttons - full width on mobile, side by side on desktop */}
            <div className="mt-3 flex flex-col sm:flex-row gap-2 w-full">
              {/* Change Photo button */}
              <label className="flex-1 px-4 py-3 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center justify-center gap-2 cursor-pointer transition-colors">
                <Upload size={16} />
                {language === 'de' ? 'Neues Foto' : language === 'fr' ? 'Nouvelle photo' : 'New Photo'}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>
              {/* Modify Avatar button */}
              <button
                onClick={() => setIsModifyingAvatar(true)}
                className="flex-1 px-4 py-3 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center justify-center gap-2 transition-colors"
              >
                <Pencil size={16} />
                {language === 'de' ? 'Anpassen' : language === 'fr' ? 'Modifier' : 'Modify'}
              </button>
            </div>
            {/* Developer mode buttons - below main buttons */}
            <div className="mt-1 space-y-1">
              {/* Regenerate button - developer mode only */}
              {(developerMode || isImpersonating) && (
                <button
                  onClick={handleUserRegenerate}
                  disabled={!canRegenerate || isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating'}
                  className="w-full px-2 py-1 text-[10px] font-medium bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
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
              )}
              {/* Generate 3 Options button */}
              {(developerMode || isImpersonating) && (
                <button
                  onClick={handleGenerateAvatarOptions}
                  disabled={isGeneratingOptions || isRegeneratingAvatars || isRegeneratingAvatarsWithTraits || !character.photos?.original}
                  className="w-full px-2 py-1 text-[10px] font-medium bg-purple-100 text-purple-700 rounded hover:bg-purple-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                >
                  {isGeneratingOptions ? (
                    <>
                      <div className="w-3 h-3 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
                      {language === 'de' ? 'Generiere 3...' : 'Generating 3...'}
                    </>
                  ) : (
                    language === 'de' ? '3 Optionen generieren' : 'Generate 3 Options'
                  )}
                </button>
              )}
            </div>
            {/* Developer mode: show face match score with full details */}
            {(developerMode || isImpersonating) && character.avatars?.faceMatch?.standard && (
              <details className="mt-1 text-left">
                <summary className={`text-[10px] font-medium cursor-pointer ${
                  character.avatars.faceMatch.standard.score >= 6 ? 'text-green-600' : 'text-red-600'
                }`}>
                  Face eval: {character.avatars.faceMatch.standard.score}/10
                  {character.avatars.faceMatch.standard.lpips && (
                    <span className={`ml-2 ${
                      character.avatars.faceMatch.standard.lpips.lpipsScore < 0.15 ? 'text-green-600' :
                      character.avatars.faceMatch.standard.lpips.lpipsScore < 0.30 ? 'text-yellow-600' : 'text-red-600'
                    }`}>
                      | LPIPS: {character.avatars.faceMatch.standard.lpips.lpipsScore?.toFixed(3)}
                    </span>
                  )}
                  {character.avatars.faceMatch.standard.arcface && (
                    <span className={`ml-2 ${
                      character.avatars.faceMatch.standard.arcface.samePerson ? 'text-green-600' : 'text-red-600'
                    }`}>
                      | ID: {((character.avatars.faceMatch.standard.arcface.similarity ?? 0) * 100).toFixed(0)}% ({character.avatars.faceMatch.standard.arcface.confidence})
                    </span>
                  )}
                </summary>
                <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-48 border bg-gray-100 border-gray-200">
                  {character.avatars.faceMatch.standard.details}
                  {character.avatars.faceMatch.standard.lpips && `\n\nLPIPS Perceptual Similarity:\n- Score: ${character.avatars.faceMatch.standard.lpips.lpipsScore?.toFixed(4)}\n- Interpretation: ${character.avatars.faceMatch.standard.lpips.interpretation}\n- Note: 0 = identical, <0.15 = very similar, <0.30 = similar`}
                  {character.avatars.faceMatch.standard.arcface && `\n\nArcFace Identity (style-invariant):\n- Similarity: ${((character.avatars.faceMatch.standard.arcface.similarity ?? 0) * 100).toFixed(1)}%\n- Same Person: ${character.avatars.faceMatch.standard.arcface.samePerson ? 'Yes' : 'No'}\n- Confidence: ${character.avatars.faceMatch.standard.arcface.confidence}\n- Note: Works photo→anime, >60% = high confidence same person`}
                </pre>
              </details>
            )}
            {/* Developer mode: show extracted clothing per avatar */}
            {(developerMode || isImpersonating) && character.avatars?.clothing && Object.keys(character.avatars.clothing).length > 0 && (
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
            {/* Developer mode: show avatar generation input (source photo + user traits) */}
            {(developerMode || isImpersonating) && (
              <details className="mt-1 text-left">
                <summary className="text-[10px] font-medium cursor-pointer text-purple-600">
                  Avatar Gen Input
                </summary>
                <div className="mt-1 p-2 rounded text-[9px] border bg-purple-50 border-purple-200 space-y-2">
                  <div className="flex gap-2">
                    <div>
                      <span className="font-semibold block mb-1">Source Photo:</span>
                      {(character.photos?.face || character.photos?.original) ? (
                        <img
                          src={character.photos?.face || character.photos?.original}
                          alt="Source"
                          className="w-16 h-16 object-cover rounded border"
                        />
                      ) : (
                        <span className="text-red-500">No photo</span>
                      )}
                      <span className="block text-[8px] text-gray-500 mt-0.5">
                        {character.photos?.face ? 'face crop' : character.photos?.original ? 'original' : 'none'}
                      </span>
                    </div>
                    <div className="flex-1">
                      <span className="font-semibold block mb-1">User Trait Edits (sent to API):</span>
                      {(() => {
                        const source = character.physicalTraitsSource || {};
                        const userTraits = Object.entries(source)
                          .filter(([_, v]) => v === 'user')
                          .map(([k]) => k);
                        if (userTraits.length === 0) {
                          return <span className="text-gray-400">None (using extracted)</span>;
                        }
                        return (
                          <ul className="space-y-0.5">
                            {userTraits.map(trait => (
                              <li key={trait} className="text-purple-700">
                                <span className="font-medium">{trait}:</span> {character.physical?.[trait as keyof typeof character.physical] || '?'}
                              </li>
                            ))}
                          </ul>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </details>
            )}
          </div>
          </div>
        </div>

        {/* Right column: Traits - full width */}
        <div className="flex-1 min-w-0 space-y-4">
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
            <label className="block text-lg font-semibold mb-2 text-gray-800">{t.specialDetails}</label>
            <textarea
              value={character.traits?.specialDetails || ''}
              onChange={(e) => updateTraits('specialDetails', e.target.value)}
              className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none"
              placeholder={t.specialDetailsPlaceholder}
              rows={3}
            />
          </div>

          {/* Relationships with other characters */}
          {allCharacters.length > 1 && onRelationshipChange && onRelationshipTextChange && (
            <CharacterRelationships
              character={character}
              allCharacters={allCharacters}
              relationships={relationships}
              relationshipTexts={relationshipTexts}
              onRelationshipChange={onRelationshipChange}
              onRelationshipTextChange={onRelationshipTextChange}
              customRelationships={customRelationships}
              onAddCustomRelationship={onAddCustomRelationship}
            />
          )}
        </div>
      </div>

      {/* Developer Mode: Show body crop with transparent background */}
      {(developerMode || isImpersonating) && character.photos?.bodyNoBg && (
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

      {/* Developer Mode: Show raw Gemini response from photo analysis */}
      {(developerMode || isImpersonating) && photoAnalysisDebug?.rawResponse && (
        <details className="bg-purple-50 border border-purple-300 rounded-lg p-3">
          <summary className="text-xs font-semibold text-purple-700 cursor-pointer">
            Raw Gemini Response (Photo Analysis)
            {photoAnalysisDebug.error && <span className="text-red-500 ml-2">⚠️ {photoAnalysisDebug.error}</span>}
          </summary>
          <pre className="mt-2 p-2 bg-white rounded text-[10px] whitespace-pre-wrap overflow-auto max-h-64 border border-purple-200 font-mono">
            {photoAnalysisDebug.rawResponse}
          </pre>
        </details>
      )}

      {/* Clothing Avatars (developer only - all 4 variants) */}
      {(developerMode || isImpersonating) && (
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
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {/* Show winter, standard, summer avatars (formal is not generated) */}
            {(['winter', 'standard', 'summer'] as const).map((category) => (
              <div key={category} className="text-center">
                <div className="text-xs font-medium text-gray-600 mb-1 capitalize">
                  {category === 'winter' ? '❄️' : category === 'summer' ? '☀️' : '👕'}
                  <span className="ml-0.5">
                    {language === 'de'
                      ? (category === 'winter' ? 'Winter' : category === 'summer' ? 'Sommer' : 'Standard')
                      : category}
                  </span>
                </div>
                {character.avatars?.[category] ? (
                  <div
                    className="relative cursor-pointer group"
                    onClick={() => setLightboxImage(character.avatars?.[category] || null)}
                    title={language === 'de' ? 'Klicken zum Vergrössern' : 'Click to enlarge'}
                  >
                    <img
                      src={character.avatars?.[category]}
                      alt={`${character.name} - ${category}`}
                      className={`w-full h-40 object-contain rounded border bg-white transition-all group-hover:shadow-lg group-hover:scale-[1.02] ${character.avatars?.stale ? 'border-amber-400 opacity-75' : 'border-teal-200'}`}
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all rounded flex items-center justify-center">
                      <span className="text-white opacity-0 group-hover:opacity-100 text-lg">🔍</span>
                    </div>
                    {character.avatars?.stale && (
                      <div className="absolute top-1 right-1 bg-amber-500 text-white text-[8px] px-1 py-0.5 rounded">
                        {language === 'de' ? 'Alt' : 'Old'}
                      </div>
                    )}
                    {(developerMode || isImpersonating) && character.avatars?.faceMatch?.[category] && (
                      <div className={`absolute bottom-1 left-1 text-white text-[8px] px-1 py-0.5 rounded font-medium ${
                        character.avatars.faceMatch[category].score >= 6 ? 'bg-green-600' : 'bg-red-600'
                      }`}>
                        {character.avatars.faceMatch[category].score}/10
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-full h-40 rounded border border-dashed border-teal-300 bg-teal-100/50 flex items-center justify-center text-teal-400 text-[10px]">
                    {character.avatars?.status === 'generating' ? '...' : '—'}
                  </div>
                )}
                {/* Dev mode: Always show clothing description below avatar */}
                {(developerMode || isImpersonating) && character.avatars?.clothing?.[category] && (
                  <div className="mt-1 p-1.5 rounded text-[10px] text-left bg-blue-50 border border-blue-200 text-blue-700">
                    <span className="font-semibold">👕 </span>
                    {character.avatars.clothing[category]}
                  </div>
                )}
                {(developerMode || isImpersonating) && character.avatars?.[category] && !character.avatars?.clothing?.[category] && (
                  <div className="mt-1 p-1.5 rounded text-[10px] text-left bg-amber-50 border border-amber-200 text-amber-600">
                    ⚠️ No clothing data - regenerate avatar
                  </div>
                )}
                {(developerMode || isImpersonating) && (
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
                          {character.avatars.faceMatch[category].lpips && (
                            <span className={`ml-1 ${
                              character.avatars.faceMatch[category].lpips.lpipsScore < 0.15 ? 'text-green-600' :
                              character.avatars.faceMatch[category].lpips.lpipsScore < 0.30 ? 'text-yellow-600' : 'text-red-600'
                            }`}>
                              LPIPS: {character.avatars.faceMatch[category].lpips.lpipsScore?.toFixed(3)}
                            </span>
                          )}
                          {character.avatars.faceMatch[category].arcface && (
                            <span className={`ml-1 ${
                              character.avatars.faceMatch[category].arcface.samePerson ? 'text-green-600' : 'text-red-600'
                            }`}>
                              ID: {((character.avatars.faceMatch[category].arcface.similarity ?? 0) * 100).toFixed(0)}%
                            </span>
                          )}
                        </summary>
                        <pre className="mt-1 p-2 rounded text-[9px] whitespace-pre-wrap overflow-auto max-h-48 border bg-gray-100 border-gray-200">
                          {character.avatars.faceMatch[category].details}
                          {character.avatars.faceMatch[category].lpips && `\n\nLPIPS: ${character.avatars.faceMatch[category].lpips.lpipsScore?.toFixed(4)} (${character.avatars.faceMatch[category].lpips.interpretation})`}
                          {character.avatars.faceMatch[category].arcface && `\n\nArcFace ID: ${((character.avatars.faceMatch[category].arcface.similarity ?? 0) * 100).toFixed(1)}% (${character.avatars.faceMatch[category].arcface.confidence}, same_person: ${character.avatars.faceMatch[category].arcface.samePerson})`}
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
            {/* Cross-avatar LPIPS scores in developer mode */}
            {(developerMode || isImpersonating) && character.avatars?.crossLpips && (
              <div className="text-[10px] text-gray-500 bg-gray-50 border border-gray-200 rounded p-2">
                <div className="font-medium mb-1">Cross-Avatar LPIPS:</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(character.avatars.crossLpips as Record<string, number>).map(([pair, score]) => {
                    const [cat1, cat2] = pair.split('_vs_');
                    const color = score < 0.3 ? 'text-green-600' : score < 0.5 ? 'text-yellow-600' : 'text-red-600';
                    return (
                      <span key={pair} className={color}>
                        {cat1} ↔ {cat2}: {score.toFixed(2)}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Cross-avatar ArcFace identity scores in developer mode */}
            {(developerMode || isImpersonating) && character.avatars?.crossArcface && (
              <div className="text-[10px] text-gray-500 bg-blue-50 border border-blue-200 rounded p-2">
                <div className="font-medium mb-1">Cross-Avatar ArcFace ID:</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(character.avatars.crossArcface as Record<string, { similarity: number; samePerson: boolean; confidence: string }>).map(([pair, data]) => {
                    const [cat1, cat2] = pair.split('_vs_');
                    const color = data.samePerson ? 'text-green-600' : 'text-red-600';
                    return (
                      <span key={pair} className={color}>
                        {cat1} ↔ {cat2}: {((data.similarity ?? 0) * 100).toFixed(0)}% ({data.confidence})
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Show input photo that was/will be used for avatar generation */}
            {(developerMode || isImpersonating) && (
              <div className="text-[10px] text-gray-500 bg-orange-50 border border-orange-200 rounded p-2">
                <div className="font-medium mb-1">Input Photo for Generation:</div>
                <div className="flex items-start gap-2">
                  <img
                    src={character.photos?.bodyNoBg || character.photos?.body || character.photos?.face || character.photos?.original}
                    alt="Generation input"
                    className="w-16 h-20 object-contain rounded border border-orange-300"
                    style={{ background: 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 10px 10px' }}
                  />
                  <div>
                    <div className={character.photos?.bodyNoBg ? 'text-green-600 font-bold' : 'text-gray-400'}>
                      bodyNoBg: {character.photos?.bodyNoBg ? `✅ ${Math.round(character.photos.bodyNoBg.length / 1024)}KB` : '❌'}
                    </div>
                    <div className={!character.photos?.bodyNoBg && character.photos?.body ? 'text-yellow-600 font-bold' : 'text-gray-400'}>
                      body: {character.photos?.body ? `${Math.round(character.photos.body.length / 1024)}KB` : '❌'}
                    </div>
                    <div className={!character.photos?.bodyNoBg && !character.photos?.body && character.photos?.face ? 'text-yellow-600 font-bold' : 'text-gray-400'}>
                      face: {character.photos?.face ? `${Math.round(character.photos.face.length / 1024)}KB` : '❌'}
                    </div>
                    <div className="mt-1 text-orange-700 font-bold">
                      Using: {character.photos?.bodyNoBg ? 'bodyNoBg ✅' : character.photos?.body ? 'body ⚠️' : character.photos?.face ? 'face ⚠️' : 'original ❌'}
                    </div>
                  </div>
                </div>
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

      {/* Dynamic Costumed Avatars (developer only - from visual bible costumes) */}
      {(developerMode || isImpersonating) && character.avatars?.costumed && Object.keys(character.avatars.costumed).length > 0 && (
        <div className="bg-orange-50 border border-orange-300 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-orange-700 mb-3 flex items-center gap-2">
            🎭 {language === 'de' ? 'Kostümierte Avatare' : language === 'fr' ? 'Avatars costumés' : 'Costumed Avatars'}
            <span className="text-xs font-normal text-orange-500">
              ({Object.keys(character.avatars.costumed).length} {language === 'de' ? 'Kostüme' : 'costumes'})
            </span>
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {Object.entries(character.avatars.costumed).map(([costumeType, avatarData]) => {
              const imageUrl = typeof avatarData === 'string' ? avatarData : avatarData?.imageData;
              const clothing = typeof avatarData === 'object' ? avatarData?.clothing : undefined;
              return (
                <div key={costumeType} className="text-center">
                  <div className="text-xs font-medium text-orange-600 mb-1 truncate" title={costumeType}>
                    🎭 {costumeType}
                  </div>
                  {imageUrl ? (
                    <div
                      className="relative cursor-pointer group"
                      onClick={() => setLightboxImage(imageUrl)}
                      title={language === 'de' ? 'Klicken zum Vergrössern' : 'Click to enlarge'}
                    >
                      <img
                        src={imageUrl}
                        alt={`${character.name} - ${costumeType}`}
                        className="w-full h-40 object-contain rounded border border-orange-200 bg-white transition-all group-hover:shadow-lg group-hover:scale-[1.02]"
                      />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all rounded flex items-center justify-center">
                        <span className="text-white opacity-0 group-hover:opacity-100 text-lg">🔍</span>
                      </div>
                    </div>
                  ) : (
                    <div className="w-full h-40 rounded border border-dashed border-orange-300 bg-orange-100/50 flex items-center justify-center text-orange-400 text-[10px]">
                      —
                    </div>
                  )}
                  {/* Show clothing description if available */}
                  {clothing && (
                    <div className="mt-1 p-1.5 rounded text-[10px] text-left bg-orange-100 border border-orange-200 text-orange-700">
                      <span className="font-semibold">👕 </span>
                      {clothing}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Styled Avatars (developer only - pre-converted to art styles) */}
      {(developerMode || isImpersonating) && character.avatars?.styledAvatars && Object.keys(character.avatars.styledAvatars).length > 0 && (
        <div className="bg-purple-50 border border-purple-300 rounded-lg p-4">
          <h4 className="text-sm font-semibold text-purple-700 mb-3 flex items-center gap-2">
            🎨 {language === 'de' ? 'Stilisierte Avatare' : language === 'fr' ? 'Avatars stylisés' : 'Styled Avatars'}
            <span className="text-xs font-normal text-purple-500">
              ({Object.keys(character.avatars.styledAvatars).length} {language === 'de' ? 'Stile' : 'styles'})
            </span>
          </h4>
          <div className="space-y-4">
            {Object.entries(character.avatars.styledAvatars).map(([artStyle, avatars]) => {
              const styleLabels: Record<string, { en: string; de: string; emoji: string }> = {
                'pixar': { en: 'Pixar 3D', de: 'Pixar 3D', emoji: '🎬' },
                'watercolor': { en: 'Watercolor', de: 'Aquarell', emoji: '🎨' },
                'comic-book': { en: 'Comic Book', de: 'Comic', emoji: '💥' },
                'anime': { en: 'Anime', de: 'Anime', emoji: '🌸' },
                'oil-painting': { en: 'Oil Painting', de: 'Ölmalerei', emoji: '🖼️' },
                'colored-pencil': { en: 'Colored Pencil', de: 'Buntstift', emoji: '✏️' },
                'storybook': { en: 'Storybook', de: 'Bilderbuch', emoji: '📖' },
              };
              const styleInfo = styleLabels[artStyle] || { en: artStyle, de: artStyle, emoji: '🎭' };
              const clothingOrder = ['standard', 'winter', 'summer', 'formal'] as const;
              const clothingEmojis: Record<string, string> = {
                'standard': '👕',
                'winter': '❄️',
                'summer': '☀️',
                'formal': '👔'
              };

              // Get costumed avatars if they exist
              const costumedAvatars = (avatars as Record<string, unknown>).costumed as Record<string, string> | undefined;
              const costumeTypes = costumedAvatars ? Object.keys(costumedAvatars) : [];

              return (
                <div key={artStyle} className="border border-purple-200 rounded-lg p-3 bg-white">
                  <h5 className="text-xs font-semibold text-purple-600 mb-2">
                    {styleInfo.emoji} {language === 'de' ? styleInfo.de : styleInfo.en}
                  </h5>
                  {/* Standard clothing avatars */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                    {clothingOrder.map((category) => {
                      const avatar = avatars[category];
                      return (
                        <div key={category} className="text-center">
                          <div className="text-[10px] text-gray-500 mb-1">
                            {clothingEmojis[category]} {category}
                          </div>
                          {avatar ? (
                            <img
                              src={avatar}
                              alt={`${character.name} - ${artStyle} - ${category}`}
                              className="w-full h-32 object-contain rounded border border-purple-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                              onClick={() => setLightboxImage(avatar)}
                              title="Click to enlarge"
                            />
                          ) : (
                            <div className="w-full h-32 rounded border border-dashed border-purple-200 bg-purple-50/50 flex items-center justify-center text-purple-300 text-[10px]">
                              —
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* Costumed avatars (from visual bible) */}
                  {costumeTypes.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-purple-200">
                      <div className="text-[10px] font-medium text-orange-600 mb-2">
                        🎭 {language === 'de' ? 'Kostümierte Avatare' : 'Costumed Avatars'}
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                        {costumeTypes.map((costumeType) => {
                          const avatar = costumedAvatars![costumeType];
                          return (
                            <div key={costumeType} className="text-center">
                              <div className="text-[10px] text-orange-500 mb-1 truncate" title={costumeType}>
                                🎭 {costumeType}
                              </div>
                              {avatar ? (
                                <img
                                  src={avatar}
                                  alt={`${character.name} - ${artStyle} - ${costumeType}`}
                                  className="w-full h-32 object-contain rounded border border-orange-200 bg-orange-50/50 cursor-pointer hover:opacity-80 transition-opacity"
                                  onClick={() => setLightboxImage(avatar)}
                                  title="Click to enlarge"
                                />
                              ) : (
                                <div className="w-full h-32 rounded border border-dashed border-orange-200 bg-orange-50/50 flex items-center justify-center text-orange-300 text-[10px]">
                                  —
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Developer Mode: Full API Response (readable, full-width) */}
      {(developerMode || isImpersonating) && character.avatars?.rawEvaluation && (
        <details className="bg-purple-50 border border-purple-300 rounded-lg p-4">
          <summary className="text-sm font-semibold text-purple-700 cursor-pointer flex items-center gap-2">
            <span>📊 Full API Response (Avatar Evaluation)</span>
            <span className="text-xs font-normal text-purple-500">
              Click to expand
            </span>
          </summary>
          <pre className="mt-3 p-4 bg-white rounded-lg text-xs whitespace-pre-wrap overflow-auto max-h-[600px] border border-purple-200 font-mono leading-relaxed">
            {JSON.stringify(character.avatars.rawEvaluation, null, 2)}
          </pre>
        </details>
      )}

      {/* Save/Cancel Buttons */}
      <div className="flex gap-3 max-w-md">
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
            // Also check if avatars are currently being generated (don't start a second generation)
            const hasAvatars = !!(character.avatars?.winter || character.avatars?.standard || character.avatars?.summer || character.avatars?.formal);
            const isCurrentlyGenerating = character.avatars?.status === 'generating';
            if (!hasAvatars && !isCurrentlyGenerating && onSaveAndRegenerateWithTraits) {
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

      {/* Dev Mode: Full Character Data Section - Full Width */}
      {(developerMode || isImpersonating) && (
        <div className="mt-6 pt-6 border-t border-gray-200">
          <h3 className="text-lg font-bold text-gray-800 mb-4 flex items-center gap-2">
            <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded">DEV</span>
            Character Data (Database View)
          </h3>

          {/* Physical Traits Section */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-4">
            <h4 className="font-semibold text-gray-700 mb-3">Physical Traits</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 text-sm">
              <div>
                <span className="text-gray-500 text-xs">Eye Color:</span>
                <div className="font-medium flex items-center gap-1">
                  {character.physical?.eyeColor || '—'}
                  {character.physical?.eyeColorHex && (
                    <span className="inline-block w-4 h-4 rounded border border-gray-300" style={{ backgroundColor: character.physical.eyeColorHex }} title={character.physical.eyeColorHex} />
                  )}
                </div>
                {character.physicalTraitsSource?.eyeColor && (
                  <span className="text-[10px] text-gray-400">[{character.physicalTraitsSource.eyeColor}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Hair Color:</span>
                <div className="font-medium flex items-center gap-1">
                  {character.physical?.hairColor || '—'}
                  {character.physical?.hairColorHex && (
                    <span className="inline-block w-4 h-4 rounded border border-gray-300" style={{ backgroundColor: character.physical.hairColorHex }} title={character.physical.hairColorHex} />
                  )}
                </div>
                {character.physicalTraitsSource?.hairColor && (
                  <span className="text-[10px] text-gray-400">[{character.physicalTraitsSource.hairColor}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Hair Length:</span>
                <div className="font-medium">{character.physical?.hairLength || '—'}</div>
                {character.physicalTraitsSource?.hairLength && (
                  <span className="text-[10px] text-gray-400">[{character.physicalTraitsSource.hairLength}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Hair Style:</span>
                <div className="font-medium">{character.physical?.hairStyle || '—'}</div>
                {character.physicalTraitsSource?.hairStyle && (
                  <span className="text-[10px] text-gray-400">[{character.physicalTraitsSource.hairStyle}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Build:</span>
                <div className="font-medium">{character.physical?.build || '—'}</div>
                {character.physicalTraitsSource?.build && (
                  <span className="text-[10px] text-gray-400">[{character.physicalTraitsSource.build}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Facial Hair:</span>
                <div className="font-medium">{character.physical?.facialHair || '—'}</div>
                {character.physicalTraitsSource?.facialHair && (
                  <span className="text-[10px] text-gray-400">[{character.physicalTraitsSource.facialHair}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Skin Tone:</span>
                <div className="font-medium">{character.physical?.skinTone || '—'}</div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">Other:</span>
                <div className="font-medium">{character.physical?.other || '—'}</div>
                {character.physicalTraitsSource?.other && (
                  <span className="text-[10px] text-gray-400">[{character.physicalTraitsSource.other}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Height:</span>
                <div className="font-medium">{character.physical?.height || '—'}</div>
              </div>
              <div>
                <span className="text-gray-500 text-xs">Apparent Age:</span>
                <div className="font-medium">{character.physical?.apparentAge || '—'}</div>
              </div>
            </div>

            {/* Detailed Hair Analysis - Full width */}
            {character.physical?.detailedHairAnalysis && (
              <div className="mt-4 pt-3 border-t border-gray-200">
                <span className="text-gray-500 text-xs block mb-1">Detailed Hair Analysis:</span>
                <p className="text-sm bg-white border border-gray-200 rounded p-2 italic text-gray-700">
                  {typeof character.physical.detailedHairAnalysis === 'object'
                    ? JSON.stringify(character.physical.detailedHairAnalysis, null, 2)
                    : character.physical.detailedHairAnalysis}
                </p>
              </div>
            )}
          </div>

          {/* Clothing Section */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <h4 className="font-semibold text-gray-700 mb-3">Clothing</h4>

            {/* Structured Clothing */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
              <div>
                <span className="text-gray-500 text-xs">Upper Body:</span>
                <div className="font-medium">{character.clothing?.structured?.upperBody || '—'}</div>
                {character.clothingSource?.upperBody && (
                  <span className="text-[10px] text-gray-400">[{character.clothingSource.upperBody}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Lower Body:</span>
                <div className="font-medium">{character.clothing?.structured?.lowerBody || '—'}</div>
                {character.clothingSource?.lowerBody && (
                  <span className="text-[10px] text-gray-400">[{character.clothingSource.lowerBody}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Shoes:</span>
                <div className="font-medium">{character.clothing?.structured?.shoes || '—'}</div>
                {character.clothingSource?.shoes && (
                  <span className="text-[10px] text-gray-400">[{character.clothingSource.shoes}]</span>
                )}
              </div>
              <div>
                <span className="text-gray-500 text-xs">Full Body:</span>
                <div className="font-medium">{character.clothing?.structured?.fullBody || '—'}</div>
                {character.clothingSource?.fullBody && (
                  <span className="text-[10px] text-gray-400">[{character.clothingSource.fullBody}]</span>
                )}
              </div>
            </div>

            {/* Legacy clothing if exists */}
            {character.clothing?.current && (
              <div className="mb-4">
                <span className="text-gray-500 text-xs block mb-1">Legacy (current):</span>
                <div className="text-sm font-medium">{character.clothing.current}</div>
              </div>
            )}

            {/* Avatar Extracted Clothing */}
            {character.avatars?.clothing && Object.keys(character.avatars.clothing).length > 0 && (
              <div className="pt-3 border-t border-gray-200">
                <span className="text-gray-500 text-xs block mb-2">Avatar Extracted Clothing:</span>
                <div className="space-y-1 text-sm">
                  {Object.entries(character.avatars.clothing).map(([category, description]) => (
                    <div key={category} className="flex gap-2">
                      <span className="text-gray-500 capitalize w-20">{category}:</span>
                      <span className="text-gray-700">{description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Lightbox for enlarged styled avatars */}
      <ImageLightbox
        src={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />

      {/* Full-page modal for Modify Avatar */}
      {isModifyingAvatar && (
        <div className="fixed inset-0 z-50 bg-white flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50">
            <h2 className="text-lg font-semibold text-gray-800">
              {language === 'de' ? 'Aussehen anpassen' : language === 'fr' ? 'Modifier l\'apparence' : 'Modify Look'}
            </h2>
            <button
              onClick={() => setIsModifyingAvatar(false)}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-200 rounded-full transition-colors"
            >
              <X size={20} />
            </button>
          </div>

          {/* Content - Responsive: side by side on wide screens, stacked on mobile */}
          <div className="flex-1 overflow-auto p-4">
            <div className="max-w-4xl mx-auto">
              <div className="flex flex-col md:flex-row gap-6">
                {/* Left side (or top on mobile): Avatar preview */}
                <div className="flex-shrink-0 flex justify-center md:justify-start">
                  {(character.avatars?.faceThumbnails?.standard || character.avatars?.standard) ? (
                    <img
                      src={character.avatars?.faceThumbnails?.standard || character.avatars?.standard}
                      alt={`${character.name} avatar`}
                      className="w-48 h-64 object-contain rounded-lg border-2 border-indigo-300 bg-white shadow-lg"
                    />
                  ) : (
                    <div className="w-48 h-64 rounded-lg border-2 border-dashed border-gray-300 bg-gray-100 flex items-center justify-center">
                      <span className="text-gray-400 text-sm">
                        {language === 'de' ? 'Kein Bild' : 'No image'}
                      </span>
                    </div>
                  )}
                </div>

                {/* Right side (or bottom on mobile): Form fields */}
                <div className="flex-1 space-y-4">
                  {/* Physical traits - FIRST */}
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">
                      {language === 'de' ? 'Physische Merkmale' : language === 'fr' ? 'Caractéristiques physiques' : 'Physical Features'}
                    </h3>
                    <PhysicalTraitsGrid
                      character={character}
                      language={language}
                      updatePhysical={updatePhysical}
                      updateApparentAge={(v) => updatePhysical('apparentAge', v)}
                    />
                  </div>

                  {/* Clothing - SECOND - Structured inputs */}
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">
                      {language === 'de' ? 'Kleidung' : language === 'fr' ? 'Vêtements' : 'Clothing'}
                    </h3>
                    <div className="space-y-3">
                      {/* Full body option (dress, jumpsuit) - shown first for females */}
                      {character.gender === 'female' && (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-1">
                            {language === 'de' ? 'Kleid / Overall' : language === 'fr' ? 'Robe / Combinaison' : 'Dress / Jumpsuit'}
                          </label>
                          <input
                            type="text"
                            value={character.clothing?.structured?.fullBody || ''}
                            onChange={(e) => onChange({
                              ...character,
                              clothing: {
                                ...character.clothing,
                                structured: {
                                  ...character.clothing?.structured,
                                  fullBody: e.target.value,
                                  // Clear upper/lower if full body is entered
                                  ...(e.target.value ? { upperBody: '', lowerBody: '' } : {}),
                                },
                              },
                              // Mark clothing as user-edited
                              clothingSource: {
                                ...character.clothingSource,
                                fullBody: 'user' as const,
                                // Clear upper/lower source if full body is entered
                                ...(e.target.value ? { upperBody: undefined, lowerBody: undefined } : {}),
                              },
                            })}
                            placeholder={language === 'de' ? 'z.B. rotes Sommerkleid' : language === 'fr' ? 'ex. robe d\'été rouge' : 'e.g. red summer dress'}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none"
                          />
                        </div>
                      )}

                      {/* Upper body - disabled if full body is entered */}
                      <div className={character.clothing?.structured?.fullBody ? 'opacity-50' : ''}>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          {language === 'de' ? 'Oberteil' : language === 'fr' ? 'Haut' : 'Upper Body'}
                        </label>
                        <input
                          type="text"
                          value={character.clothing?.structured?.upperBody || ''}
                          onChange={(e) => onChange({
                            ...character,
                            clothing: {
                              ...character.clothing,
                              structured: {
                                ...character.clothing?.structured,
                                upperBody: e.target.value,
                              },
                            },
                            // Mark clothing as user-edited
                            clothingSource: {
                              ...character.clothingSource,
                              upperBody: 'user' as const,
                            },
                          })}
                          disabled={!!character.clothing?.structured?.fullBody}
                          placeholder={language === 'de' ? 'z.B. blaues T-Shirt' : language === 'fr' ? 'ex. t-shirt bleu' : 'e.g. blue t-shirt'}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none disabled:bg-gray-100 disabled:cursor-not-allowed"
                        />
                      </div>

                      {/* Lower body - disabled if full body is entered */}
                      <div className={character.clothing?.structured?.fullBody ? 'opacity-50' : ''}>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          {language === 'de' ? 'Unterteil' : language === 'fr' ? 'Bas' : 'Lower Body'}
                        </label>
                        <input
                          type="text"
                          value={character.clothing?.structured?.lowerBody || ''}
                          onChange={(e) => onChange({
                            ...character,
                            clothing: {
                              ...character.clothing,
                              structured: {
                                ...character.clothing?.structured,
                                lowerBody: e.target.value,
                              },
                            },
                            // Mark clothing as user-edited
                            clothingSource: {
                              ...character.clothingSource,
                              lowerBody: 'user' as const,
                            },
                          })}
                          disabled={!!character.clothing?.structured?.fullBody}
                          placeholder={language === 'de' ? 'z.B. dunkle Jeans' : language === 'fr' ? 'ex. jeans foncé' : 'e.g. dark jeans'}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none disabled:bg-gray-100 disabled:cursor-not-allowed"
                        />
                      </div>

                      {/* Shoes */}
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">
                          {language === 'de' ? 'Schuhe' : language === 'fr' ? 'Chaussures' : 'Shoes'}
                        </label>
                        <input
                          type="text"
                          value={character.clothing?.structured?.shoes || ''}
                          onChange={(e) => onChange({
                            ...character,
                            clothing: {
                              ...character.clothing,
                              structured: {
                                ...character.clothing?.structured,
                                shoes: e.target.value,
                              },
                            },
                            // Mark clothing as user-edited
                            clothingSource: {
                              ...character.clothingSource,
                              shoes: 'user' as const,
                            },
                          })}
                          placeholder={language === 'de' ? 'z.B. weiße Turnschuhe' : language === 'fr' ? 'ex. baskets blanches' : 'e.g. white sneakers'}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-base focus:border-indigo-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer with buttons */}
          <div className="px-4 py-3 border-t border-gray-200 bg-gray-50">
            <div className="max-w-4xl mx-auto flex gap-3">
              <button
                onClick={() => setIsModifyingAvatar(false)}
                className="flex-1 px-4 py-3 text-sm font-medium bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              <button
                onClick={() => {
                  setIsModifyingAvatar(false);
                  recordRegeneration();
                  // For new characters, use save+regenerate; for existing, just regenerate
                  if (isNewCharacter && onSaveAndRegenerateWithTraits) {
                    onSaveAndRegenerateWithTraits();
                  } else if (onRegenerateAvatarsWithTraits) {
                    onRegenerateAvatarsWithTraits();
                  }
                }}
                disabled={isRegeneratingAvatarsWithTraits || character.avatars?.status === 'generating' || (!developerMode && !isImpersonating && !canRegenerate)}
                className="flex-1 px-4 py-3 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                title={!developerMode && !isImpersonating && !canRegenerate ? (language === 'de' ? `Warten Sie ${waitSeconds}s` : `Wait ${waitSeconds}s`) : undefined}
              >
                {isRegeneratingAvatarsWithTraits ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    {language === 'de' ? 'Generiere...' : 'Generating...'}
                  </>
                ) : !developerMode && !isImpersonating && !canRegenerate ? (
                  <>
                    <Save size={16} />
                    {language === 'de' ? `Warten (${waitSeconds}s)` : `Wait (${waitSeconds}s)`}
                  </>
                ) : (
                  <>
                    <Save size={16} />
                    {language === 'de' ? 'Speichern & Neu generieren' : language === 'fr' ? 'Enregistrer et régénérer' : 'Save & Regenerate'}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clothing Choice Modal - shown when changing photo for character with existing clothing */}
      {showClothingChoiceModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <h3 className="text-xl font-bold text-gray-800 mb-4">
              {language === 'de' ? 'Kleidung für neues Foto' : language === 'fr' ? 'Vêtements pour la nouvelle photo' : 'Clothing for New Photo'}
            </h3>
            <p className="text-gray-600 mb-6">
              {language === 'de'
                ? 'Möchten Sie die aktuelle Kleidung beibehalten oder die Kleidung aus dem neuen Foto verwenden?'
                : language === 'fr'
                  ? 'Voulez-vous garder les vêtements actuels ou utiliser ceux de la nouvelle photo?'
                  : 'Do you want to keep the current clothing or use the clothing from the new photo?'}
            </p>

            {/* Current clothing preview */}
            {character.clothing?.structured && (
              <div className="bg-gray-50 rounded-lg p-3 mb-4 text-sm">
                <div className="font-medium text-gray-700 mb-1">
                  {language === 'de' ? 'Aktuelle Kleidung:' : language === 'fr' ? 'Vêtements actuels:' : 'Current clothing:'}
                </div>
                <div className="text-gray-600 space-y-0.5">
                  {character.clothing.structured.upperBody && (
                    <div>{language === 'de' ? 'Oberteil' : 'Top'}: {character.clothing.structured.upperBody}</div>
                  )}
                  {character.clothing.structured.lowerBody && (
                    <div>{language === 'de' ? 'Unterteil' : 'Bottom'}: {character.clothing.structured.lowerBody}</div>
                  )}
                  {character.clothing.structured.shoes && (
                    <div>{language === 'de' ? 'Schuhe' : 'Shoes'}: {character.clothing.structured.shoes}</div>
                  )}
                  {character.clothing.structured.fullBody && (
                    <div>{language === 'de' ? 'Ganzkörper' : 'Full outfit'}: {character.clothing.structured.fullBody}</div>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-3">
              {/* Use new photo's clothing - DEFAULT */}
              <button
                onClick={() => handleClothingChoice(false)}
                className="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-colors flex items-center justify-center gap-2"
              >
                {language === 'de' ? 'Kleidung aus neuem Foto verwenden' : language === 'fr' ? 'Utiliser les vêtements de la nouvelle photo' : 'Use clothing from new photo'}
                <span className="text-xs bg-indigo-500 px-2 py-0.5 rounded">
                  {language === 'de' ? 'Empfohlen' : language === 'fr' ? 'Recommandé' : 'Default'}
                </span>
              </button>

              {/* Keep old clothing */}
              <button
                onClick={() => handleClothingChoice(true)}
                className="w-full px-4 py-3 bg-gray-100 text-gray-700 rounded-xl font-semibold hover:bg-gray-200 transition-colors"
              >
                {language === 'de' ? 'Aktuelle Kleidung beibehalten' : language === 'fr' ? 'Garder les vêtements actuels' : 'Keep current clothing'}
              </button>

              {/* Cancel */}
              <button
                onClick={() => {
                  setShowClothingChoiceModal(false);
                  setPendingPhotoFile(null);
                }}
                className="w-full px-4 py-2 text-gray-500 hover:text-gray-700 text-sm transition-colors"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Avatar Options Selection Modal */}
      {avatarOptions && avatarOptions.length > 0 && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full p-6">
            <h3 className="text-xl font-bold text-gray-800 mb-2">
              {language === 'de' ? 'Wähle deinen Avatar' : 'Choose Your Avatar'}
            </h3>
            <p className="text-gray-600 mb-4 text-sm">
              {language === 'de'
                ? 'Klicke auf das Bild, das dir am besten gefällt'
                : 'Click on the image you like best'}
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4 mb-6">
              {avatarOptions.map((option) => (
                <div
                  key={option.id}
                  onClick={() => setSelectedOptionId(option.id)}
                  className={`cursor-pointer rounded-xl overflow-hidden border-4 transition-all ${
                    selectedOptionId === option.id
                      ? 'border-indigo-500 shadow-lg scale-[1.02]'
                      : 'border-transparent hover:border-gray-300'
                  }`}
                >
                  <img
                    src={option.imageData}
                    alt={`Option ${option.id + 1}`}
                    className="w-full aspect-[9/16] object-cover"
                  />
                  <div className={`text-center py-2 text-sm font-medium ${
                    selectedOptionId === option.id ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-700'
                  }`}>
                    Option {option.id + 1}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleSaveSelectedAvatar}
                disabled={selectedOptionId === null}
                className="flex-1 px-4 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {language === 'de' ? 'Auswahl verwenden' : 'Use Selected'}
              </button>
              <button
                onClick={() => {
                  setAvatarOptions(null);
                  setSelectedOptionId(null);
                }}
                className="px-4 py-3 text-gray-600 hover:text-gray-800 transition-colors"
              >
                {language === 'de' ? 'Abbrechen' : 'Cancel'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CharacterForm;
