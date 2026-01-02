import { useState } from 'react';
import { Edit2, Trash2, Check, AlertTriangle, Star, Plus } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { Character } from '@/types/character';

// Character role in story: 'out' = not in story, 'in' = side character, 'main' = main character
type CharacterRole = 'out' | 'in' | 'main';

interface CharacterListProps {
  characters: Character[];
  showSuccessMessage?: boolean;
  mainCharacters?: number[];
  excludedCharacters?: number[];
  onCharacterRoleChange?: (charId: number, role: CharacterRole) => void;
  onEdit: (character: Character) => void;
  onDelete: (id: number) => void;
  onCreateAnother: () => void;
}

export function CharacterList({
  characters,
  showSuccessMessage,
  mainCharacters = [],
  excludedCharacters = [],
  onCharacterRoleChange,
  onEdit,
  onDelete,
  onCreateAnother,
}: CharacterListProps) {
  const { t, language } = useLanguage();
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; name: string } | null>(null);

  // Helper to determine character's current role
  const getCharacterRole = (charId: number): CharacterRole => {
    if (excludedCharacters.includes(charId)) return 'out';
    if (mainCharacters.includes(charId)) return 'main';
    return 'in';
  };

  // Role labels for 3-state buttons
  const roleLabels = {
    out: language === 'de' ? 'Nicht dabei' : language === 'fr' ? 'Absent' : 'Out',
    in: language === 'de' ? 'Dabei' : language === 'fr' ? 'Présent' : 'In',
    main: language === 'de' ? 'Hauptrolle' : language === 'fr' ? 'Principal' : 'Main',
  };

  const handleDeleteClick = (char: Character) => {
    setDeleteConfirm({ id: char.id, name: char.name });
  };

  const confirmDelete = () => {
    if (deleteConfirm) {
      onDelete(deleteConfirm.id);
      setDeleteConfirm(null);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirm(null);
  };

  if (characters.length === 0) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Success message */}
      {showSuccessMessage && (
        <div className="md:bg-green-50 md:border-2 md:border-green-400 md:rounded-xl p-4 animate-fade-in">
          <div className="flex items-center gap-3">
            <div className="bg-green-500 text-white rounded-full w-8 h-8 flex items-center justify-center">
              <Check size={20} />
            </div>
            <h3 className="text-lg font-bold text-green-700">
              {language === 'de'
                ? 'Charakter erfolgreich erstellt!'
                : language === 'fr'
                ? 'Personnage cre avec succes!'
                : 'Character Created Successfully!'}
            </h3>
          </div>
        </div>
      )}

      {/* Existing characters */}
      <div className="bg-white border-2 border-indigo-200 rounded-lg p-3">
        <h3 className="text-base font-bold text-gray-800 mb-2">{t.yourCharacters}</h3>
        <div className="grid md:grid-cols-2 gap-2">
          {characters.map((char) => {
            const role = getCharacterRole(char.id);
            const isOut = role === 'out';
            const isIn = role === 'in';
            const isMain = role === 'main';
            // Count characters currently in story (not excluded)
            const charactersInStory = characters.filter(c => !excludedCharacters.includes(c.id));
            // Prevent removing the last character from the story
            const isLastInStory = !isOut && charactersInStory.length === 1;

            return (
              <div
                key={char.id}
                className={`border rounded p-2 transition-all ${
                  isOut
                    ? 'border-dashed border-gray-300 bg-gray-50 opacity-60'
                    : isMain
                    ? 'border-2 border-indigo-600 bg-indigo-50'
                    : 'border-gray-200 bg-white'
                }`}
              >
                {/* Top row: Photo/Name on left, Edit/Delete on right */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {(char.photos?.face || char.photos?.original) && (
                      <img
                        src={char.photos?.face || char.photos?.original}
                        alt={char.name}
                        className={`w-10 h-10 md:w-12 md:h-12 rounded-full object-cover border-2 border-indigo-200 flex-shrink-0 ${isOut ? 'grayscale' : ''}`}
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <h4 className="font-bold text-sm md:text-base truncate flex items-center gap-1">
                        {char.name}
                        {isMain && <Star size={14} className="text-indigo-600 fill-indigo-600 flex-shrink-0" />}
                      </h4>
                      <p className="text-xs text-gray-500">
                        {char.gender === 'male' ? t.male : char.gender === 'female' ? t.female : t.other},{' '}
                        {char.age} {language === 'de' ? 'J' : language === 'fr' ? 'ans' : 'y'}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => onEdit(char)}
                      className="bg-indigo-600 text-white p-1.5 rounded text-xs hover:bg-indigo-700"
                      title={t.editCharacter}
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => handleDeleteClick(char)}
                      className="bg-red-500 text-white p-1.5 rounded text-xs hover:bg-red-600"
                      title={t.deleteCharacter}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Role selector */}
                {onCharacterRoleChange && (
                  <div className="flex rounded-lg overflow-hidden border border-gray-300">
                    <button
                      onClick={() => onCharacterRoleChange(char.id, 'out')}
                      disabled={isLastInStory}
                      title={isLastInStory ? (language === 'de' ? 'Mindestens ein Charakter muss in der Geschichte sein' : language === 'fr' ? 'Au moins un personnage doit être dans l\'histoire' : 'At least one character must be in the story') : undefined}
                      className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors ${
                        isOut
                          ? 'bg-gray-500 text-white'
                          : isLastInStory
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-white text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      {roleLabels.out}
                    </button>
                    <button
                      onClick={() => onCharacterRoleChange(char.id, 'in')}
                      className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors border-l border-r border-gray-300 ${
                        isIn
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      {roleLabels.in}
                    </button>
                    <button
                      onClick={() => onCharacterRoleChange(char.id, 'main')}
                      className={`flex-1 px-2 py-1.5 text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
                        isMain
                          ? 'bg-indigo-600 text-white'
                          : 'bg-white text-gray-600 hover:bg-gray-100'
                      }`}
                    >
                      <Star size={12} className={isMain ? 'fill-white' : ''} />
                      {roleLabels.main}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {/* Add Character Card */}
          <button
            onClick={onCreateAnother}
            className="border-2 border-dashed border-indigo-300 rounded p-4 flex flex-col items-center justify-center gap-2 hover:border-indigo-500 hover:bg-indigo-50 transition-colors min-h-[100px]"
          >
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
              <Plus size={24} className="text-indigo-600" />
            </div>
            <span className="text-sm font-medium text-indigo-600">
              {language === 'de'
                ? 'Weiteren Charakter erstellen'
                : language === 'fr'
                ? 'Créer un autre personnage'
                : 'Create Another Character'}
            </span>
          </button>
        </div>
      </div>

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 max-w-sm w-full shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-red-100 text-red-600 rounded-full p-2">
                <AlertTriangle size={24} />
              </div>
              <h3 className="text-lg font-bold text-gray-800">
                {language === 'de'
                  ? 'Charakter löschen?'
                  : language === 'fr'
                  ? 'Supprimer le personnage?'
                  : 'Delete Character?'}
              </h3>
            </div>
            <p className="text-gray-600 mb-6">
              {language === 'de'
                ? `Möchtest du "${deleteConfirm.name}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`
                : language === 'fr'
                ? `Voulez-vous vraiment supprimer "${deleteConfirm.name}"? Cette action est irréversible.`
                : `Are you sure you want to delete "${deleteConfirm.name}"? This action cannot be undone.`}
            </p>
            <div className="flex gap-3">
              <button
                onClick={cancelDelete}
                className="flex-1 px-4 py-2 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium"
              >
                {language === 'de' ? 'Löschen' : language === 'fr' ? 'Supprimer' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CharacterList;
