import { useState, useCallback, useEffect } from 'react';
import { Images, X, Check, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from 'lucide-react';
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
  activeVersionIndex?: number;
  onClose: () => void;
  onSelectVersion: (pageNumberOrCoverType: number | string, versionIndex: number) => void;
  developerMode?: boolean;
}

export function ImageHistoryModal({
  pageNumber,
  coverType,
  versions,
  activeVersionIndex,
  onClose,
  onSelectVersion,
  developerMode = false,
}: ImageHistoryModalProps) {
  const { language } = useLanguage();
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null);

  const getTitle = () => {
    if (coverType) {
      const labels = COVER_LABELS[coverType];
      const label = language === 'de' ? labels.de : language === 'fr' ? labels.fr : labels.en;
      return language === 'de' ? `Bild wählen - ${label}` :
             language === 'fr' ? `Choisir image - ${label}` :
             `Select Image - ${label}`;
    }
    return language === 'de' ? `Bild wählen - Seite ${pageNumber}` :
           language === 'fr' ? `Choisir image - Page ${pageNumber}` :
           `Select Image - Page ${pageNumber}`;
  };

  const handleSelect = (idx: number) => {
    const version = versions[idx];
    const effectiveIndex = version?.versionIndex ?? idx;
    if (coverType) {
      onSelectVersion(coverType, effectiveIndex);
    } else if (pageNumber !== undefined) {
      onSelectVersion(pageNumber, effectiveIndex);
    }
  };

  const versionLabel = (idx: number) => idx === 0 ? 'Original' : `V${idx + 1}`;

  const scoreBgColor = (score: number) =>
    score >= 80 ? 'bg-green-600' : score >= 60 ? 'bg-yellow-600' : 'bg-red-600';

  const scoreColor = (score: number) =>
    score >= 80 ? 'text-green-600' : score >= 60 ? 'text-yellow-600' : 'text-red-600';

  // Fullscreen navigation
  const goNext = useCallback(() => {
    if (fullscreenIndex !== null && fullscreenIndex < versions.length - 1) {
      setFullscreenIndex(fullscreenIndex + 1);
    }
  }, [fullscreenIndex, versions.length]);

  const goPrev = useCallback(() => {
    if (fullscreenIndex !== null && fullscreenIndex > 0) {
      setFullscreenIndex(fullscreenIndex - 1);
    }
  }, [fullscreenIndex]);

  // Keyboard navigation in fullscreen
  useEffect(() => {
    if (fullscreenIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goNext();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') goPrev();
      else if (e.key === 'Escape') setFullscreenIndex(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreenIndex, goNext, goPrev]);

  // Touch swipe support
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const handleTouchStart = (e: React.TouchEvent) => setTouchStart(e.touches[0].clientX);
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const diff = touchStart - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) {
      if (diff > 0) goNext();
      else goPrev();
    }
    setTouchStart(null);
  };

  const detailVersion = detailIndex !== null ? versions[detailIndex] : null;

  return (
    <>
      {/* Fullscreen image viewer with swipe */}
      {fullscreenIndex !== null && versions[fullscreenIndex] && (
        <div
          className="fixed inset-0 bg-black z-[60] flex flex-col"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Top bar */}
          <div className="flex items-center justify-between px-4 py-2 bg-black/80 shrink-0">
            <span className="text-white text-sm font-medium">
              {versionLabel(fullscreenIndex)} ({fullscreenIndex + 1}/{versions.length})
              {developerMode && versions[fullscreenIndex].qualityScore != null && (
                <span className={`ml-2 text-xs font-bold px-1.5 py-0.5 rounded ${scoreBgColor(versions[fullscreenIndex].qualityScore!)}`}>
                  {versions[fullscreenIndex].qualityScore}%
                </span>
              )}
            </span>
            <button onClick={() => setFullscreenIndex(null)} className="text-white p-1.5 hover:bg-white/20 rounded-lg">
              <X size={20} />
            </button>
          </div>

          {/* Image area */}
          <div className="flex-1 flex items-center justify-center relative min-h-0">
            {/* Left arrow */}
            {fullscreenIndex > 0 && (
              <button onClick={goPrev} className="absolute left-2 z-10 bg-black/50 hover:bg-black/70 text-white p-2 rounded-full">
                <ChevronLeft size={24} />
              </button>
            )}

            <img
              src={versions[fullscreenIndex].imageData}
              alt={versionLabel(fullscreenIndex)}
              className="max-w-full max-h-full object-contain"
            />

            {/* Right arrow */}
            {fullscreenIndex < versions.length - 1 && (
              <button onClick={goNext} className="absolute right-2 z-10 bg-black/50 hover:bg-black/70 text-white p-2 rounded-full">
                <ChevronRight size={24} />
              </button>
            )}
          </div>

          {/* Bottom bar with select/active button */}
          <div className="px-4 py-3 bg-black/80 flex items-center justify-between shrink-0">
            {/* Dots indicator */}
            <div className="flex gap-1.5">
              {versions.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setFullscreenIndex(i)}
                  className={`w-2.5 h-2.5 rounded-full transition-colors ${
                    i === fullscreenIndex ? 'bg-white' :
                    (activeVersionIndex != null ? i === activeVersionIndex : i === versions.length - 1) ? 'bg-green-500' : 'bg-white/30'
                  }`}
                />
              ))}
            </div>

            {/* Select button */}
            {(() => {
              const isActive = activeVersionIndex != null ? fullscreenIndex === activeVersionIndex : fullscreenIndex === versions.length - 1;
              return isActive ? (
                <span className="bg-green-500 text-white text-sm font-bold px-4 py-1.5 rounded-lg flex items-center gap-1.5">
                  <Check size={14} />
                  {language === 'de' ? 'Aktiv' : language === 'fr' ? 'Actif' : 'Active'}
                </span>
              ) : (
                <button
                  onClick={() => { handleSelect(fullscreenIndex); setFullscreenIndex(null); }}
                  className="bg-white text-gray-800 text-sm font-semibold px-4 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  {language === 'de' ? 'Dieses Bild verwenden' : language === 'fr' ? 'Utiliser cette image' : 'Use this image'}
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {/* Grid modal */}
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
        <div className="bg-white rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
          {/* Header */}
          <div className="px-3 sm:px-5 py-2.5 border-b border-gray-200 flex items-center justify-between shrink-0">
            <h3 className="text-base sm:text-lg font-bold text-gray-800 flex items-center gap-2">
              <Images size={18} />
              {getTitle()}
            </h3>
            <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <X size={20} />
            </button>
          </div>

          {/* Version grid — tighter on mobile */}
          <div className="flex-1 overflow-y-auto p-2 sm:p-5">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 sm:gap-4">
              {versions.map((version, idx) => {
                const isActiveVersion = activeVersionIndex != null ? idx === activeVersionIndex : idx === versions.length - 1;
                return (
                <div
                  key={idx}
                  className={`relative rounded-lg overflow-hidden border transition-all ${
                    isActiveVersion
                      ? 'border-green-500 sm:border-2 sm:ring-2 sm:ring-green-200'
                      : 'border-gray-200 hover:border-indigo-400 hover:shadow-md'
                  }`}
                >
                  {/* Image — click opens fullscreen viewer */}
                  <img
                    src={version.imageData}
                    alt={versionLabel(idx)}
                    className="w-full aspect-square object-cover cursor-pointer"
                    onClick={() => setFullscreenIndex(idx)}
                  />

                  {/* Overlay bar — compact on mobile */}
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-black/0 pt-6 sm:pt-8 pb-1.5 sm:pb-3 px-1.5 sm:px-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1 sm:gap-2">
                        <span className="text-white text-xs sm:text-sm font-semibold">{versionLabel(idx)}</span>
                        {developerMode && version.qualityScore != null && (
                          <span className={`text-white text-[10px] sm:text-[11px] font-bold px-1 sm:px-1.5 py-0.5 rounded ${scoreBgColor(version.qualityScore)}`}>
                            {version.qualityScore}%
                          </span>
                        )}
                      </div>
                      {isActiveVersion ? (
                        <span className="bg-green-500 text-white text-[10px] sm:text-xs font-bold px-1.5 sm:px-2 py-0.5 sm:py-1 rounded flex items-center gap-0.5">
                          <Check size={10} className="sm:w-3 sm:h-3" />
                          {language === 'de' ? 'Aktiv' : language === 'fr' ? 'Actif' : 'Active'}
                        </span>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSelect(idx); }}
                          className="bg-white/90 hover:bg-white text-gray-800 text-[10px] sm:text-sm font-medium px-2 sm:px-3 py-0.5 sm:py-1 rounded transition-colors cursor-pointer"
                        >
                          {language === 'de' ? 'Wählen' : language === 'fr' ? 'Choisir' : 'Select'}
                        </button>
                      )}
                    </div>
                    <div className="text-[9px] sm:text-[11px] text-gray-300 mt-0.5">
                      {version.createdAt && new Date(version.createdAt).toLocaleDateString()}
                      {version.type && version.type !== 'original' && (
                        <span className="ml-1 text-gray-400">({version.type})</span>
                      )}
                    </div>
                  </div>

                  {/* Dev mode: info button */}
                  {developerMode && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setDetailIndex(detailIndex === idx ? null : idx); }}
                      className={`absolute top-1 right-1 sm:top-2 sm:right-2 w-5 h-5 sm:w-7 sm:h-7 rounded-full flex items-center justify-center text-[10px] sm:text-xs font-bold transition-colors ${
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
                );
              })}
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
                  {detailVersion.qualityScore != null && (
                    <div className="space-y-2">
                      {/* Score breakdown as separate rows */}
                      <div className="flex flex-wrap items-center gap-3 text-sm">
                        <span className="font-semibold text-gray-700">Final:</span>
                        <span className={`font-bold text-lg ${scoreColor(detailVersion.qualityScore)}`}>
                          {detailVersion.qualityScore}%
                        </span>
                        {detailVersion.totalAttempts != null && detailVersion.totalAttempts > 1 && (
                          <span className="text-gray-400">({detailVersion.totalAttempts} attempts)</span>
                        )}
                        {detailVersion.evaluatedAt && (
                          <span className="text-xs text-gray-400 ml-auto">
                            {new Date(detailVersion.evaluatedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      {/* Individual score components */}
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        {/* Quality */}
                        <div className="bg-gray-50 rounded-lg p-2 border border-gray-200">
                          <div className="text-gray-500 font-medium mb-0.5">Quality</div>
                          <div className={`font-bold text-base ${scoreColor(detailVersion.rawQualityScore ?? detailVersion.qualityScore)}`}>
                            {detailVersion.rawQualityScore ?? detailVersion.qualityScore}%
                          </div>
                          <div className="text-gray-400">visual eval</div>
                        </div>
                        {/* Semantic */}
                        <div className="bg-indigo-50 rounded-lg p-2 border border-indigo-200">
                          <div className="text-indigo-500 font-medium mb-0.5">Semantic</div>
                          <div className={`font-bold text-base ${detailVersion.semanticScore != null ? (detailVersion.semanticScore >= 80 ? 'text-green-600' : detailVersion.semanticScore >= 60 ? 'text-yellow-600' : 'text-red-600') : 'text-gray-400'}`}>
                            {detailVersion.semanticScore != null ? `${detailVersion.semanticScore}%` : 'n/a'}
                          </div>
                          <div className="text-indigo-400">prompt match</div>
                        </div>
                        {/* Entity */}
                        <div className="bg-orange-50 rounded-lg p-2 border border-orange-200">
                          <div className="text-orange-500 font-medium mb-0.5">Entity</div>
                          <div className={`font-bold text-base ${detailVersion.entityPenalty ? 'text-orange-600' : 'text-green-600'}`}>
                            {detailVersion.entityPenalty ? `-${detailVersion.entityPenalty}` : '0'}
                          </div>
                          <div className="text-orange-400">penalty</div>
                        </div>
                      </div>
                      {/* Penalty details — show entity/image-check issues that contributed to penalties */}
                      {detailVersion.fixableIssues && detailVersion.fixableIssues.filter(i => i.source === 'entity check' || i.source === 'image checks').length > 0 && (
                        <div className="bg-orange-50 rounded-lg p-2 border border-orange-200">
                          <div className="text-xs font-medium text-orange-700 mb-1">Penalty details:</div>
                          <div className="space-y-1">
                            {detailVersion.fixableIssues.filter(i => i.source === 'entity check' || i.source === 'image checks').map((issue, idx) => (
                              <div key={idx} className="flex items-start gap-2 text-xs">
                                <span className={`shrink-0 px-1.5 py-0.5 rounded font-medium ${
                                  issue.severity === 'critical' ? 'bg-red-200 text-red-800' :
                                  issue.severity === 'major' ? 'bg-orange-200 text-orange-800' :
                                  'bg-yellow-200 text-yellow-800'
                                }`}>
                                  {issue.severity === 'critical' ? '-30' : issue.severity === 'major' ? '-20' : '-10'}
                                </span>
                                <span className="text-gray-700">
                                  {issue.character && <span className="font-medium">{issue.character}: </span>}
                                  {issue.description}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
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
    </>
  );
}

/** Collapsible text block for dev details */
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
