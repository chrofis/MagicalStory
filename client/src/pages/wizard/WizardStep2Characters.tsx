import { Users, Sparkles } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { Button } from '@/components/common';
import { CharacterList, CharacterForm, PhotoUpload } from '@/components/character';
import type { Character, ChangedTraits, RelationshipMap, RelationshipTextMap } from '@/types/character';
import type { CustomRelationshipPair } from '@/constants/relationships';

// Character role in story
type CharacterRole = 'out' | 'in' | 'main';

interface WizardStep2Props {
  characters: Character[];
  currentCharacter: Character | null;
  characterStep: 'photo' | 'name' | 'traits' | 'characteristics' | 'relationships';
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
  onCharacterStepChange: (step: 'photo' | 'name' | 'traits' | 'characteristics' | 'relationships') => void;
  onPhotoSelect: (file: File, keepOldClothing?: boolean) => void;
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
  customRelationships: CustomRelationshipPair[];
  onAddCustomRelationship: (forward: string, inverse: string) => void;
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
            isNewCharacter={true}
          />
        </div>
      );
    }

    // Step 2c+: Traits, Characteristics, Relationships
    // Check if this is a new character (not yet in the characters list)
    const isNewChar = !characters.find(c => c.id === currentCharacter.id);
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
          onContinueToCharacteristics={() => onCharacterStepChange('characteristics')}
          onContinueToRelationships={() => onCharacterStepChange('relationships')}
          onRegenerateAvatars={onRegenerateAvatars}
          onRegenerateAvatarsWithTraits={onRegenerateAvatarsWithTraits}
          onSaveAndRegenerateWithTraits={onSaveAndRegenerateWithTraits}
          isLoading={isLoading}
          isAnalyzingPhoto={isAnalyzingPhoto}
          isGeneratingAvatar={isGeneratingAvatar}
          isRegeneratingAvatars={isRegeneratingAvatars}
          isRegeneratingAvatarsWithTraits={isRegeneratingAvatarsWithTraits}
          step={characterStep as 'traits' | 'characteristics' | 'relationships'}
          developerMode={developerMode}
          changedTraits={changedTraits}
          photoAnalysisDebug={photoAnalysisDebug}
          relationships={relationships}
          relationshipTexts={relationshipTexts}
          onRelationshipChange={onRelationshipChange}
          onRelationshipTextChange={onRelationshipTextChange}
          customRelationships={customRelationships}
          onAddCustomRelationship={onAddCustomRelationship}
          isNewCharacter={isNewChar}
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
        {/* Main character requirement message */}
        {mainCharacters.length === 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <span className="text-amber-500 text-xl">⭐</span>
            <div>
              <p className="text-amber-800 font-medium">
                {language === 'de'
                  ? 'Wähle mindestens einen Hauptcharakter aus'
                  : language === 'fr'
                  ? 'Sélectionnez au moins un personnage principal'
                  : 'Select at least one main character'}
              </p>
              <p className="text-amber-600 text-sm mt-1">
                {language === 'de'
                  ? 'Klicke auf den Stern ⭐ neben einem Charakter, um ihn zum Hauptcharakter zu machen.'
                  : language === 'fr'
                  ? 'Cliquez sur l\'étoile ⭐ à côté d\'un personnage pour en faire le personnage principal.'
                  : 'Click the star ⭐ next to a character to make them the main character.'}
              </p>
            </div>
          </div>
        )}
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
