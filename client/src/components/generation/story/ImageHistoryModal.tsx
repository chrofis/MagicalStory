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
  const [detailIndex, setDetailIndex] = useState<number | null>(null);

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

  const handleSelect = (idx: number) => {
    if (coverType) {
      onSelectVersion(coverType, idx);
    } else if (pageNumber !== undefined) {
      onSelectVersion(pageNumber, idx);
    }
  };

  const versionLabel = (idx: number) => idx === 0 ? 'Original' : `V${idx + 1}`;

  const scoreBgColor = (score: number) =>
    score >= 80 ? 'bg-green-600' : score >= 60 ? 'bg-yellow-600' : 'bg-red-600';

  const scoreColor = (score: number) =>
    score >= 80 ? 'text-green-600' : score >= 60 ? 'text-yellow-600' : 'text-red-600';

  const detailVersion = detailIndex !== null ? versions[detailIndex] : null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between shrink-0">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Images size={20} />
            {getTitle()}
          </h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
            <X size={20} />
          </button>
        </div>

        {/* Version grid */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {versions.map((version, idx) => (
              <div
                key={idx}
                onClick={() => !version.isActive && handleSelect(idx)}
                className={`relative rounded-lg overflow-hidden border-2 transition-all ${
                  version.isActive
                    ? 'border-green-500 ring-2 ring-green-200'
                    : 'border-gray-200 hover:border-indigo-400 hover:shadow-md cursor-pointer active:scale-[0.98]'
                }`}
              >
                {/* Image */}
                <img
                  src={version.imageData}
                  alt={versionLabel(idx)}
                  className="w-full aspect-square object-cover"
                />

                {/* Overlay bar */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-black/0 pt-8 pb-3 px-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-white text-sm font-semibold">{versionLabel(idx)}</span>
                      {developerMode && version.qualityScore != null && (
                        <span className={`text-white text-[11px] font-bold px-1.5 py-0.5 rounded ${scoreBgColor(version.qualityScore)}`}>
                          {version.semanticScore != null || version.entityPenalty
                            ? `${version.qualityScore}%`
                            : `${version.qualityScore}%`
                          }
                        </span>
                      )}
                    </div>
                    {version.isActive ? (
                      <span className="bg-green-500 text-white text-xs font-bold px-2 py-1 rounded flex items-center gap-1">
                        <Check size={12} />
                        {language === 'de' ? 'Aktiv' : language === 'fr' ? 'Actif' : 'Active'}
                      </span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleSelect(idx); }}
                        className="bg-white/90 hover:bg-white text-gray-800 text-sm font-medium px-4 py-2 min-h-[44px] min-w-[44px] rounded transition-colors"
                      >
                        {language === 'de' ? 'Auswählen' : language === 'fr' ? 'Sélectionner' : 'Select'}
                      </button>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-300 mt-1">
                    {version.createdAt && new Date(version.createdAt).toLocaleDateString()}
                    {version.type && version.type !== 'original' && (
                      <span className="ml-1.5 text-gray-400">({version.type})</span>
                    )}
                  </div>
                </div>

                {/* Dev mode: info button */}
                {developerMode && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setDetailIndex(detailIndex === idx ? null : idx); }}
                    className={`absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                      detailIndex === idx
                        ? 'bg-indigo-600 text-white'
                        : 'bg-black/50 text-white hover:bg-black/70'
                    }`}
                    title="Show details"
                  >
                    i
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Dev mode: detail panel for selected version */}
          {developerMode && detailVersion && detailIndex !== null && (
            <div className="mt-5 border border-gray-200 rounded-lg bg-gray-50">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-200">
                <span className="text-sm font-semibold text-gray-700">
                  {language === 'de' ? 'Details' : language === 'fr' ? 'Détails' : 'Details'}
                  {' — '}{versionLabel(detailIndex)}
                </span>
                <button onClick={() => setDetailIndex(null)} className="p-1 hover:bg-gray-200 rounded">
                  <X size={14} />
                </button>
              </div>
              <div className="p-4 space-y-3">
                {/* Scores row */}
                {detailVersion.qualityScore != null && (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <span className="font-semibold text-gray-700">Final:</span>
                    <span className={`font-bold ${scoreColor(detailVersion.qualityScore)}`}>
                      {detailVersion.qualityScore}%
                    </span>
                    {detailVersion.semanticScore != null && (
                      <>
                        <span className="text-gray-400">|</span>
                        <span className="text-indigo-600">Semantic: {detailVersion.semanticScore}%</span>
                      </>
                    )}
                    {detailVersion.entityPenalty != null && detailVersion.entityPenalty > 0 && (
                      <>
                        <span className="text-gray-400">|</span>
                        <span className="text-orange-600">Entity: -{detailVersion.entityPenalty}</span>
                      </>
                    )}
                    {detailVersion.totalAttempts != null && detailVersion.totalAttempts > 1 && (
                      <span className="text-gray-400">({detailVersion.totalAttempts} attempts)</span>
                    )}
                    {detailVersion.evaluatedAt && (
                      <span className="text-xs text-gray-400 ml-auto">
                        {new Date(detailVersion.evaluatedAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                )}
                {detailVersion.issuesSummary && (
                  <div className="text-sm text-gray-600 italic bg-yellow-50 p-2 rounded border border-yellow-200">
                    {detailVersion.issuesSummary}
                  </div>
                )}
                {detailVersion.modelId && (
                  <div className="text-sm text-gray-500">Model: <code className="bg-gray-100 px-1 rounded">{detailVersion.modelId}</code></div>
                )}
                {detailVersion.userInput && (
                  <DetailBlock
                    label={language === 'de' ? 'Benutzer-Eingabe' : language === 'fr' ? 'Entrée utilisateur' : 'User Input'}
                    color="purple"
                  >
                    {detailVersion.userInput}
                  </DetailBlock>
                )}
                {detailVersion.description && (
                  <DetailBlock
                    label={language === 'de' ? 'Erweiterte Szene' : language === 'fr' ? 'Scène étendue' : 'Expanded Scene'}
                    color="amber"
                  >
                    {detailVersion.description}
                  </DetailBlock>
                )}
                {detailVersion.prompt && (
                  <DetailBlock
                    label={language === 'de' ? 'API-Prompt' : language === 'fr' ? 'Prompt API' : 'API Prompt'}
                    color="blue"
                  >
                    {detailVersion.prompt}
                  </DetailBlock>
                )}
                {detailVersion.qualityReasoning && (
                  <DetailBlock label="Quality Reasoning" color="gray">
                    {detailVersion.qualityReasoning}
                  </DetailBlock>
                )}
                {detailVersion.fixTargets && detailVersion.fixTargets.length > 0 && (
                  <div>
                    <div className="text-sm font-semibold text-orange-700 mb-1">
                      Fix Targets ({detailVersion.fixTargets.length}):
                    </div>
                    <ul className="text-sm text-gray-600 list-disc list-inside space-y-0.5">
                      {detailVersion.fixTargets.map((ft, ftIdx) => (
                        <li key={ftIdx}>{ft.issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {detailVersion.referencePhotoNames && detailVersion.referencePhotoNames.length > 0 && (
                  <div className="text-sm text-gray-500">
                    Avatars: {detailVersion.referencePhotoNames.map(p => p.name).join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Collapsible text block for dev details — larger max-height for readability */
function DetailBlock({ label, color, children }: { label: string; color: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const colorMap: Record<string, { label: string; bg: string; border: string }> = {
    purple: { label: 'text-indigo-700', bg: 'bg-indigo-50', border: 'border-indigo-200' },
    amber: { label: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' },
    blue: { label: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200' },
    gray: { label: 'text-gray-700', bg: 'bg-gray-50', border: 'border-gray-200' },
  };
  const c = colorMap[color] || colorMap.gray;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className={`text-sm font-semibold ${c.label} flex items-center gap-1`}
      >
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        {label}
      </button>
      {expanded && (
        <pre className={`mt-1 text-sm text-gray-700 whitespace-pre-wrap ${c.bg} p-3 rounded border ${c.border} max-h-64 overflow-y-auto`}>
          {children}
        </pre>
      )}
    </div>
  );
}
