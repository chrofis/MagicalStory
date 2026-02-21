import { Images, X } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import type { ImageVersion } from '@/types/story';

// Cover type names for display
const COVER_LABELS = {
  frontCover: { en: 'Front Cover', de: 'Titelseite', fr: 'Couverture' },
  initialPage: { en: 'Dedication Page', de: 'Widmungsseite', fr: 'Page de dédicace' },
  backCover: { en: 'Back Cover', de: 'Rückseite', fr: 'Quatrième de couverture' },
};

interface ImageHistoryModalProps {
  pageNumber?: number;
  coverType?: 'frontCover' | 'initialPage' | 'backCover';
  versions: ImageVersion[];
  onClose: () => void;
  onSelectVersion: (pageNumberOrCoverType: number | string, versionIndex: number) => void;
  developerMode?: boolean;
}

export function ImageHistoryModal({
  pageNumber,
  coverType,
  versions,
  onClose,
  onSelectVersion,
  developerMode = false,
}: ImageHistoryModalProps) {
  const { language } = useLanguage();

  // Determine title based on whether this is a page or cover
  const getTitle = () => {
    if (coverType) {
      const labels = COVER_LABELS[coverType];
      const label = language === 'de' ? labels.de : language === 'fr' ? labels.fr : labels.en;
      return language === 'de' ? `Bildversionen - ${label}` :
             language === 'fr' ? `Versions d'image - ${label}` :
             `Image Versions - ${label}`;
    }
    return language === 'de' ? `Bildversionen - Seite ${pageNumber}` :
           language === 'fr' ? `Versions d'image - Page ${pageNumber}` :
           `Image Versions - Page ${pageNumber}`;
  };

  const handleSelect = (versionIndex: number) => {
    if (coverType) {
      onSelectVersion(coverType, versionIndex);
    } else if (pageNumber !== undefined) {
      onSelectVersion(pageNumber, versionIndex);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl max-w-3xl w-full max-h-[80vh] overflow-hidden shadow-2xl">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Images size={20} />
            {getTitle()}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto max-h-[60vh]">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {versions.map((version, idx) => (
              <div
                key={idx}
                className={`relative cursor-pointer rounded-lg overflow-hidden border-2 transition-all ${
                  version.isActive
                    ? 'border-green-500 ring-2 ring-green-200'
                    : 'border-gray-200 hover:border-indigo-300'
                }`}
                onClick={() => handleSelect(idx)}
              >
                <img
                  src={version.imageData}
                  alt={`Version ${idx + 1}`}
                  className="w-full aspect-square object-cover"
                />
                <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-60 text-white text-xs p-2">
                  <div className="flex items-center justify-between">
                    <span>
                      {idx === 0
                        ? (language === 'de' ? 'Original' : language === 'fr' ? 'Original' : 'Original')
                        : `V${idx + 1}`
                      }
                    </span>
                    <div className="flex items-center gap-1">
                      {developerMode && version.qualityScore != null && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          version.qualityScore >= 80 ? 'bg-green-600' :
                          version.qualityScore >= 60 ? 'bg-yellow-600' : 'bg-red-600'
                        }`}>
                          {version.qualityScore}%
                        </span>
                      )}
                      {version.isActive && (
                        <span className="bg-green-500 px-2 py-0.5 rounded text-[10px] font-bold">
                          {language === 'de' ? 'Aktiv' : language === 'fr' ? 'Actif' : 'Active'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-300 mt-1">
                    {new Date(version.createdAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Dev mode: Show scene and prompt comparison */}
          {developerMode && versions.length > 1 && (
            <div className="mt-4 space-y-3">
              <h4 className="font-semibold text-gray-700">
                {language === 'de' ? 'Szenen- und Prompt-Vergleich' : language === 'fr' ? 'Comparaison de scènes et prompts' : 'Scene & Prompt Comparison'}
              </h4>
              {versions.map((version, idx) => (
                <details key={idx} className={`rounded-lg p-3 ${version.isActive ? 'bg-green-50 border border-green-200' : 'bg-gray-50 border border-gray-200'}`}>
                  <summary className="cursor-pointer text-sm font-medium text-gray-700">
                    {idx === 0 ? 'Original' : `V${idx + 1}`}
                    {version.isActive && <span className="ml-2 text-green-600 text-xs">(Active)</span>}
                  </summary>
                  <div className="mt-2 space-y-2">
                    {version.userInput && (
                      <div>
                        <div className="text-xs font-semibold text-purple-700">
                          {language === 'de' ? 'Benutzer-Eingabe:' : language === 'fr' ? 'Entrée utilisateur:' : 'User Input:'}
                        </div>
                        <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-purple-50 p-2 rounded border border-purple-200 max-h-24 overflow-y-auto">
                          {version.userInput}
                        </pre>
                      </div>
                    )}
                    {version.description && (
                      <div>
                        <div className="text-xs font-semibold text-amber-700">
                          {language === 'de' ? 'Erweiterte Szene:' : language === 'fr' ? 'Scène étendue:' : 'Expanded Scene:'}
                        </div>
                        <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-24 overflow-y-auto">
                          {version.description}
                        </pre>
                      </div>
                    )}
                    {version.prompt && (
                      <div>
                        <div className="text-xs font-semibold text-blue-700">
                          {language === 'de' ? 'API-Prompt:' : language === 'fr' ? 'Prompt API:' : 'API Prompt:'}
                        </div>
                        <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-32 overflow-y-auto">
                          {version.prompt}
                        </pre>
                      </div>
                    )}
                    {version.modelId && (
                      <div className="text-xs text-gray-500">Model: {version.modelId}</div>
                    )}
                    {version.qualityScore != null && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs font-semibold text-gray-700">Quality:</span>
                        <span className={`text-xs font-bold ${
                          version.qualityScore >= 80 ? 'text-green-600' :
                          version.qualityScore >= 60 ? 'text-yellow-600' : 'text-red-600'
                        }`}>
                          {version.qualityScore}%
                        </span>
                        {version.totalAttempts != null && version.totalAttempts > 1 && (
                          <span className="text-xs text-gray-400">({version.totalAttempts} attempts)</span>
                        )}
                      </div>
                    )}
                    {version.qualityReasoning && (
                      <div>
                        <div className="text-xs font-semibold text-gray-700">Quality Reasoning:</div>
                        <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-24 overflow-y-auto">
                          {version.qualityReasoning}
                        </pre>
                      </div>
                    )}
                    {version.fixTargets && version.fixTargets.length > 0 && (
                      <div>
                        <div className="text-xs font-semibold text-orange-700">
                          Fix Targets ({version.fixTargets.length}):
                        </div>
                        <ul className="text-xs text-gray-600 list-disc list-inside">
                          {version.fixTargets.map((ft, ftIdx) => (
                            <li key={ftIdx}>{ft.issue}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {version.referencePhotoNames && version.referencePhotoNames.length > 0 && (
                      <div className="text-xs text-gray-500">
                        Avatars: {version.referencePhotoNames.map(p => p.name).join(', ')}
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
        <div className="p-4 border-t border-gray-200 text-sm text-gray-500">
          {language === 'de' ? 'Klicken Sie auf ein Bild, um es auszuwählen' :
           language === 'fr' ? 'Cliquez sur une image pour la sélectionner' :
           'Click an image to select it'}
        </div>
      </div>
    </div>
  );
}
