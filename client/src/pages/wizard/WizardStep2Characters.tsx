import { Users, Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common';
import { CharacterList, CharacterForm, PhotoUpload } from '@/components/character';
import type { Character, ChangedTraits, RelationshipMap, RelationshipTextMap } from '@/types/character';

// Character role in story
type CharacterRole = 'out' | 'in' | 'main';

interface WizardStep2Props {
  characters: Character[];
  currentCharacter: Character | null;
  characterStep: 'photo' | 'name' | 'traits';
  showCharacterCreated: boolean;
  isLoading: boolean;
  isAnalyzingPhoto: boolean;
  isGeneratingAvatar: boolean;  // Background avatar generation
  isRegeneratingAvatars: boolean;
  isRegeneratingAvatarsWithTraits: boolean;
  developerMode: boolean;
  changedTraits?: ChangedTraits;  // Which traits changed from previous photo
  photoAnalysisDebug?: { rawResponse?: string; error?: string };  // Debug info for dev mode
  // Character role selection
  mainCharacters: number[];
  excludedCharacters: number[];
  onCharacterRoleChange: (charId: number, role: CharacterRole) => void;
  onCharacterChange: (character: Character | null) => void;
  onCharacterStepChange: (step: 'photo' | 'name' | 'traits') => void;
  onPhotoSelect: (file: File) => void;
  onSaveAndGenerateAvatar: () => void;  // Save traits and trigger avatar generation
  onSaveCharacter: () => void;
  onEditCharacter: (character: Character) => void;
  onDeleteCharacter: (id: number) => void;
  onStartNewCharacter: () => void;
  onRegenerateAvatars: () => void;
  onRegenerateAvatarsWithTraits: () => void;
  onSaveAndRegenerateWithTraits: () => void;  // Combined save + regenerate with traits
  // Relationship props
  relationships: RelationshipMap;
  relationshipTexts: RelationshipTextMap;
  onRelationshipChange: (char1Id: number, char2Id: number, value: string) => void;
  onRelationshipTextChange: (key: string, text: string) => void;
  customRelationships: string[];
  onAddCustomRelationship: (relationship: string) => void;
}

/**
 * Step 2: Character Creation
 * Handles photo upload, name entry, traits editing, and character list
 */
export function WizardStep2Characters({
  characters,
  currentCharacter,
  characterStep,
  showCharacterCreated,
  isLoading,
  isAnalyzingPhoto,
  isGeneratingAvatar,
  isRegeneratingAvatars,
  isRegeneratingAvatarsWithTraits,
  developerMode,
  changedTraits,
  photoAnalysisDebug,
  mainCharacters,
  excludedCharacters,
  onCharacterRoleChange,
  onCharacterChange,
  onCharacterStepChange,
  onPhotoSelect,
  onSaveAndGenerateAvatar,
  onSaveCharacter,
  onEditCharacter,
  onDeleteCharacter,
  onStartNewCharacter,
  onRegenerateAvatars,
  onRegenerateAvatarsWithTraits,
  onSaveAndRegenerateWithTraits,
  relationships,
  relationshipTexts,
  onRelationshipChange,
  onRelationshipTextChange,
  customRelationships,
  onAddCustomRelationship,
}: WizardStep2Props) {
  const { t, language } = useLanguage();

  // Currently editing a character
  if (currentCharacter) {
    // Step 2a: Photo upload
    if (characterStep === 'photo') {
      return (
        <div className="space-y-6">
          <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
            <Users size={24} /> {t.charactersStepTitle}
          </h2>
          <PhotoUpload onPhotoSelect={onPhotoSelect} />
          <button
            onClick={() => onCharacterChange(null)}
            className="w-full bg-gray-200 text-gray-700 px-4 py-2 rounded-lg font-semibold hover:bg-gray-300 transition-colors"
          >
            {t.cancel}
          </button>
        </div>
      );
    }

    // Step 2b: Name entry only
    if (characterStep === 'name') {
      return (
        <div className="space-y-6">
          <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
            <Users size={24} /> {t.charactersStepTitle}
          </h2>
          <CharacterForm
            character={currentCharacter}
            onChange={onCharacterChange}
            onSave={onSaveCharacter}
            onCancel={() => onCharacterChange(null)}
            onPhotoChange={onPhotoSelect}
            onContinueToTraits={() => onCharacterStepChange('traits')}
            onSaveAndGenerateAvatar={onSaveAndGenerateAvatar}
            onRegenerateAvatars={onRegenerateAvatars}
            onRegenerateAvatarsWithTraits={onRegenerateAvatarsWithTraits}
            isLoading={isLoading}
            isAnalyzingPhoto={isAnalyzingPhoto}
            isGeneratingAvatar={isGeneratingAvatar}
            isRegeneratingAvatars={isRegeneratingAvatars}
            isRegeneratingAvatarsWithTraits={isRegeneratingAvatarsWithTraits}
            step="name"
            developerMode={developerMode}
            changedTraits={changedTraits}
            photoAnalysisDebug={photoAnalysisDebug}
          />
        </div>
      );
    }

    // Step 2c: Traits and characteristics
    return (
      <div className="space-y-6">
        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Users size={24} /> {t.charactersStepTitle}
        </h2>
        <CharacterForm
          character={currentCharacter}
          allCharacters={characters}
          onChange={onCharacterChange}
          onSave={onSaveCharacter}
          onCancel={() => onCharacterChange(null)}
          onPhotoChange={onPhotoSelect}
          onRegenerateAvatars={onRegenerateAvatars}
          onRegenerateAvatarsWithTraits={onRegenerateAvatarsWithTraits}
          onSaveAndRegenerateWithTraits={onSaveAndRegenerateWithTraits}
          isLoading={isLoading}
          isAnalyzingPhoto={isAnalyzingPhoto}
          isGeneratingAvatar={isGeneratingAvatar}
          isRegeneratingAvatars={isRegeneratingAvatars}
          isRegeneratingAvatarsWithTraits={isRegeneratingAvatarsWithTraits}
          step="traits"
          developerMode={developerMode}
          changedTraits={changedTraits}
          photoAnalysisDebug={photoAnalysisDebug}
          relationships={relationships}
          relationshipTexts={relationshipTexts}
          onRelationshipChange={onRelationshipChange}
          onRelationshipTextChange={onRelationshipTextChange}
          customRelationships={customRelationships}
          onAddCustomRelationship={onAddCustomRelationship}
        />
      </div>
    );
  }

  // Has characters - show list
  if (characters.length > 0) {
    return (
      <div className="space-y-6">
        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
          <Users size={24} /> {t.charactersStepTitle}
        </h2>
        <CharacterList
          characters={characters}
          showSuccessMessage={showCharacterCreated}
          mainCharacters={mainCharacters}
          excludedCharacters={excludedCharacters}
          onCharacterRoleChange={onCharacterRoleChange}
          onEdit={onEditCharacter}
          onDelete={onDeleteCharacter}
          onCreateAnother={onStartNewCharacter}
        />
      </div>
    );
  }

  // No characters yet - show empty state
  return (
    <div className="space-y-6">
      <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-2">
        <Users size={24} /> {t.charactersStepTitle}
      </h2>
      <div className="text-center py-12">
        <Users className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-600 mb-6">{t.startCreating}</p>
        <Button onClick={onStartNewCharacter} icon={Sparkles}>
          {language === 'de' ? 'Ersten Charakter erstellen' : language === 'fr' ? 'Creer le premier personnage' : 'Create First Character'}
        </Button>
      </div>
    </div>
  );
}
