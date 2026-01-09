import { ArrowLeftRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { relationshipTypes, getNotKnownRelationship, isNotKnownRelationship, findInverseRelationship, type CustomRelationshipPair } from '@/constants/relationships';
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { Language } from '@/types/story';

interface CharacterRelationshipsProps {
  character: Character;
  allCharacters: Character[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  onRelationshipChange: (char1Id: number, char2Id: number, value: string) => void;
  onRelationshipTextChange: (key: string, text: string) => void;
  customRelationships?: CustomRelationshipPair[];
  onAddCustomRelationship?: (forward: string, inverse: string) => void;
}

/**
 * CharacterRelationships - Shows and edits relationships for a single character
 * Displays both forward and inverse relationships with shared comments
 * Layout matches the original RelationshipEditor with photos on both sides
 */
export function CharacterRelationships({
  character,
  allCharacters,
  relationships,
  relationshipTexts,
  onRelationshipChange,
  onRelationshipTextChange,
  customRelationships = [],
  onAddCustomRelationship,
}: CharacterRelationshipsProps) {
  const { language } = useLanguage();
  const lang = language as Language;

  // Get other characters (excluding current)
  const otherCharacters = allCharacters.filter(c => c.id !== character.id);

  // If no other characters, show empty state
  if (otherCharacters.length === 0) {
    return null;
  }

  // Combine default and custom relationships
  const allRelationshipTypes = [
    ...relationshipTypes,
    ...customRelationships.map((rel) => ({
      value: { en: rel.forward, de: rel.forward, fr: rel.forward },
      inverse: { en: rel.inverse, de: rel.inverse, fr: rel.inverse },
    })),
  ];

  const handleSelectChange = (char1Id: number, char2Id: number, value: string) => {
    if (value === '__CREATE_CUSTOM__') {
      // Prompt for the forward relationship
      const customRel = prompt(
        language === 'de'
          ? 'Beziehung eingeben (z.B. "Onkel"):'
          : language === 'fr'
          ? 'Entrer la relation (ex. "oncle"):'
          : 'Enter relationship (e.g. "uncle"):'
      );
      if (customRel && customRel.trim()) {
        // Prompt for the inverse relationship
        const inverseRel = prompt(
          language === 'de'
            ? `Was ist die umgekehrte Beziehung? (z.B. wenn "${customRel.trim()}" dann vielleicht "Neffe/Nichte"):`
            : language === 'fr'
            ? `Quelle est la relation inverse? (ex. si "${customRel.trim()}" alors peut-être "neveu/nièce"):`
            : `What is the inverse relationship? (e.g. if "${customRel.trim()}" then maybe "nephew/niece"):`
        );
        if (inverseRel && inverseRel.trim()) {
          onAddCustomRelationship?.(customRel.trim(), inverseRel.trim());
          onRelationshipChange(char1Id, char2Id, customRel.trim());
        }
      }
    } else {
      onRelationshipChange(char1Id, char2Id, value);
    }
  };

  // Get canonical key for shared comment (always use smaller id first)
  const getCommentKey = (id1: number, id2: number) => {
    return id1 < id2 ? `${id1}-${id2}` : `${id2}-${id1}`;
  };

  const translations = {
    relationships: language === 'de' ? 'Beziehungen' : language === 'fr' ? 'Relations' : 'Relationships',
    detailsPlaceholder: language === 'de' ? 'Details...' : language === 'fr' ? 'Détails...' : 'Details...',
  };

  // Get photo for current character (prefer AI-extracted face thumbnail from avatars)
  const currentPhoto = character.avatars?.faceThumbnails?.standard || character.photos?.face || character.photos?.original;

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-gray-800">
        {translations.relationships}
      </h3>

      <div className="space-y-3">
        {otherCharacters.map((otherChar) => {
          // Forward key: current -> other
          const forwardKey = `${character.id}-${otherChar.id}`;
          // Inverse key: other -> current
          const inverseKey = `${otherChar.id}-${character.id}`;

          // Get current relationship values
          const forwardRelationship = relationships[forwardKey];

          // Determine if relationship is defined
          const isForwardDefined = forwardRelationship && !isNotKnownRelationship(forwardRelationship);

          // Compute expected inverse for display (including custom relationships)
          const expectedInverse = forwardRelationship ? findInverseRelationship(forwardRelationship, lang, customRelationships) : null;

          // Use canonical key for shared comment
          const commentKey = getCommentKey(character.id, otherChar.id);
          const sharedComment = relationshipTexts[commentKey] || '';

          // Get photo for other character (prefer AI-extracted face thumbnail from avatars)
          const otherPhoto = otherChar.avatars?.faceThumbnails?.standard || otherChar.photos?.face || otherChar.photos?.original;

          return (
            <div
              key={otherChar.id}
              className={`rounded-lg p-3 md:p-4 w-full ${
                isForwardDefined
                  ? 'bg-blue-50 border-2 border-blue-300'
                  : 'bg-white border-[3px] border-red-500'
              }`}
            >
              {/* Layout: Character photos on sides, dropdown fills center */}
              <div className="flex items-center gap-3 md:gap-4 w-full">
                {/* Current Character - Left side */}
                <div className="flex flex-col items-center gap-1 flex-shrink-0">
                  {currentPhoto && (
                    <img
                      src={currentPhoto}
                      alt={character.name}
                      className="w-12 h-12 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-full object-cover"
                    />
                  )}
                  <span className="font-semibold text-xs md:text-sm text-center max-w-[60px] sm:max-w-[80px] md:max-w-[100px] truncate">
                    {character.name}
                  </span>
                </div>

                {/* Center: Dropdown + Details - fills all available space */}
                <div className="flex-1 flex flex-col items-center gap-1">
                  <select
                    value={forwardRelationship || getNotKnownRelationship(lang)}
                    onChange={(e) => handleSelectChange(character.id, otherChar.id, e.target.value)}
                    className={`w-full px-3 py-2 md:px-4 md:py-2.5 border rounded text-sm md:text-base font-medium text-center ${
                      isForwardDefined
                        ? 'bg-blue-100 border-blue-400'
                        : 'bg-white border-red-400 border-2'
                    }`}
                  >
                    <option value="__CREATE_CUSTOM__">
                      + {lang === 'de' ? 'Eigene' : lang === 'fr' ? 'Personnalisé' : 'Custom'}
                    </option>
                    {allRelationshipTypes.map((type, idx) => (
                      <option key={idx} value={type.value[lang]}>
                        {type.value[lang]}
                      </option>
                    ))}
                  </select>

                  {/* Inverse relationship display */}
                  {isForwardDefined && expectedInverse && (
                    <div className="flex items-center gap-1 text-xs text-gray-500">
                      <ArrowLeftRight size={12} className="text-blue-400" />
                      <span>{otherChar.name}</span>
                      <span className="font-medium text-blue-600">{expectedInverse}</span>
                      <span>{character.name}</span>
                    </div>
                  )}

                  {/* Details input below dropdown */}
                  {isForwardDefined && (
                    <input
                      type="text"
                      value={sharedComment}
                      onChange={(e) => {
                        // Update both keys with the same comment
                        onRelationshipTextChange(forwardKey, e.target.value);
                        onRelationshipTextChange(inverseKey, e.target.value);
                      }}
                      placeholder={translations.detailsPlaceholder}
                      className="w-full px-3 py-1.5 md:px-4 md:py-2 border border-blue-300 rounded text-xs md:text-sm text-center bg-white"
                    />
                  )}
                </div>

                {/* Other Character - Right side */}
                <div className="flex flex-col items-center gap-1 flex-shrink-0">
                  {otherPhoto && (
                    <img
                      src={otherPhoto}
                      alt={otherChar.name}
                      className="w-12 h-12 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-full object-cover"
                    />
                  )}
                  <span className="font-semibold text-xs md:text-sm text-center max-w-[60px] sm:max-w-[80px] md:max-w-[100px] truncate">
                    {otherChar.name}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default CharacterRelationships;
