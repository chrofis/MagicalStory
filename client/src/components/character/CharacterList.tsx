import { useState } from 'react';
import { Edit2, Trash2, Check, AlertTriangle, Star, Plus } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { Character } from '@/types/character';
import { getDisplayPhoto } from '@/utils/characterPhotos';
import { pickMainCharacters, mainLimit } from '@/utils/mainCharacters';

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
    out: language === 'de' ? 'Nicht dabei' : language === 'fr' ? 'Absent' : language === 'it' ? 'Assente' : 'Out',
    in: language === 'de' ? 'Dabei' : language === 'fr' ? 'Présent' : language === 'it' ? 'Presente' : 'In',
    main: language === 'de' ? 'Hauptrolle' : language === 'fr' ? 'Principal' : language === 'it' ? 'Protagonista' : 'Main',
  };

  const pick = (de: string, fr: string, it: string, en: string) =>
    language === 'de' ? de : language === 'fr' ? fr : language === 'it' ? it : en;

  // What the server will do with the current selection (mirror of pickMainCharacters)
  const inStory = characters.filter(c => !excludedCharacters.includes(c.id));
  const sel = pickMainCharacters(inStory, mainCharacters);
  const declaredCount = sel.counted.length;
  const ageLine = (() => {
    if (!sel.focus || sel.focusAge === null) return null;
    const n = sel.focusAge;
    const who = declaredCount > 1
      ? pick('älteste Hauptrolle', 'rôle principal le plus âgé', 'protagonista più grande', 'oldest main character')
      : pick('Hauptrolle', 'rôle principal', 'protagonista', 'main character');
    const name = sel.focus.name;
    return n < 1
      ? pick(`Geschrieben für Babys (${name}, ${who}).`, `Écrit pour des bébés (${name}, ${who}).`, `Scritto per neonati (${name}, ${who}).`, `Written for babies (${name}, ${who}).`)
      : pick(`Geschrieben für ${n}-Jährige (${name}, ${who}).`, `Écrit pour des enfants de ${n} ans (${name}, ${who}).`, `Scritto per bambini di ${n} anni (${name}, ${who}).`, `Written for ${n}-year-olds (${name}, ${who}).`);
  })();

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
                ? 'Personnage créé avec succès!'
                : language === 'it'
                ? 'Personaggio creato con successo!'
                : 'Character Created Successfully!'}
            </h3>
          </div>
        </div>
      )}

      {onCharacterRoleChange && (
        <p className="text-sm text-gray-600">
          {pick(
            '⭐ Hauptrolle: Um diese Figur dreht sich die Geschichte – sie ist auf den meisten Seiten, und ihr Alter bestimmt, wie einfach oder anspruchsvoll die Geschichte wird. Höchstens 2 Hauptrollen, bei 1–2 Figuren eine. Tipp: Ist das Buch ein Geschenk für ein Kind, z. B. zum Geburtstag, wähle nur dieses Kind als Hauptrolle – Geschwister bleiben «Dabei» und kommen trotzdem vor.',
            '⭐ Rôle principal : l\'histoire tourne autour de ce personnage, qui apparaît sur la plupart des pages, et son âge détermine si l\'histoire est simple ou exigeante. Au maximum 2 rôles principaux, un seul avec 1–2 personnages. Astuce : si le livre est un cadeau pour un enfant, par ex. pour son anniversaire, choisissez uniquement cet enfant – ses frères et sœurs restent « Présent » et apparaissent quand même.',
            '⭐ Protagonista: la storia ruota attorno a questo personaggio, presente nella maggior parte delle pagine, e la sua età decide quanto la storia è semplice o impegnativa. Al massimo 2 protagonisti, uno solo con 1–2 personaggi. Consiglio: se il libro è un regalo per un bambino, ad es. per il compleanno, scegli solo quel bambino – i fratelli restano «Presente» e compaiono comunque.',
            '⭐ Main: the story revolves around this character, who is on most pages, and their age decides how simple or demanding the story is. At most 2 main characters, only one with 1–2 characters. Tip: if the book is a gift for one child, e.g. a birthday, make only that child the main character – siblings stay "In" and still appear.',
          )}
        </p>
      )}

      {/* Existing characters */}
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
            // Main limit for the cast as it would be with this character in the story
            const limitWithChar = mainLimit(charactersInStory.length + (isOut ? 1 : 0));
            const mainFull = !isMain && limitWithChar >= 2 && sel.counted.length >= limitWithChar;

            return (
              <div
                key={char.id}
                className={`border rounded p-2 transition-all ${
                  isOut
                    ? 'border-dashed border-gray-300 bg-gray-50'
                    : isMain
                    ? 'border-2 border-indigo-500 bg-indigo-50'
                    : 'border-gray-200 bg-white'
                }`}
              >
                {/* Layout: Thumbnail left, Info+Controls right */}
                <div className="flex gap-3">
                  {/* Large thumbnail - clickable to edit.
                      Dual-shape (Phase 1): getDisplayPhoto reads NEW
                      `faceThumb.standard` first, then OLD shapes, then photos. */}
                  {(() => {
                    const photo = getDisplayPhoto(char);
                    if (!photo) return null;
                    return (
                      <button
                        onClick={() => onEdit(char)}
                        className="flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-400 rounded-full"
                        title={t.editCharacter}
                      >
                        <img
                          draggable={false}
                          src={photo}
                          alt={char.name}
                          className={`w-20 h-20 rounded-full object-cover object-top border-2 border-indigo-200 cursor-pointer hover:border-indigo-400 transition-colors ${isOut ? 'grayscale opacity-50' : ''}`}
                        />
                      </button>
                    );
                  })()}

                  {/* Right side: Name, info, and controls */}
                  <div className="flex-1 min-w-0 flex flex-col justify-between">
                    {/* Top: Name and Edit/Delete */}
                    <div className={`flex items-start justify-between gap-2 ${isOut ? 'opacity-50' : ''}`}>
                      <div className="min-w-0">
                        <h4 className="font-bold text-sm md:text-base truncate flex items-center gap-1">
                          {char.name}
                          {isMain && <Star size={14} className="text-indigo-500 fill-indigo-600 flex-shrink-0" />}
                        </h4>
                        <p className="text-xs text-gray-500">
                          {char.gender === 'male' ? t.male : char.gender === 'female' ? t.female : t.other},{' '}
                          {char.age} {language === 'de' ? 'J' : language === 'fr' ? 'ans' : language === 'it' ? 'a' : 'y'}
                        </p>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <button
                          onClick={() => onEdit(char)}
                          className="bg-indigo-500 text-white p-1.5 rounded text-xs hover:bg-indigo-600"
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

                    {/* Bottom: Role selector */}
                    {onCharacterRoleChange && (
                      <div className="flex rounded overflow-hidden border border-gray-300 text-[10px] md:text-xs mt-1">
                        <button
                          onClick={() => onCharacterRoleChange(char.id, 'out')}
                          disabled={isLastInStory}
                          title={isLastInStory ? (language === 'de' ? 'Mindestens ein Charakter muss in der Geschichte sein' : language === 'fr' ? 'Au moins un personnage doit être dans l\'histoire' : language === 'it' ? 'Almeno un personaggio deve essere nella storia' : 'At least one character must be in the story') : undefined}
                          className={`flex-1 px-1.5 py-1 font-medium transition-colors ${
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
                          className={`flex-1 px-1.5 py-1 font-medium transition-colors border-l border-r border-gray-300 ${
                            isIn
                              ? 'bg-indigo-500 text-white'
                              : isOut
                              ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                              : 'bg-white text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          {roleLabels.in}
                        </button>
                        <button
                          onClick={() => onCharacterRoleChange(char.id, 'main')}
                          disabled={mainFull}
                          title={mainFull ? pick('Höchstens 2 Hauptrollen', 'Au maximum 2 rôles principaux', 'Al massimo 2 protagonisti', 'At most 2 main characters') : undefined}
                          className={`flex-1 px-1.5 py-1 font-medium transition-colors flex items-center justify-center gap-0.5 ${
                            mainFull
                              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                              : isMain
                              ? 'bg-indigo-500 text-white'
                              : isOut
                              ? 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                              : 'bg-white text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          <Star size={10} className={isMain ? 'fill-white' : ''} />
                          {roleLabels.main}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add Character Card */}
          <button
            onClick={onCreateAnother}
            className="border-2 border-dashed border-indigo-300 rounded p-4 flex flex-col items-center justify-center gap-2 hover:border-indigo-500 hover:bg-indigo-50 transition-colors min-h-[100px]"
          >
            <div className="w-10 h-10 rounded-full bg-indigo-100 flex items-center justify-center">
              <Plus size={24} className="text-indigo-500" />
            </div>
            <span className="text-sm font-medium text-indigo-500">
              {language === 'de'
                ? 'Weiteren Charakter erstellen'
                : language === 'fr'
                ? 'Créer un autre personnage'
                : language === 'it'
                ? 'Crea un altro personaggio'
                : 'Create Another Character'}
            </span>
          </button>
      </div>

      {onCharacterRoleChange && ageLine && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 text-sm text-indigo-900 space-y-1">
          {ageLine && <p className="font-medium">📖 {ageLine}</p>}
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="bg-red-100 text-red-600 rounded-full p-2">
                <AlertTriangle size={24} />
              </div>
              <h3 className="text-lg font-bold text-gray-800">
                {language === 'de'
                  ? 'Charakter löschen?'
                  : language === 'fr'
                  ? 'Supprimer le personnage?'
                  : language === 'it'
                  ? 'Eliminare il personaggio?'
                  : 'Delete Character?'}
              </h3>
            </div>
            <p className="text-gray-600 mb-6">
              {language === 'de'
                ? `Möchtest du «${deleteConfirm.name}» wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`
                : language === 'fr'
                ? `Voulez-vous vraiment supprimer "${deleteConfirm.name}"? Cette action est irréversible.`
                : language === 'it'
                ? `Vuoi davvero eliminare "${deleteConfirm.name}"? Questa azione non può essere annullata.`
                : `Are you sure you want to delete "${deleteConfirm.name}"? This action cannot be undone.`}
            </p>
            <div className="flex gap-3">
              <button
                onClick={cancelDelete}
                className="flex-1 px-4 py-2 border-2 border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 font-medium"
              >
                {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : language === 'it' ? 'Annulla' : 'Cancel'}
              </button>
              <button
                onClick={confirmDelete}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium"
              >
                {language === 'de' ? 'Löschen' : language === 'fr' ? 'Supprimer' : language === 'it' ? 'Elimina' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CharacterList;
