import { RelationshipEditor } from '@/components/story';
import type { Character, RelationshipMap, RelationshipTextMap } from '@/types/character';

interface WizardStep3Props {
  characters: Character[];
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  customRelationships: string[];
  onRelationshipChange: (char1Id: number, char2Id: number, value: string) => void;
  onRelationshipTextChange: (key: string, text: string) => void;
  onAddCustomRelationship: (relationship: string) => void;
}

/**
 * Step 3: Relationships
 * Handles defining relationships between characters
 */
export function WizardStep3Relationships({
  characters,
  relationships,
  relationshipTexts,
  customRelationships,
  onRelationshipChange,
  onRelationshipTextChange,
  onAddCustomRelationship,
}: WizardStep3Props) {
  return (
    <RelationshipEditor
      characters={characters}
      relationships={relationships}
      relationshipTexts={relationshipTexts}
      onRelationshipChange={onRelationshipChange}
      onRelationshipTextChange={onRelationshipTextChange}
      customRelationships={customRelationships}
      onAddCustomRelationship={onAddCustomRelationship}
    />
  );
}
