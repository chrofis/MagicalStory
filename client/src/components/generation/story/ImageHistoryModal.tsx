import { useState } from 'react';
import { Images, X, Check, ChevronDown, ChevronUp } from 'lucide-react';
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
  const activeIndex = versions.findIndex(v => v.isActive);
  const [focusedIndex, setFocusedIndex] = useState(activeIndex >= 0 ? activeIndex : 0);
  const [showDetails, setShowDetails] = useState(false);

  const focused = versions[focusedIndex];

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

  const handleSelect = () => {
    if (coverType) {
      onSelectVersion(coverType, focusedIndex);
    } else if (pageNumber !== undefined) {
      onSelectVersion(pageNumber, focusedIndex);
    }
  };

  const versionLabel = (idx: number) => idx === 0 ? 'Original' : `V${idx + 1}`;

  const scoreColor = (score: number) =>
    score >= 80 ? 'text-green-600' : score >= 60 ? 'text-yellow-600' : 'text-red-600';

  const scoreBgColor = (score: number) =>
    score >= 80 ? 'bg-green-600' : score >= 60 ? 'bg-yellow-600' : 'bg-red-600';

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-gray-50 shrink-0">
        <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
          <Images size={20} />
          {getTitle()}
        </h3>
        <button
          onClick={onClose}
          className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto px-4 py-4 flex flex-col gap-4">
          {/* Large preview */}
          <div className="relative w-full flex justify-center">
            <img
              src={focused?.imageData}
              alt={versionLabel(focusedIndex)}
              className="max-h-[55vh] w-auto rounded-lg shadow-lg object-contain"
            />
            {/* Active badge on preview */}
            {focused?.isActive && (
              <span className="absolute top-3 right-3 bg-green-500 text-white text-xs font-bold px-3 py-1 rounded-full flex items-center gap-1 shadow">
                <Check size={12} />
                {language === 'de' ? 'Aktiv' : language === 'fr' ? 'Actif' : 'Active'}
              </span>
            )}
          </div>

          {/* Version info + Select button */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-gray-700">
                {versionLabel(focusedIndex)}
              </span>
              {focused?.createdAt && (
                <span className="text-xs text-gray-400">
                  {new Date(focused.createdAt).toLocaleDateString()}
                </span>
              )}
              {developerMode && focused?.qualityScore != null && (
                <span className={`text-xs font-bold px-2 py-0.5 rounded text-white ${scoreBgColor(focused.qualityScore)}`}>
                  {focused.semanticScore != null || focused.entityPenalty
                    ? `Q:${Math.round(focused.qualityScore + (focused.entityPenalty || 0))} S:${focused.semanticScore ?? '?'} E:${focused.entityPenalty ? `-${focused.entityPenalty}` : '0'} → ${focused.qualityScore}%`
                    : `${focused.qualityScore}%`
                  }
                </span>
              )}
            </div>
            {!focused?.isActive && (
              <button
                onClick={handleSelect}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors flex items-center gap-1.5 shrink-0"
              >
                <Check size={14} />
                {language === 'de' ? 'Auswählen' : language === 'fr' ? 'Sélectionner' : 'Select'}
              </button>
            )}
          </div>

          {/* Horizontal thumbnail strip */}
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
            {versions.map((version, idx) => (
              <button
                key={idx}
                onClick={() => setFocusedIndex(idx)}
                className={`relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 transition-all ${
                  idx === focusedIndex
                    ? 'border-blue-500 ring-2 ring-blue-200'
                    : 'border-gray-200 hover:border-gray-400'
                }`}
              >
                <img
                  src={version.imageData}
                  alt={versionLabel(idx)}
                  className="w-full h-full object-cover"
                />
                {/* Active indicator */}
                {version.isActive && (
                  <span className="absolute top-0.5 right-0.5 bg-green-500 rounded-full p-0.5">
                    <Check size={8} className="text-white" />
                  </span>
                )}
                {/* Version label */}
                <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] text-center py-0.5">
                  {versionLabel(idx)}
                </span>
                {/* Score badge */}
                {developerMode && version.qualityScore != null && (
                  <span className={`absolute top-0.5 left-0.5 text-white text-[9px] font-bold px-1 rounded ${scoreBgColor(version.qualityScore)}`}>
                    {version.qualityScore}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Dev mode: expandable details for focused version */}
          {developerMode && focused && (
            <div className="border border-gray-200 rounded-lg">
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <span>
                  {language === 'de' ? 'Details' : language === 'fr' ? 'Détails' : 'Details'}
                  {' '} — {versionLabel(focusedIndex)}
                </span>
                {showDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
              {showDetails && (
                <div className="px-3 pb-3 space-y-2 border-t border-gray-100">
                  {focused.userInput && (
                    <div className="mt-2">
                      <div className="text-xs font-semibold text-purple-700">
                        {language === 'de' ? 'Benutzer-Eingabe:' : language === 'fr' ? 'Entrée utilisateur:' : 'User Input:'}
                      </div>
                      <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-purple-50 p-2 rounded border border-purple-200 max-h-24 overflow-y-auto">
                        {focused.userInput}
                      </pre>
                    </div>
                  )}
                  {focused.description && (
                    <div>
                      <div className="text-xs font-semibold text-amber-700">
                        {language === 'de' ? 'Erweiterte Szene:' : language === 'fr' ? 'Scène étendue:' : 'Expanded Scene:'}
                      </div>
                      <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-24 overflow-y-auto">
                        {focused.description}
                      </pre>
                    </div>
                  )}
                  {focused.prompt && (
                    <div>
                      <div className="text-xs font-semibold text-blue-700">
                        {language === 'de' ? 'API-Prompt:' : language === 'fr' ? 'Prompt API:' : 'API Prompt:'}
                      </div>
                      <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-32 overflow-y-auto">
                        {focused.prompt}
                      </pre>
                    </div>
                  )}
                  {focused.modelId && (
                    <div className="text-xs text-gray-500">Model: {focused.modelId}</div>
                  )}
                  {focused.qualityScore != null && (
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-gray-700">Final Score:</span>
                        <span className={`text-xs font-bold ${scoreColor(focused.qualityScore)}`}>
                          {focused.qualityScore}%
                        </span>
                        {focused.totalAttempts != null && focused.totalAttempts > 1 && (
                          <span className="text-xs text-gray-400">({focused.totalAttempts} attempts)</span>
                        )}
                      </div>
                      {focused.semanticScore != null && (
                        <div className="text-xs text-purple-600">
                          Semantic: {focused.semanticScore}%
                        </div>
                      )}
                      {focused.entityPenalty != null && focused.entityPenalty > 0 && (
                        <div className="text-xs text-orange-600">
                          Entity Penalty: -{focused.entityPenalty}
                        </div>
                      )}
                      {focused.evaluatedAt && (
                        <div className="text-xs text-gray-400">
                          Evaluated: {new Date(focused.evaluatedAt).toLocaleString()}
                        </div>
                      )}
                      {focused.issuesSummary && (
                        <div className="text-xs text-gray-500 italic">{focused.issuesSummary}</div>
                      )}
                    </div>
                  )}
                  {focused.qualityReasoning && (
                    <div>
                      <div className="text-xs font-semibold text-gray-700">Quality Reasoning:</div>
                      <pre className="text-xs text-gray-600 whitespace-pre-wrap bg-white p-2 rounded border border-gray-200 max-h-24 overflow-y-auto">
                        {focused.qualityReasoning}
                      </pre>
                    </div>
                  )}
                  {focused.fixTargets && focused.fixTargets.length > 0 && (
                    <div>
                      <div className="text-xs font-semibold text-orange-700">
                        Fix Targets ({focused.fixTargets.length}):
                      </div>
                      <ul className="text-xs text-gray-600 list-disc list-inside">
                        {focused.fixTargets.map((ft, ftIdx) => (
                          <li key={ftIdx}>{ft.issue}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {focused.referencePhotoNames && focused.referencePhotoNames.length > 0 && (
                    <div className="text-xs text-gray-500">
                      Avatars: {focused.referencePhotoNames.map(p => p.name).join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
