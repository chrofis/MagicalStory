import { RefreshCw, Edit3 } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';

interface SceneEditModalProps {
  pageNumber: number;
  scene: string;
  onSceneChange: (scene: string) => void;
  onClose: () => void;
  onRegenerate: () => void;
  isRegenerating: boolean;
  imageRegenerationCost: number;
}

export function SceneEditModal({
  pageNumber,
  scene,
  onSceneChange,
  onClose,
  onRegenerate,
  isRegenerating,
  imageRegenerationCost,
}: SceneEditModalProps) {
  const { language } = useLanguage();

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-2xl w-full shadow-2xl">
        <div className="p-4 border-b border-gray-200">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Edit3 size={20} />
            {language === 'de' ? `Szene bearbeiten - Seite ${pageNumber}` :
             language === 'fr' ? `Modifier la scène - Page ${pageNumber}` :
             `Edit Scene - Page ${pageNumber}`}
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            {language === 'de' ? 'Bearbeiten Sie die Szenenbeschreibung und generieren Sie das Bild neu.' :
             language === 'fr' ? 'Modifiez la description de la scène et régénérez l\'image.' :
             'Edit the scene description and regenerate the image.'}
          </p>
        </div>
        <div className="p-4">
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
            {language === 'de' ? 'Tipp: Beschreiben Sie die Charaktere, ihre Aktionen und die Umgebung.' :
             language === 'fr' ? 'Conseil: Décrivez les personnages, leurs actions et l\'environnement.' :
             'Tip: Describe the characters, their actions, and the environment.'}
          </p>
        </div>
        <div className="p-4 border-t border-gray-200 flex justify-end gap-3">
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
  );
}
