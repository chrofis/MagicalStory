import { Heart, ArrowLeftRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { relationshipTypes, getNotKnownRelationship, isNotKnownRelationship, findInverseRelationship } from '@/constants/relationships';
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { Language } from '@/types/story';

interface CharacterRelationshipsProps {
  character: Character;
  allCharacters: Character[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  onRelationshipChange: (char1Id: number, char2Id: number, value: string) => void;
  onRelationshipTextChange: (key: string, text: string) => void;
  customRelationships?: string[];
  onAddCustomRelationship?: (relationship: string) => void;
}

/**
 * CharacterRelationships - Shows and edits relationships for a single character
 * Displays both forward and inverse relationships with shared comments
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
      value: { en: rel, de: rel, fr: rel },
      inverse: { en: rel, de: rel, fr: rel },
    })),
  ];

  const handleSelectChange = (char1Id: number, char2Id: number, value: string) => {
    if (value === '__CREATE_CUSTOM__') {
      const customRel = prompt(
        language === 'de'
          ? 'Beziehung eingeben:'
          : language === 'fr'
          ? 'Entrer la relation:'
          : 'Enter relationship:'
      );
      if (customRel && customRel.trim()) {
        onAddCustomRelationship?.(customRel.trim());
        onRelationshipChange(char1Id, char2Id, customRel.trim());
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
    noRelationships: language === 'de' ? 'Erstelle weitere Figuren um Beziehungen zu definieren' : language === 'fr' ? 'Créez d\'autres personnages pour définir les relations' : 'Create more characters to define relationships',
    detailsPlaceholder: language === 'de' ? 'Details zur Beziehung...' : language === 'fr' ? 'Détails de la relation...' : 'Relationship details...',
    isOf: language === 'de' ? 'ist' : language === 'fr' ? 'est' : 'is',
    of: language === 'de' ? 'von' : language === 'fr' ? 'de' : 'of',
  };

  return (
    <div className="space-y-3">
      <h3 className="text-lg font-semibold text-indigo-700 flex items-center gap-2">
        <Heart size={18} /> {translations.relationships}
      </h3>

      <div className="space-y-3">
        {otherCharacters.map((otherChar) => {
          // Forward key: current -> other
          const forwardKey = `${character.id}-${otherChar.id}`;
          // Inverse key: other -> current
          const inverseKey = `${otherChar.id}-${character.id}`;

          // Get current relationship values
          const forwardRelationship = relationships[forwardKey];
          const inverseRelationship = relationships[inverseKey];

          // Determine if relationship is defined
          const isForwardDefined = forwardRelationship && !isNotKnownRelationship(forwardRelationship);
          const isInverseDefined = inverseRelationship && !isNotKnownRelationship(inverseRelationship);
          const isAnyDefined = isForwardDefined || isInverseDefined;

          // Compute expected inverse for display
          const expectedInverse = forwardRelationship ? findInverseRelationship(forwardRelationship, lang) : null;

          // Use canonical key for shared comment
          const commentKey = getCommentKey(character.id, otherChar.id);
          const sharedComment = relationshipTexts[commentKey] || '';

          // Get photo for other character
          const otherPhoto = otherChar.photos?.face || otherChar.photos?.original;

          return (
            <div
              key={otherChar.id}
              className={`rounded-lg p-3 ${
                isAnyDefined
                  ? 'bg-blue-50 border-2 border-blue-300'
                  : 'bg-white border-2 border-red-300'
              }`}
            >
              {/* Header with other character photo and name */}
              <div className="flex items-center gap-3 mb-2">
                {otherPhoto && (
                  <img
                    src={otherPhoto}
                    alt={otherChar.name}
                    className="w-10 h-10 rounded-full object-cover border-2 border-gray-200"
                  />
                )}
                <span className="font-semibold text-gray-800">{otherChar.name}</span>
              </div>

              {/* Forward relationship: Current character -> Other character */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm text-gray-600 flex-shrink-0">{character.name}</span>
                <select
                  value={forwardRelationship || getNotKnownRelationship(lang)}
                  onChange={(e) => handleSelectChange(character.id, otherChar.id, e.target.value)}
                  className={`flex-1 px-2 py-1.5 border rounded text-sm font-medium ${
                    isForwardDefined
                      ? 'bg-blue-100 border-blue-400'
                      : 'bg-white border-red-400'
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
                <span className="text-sm text-gray-600 flex-shrink-0">{otherChar.name}</span>
              </div>

              {/* Inverse relationship display with swap icon */}
              {isForwardDefined && expectedInverse && (
                <div className="flex items-center gap-2 mb-2 pl-2 border-l-2 border-blue-200">
                  <ArrowLeftRight size={14} className="text-blue-400 flex-shrink-0" />
                  <span className="text-xs text-gray-500">
                    {otherChar.name} <span className="font-medium text-blue-600">{expectedInverse}</span> {character.name}
                  </span>
                </div>
              )}

              {/* Shared comment field */}
              {isAnyDefined && (
                <input
                  type="text"
                  value={sharedComment}
                  onChange={(e) => {
                    // Update both keys with the same comment
                    onRelationshipTextChange(forwardKey, e.target.value);
                    onRelationshipTextChange(inverseKey, e.target.value);
                  }}
                  placeholder={translations.detailsPlaceholder}
                  className="w-full px-3 py-1.5 border border-blue-300 rounded text-sm bg-white"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default CharacterRelationships;
