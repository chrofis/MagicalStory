import { useState } from 'react';
import { Edit2, Trash2, Check, AlertTriangle } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { Character } from '@/types/character';

interface CharacterListProps {
  characters: Character[];
  showSuccessMessage?: boolean;
  onEdit: (character: Character) => void;
  onDelete: (id: number) => void;
  onCreateAnother: () => void;
  onContinue: () => void;
}

export function CharacterList({
  characters,
  showSuccessMessage,
  onEdit,
  onDelete,
  onCreateAnother,
  onContinue,
}: CharacterListProps) {
  const { t, language } = useLanguage();
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; name: string } | null>(null);

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
          {characters.map((char) => (
            <div key={char.id} className="border border-gray-200 rounded p-2">
              {/* Top row: Photo/Name on left, Buttons on right */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {(char.photos?.face || char.photos?.original) && (
                    <img
                      src={char.photos?.face || char.photos?.original}
                      alt={char.name}
                      className="w-12 h-12 md:w-16 md:h-16 rounded-full object-cover border-2 border-indigo-200 flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h4 className="font-bold text-sm md:text-base truncate">{char.name}</h4>
                    <p className="text-xs md:text-sm text-gray-500">
                      {char.gender === 'male' ? t.male : char.gender === 'female' ? t.female : t.other},{' '}
                      {char.age} {language === 'de' ? 'J' : language === 'fr' ? 'ans' : 'y'}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  <button
                    onClick={() => onEdit(char)}
                    className="bg-indigo-600 text-white px-2 md:px-3 py-1 rounded text-xs hover:bg-indigo-700 flex items-center gap-1"
                  >
                    <Edit2 size={12} />
                    {t.editCharacter}
                  </button>
                  <button
                    onClick={() => handleDeleteClick(char)}
                    className="bg-red-500 text-white px-2 md:px-3 py-1 rounded text-xs hover:bg-red-600 flex items-center gap-1"
                  >
                    <Trash2 size={12} />
                    {t.deleteCharacter}
                  </button>
                </div>
              </div>

              {/* Character traits */}
              {char.traits?.strengths && char.traits.strengths.length > 0 && (
                <p className="text-xs text-gray-800 mb-1">
                  <strong className="text-green-600">{t.strengths}:</strong> {char.traits.strengths.join(', ')}
                </p>
              )}
              {char.traits?.flaws && char.traits.flaws.length > 0 && (
                <p className="text-xs text-gray-800 mb-1">
                  <strong className="text-orange-600">{language === 'de' ? 'Schwächen' : language === 'fr' ? 'Défauts' : 'Flaws'}:</strong> {char.traits.flaws.join(', ')}
                </p>
              )}
              {char.traits?.challenges && char.traits.challenges.length > 0 && (
                <p className="text-xs text-gray-800 mb-1">
                  <strong className="text-purple-600">{language === 'de' ? 'Herausforderungen' : language === 'fr' ? 'Défis' : 'Challenges'}:</strong> {char.traits.challenges.join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Action buttons */}
      <div className="md:bg-indigo-50 md:border-2 md:border-indigo-200 md:rounded-lg p-4">
        <p className="text-gray-800 mb-4 text-center font-semibold">
          {language === 'de'
            ? 'Was mochten Sie als Nachstes tun?'
            : language === 'fr'
            ? 'Que voulez-vous faire ensuite?'
            : 'What would you like to do next?'}
        </p>
        <div className="grid md:grid-cols-2 gap-3">
          <button
            onClick={onCreateAnother}
            className="bg-indigo-500 text-white px-6 py-3 rounded-lg hover:bg-indigo-600 font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            {language === 'de'
              ? 'Weiteren Charakter erstellen'
              : language === 'fr'
              ? 'Creer un autre personnage'
              : 'Create Another Character'}
          </button>
          <button
            onClick={onContinue}
            className="bg-indigo-600 text-white px-6 py-3 rounded-lg hover:bg-indigo-700 font-semibold flex items-center justify-center gap-2 transition-colors"
          >
            {language === 'de'
              ? 'Weiter zu Beziehungen'
              : language === 'fr'
              ? 'Continuer vers les relations'
              : 'Continue to Relationships'}
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
