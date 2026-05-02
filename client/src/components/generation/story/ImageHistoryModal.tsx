import { useState, useCallback, useEffect } from 'react';
import { Images, X, Check, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '@/context/LanguageContext';
import { ImageLightbox } from '@/components/common/ImageLightbox';
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
  grokRefImages?: string[] | null;  // Scene-level fallback for active version
  // Entity-consistency issues for this page (from finalChecksReport.entity).
  // These are page-scoped and apply to every version of the page — they're
  // not stored per-version, but they explain the entityPenalty deduction.
  entityIssues?: Array<{ name: string; severity: string; description: string; source: string }>;
}

export function ImageHistoryModal({
  pageNumber,
  coverType,
  versions,
  activeVersionIndex,
  onClose,
  onSelectVersion,
  developerMode = false,
  grokRefImages: sceneLevelGrokRefImages,
  entityIssues: pageEntityIssues,
}: ImageHistoryModalProps) {
  const { language } = useLanguage();
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [fullscreenIndex, setFullscreenIndex] = useState<number | null>(null);
  const [lightboxRef, setLightboxRef] = useState<string | null>(null);

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
                          ? 'bg-indigo-500 text-white'
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
                  {/* 1. METHOD HEADER — what produced this version */}
                  <div className="flex items-center justify-between gap-2 pb-2 border-b border-gray-200">
                    <div className="flex items-center gap-2">
                      <span className="text-xs uppercase tracking-wide font-semibold text-gray-500">
                        {language === 'de' ? 'Methode' : language === 'fr' ? 'Méthode' : 'Method'}
                      </span>
                      <span className="text-sm font-bold text-gray-800 uppercase">
                        {detailVersion.type || 'original'}
                      </span>
                      {detailVersion.modelId && (
                        <code className="text-xs bg-gray-100 px-1 rounded text-gray-600">{detailVersion.modelId}</code>
                      )}
                    </div>
                    {detailVersion.evaluatedAt && (
                      <span className="text-xs text-gray-400">{new Date(detailVersion.evaluatedAt).toLocaleString()}</span>
                    )}
                  </div>

                  {/* 2. REPAIR INSTRUCTION — what was sent to Grok to PRODUCE this version */}
                  {detailVersion.inpaintInstruction && (
                    <div>
                      <div className="text-xs font-medium text-amber-700 mb-1">
                        {language === 'de' ? 'Reparatur-Anweisung (an Grok)' : language === 'fr' ? 'Instruction de réparation (à Grok)' : 'Repair instruction (to Grok)'}
                      </div>
                      <p className="text-xs text-gray-700 bg-amber-50 rounded p-2 border border-amber-200 whitespace-pre-wrap">
                        {detailVersion.inpaintInstruction}
                      </p>
                    </div>
                  )}

                  {/* 3. REFERENCE IMAGES — what Grok received as visual context */}
                  {detailVersion.inpaintReferenceImages && detailVersion.inpaintReferenceImages.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-orange-700 mb-1">
                        {language === 'de' ? 'Referenzbilder (Reparatur)' : 'Reference images (repair)'} ({detailVersion.inpaintReferenceImages.length})
                      </div>
                      <div className="flex gap-1.5 flex-wrap">
                        {detailVersion.inpaintReferenceImages.map((img, idx) => (
                          <img key={idx} src={img} alt={`Ref ${idx + 1}`} className="h-24 rounded border border-orange-200 cursor-pointer hover:opacity-80 transition-opacity" title="Click to enlarge" onClick={() => setLightboxRef(img)} />
                        ))}
                      </div>
                    </div>
                  )}
                  {(() => {
                    const refs = detailVersion.grokRefImages || (detailVersion.isActive ? sceneLevelGrokRefImages : null);
                    if (!refs || refs.length === 0) return null;
                    return (
                      <div>
                        <div className="text-xs font-medium text-orange-600 mb-1">
                          {language === 'de' ? 'An Grok API gesendet' : 'Sent to Grok API'} ({refs.length}/3 slots)
                        </div>
                        <div className="flex gap-1.5">
                          {refs.map((img, idx) => (
                            <img key={idx} src={img} alt={`Slot ${idx + 1}`} className="h-24 rounded border border-orange-200 cursor-pointer hover:opacity-80 transition-opacity" title="Click to enlarge" onClick={() => setLightboxRef(img)} />
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  {detailVersion.referencePhotoNames && detailVersion.referencePhotoNames.length > 0 && (
                    <div className="text-xs text-gray-500">
                      Avatars: {detailVersion.referencePhotoNames.map(p => p.name).join(', ')}
                    </div>
                  )}

                  {/* 4. FINAL SCORE + PENALTIES (each evaluator's deduction, same scale) */}
                  {detailVersion.qualityScore != null && (() => {
                    const rawQ = detailVersion.rawQualityScore ?? detailVersion.qualityScore;
                    const qualityPenalty = Math.max(0, 100 - rawQ);
                    const semanticPenalty = detailVersion.semanticScore != null ? Math.max(0, 100 - detailVersion.semanticScore) : null;
                    const entityPenalty = detailVersion.entityPenalty || 0;
                    const penaltyClass = (p: number) => p === 0 ? 'text-green-600' : p >= 30 ? 'text-red-600' : p >= 15 ? 'text-orange-600' : 'text-yellow-600';
                    return (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-3 text-sm">
                          <span className="font-semibold text-gray-700">{language === 'de' ? 'Endwert:' : 'Final:'}</span>
                          <span className={`font-bold text-lg ${scoreColor(detailVersion.qualityScore)}`}>
                            {detailVersion.qualityScore}%
                          </span>
                          {detailVersion.totalAttempts != null && detailVersion.totalAttempts > 1 && (
                            <span className="text-gray-400">({detailVersion.totalAttempts} attempts)</span>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-xs">
                          <div className="bg-gray-50 rounded-lg p-2 border border-gray-200">
                            <div className="text-gray-500 font-medium mb-0.5">{language === 'de' ? 'Qualitäts-Eval' : 'Quality eval'}</div>
                            <div className={`font-bold text-base ${penaltyClass(qualityPenalty)}`}>
                              {qualityPenalty === 0 ? '0' : `-${qualityPenalty}`}
                            </div>
                            <div className="text-gray-400">{language === 'de' ? 'Abzug' : 'penalty'}</div>
                          </div>
                          <div className="bg-indigo-50 rounded-lg p-2 border border-indigo-200">
                            <div className="text-indigo-500 font-medium mb-0.5">{language === 'de' ? 'Semantik' : 'Semantic'}</div>
                            <div className={`font-bold text-base ${semanticPenalty == null ? 'text-gray-400' : penaltyClass(semanticPenalty)}`}>
                              {semanticPenalty == null ? 'n/a' : (semanticPenalty === 0 ? '0' : `-${semanticPenalty}`)}
                            </div>
                            <div className="text-indigo-400">{language === 'de' ? 'Abzug' : 'penalty'}</div>
                          </div>
                          <div className="bg-orange-50 rounded-lg p-2 border border-orange-200">
                            <div className="text-orange-500 font-medium mb-0.5">{language === 'de' ? 'Entität+Checks' : 'Entity+checks'}</div>
                            <div className={`font-bold text-base ${penaltyClass(entityPenalty)}`}>
                              {entityPenalty === 0 ? '0' : `-${entityPenalty}`}
                            </div>
                            <div className="text-orange-400">{language === 'de' ? 'Abzug' : 'penalty'}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* 5. ALL FLAGGED ISSUES — grouped by source, severity badges */}
                  {(() => {
                    const fixable = detailVersion.fixableIssues || [];
                    const semanticOnly = (detailVersion.semanticResult?.semanticIssues || [])
                      .filter(s => !fixable.some(f => (f.description || '').toLowerCase().includes((s.problem || '').slice(0, 30).toLowerCase())))
                      .map(s => ({ description: s.problem, severity: s.severity, source: 'semantic', type: 'semantic' as string, fix: '' }));
                    // Entity issues are page-scoped (from finalChecksReport.entity), shared
                    // across all versions of the page. They explain the entityPenalty.
                    const entityFromPage = (pageEntityIssues || []).map(e => ({
                      description: e.description,
                      severity: e.severity,
                      source: 'entity check',
                      type: e.source,
                      fix: '',
                      character: e.name,
                    }));
                    const allIssues: any[] = [...fixable, ...semanticOnly, ...entityFromPage];
                    if (allIssues.length === 0) return null;

                    const sevRank = (s: string) => {
                      const v = String(s || '').toLowerCase();
                      if (v === 'critical') return 4;
                      if (v === 'major') return 3;
                      if (v === 'moderate') return 2;
                      if (v === 'minor') return 1;
                      return 0;
                    };

                    // Group by source. Order matters: quality eval first (broadest),
                    // then semantic, then entity, then image checks.
                    const SOURCE_ORDER = ['quality eval', 'three-stage', 'semantic', 'entity check', 'image checks'];
                    const SOURCE_META: Record<string, { label: string; subtitle: string; bg: string; border: string; labelColor: string }> = {
                      'quality eval':  { label: language === 'de' ? 'Qualitäts-Eval (Gemini Vision)'  : 'Quality eval (Gemini vision)',     subtitle: language === 'de' ? 'image-evaluation.txt'         : 'from image-evaluation.txt',                       bg: 'bg-gray-50',    border: 'border-gray-300',    labelColor: 'text-gray-700' },
                      'three-stage':   { label: language === 'de' ? 'Compliance-Eval (Sonnet)'         : 'Compliance eval (Sonnet 2-stage)',  subtitle: language === 'de' ? 'image-vision-inventory + image-prompt-compliance.txt' : 'image-vision-inventory + image-prompt-compliance.txt', bg: 'bg-blue-50',    border: 'border-blue-300',    labelColor: 'text-blue-700' },
                      'semantic':      { label: language === 'de' ? 'Semantik-Prüfung'                 : 'Semantic check',                    subtitle: language === 'de' ? 'image-semantic.txt'           : 'from image-semantic.txt',                          bg: 'bg-indigo-50',  border: 'border-indigo-300',  labelColor: 'text-indigo-700' },
                      'entity check':  { label: language === 'de' ? 'Charakter-Konsistenz'              : 'Entity consistency',                subtitle: language === 'de' ? 'entityConsistency.js'         : 'from entityConsistency.js',                        bg: 'bg-orange-50',  border: 'border-orange-300',  labelColor: 'text-orange-700' },
                      'image checks':  { label: language === 'de' ? 'Bild-Checks'                       : 'Image checks',                      subtitle: language === 'de' ? 'Text-Overlay & Ränder'        : 'text overlay & borders',                           bg: 'bg-amber-50',   border: 'border-amber-300',   labelColor: 'text-amber-700' },
                    };
                    // Issues stored on a version's fixableIssues come straight from the
                    // per-image Gemini quality evaluator — they carry `type` (composition,
                    // scale, hair, …) but no `source` field; that's only attached at the
                    // orchestration layer when issues from multiple evaluators are merged.
                    // So when `source` is missing, the issue is from the quality eval.
                    // Semantic issues (added via the merge above) and entity/image-check
                    // issues (added by the orchestrator) DO carry `source`.
                    const grouped = new Map<string, any[]>();
                    for (const it of allIssues) {
                      const src = it.source || 'quality eval';
                      if (!grouped.has(src)) grouped.set(src, []);
                      grouped.get(src)!.push(it);
                    }
                    const orderedSources = [
                      ...SOURCE_ORDER.filter(s => grouped.has(s)),
                      ...[...grouped.keys()].filter(s => !SOURCE_ORDER.includes(s)),
                    ];

                    return (
                      <div className="bg-white rounded-lg border border-gray-200">
                        <div className="px-3 pt-2 pb-1 text-xs font-semibold text-gray-700">
                          {language === 'de' ? 'Gefundene Probleme' : language === 'fr' ? 'Problèmes détectés' : 'Issues found'} ({allIssues.length})
                        </div>
                        <div className="px-3 pb-3 space-y-3">
                          {orderedSources.map((src) => {
                            const meta = SOURCE_META[src] || { label: src, subtitle: '', bg: 'bg-gray-50', border: 'border-gray-300', labelColor: 'text-gray-700' };
                            const items = [...grouped.get(src)!].sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
                            return (
                              <div key={src} className={`${meta.bg} ${meta.border} border rounded p-2`}>
                                <div className={`text-[11px] font-bold uppercase tracking-wide ${meta.labelColor} mb-1.5 flex items-baseline gap-2`}>
                                  <span>{meta.label}</span>
                                  <span className="text-[10px] font-normal normal-case tracking-normal text-gray-500">{meta.subtitle}</span>
                                  <span className="text-[10px] font-normal text-gray-400 ml-auto">{items.length}</span>
                                </div>
                                <ul className="space-y-1">
                                  {items.map((issue: any, idx: number) => {
                                    const sev = String(issue.severity || '').toLowerCase();
                                    const cls = sev === 'critical' ? 'bg-red-200 text-red-800'
                                      : sev === 'major' ? 'bg-orange-200 text-orange-800'
                                      : sev === 'moderate' ? 'bg-yellow-200 text-yellow-800'
                                      : sev === 'minor' ? 'bg-gray-200 text-gray-700'
                                      : 'bg-gray-200 text-gray-700';
                                    return (
                                      <li key={idx} className="flex items-start gap-2 text-xs">
                                        <span className={`shrink-0 px-1.5 py-0.5 rounded font-bold uppercase ${cls}`}>
                                          {issue.severity || 'unknown'}
                                        </span>
                                        <span className="text-gray-700">
                                          {issue.character && <span className="font-medium">{issue.character}: </span>}
                                          {issue.description}
                                        </span>
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* 6. SEMANTIC DETAILS — collapsed (visible vs expected grids) */}
                  {detailVersion.semanticResult?.visible && (
                    <DetailBlock label={language === 'de' ? 'Semantik-Details' : 'Semantic details'} color="purple">
                      {[
                        '👁️ VISIBLE',
                        (detailVersion.semanticResult.visible.characters?.length ?? 0) > 0 ? `  Characters: ${detailVersion.semanticResult.visible.characters?.join(', ')}` : null,
                        (detailVersion.semanticResult.visible.objects?.length ?? 0) > 0 ? `  Objects: ${detailVersion.semanticResult.visible.objects?.join(', ')}` : null,
                        detailVersion.semanticResult.visible.setting ? `  Setting: ${detailVersion.semanticResult.visible.setting}` : null,
                        detailVersion.semanticResult.visible.action ? `  Action: ${detailVersion.semanticResult.visible.action}` : null,
                        '',
                        '🎯 EXPECTED',
                        (detailVersion.semanticResult.expected?.characters?.length ?? 0) > 0 ? `  Characters: ${detailVersion.semanticResult.expected?.characters?.join(', ')}` : null,
                        (detailVersion.semanticResult.expected?.objects?.length ?? 0) > 0 ? `  Objects: ${detailVersion.semanticResult.expected?.objects?.join(', ')}` : null,
                        detailVersion.semanticResult.expected?.setting ? `  Setting: ${detailVersion.semanticResult.expected.setting}` : null,
                        detailVersion.semanticResult.expected?.action ? `  Action: ${detailVersion.semanticResult.expected.action}` : null,
                      ].filter(Boolean).join('\n')}
                    </DetailBlock>
                  )}

                  {/* 6b. THREE-STAGE — Stage 1 vision inventory + Stage 2 compliance.
                       Stage 1 is the raw "what I see" text Gemini wrote BEFORE any
                       comparison to the prompt; useful for debugging eval misses
                       (e.g. a leap that read as "flying not jumping"). */}
                  {detailVersion.threeStageResult?.visionInventory && (
                    <DetailBlock label={language === 'de' ? 'Stage 1 — Bild-Inventar (Gemini Vision)' : 'Stage 1 — Vision inventory (Gemini Vision)'} color="purple">
                      {detailVersion.threeStageResult.visionInventory}
                    </DetailBlock>
                  )}
                  {detailVersion.threeStageResult?.complianceResult && (
                    <DetailBlock label={language === 'de' ? 'Stage 2 — Konformitäts-Prüfung (Sonnet)' : 'Stage 2 — Prompt compliance (Sonnet)'} color="purple">
                      {(() => {
                        try {
                          return JSON.stringify(detailVersion.threeStageResult.complianceResult, null, 2);
                        } catch {
                          return String(detailVersion.threeStageResult.complianceResult);
                        }
                      })()}
                    </DetailBlock>
                  )}

                  {/* 7. QUALITY REASONING — collapsed */}
                  {detailVersion.qualityReasoning && (
                    <DetailBlock label={language === 'de' ? 'Qualitäts-Begründung' : 'Quality reasoning'} color="gray">
                      {detailVersion.qualityReasoning}
                    </DetailBlock>
                  )}

                  {/* 8. ISSUES SUMMARY — short digest */}
                  {detailVersion.issuesSummary && (
                    <div className="text-sm text-gray-600 italic bg-yellow-50 p-2 rounded border border-yellow-200">
                      {detailVersion.issuesSummary}
                    </div>
                  )}

                  {/* Misc dev info, collapsed */}
                  {detailVersion.userInput && (
                    <DetailBlock label={language === 'de' ? 'Benutzer-Eingabe' : 'User input'} color="purple">
                      {detailVersion.userInput}
                    </DetailBlock>
                  )}
                  {detailVersion.description && (
                    <DetailBlock label={language === 'de' ? 'Erweiterte Szene' : 'Expanded scene'} color="amber">
                      {detailVersion.description}
                    </DetailBlock>
                  )}
                  {detailVersion.prompt && (
                    <DetailBlock label={language === 'de' ? 'API-Prompt' : 'API prompt'} color="blue">
                      {detailVersion.prompt}
                    </DetailBlock>
                  )}
                  {detailVersion.textSpaceCoveragePct != null && (
                    <div className="text-xs text-gray-500">
                      Text-space coverage: <span className="font-semibold text-gray-700">{detailVersion.textSpaceCoveragePct}%</span>
                      {detailVersion.textSpacePosition && <span className="ml-1 text-gray-400">({detailVersion.textSpacePosition})</span>}
                    </div>
                  )}

                  {/* 9. NEXT REPAIR — what was selected and sent for the next version */}
                  {(() => {
                    const next = versions[detailIndex + 1];
                    if (!next) return null;
                    const nextLabel = next.type ? String(next.type).toUpperCase() : 'REPAIR';
                    return (
                      <div className="mt-3 pt-3 border-t-2 border-dashed border-gray-300">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs uppercase tracking-wide font-semibold text-gray-500">
                            {language === 'de' ? 'Nächste Runde' : language === 'fr' ? 'Prochain tour' : 'Next round'}
                          </span>
                          <span className="text-sm font-bold text-gray-800">→ {nextLabel}</span>
                          {next.modelId && <code className="text-xs bg-gray-100 px-1 rounded text-gray-600">{next.modelId}</code>}
                        </div>
                        {next.inpaintInstruction ? (
                          <p className="text-xs text-gray-700 bg-amber-50 rounded p-2 border border-amber-200 whitespace-pre-wrap">
                            {next.inpaintInstruction}
                          </p>
                        ) : (
                          <p className="text-xs text-gray-500 italic">
                            {language === 'de' ? '(volle Neugenerierung – kein Inpaint-Befehl)' : '(full re-render — no inpaint instruction)'}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Lightbox for Grok reference images */}
      <ImageLightbox src={lightboxRef} onClose={() => setLightboxRef(null)} />
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
