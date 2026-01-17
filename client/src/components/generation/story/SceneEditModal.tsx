import { useState } from 'react';
import { RefreshCw, Edit3, Users, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface CharacterOption {
  id: number;
  name: string;
  photoUrl?: string;
}

interface ConsistencyIssue {
  type: string;
  characterInvolved?: string;
  description: string;
  recommendation: string;
  severity: string;
}

interface ConsistencyRegenData {
  originalImage: string;
  originalPrompt: string;
  originalDescription: string;
  fixedImage: string;
  fixedPrompt: string;
  fixedDescription: string;
  correctionNotes: string;
  issues: ConsistencyIssue[];
  score: number;
  timestamp: string;
}

interface SceneEditModalProps {
  pageNumber: number;
  scene: string;
  onSceneChange: (scene: string) => void;
  onClose: () => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
  imageRegenerationCost: number;
  // Character selection
  characters?: CharacterOption[];
  selectedCharacterIds?: number[];
  onCharacterSelectionChange?: (ids: number[]) => void;
  // Consistency regeneration data (dev mode)
  consistencyRegen?: ConsistencyRegenData;
}

export function SceneEditModal({
  pageNumber,
  scene,
  onSceneChange,
  onClose,
  onRegenerate,
  isRegenerating,
  imageRegenerationCost,
  characters = [],
  selectedCharacterIds = [],
  onCharacterSelectionChange,
  consistencyRegen,
}: SceneEditModalProps) {
  const { language } = useLanguage();
  const [showOriginalPrompt, setShowOriginalPrompt] = useState(false);
  const [showFixedPrompt, setShowFixedPrompt] = useState(false);

  const toggleCharacter = (id: number) => {
    if (!onCharacterSelectionChange) return;
    if (selectedCharacterIds.includes(id)) {
      onCharacterSelectionChange(selectedCharacterIds.filter(cid => cid !== id));
    } else {
      onCharacterSelectionChange([...selectedCharacterIds, id]);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Edit3 size={20} />
            {language === 'de' ? `Szene bearbeiten - Seite ${pageNumber}` :
             language === 'fr' ? `Modifier la scène - Page ${pageNumber}` :
             `Edit Scene - Page ${pageNumber}`}
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            {language === 'de' ? 'Bearbeiten Sie die Szenenbeschreibung und wählen Sie die Charaktere aus.' :
             language === 'fr' ? 'Modifiez la description de la scène et sélectionnez les personnages.' :
             'Edit the scene description and select the characters.'}
          </p>
        </div>

        <div className="p-4 space-y-4">
          {/* Character Selection */}
          {characters.length > 0 && onCharacterSelectionChange && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                <Users size={16} />
                {language === 'de' ? 'Charaktere in dieser Szene:' :
                 language === 'fr' ? 'Personnages dans cette scène:' :
                 'Characters in this scene:'}
              </label>
              <div className="flex flex-wrap gap-2">
                {characters.map((char) => {
                  const isSelected = selectedCharacterIds.includes(char.id);
                  return (
                    <button
                      key={char.id}
                      type="button"
                      onClick={() => toggleCharacter(char.id)}
                      className={`flex items-center gap-2 px-3 py-2 rounded-lg border-2 transition-all ${
                        isSelected
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {char.photoUrl && (
                        <img
                          src={char.photoUrl}
                          alt={char.name}
                          className="w-8 h-8 rounded-full object-cover"
                        />
                      )}
                      <span className="font-medium">{char.name}</span>
                      {isSelected && (
                        <span className="text-indigo-500">✓</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-400 mt-2">
                {language === 'de' ? 'Wählen Sie die Charaktere aus, die im Bild erscheinen sollen.' :
                 language === 'fr' ? 'Sélectionnez les personnages qui doivent apparaître dans l\'image.' :
                 'Select the characters that should appear in the image.'}
              </p>
            </div>
          )}

          {/* Consistency Fix Comparison (Dev Mode) */}
          {consistencyRegen && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="text-amber-600" size={20} />
                <h4 className="font-semibold text-amber-800">
                  {language === 'de' ? 'Konsistenz-Korrektur angewendet' :
                   language === 'fr' ? 'Correction de cohérence appliquée' :
                   'Consistency Fix Applied'}
                </h4>
                <span className="text-xs bg-amber-200 text-amber-800 px-2 py-0.5 rounded">
                  Score: {consistencyRegen.score}%
                </span>
              </div>

              {/* Issues Fixed */}
              <div className="mb-4">
                <p className="text-sm font-medium text-amber-700 mb-2">
                  {language === 'de' ? 'Behobene Probleme:' :
                   language === 'fr' ? 'Problèmes corrigés:' :
                   'Issues Fixed:'}
                </p>
                <ul className="text-sm text-amber-900 space-y-1">
                  {consistencyRegen.issues.map((issue, idx) => (
                    <li key={idx} className="flex flex-col">
                      <span className="font-medium">
                        {issue.type.toUpperCase()}
                        {issue.characterInvolved && ` (${issue.characterInvolved})`}:
                      </span>
                      <span className="text-amber-700 ml-2">{issue.description}</span>
                      <span className="text-amber-600 ml-2 text-xs">→ {issue.recommendation}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Image Comparison */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1 text-center">
                    {language === 'de' ? 'Original' : language === 'fr' ? 'Original' : 'Original'}
                  </p>
                  <img
                    src={consistencyRegen.originalImage}
                    alt="Original"
                    className="w-full rounded-lg border border-gray-300"
                  />
                </div>
                <div>
                  <p className="text-xs font-medium text-green-600 mb-1 text-center">
                    {language === 'de' ? 'Korrigiert' : language === 'fr' ? 'Corrigé' : 'Fixed'}
                  </p>
                  <img
                    src={consistencyRegen.fixedImage}
                    alt="Fixed"
                    className="w-full rounded-lg border-2 border-green-500"
                  />
                </div>
              </div>

              {/* Collapsible Prompts */}
              <div className="space-y-2">
                <button
                  onClick={() => setShowOriginalPrompt(!showOriginalPrompt)}
                  className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-800"
                >
                  {showOriginalPrompt ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {language === 'de' ? 'Original-Prompt' : language === 'fr' ? 'Prompt original' : 'Original Prompt'}
                </button>
                {showOriginalPrompt && (
                  <pre className="text-xs bg-gray-100 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
                    {consistencyRegen.originalPrompt}
                  </pre>
                )}

                <button
                  onClick={() => setShowFixedPrompt(!showFixedPrompt)}
                  className="flex items-center gap-1 text-xs text-green-600 hover:text-green-800"
                >
                  {showFixedPrompt ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {language === 'de' ? 'Korrigierter Prompt (mit Korrekturen)' :
                   language === 'fr' ? 'Prompt corrigé (avec corrections)' :
                   'Fixed Prompt (with corrections)'}
                </button>
                {showFixedPrompt && (
                  <pre className="text-xs bg-green-50 p-2 rounded border border-green-200 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
                    {consistencyRegen.fixedPrompt}
                  </pre>
                )}
              </div>

              <p className="text-xs text-gray-400 mt-2">
                {language === 'de' ? `Korrigiert am ${new Date(consistencyRegen.timestamp).toLocaleString()}` :
                 language === 'fr' ? `Corrigé le ${new Date(consistencyRegen.timestamp).toLocaleString()}` :
                 `Fixed at ${new Date(consistencyRegen.timestamp).toLocaleString()}`}
              </p>
            </div>
          )}

          {/* Scene Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              {language === 'de' ? 'Szenenbeschreibung:' :
               language === 'fr' ? 'Description de la scène:' :
               'Scene description:'}
            </label>
            <textarea
              value={scene}
              onChange={(e) => onSceneChange(e.target.value)}
              className="w-full h-40 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 resize-y"
              placeholder={language === 'de' ? 'Beschreiben Sie die Szene...' :
                          language === 'fr' ? 'Décrivez la scène...' :
                          'Describe the scene...'}
            />
            <p className="text-xs text-gray-400 mt-2">
              {language === 'de' ? 'Tipp: Beschreiben Sie die Aktionen und die Umgebung. Die ausgewählten Charaktere werden automatisch hinzugefügt.' :
               language === 'fr' ? 'Conseil: Décrivez les actions et l\'environnement. Les personnages sélectionnés seront ajoutés automatiquement.' :
               'Tip: Describe the actions and the environment. Selected characters will be added automatically.'}
            </p>
          </div>
        </div>

        <div className="p-4 border-t border-gray-200 flex justify-between items-center">
          <div className="text-sm text-gray-500">
            {selectedCharacterIds.length > 0 && (
              <span>
                {language === 'de' ? `${selectedCharacterIds.length} Charakter(e) ausgewählt` :
                 language === 'fr' ? `${selectedCharacterIds.length} personnage(s) sélectionné(s)` :
                 `${selectedCharacterIds.length} character(s) selected`}
              </span>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isRegenerating}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-700 font-medium disabled:opacity-50"
            >
              {language === 'de' ? 'Abbrechen' : language === 'fr' ? 'Annuler' : 'Cancel'}
            </button>
            <button
              onClick={onRegenerate}
              disabled={isRegenerating || !scene.trim()}
              className={`px-4 py-2 bg-indigo-600 text-white rounded-lg font-medium flex items-center gap-2 ${
                isRegenerating || !scene.trim() ? 'opacity-50 cursor-not-allowed' : 'hover:bg-indigo-700'
              }`}
            >
              {isRegenerating ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  {language === 'de' ? 'Generiere...' : language === 'fr' ? 'Génération...' : 'Generating...'}
                </>
              ) : (
                <>
                  <RefreshCw size={16} />
                  {language === 'de' ? 'Neu generieren' : language === 'fr' ? 'Régénérer' : 'Regenerate'}
                  <span className="text-xs opacity-80">({imageRegenerationCost} credits)</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
