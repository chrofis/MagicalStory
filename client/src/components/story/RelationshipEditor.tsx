import { Heart } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { relationshipTypes, getNotKnownRelationship, isNotKnownRelationship } from '@/constants/relationships';
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { Language } from '@/types/story';

interface RelationshipEditorProps {
  characters: Character[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  onRelationshipChange: (char1Id: number, char2Id: number, value: string) => void;
  onRelationshipTextChange: (key: string, text: string) => void;
  customRelationships?: string[];
  onAddCustomRelationship?: (relationship: string) => void;
}

export function RelationshipEditor({
  characters,
  relationships,
  relationshipTexts,
  onRelationshipChange,
  onRelationshipTextChange,
  customRelationships = [],
  onAddCustomRelationship,
}: RelationshipEditorProps) {
  const { t, language } = useLanguage();
  const lang = language as Language;

  // Combine default and custom relationships
  const allRelationships = [
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

  return (
    <div className="space-y-4">
      <h2 className="text-2xl md:text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Heart size={24} /> {t.defineRelationships}
      </h2>
      <p className="text-sm text-gray-500">{t.defineRelationshipsDesc}</p>

      <div className="grid gap-3 md:gap-4">
        {characters.map((char1, i) =>
          characters.map((char2, j) => {
            if (i >= j) return null;
            const key = `${char1.id}-${char2.id}`;
            const currentRelationship = relationships[key];
            const isNotKnown = !currentRelationship || isNotKnownRelationship(currentRelationship);

            return (
              <div
                key={key}
                className={`rounded-lg p-3 md:p-4 ${
                  isNotKnown
                    ? 'bg-white border-red-500 border-[3px]'
                    : 'bg-blue-50 border-blue-300 border-2'
                }`}
              >
                {/* Layout: Character photos on sides, dropdown + details in center */}
                <div className="flex items-center justify-center gap-2 sm:gap-4 md:gap-6 lg:gap-8">
                  {/* Character 1 - Left side */}
                  <div className="flex flex-col items-center gap-1 flex-shrink-0">
                    {(char1.thumbnailUrl || char1.photoUrl) && (
                      <img
                        src={char1.thumbnailUrl || char1.photoUrl}
                        alt={char1.name}
                        className="w-12 h-12 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-full object-cover"
                      />
                    )}
                    <span className="font-semibold text-xs md:text-sm text-center max-w-[60px] sm:max-w-[80px] md:max-w-[100px] truncate">
                      {char1.name}
                    </span>
                  </div>

                  {/* Center: Dropdown + Details stacked - grows to fill available space */}
                  <div className="flex-1 flex flex-col items-center gap-1 min-w-0 max-w-[200px] sm:max-w-[300px] md:max-w-[400px] lg:max-w-[600px] xl:max-w-[800px]">
                    <select
                      value={currentRelationship || getNotKnownRelationship(lang)}
                      onChange={(e) => handleSelectChange(char1.id, char2.id, e.target.value)}
                      className={`w-full px-2 py-1.5 md:px-3 md:py-2 border rounded text-sm md:text-base font-medium text-center ${
                        isNotKnown
                          ? 'bg-white border-red-400 border-2'
                          : 'bg-blue-100 border-blue-400'
                      }`}
                    >
                      <option value="__CREATE_CUSTOM__">
                        + {lang === 'de' ? 'Eigene' : lang === 'fr' ? 'Personnalisé' : 'Custom'}
                      </option>
                      {allRelationships.map((type, idx) => (
                        <option key={idx} value={type.value[lang]}>
                          {type.value[lang]}
                        </option>
                      ))}
                    </select>

                    {/* Details input below dropdown */}
                    {!isNotKnown && (
                      <input
                        type="text"
                        value={relationshipTexts[key] || ''}
                        onChange={(e) => onRelationshipTextChange(key, e.target.value)}
                        placeholder={lang === 'de' ? 'Details...' : lang === 'fr' ? 'Détails...' : 'Details...'}
                        className="w-full px-2 py-1 md:px-3 md:py-1.5 border border-blue-300 rounded text-xs md:text-sm text-center bg-white"
                      />
                    )}
                  </div>

                  {/* Character 2 - Right side */}
                  <div className="flex flex-col items-center gap-1 flex-shrink-0">
                    {(char2.thumbnailUrl || char2.photoUrl) && (
                      <img
                        src={char2.thumbnailUrl || char2.photoUrl}
                        alt={char2.name}
                        className="w-12 h-12 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-full object-cover"
                      />
                    )}
                    <span className="font-semibold text-xs md:text-sm text-center max-w-[60px] sm:max-w-[80px] md:max-w-[100px] truncate">
                      {char2.name}
                    </span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default RelationshipEditor;
