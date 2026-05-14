import { useState, useCallback } from 'react';
import type { ReferencePhoto } from '@/types/story';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import storyService from '@/services/storyService';

interface LandmarkPhoto {
  name: string;
  photoData?: string;  // Inline data URI (legacy / pre-R2)
  photoUrl?: string;   // R2 URL (post-Phase-2 migration); browser loads directly
  hasPhoto?: boolean;  // Flag when photoData is stripped
  attribution?: string;
  source?: string;
}

interface CompositeAttempt {
  pass: number;
  input?: string | null;
  vbGrid?: string | null;  // VB grid second-image reference for pass 1
  output?: string | null;
  prompt?: string | null;
  modelId?: string | null;
  elapsedMs?: number | null;
}

interface ReferencePhotosDisplayProps {
  referencePhotos: ReferencePhoto[];
  landmarkPhotos?: LandmarkPhoto[];
  visualBibleGrid?: string;  // Base64 data URL of combined VB elements grid
  hasVisualBibleGrid?: boolean;  // Flag when visualBibleGrid is stripped (for lazy loading)
  grokRefImages?: string[] | null;  // Exact packed images sent to Grok API (max 3)
  compositeAttempts?: CompositeAttempt[] | null;  // 2-pass composite cover debug
  emptySceneImage?: string | null;  // Pre-generated empty scene (Pass 1)
  emptyScenePrompt?: string | null;  // Prompt used for empty scene
  hasEmptySceneImage?: boolean;  // Flag when emptySceneImage is stripped (for lazy loading)
  hasCompositeStages?: boolean;  // Flag when scene-composite intermediates exist (lazy load)
  compositeBboxes?: Record<string, { x: number; y: number; width: number; height: number }> | null;  // Per-character bbox metadata from blocking pass
  emptySceneQc?: { v1ImageData?: string; v1Issues?: string[]; visionFeedback?: string; retryPrompt?: string } | null;
  textAreaMask?: string | null;  // Black/white mask sent to Grok marking the text-overlay calm zone
  emptySceneVbGrid?: string | null;  // Filtered VB grid (vehicles + non-landmark locations) sent to the empty-scene call — the main-scene visualBibleGrid is different
  textCoverageReport?: {
    words: number;
    fontPt: number;
    calmNeededPx: number;
    calmFoundPx: number;
    areaPx: number;
    passed: boolean;
    retriesUsed: number;
    winnerIndex: number;
    candidates: { index: number; source: string; calmFoundPx: number; calmPct: number; position: string }[];
    postRepairChecked?: boolean;
  } | null;
  language: string;
  // For lazy loading
  storyId?: string;
  pageNumber?: number;
}

/**
 * Component to display reference photos used for image generation
 */
export function ReferencePhotosDisplay({
  referencePhotos,
  landmarkPhotos,
  visualBibleGrid,
  hasVisualBibleGrid,
  grokRefImages,
  compositeAttempts,
  emptySceneImage,
  emptyScenePrompt,
  hasEmptySceneImage,
  hasCompositeStages,
  compositeBboxes,
  emptySceneQc,
  textAreaMask,
  emptySceneVbGrid,
  textCoverageReport,
  language,
  storyId,
  pageNumber
}: ReferencePhotosDisplayProps) {
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [loadedReferencePhotos, setLoadedReferencePhotos] = useState<ReferencePhoto[] | null>(null);
  const [loadedLandmarkPhotos, setLoadedLandmarkPhotos] = useState<LandmarkPhoto[] | null>(null);
  const [loadedVBGrid, setLoadedVBGrid] = useState<string | null>(null);
  const [loadedEmptyScene, setLoadedEmptyScene] = useState<{ image: string; prompt?: string } | null>(null);
  const [compositeStages, setCompositeStages] = useState<{
    clean_bg: string | null;
    blocking: string | null;
    composited: string | null;
    final: string | null;
    blockingPrompt: string | null;
  } | null>(null);
  const [compositeStagesLoading, setCompositeStagesLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Check if we need to lazy load (photos have hasPhoto flag but no actual data)
  const needsLazyLoadRef = referencePhotos?.some(p => p.hasPhoto && !p.photoUrl);
  const needsLazyLoadLandmark = landmarkPhotos?.some(p => p.hasPhoto && !p.photoData);
  const needsLazyLoadVBGrid = hasVisualBibleGrid && !visualBibleGrid;
  const needsLazyLoadEmptyScene = hasEmptySceneImage && !emptySceneImage;

  const loadImages = useCallback(async () => {
    if (!storyId || !pageNumber || isLoading) return;
    if (!needsLazyLoadRef && !needsLazyLoadLandmark && !needsLazyLoadVBGrid && !needsLazyLoadEmptyScene) return;

    setIsLoading(true);
    setLoadError(null);

    try {
      // Load reference photos (and VB grid - returned together from 'reference' endpoint)
      if (needsLazyLoadRef || needsLazyLoadVBGrid) {
        const refData = await storyService.getDevImage(storyId, pageNumber, 'reference');
        if (refData?.referencePhotos) {
          setLoadedReferencePhotos(refData.referencePhotos as ReferencePhoto[]);
        }
        if (refData?.visualBibleGrid) {
          setLoadedVBGrid(refData.visualBibleGrid as string);
        }
      }

      // Load landmark photos
      if (needsLazyLoadLandmark) {
        const landmarkData = await storyService.getDevImage(storyId, pageNumber, 'landmark');
        if (landmarkData?.landmarkPhotos) {
          setLoadedLandmarkPhotos(landmarkData.landmarkPhotos as LandmarkPhoto[]);
        }
      }

      // Load empty scene image
      if (needsLazyLoadEmptyScene) {
        const emptyData = await storyService.getDevImage(storyId, pageNumber, 'empty_scene');
        if (emptyData?.emptySceneImage) {
          setLoadedEmptyScene({ image: emptyData.emptySceneImage as string, prompt: emptyData.emptyScenePrompt as string });
        }
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load images');
    } finally {
      setIsLoading(false);
    }
  }, [storyId, pageNumber, isLoading, needsLazyLoadRef, needsLazyLoadLandmark, needsLazyLoadVBGrid, needsLazyLoadEmptyScene]);

  // Lazy-load scene-composite intermediates on first open of the section.
  const loadCompositeStages = useCallback(async () => {
    if (!storyId || !pageNumber || compositeStages || compositeStagesLoading) return;
    setCompositeStagesLoading(true);
    try {
      const data = await storyService.getCompositeStages(storyId, pageNumber);
      if (data?.stages) {
        const pick = (s: { imageData?: string; imageUrl?: string } | null) =>
          s ? (s.imageUrl || s.imageData || null) : null;
        setCompositeStages({
          clean_bg: pick(data.stages.clean_bg),
          blocking: pick(data.stages.blocking),
          composited: pick(data.stages.composited),
          final: pick(data.stages.final),
          blockingPrompt: data.blockingPrompt,
        });
      }
    } finally {
      setCompositeStagesLoading(false);
    }
  }, [storyId, pageNumber, compositeStages, compositeStagesLoading]);

  // Use loaded photos if available, otherwise use props
  const displayRefPhotos = loadedReferencePhotos || referencePhotos;
  const displayLandmarkPhotos = loadedLandmarkPhotos || landmarkPhotos;

  const displayVBGrid = loadedVBGrid || visualBibleGrid;

  const hasCharacterPhotos = displayRefPhotos && displayRefPhotos.length > 0;
  const hasLandmarkPhotos = displayLandmarkPhotos && displayLandmarkPhotos.length > 0;
  const hasVBGrid = !!displayVBGrid || hasVisualBibleGrid;

  const displayEmptySceneImage = loadedEmptyScene?.image || emptySceneImage;
  const displayEmptyScenePrompt = loadedEmptyScene?.prompt || emptyScenePrompt;

  if (!hasCharacterPhotos && !hasLandmarkPhotos && !hasVBGrid && !displayEmptySceneImage && !hasEmptySceneImage && !hasCompositeStages) return null;

  const totalCount = (referencePhotos?.length || 0) + (landmarkPhotos?.length || 0) + (hasVBGrid ? 1 : 0);

  const getPhotoTypeLabel = (photoType: string) => {
    switch (photoType) {
      case 'bodyNoBg':
      case 'body-no-bg': return language === 'de' ? 'Ganzkörper (freigestellt)' : language === 'fr' ? 'Corps entier (détouré)' : 'Full body (no bg)';
      case 'body': return language === 'de' ? 'Ganzkörper' : language === 'fr' ? 'Corps entier' : 'Full body';
      case 'face': return language === 'de' ? 'Gesicht' : language === 'fr' ? 'Visage' : 'Face only';
      case 'clothing-winter': return language === 'de' ? 'Winter-Avatar' : language === 'fr' ? 'Avatar hiver' : 'Winter avatar';
      case 'clothing-summer': return language === 'de' ? 'Sommer-Avatar' : language === 'fr' ? 'Avatar été' : 'Summer avatar';
      case 'clothing-formal': return language === 'de' ? 'Formell-Avatar' : language === 'fr' ? 'Avatar formel' : 'Formal avatar';
      case 'clothing-standard': return language === 'de' ? 'Standard-Avatar' : language === 'fr' ? 'Avatar standard' : 'Standard avatar';
      case 'none': return language === 'de' ? 'Kein Foto' : language === 'fr' ? 'Pas de photo' : 'No photo';
      default: return photoType;
    }
  };

  const getPhotoTypeColor = (photoType: string) => {
    switch (photoType) {
      case 'bodyNoBg':
      case 'body-no-bg': return 'bg-green-100 text-green-700 border-green-300';
      case 'body': return 'bg-blue-100 text-blue-700 border-blue-300';
      case 'face': return 'bg-yellow-100 text-yellow-700 border-yellow-300';
      case 'clothing-winter': return 'bg-cyan-100 text-cyan-700 border-cyan-300';
      case 'clothing-summer': return 'bg-orange-100 text-orange-700 border-orange-300';
      case 'clothing-formal': return 'bg-indigo-100 text-indigo-700 border-indigo-300';
      case 'clothing-standard': return 'bg-teal-100 text-teal-700 border-teal-300';
      case 'none': return 'bg-red-100 text-red-700 border-red-300';
      default: return 'bg-gray-100 text-gray-700 border-gray-300';
    }
  };

  // Get clothing category from first photo that has it
  const clothingCategory = displayRefPhotos?.find(p => p.clothingCategory)?.clothingCategory;

  const getClothingLabel = (category: string | undefined) => {
    if (!category) return '';
    switch (category) {
      case 'winter': return language === 'de' ? 'Winter' : language === 'fr' ? 'Hiver' : 'Winter';
      case 'summer': return language === 'de' ? 'Sommer' : language === 'fr' ? 'Été' : 'Summer';
      case 'formal': return language === 'de' ? 'Formell' : language === 'fr' ? 'Formel' : 'Formal';
      case 'standard': return language === 'de' ? 'Standard' : 'Standard';
      default: return category;
    }
  };

  return (
    <details
      className="bg-pink-50 border border-pink-300 rounded-lg p-3"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && (needsLazyLoadRef || needsLazyLoadLandmark || needsLazyLoadVBGrid || needsLazyLoadEmptyScene)) {
          loadImages();
        }
      }}
    >
      <summary className="cursor-pointer text-sm font-semibold text-pink-700 hover:text-pink-900 flex items-center gap-2">
        <span>📸</span>
        {language === 'de' ? 'Referenzfotos' : language === 'fr' ? 'Photos de référence' : 'Reference Photos'}
        <span className="text-xs text-pink-600">({totalCount})</span>
        {clothingCategory && (
          <span className="ml-2 px-2 py-0.5 bg-pink-200 text-pink-800 text-xs rounded">
            👕 {getClothingLabel(clothingCategory)}
          </span>
        )}
        {hasLandmarkPhotos && (
          <span className="ml-2 px-2 py-0.5 bg-amber-200 text-amber-800 text-xs rounded">
            📍 {displayLandmarkPhotos!.length} {language === 'de' ? 'Wahrzeichen' : 'Landmark'}
          </span>
        )}
        {hasVBGrid && (
          <span className="ml-2 px-2 py-0.5 bg-indigo-200 text-indigo-800 text-xs rounded">
            🔲 VB Grid
          </span>
        )}
        {isLoading && (
          <span className="ml-2 text-xs text-gray-500 animate-pulse">Loading...</span>
        )}
      </summary>

      {/* Loading error */}
      {loadError && (
        <div className="mt-3 text-sm text-red-600 bg-red-50 p-2 rounded">
          {loadError}
        </div>
      )}

      {/* ═══ Pass 1: Empty Scene ═══ */}
      {displayEmptySceneImage && (
        <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-emerald-700 flex items-center gap-1">
            🎬 {language === 'de' ? 'Pass 1: Leere Szene (Stil-Anker)' : 'Pass 1: Empty Scene (Style Anchor)'}
          </div>

          {/* Pass 1 inputs: landmark photos + FILTERED empty-scene VB grid + text-area mask.
              Note: emptySceneVbGrid is different from the main-scene visualBibleGrid —
              it excludes characters/animals/artifacts to avoid doubling. */}
          <div className="text-[10px] text-emerald-600 font-medium">
            {language === 'de' ? 'Eingaben →' : 'Inputs →'}
            {hasLandmarkPhotos && ` 📍 ${displayLandmarkPhotos!.length} landmark`}
            {emptySceneVbGrid && ' 🔲 VB grid (gefiltert)'}
            {textAreaMask && ' ◳ text-zone mask'}
            {!hasLandmarkPhotos && !emptySceneVbGrid && !textAreaMask && (language === 'de' ? ' nur Text-Prompt' : ' text prompt only')}
          </div>
          {(hasLandmarkPhotos || emptySceneVbGrid || textAreaMask) && (
            <div className="flex gap-2 flex-wrap">
              {displayLandmarkPhotos?.map((lm, i) => lm.photoData && (
                <img key={`lm-${i}`} src={lm.photoData} alt={lm.name} className="h-16 rounded border border-emerald-200 cursor-pointer hover:opacity-80" onClick={() => setLightboxImage(lm.photoData!)} title={`📍 ${lm.name}`} />
              ))}
              {emptySceneVbGrid && (
                <img src={emptySceneVbGrid} alt="Empty-scene VB Grid (filtered)" className="h-16 rounded border border-emerald-200 cursor-pointer hover:opacity-80" onClick={() => setLightboxImage(emptySceneVbGrid)} title={language === 'de' ? '🔲 VB Grid für leere Szene (nur Fahrzeuge + Nicht-Wahrzeichen-Orte)' : '🔲 Empty-scene VB grid (vehicles + non-landmark locations only)'} />
              )}
              {textAreaMask && (
                <img src={textAreaMask} alt="Text-zone mask sent to Grok" className="h-16 rounded border border-emerald-200 cursor-pointer hover:opacity-80" onClick={() => setLightboxImage(textAreaMask)} title={language === 'de' ? '◳ Text-Zonen-Maske (schwarz = Textzone, ~20%; weiss = Rest der Szene, ~80%) — wird an Grok gesendet' : '◳ Text-zone mask (black = text zone ~20%, white = rest of scene ~80%) — sent to Grok'} />
              )}
            </div>
          )}

          {/* Pass 1 prompt — always visible so it can be checked against the output */}
          {displayEmptyScenePrompt && (
            <div>
              <div className="text-[10px] text-emerald-600 font-medium mb-1">{language === 'de' ? 'Prompt ↓' : 'Prompt ↓'}</div>
              <pre className="text-[10px] bg-emerald-100 p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap text-emerald-800 border border-emerald-200">{displayEmptyScenePrompt}</pre>
            </div>
          )}

          {/* Pass 1 output: generated empty scene (prompt already shown above as <pre>) */}
          <div className="text-[10px] text-emerald-600 font-medium">{language === 'de' ? 'Ausgabe ↓' : 'Output ↓'}</div>
          <img
            src={displayEmptySceneImage}
            alt="Empty scene background"
            className="w-full max-h-48 object-contain rounded border border-emerald-300 bg-white cursor-pointer hover:opacity-80 transition-opacity"
            onClick={() => setLightboxImage(displayEmptySceneImage)}
          />

          {/* QC comparison: V1 (failed) vs V2 (retry) — open by default since the retry is high-signal */}
          {emptySceneQc && (
            <details open className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <summary className="cursor-pointer text-sm font-semibold text-amber-800 flex items-center gap-1.5">
                ⚠️ {language === 'de' ? 'Szene-QC' : 'Scene QC'} — {emptySceneQc.v1Issues?.length || 0} {language === 'de' ? 'Probleme gefunden, neu generiert' : 'issues found, retried'}
              </summary>
              <div className="mt-3 space-y-3">
                {/* V1 failed image */}
                {emptySceneQc.v1ImageData && (
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">V1 (failed)</div>
                    <img
                      src={emptySceneQc.v1ImageData}
                      alt="Empty scene V1 (failed)"
                      className="max-h-48 rounded border border-red-300 cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={() => setLightboxImage(emptySceneQc.v1ImageData || null)}
                    />
                  </div>
                )}
                {/* Issues */}
                {(emptySceneQc.v1Issues?.length ?? 0) > 0 && (
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">{language === 'de' ? 'Probleme' : 'Issues'}</div>
                    <ul className="text-sm text-red-700 list-disc pl-5 space-y-0.5">
                      {emptySceneQc.v1Issues!.map((issue: string, i: number) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {/* Gemini feedback */}
                {emptySceneQc.visionFeedback && (
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">Gemini feedback</div>
                    <p className="text-sm text-gray-800 bg-white p-2.5 rounded border border-gray-200">{emptySceneQc.visionFeedback}</p>
                  </div>
                )}
                {/* Retry prompt (collapsed) */}
                {emptySceneQc.retryPrompt && (
                  <details className="bg-white rounded border border-gray-200 p-2">
                    <summary className="text-sm text-gray-600 cursor-pointer">{language === 'de' ? 'Retry-Prompt anzeigen' : 'Show retry prompt'}</summary>
                    <pre className="mt-2 text-xs whitespace-pre-wrap font-mono max-h-64 overflow-y-auto text-gray-700 bg-gray-50 p-2 rounded">{emptySceneQc.retryPrompt}</pre>
                  </details>
                )}
                {/* V2 image (current, in use) */}
                <div>
                  <div className="text-sm font-medium text-gray-700 mb-1 flex items-center gap-1.5">
                    V2 (retry — in use)
                    <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded">active</span>
                  </div>
                  <img
                    src={displayEmptySceneImage}
                    alt="Empty scene V2 (retry)"
                    className="max-h-48 rounded border border-green-300 cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setLightboxImage(displayEmptySceneImage)}
                  />
                </div>
              </div>
            </details>
          )}

          {/* ═══ Scene Composite Stages (4-step pipeline) ═══
              Renders the BG → blocking → composited → final progression
              when the page was generated through server/lib/sceneComposite.js.
              Lazy-loads via /api/stories/:id/composite-stages/:pageNumber on
              first open. */}
          {hasCompositeStages && (
            <details
              className="mt-3 bg-purple-50 border border-purple-200 rounded-lg p-3 space-y-3"
              onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadCompositeStages(); }}
            >
              <summary className="cursor-pointer text-xs font-semibold text-purple-700 flex items-center gap-2">
                <span>🧩</span>
                {language === 'de' ? 'Szene-Composite (4 Stufen)' : language === 'fr' ? 'Composite de scène (4 étapes)' : 'Scene Composite (4 stages)'}
                {compositeStagesLoading && <span className="text-purple-500 animate-pulse">— loading…</span>}
                {compositeBboxes && (
                  <span className="ml-1 px-1.5 py-0.5 bg-purple-200 text-purple-800 rounded">
                    {Object.keys(compositeBboxes).length} {language === 'de' ? 'Figuren' : 'figures'}
                  </span>
                )}
              </summary>

              {/* 4-up grid: BG → blocking → composited → final */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                {[
                  { key: 'clean_bg' as const, label: '1. Clean BG', desc: language === 'de' ? 'Leerer Hintergrund (Grok generate)' : 'Empty background (Grok generate)' },
                  { key: 'blocking' as const, label: '2. Blocking', desc: language === 'de' ? 'Silhouetten platziert (Grok edit)' : 'Coloured silhouettes (Grok edit)' },
                  { key: 'composited' as const, label: '3. Composited', desc: language === 'de' ? 'Figuren eingefügt (lokal)' : 'Cutouts pasted (local sharp)' },
                  { key: 'final' as const, label: '4. Final', desc: language === 'de' ? 'Geblendet (Grok edit)' : 'Blend pass (Grok edit)' },
                ].map(({ key, label, desc }) => {
                  const url = compositeStages?.[key] || null;
                  return (
                    <div key={key} className="text-center">
                      <div className="text-[10px] font-semibold text-purple-700 mb-1">{label}</div>
                      {url ? (
                        <img
                          draggable={false}
                          src={url}
                          alt={label}
                          className="w-full h-32 object-contain rounded border border-purple-200 bg-white cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setLightboxImage(url)}
                          title={`${label} — ${desc}`}
                        />
                      ) : (
                        <div className="w-full h-32 rounded border border-dashed border-purple-200 bg-purple-50/50 flex items-center justify-center text-purple-300 text-[10px]">
                          {compositeStagesLoading ? '…' : '—'}
                        </div>
                      )}
                      <div className="text-[9px] text-purple-500 mt-1 leading-tight">{desc}</div>
                    </div>
                  );
                })}
              </div>

              {/* Per-character bbox metadata — useful for diagnosing
                  silhouette-detection misses. */}
              {compositeBboxes && Object.keys(compositeBboxes).length > 0 && (
                <div className="mt-2 text-[10px] text-purple-600">
                  <div className="font-semibold mb-0.5">{language === 'de' ? 'Erkannte Bounding-Boxes' : 'Detected bounding boxes'}:</div>
                  <ul className="space-y-0.5 ml-3 list-disc">
                    {Object.entries(compositeBboxes).map(([name, b]) => (
                      <li key={name}>
                        <span className="font-medium">{name}</span> — {b.width}×{b.height} @ ({b.x},{b.y})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Blocking prompt (handy when silhouettes don't show up) */}
              {compositeStages?.blockingPrompt && (
                <details className="mt-2">
                  <summary className="text-[10px] text-purple-600 cursor-pointer">{language === 'de' ? 'Blocking-Prompt anzeigen' : 'Show blocking prompt'}</summary>
                  <pre className="mt-1 text-[10px] bg-white p-2 rounded border border-purple-200 max-h-40 overflow-auto whitespace-pre-wrap text-purple-800">{compositeStages.blockingPrompt}</pre>
                </details>
              )}
            </details>
          )}

          {/* Text-space coverage report — calm pixels inside the actual
              renderer polygon (triangle for corners, rectangle for full). */}
          {textCoverageReport && (
            <div className={`mt-2 border rounded-lg p-3 ${textCoverageReport.passed ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
              <div className={`text-sm font-semibold flex items-center gap-2 flex-wrap ${textCoverageReport.passed ? 'text-emerald-800' : 'text-amber-800'}`}>
                {textCoverageReport.passed ? '✅' : '⚠️'} {language === 'de' ? 'Text-Platz' : 'Text space'}
                <span className="text-xs font-normal text-gray-700">
                  {textCoverageReport.calmFoundPx.toLocaleString()} / {textCoverageReport.calmNeededPx.toLocaleString()} px² {language === 'de' ? 'Ruhe' : 'calm'}
                </span>
                <span className="text-xs font-normal text-gray-600">
                  · {textCoverageReport.words} {language === 'de' ? 'Wörter' : 'words'} @ {textCoverageReport.fontPt}pt
                </span>
                {textCoverageReport.retriesUsed > 0 && (
                  <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
                    {language === 'de' ? 'repariert' : 'repaired'} ({textCoverageReport.retriesUsed})
                  </span>
                )}
                {textCoverageReport.postRepairChecked && (
                  <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">
                    {language === 'de' ? 'nach Reparatur' : 'post-repair'}
                  </span>
                )}
              </div>
              {textCoverageReport.candidates.length > 1 && (
                <div className="mt-2 text-xs text-gray-700 space-y-0.5">
                  {textCoverageReport.candidates.map((c) => (
                    <div key={c.index} className="flex items-center gap-2">
                      <span className={c.index === textCoverageReport.winnerIndex ? 'font-semibold text-emerald-700' : ''}>
                        {c.source}
                      </span>
                      <span>→ {c.calmFoundPx.toLocaleString()} px² ({c.calmPct}%)</span>
                      <span className="text-gray-500">({c.position})</span>
                      {c.index === textCoverageReport.winnerIndex && <span className="text-xs bg-emerald-100 text-emerald-700 px-1 rounded">{language === 'de' ? 'ausgewählt' : 'picked'}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══ Pass 2: Character Placement ═══ */}
      {displayEmptySceneImage && (
        <div className="mt-3 bg-pink-50 border border-pink-200 rounded-lg p-3 space-y-2">
          <div className="text-xs font-semibold text-pink-700 flex items-center gap-1">
            👥 {language === 'de' ? 'Pass 2: Charaktere platzieren' : 'Pass 2: Character Placement'}
          </div>
          <div className="text-[10px] text-pink-600 font-medium">
            {language === 'de' ? 'Eingaben →' : 'Inputs →'}
            {` 🎬 scene background + ${displayRefPhotos?.length || 0} character photos`}
          </div>
          {/* Show scene background thumbnail alongside character photos */}
          <div className="flex gap-2 flex-wrap items-start">
            <div className="relative">
              <img src={displayEmptySceneImage} alt="Scene bg" className="h-16 rounded border-2 border-emerald-400 cursor-pointer hover:opacity-80" onClick={() => setLightboxImage(displayEmptySceneImage)} />
              <span className="absolute -top-1 -left-1 text-[8px] bg-emerald-500 text-white px-1 rounded">BG</span>
            </div>
            {(() => {
              // Dedupe: a character can have multiple photo entries (face + body)
              // — only label the first thumbnail per name so the name doesn't
              // appear twice under the same character.
              const seen = new Set<string>();
              return displayRefPhotos?.map((photo, i) => {
                if (!photo.photoUrl) return null;
                const showName = !seen.has(photo.name);
                seen.add(photo.name);
                return (
                  <div key={i} className="relative">
                    <img src={photo.photoUrl} alt={photo.name} className="h-16 rounded border border-pink-200 cursor-pointer hover:opacity-80" onClick={() => setLightboxImage(photo.photoUrl)} />
                    {showName && (
                      <span className="absolute -top-1 -left-1 text-[8px] bg-pink-500 text-white px-1 rounded">{photo.name}</span>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ═══ Flat layout (no empty scene) ═══ */}

      {/* Character photos — ONE card per character (face + body grouped together) */}
      {!displayEmptySceneImage && hasCharacterPhotos && (
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {(() => {
            // Group photo entries by character name so two photos for the same
            // character (face + body) render inside ONE card with a single
            // header — not two cards each with their own name + photoType label.
            const groups = new Map<string, ReferencePhoto[]>();
            for (const p of displayRefPhotos!) {
              if (!groups.has(p.name)) groups.set(p.name, []);
              groups.get(p.name)!.push(p);
            }
            return Array.from(groups.entries()).map(([name, photos]) => {
              const types = photos.map(p => p.photoType).filter(Boolean) as string[];
              const photoHash = photos.find(p => p.photoHash)?.photoHash;
              const visiblePhotos = photos.filter(p => p.photoUrl);
              return (
                <div key={name} className="bg-white rounded-lg p-2 border border-pink-200">
                  <div className="flex items-center justify-between mb-2 gap-1">
                    <span className="font-semibold text-xs text-gray-800 truncate">{name}</span>
                    {types.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {types.map((t, ti) => (
                          <span key={ti} className={`px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap ${getPhotoTypeColor(t)}`}>
                            {getPhotoTypeLabel(t)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {visiblePhotos.length > 0 ? (
                    <>
                      <div className="flex gap-1">
                        {visiblePhotos.map((photo, pi) => (
                          <div key={pi} className="relative flex-1 min-w-0">
                            <img
                              src={photo.photoUrl!}
                              alt={`${photo.name} - ${getPhotoTypeLabel(photo.photoType || 'unknown')}`}
                              className={`w-full max-h-32 object-contain rounded border bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity ${photo.isStyled ? 'border-indigo-400 ring-2 ring-indigo-200' : 'border-gray-200'}`}
                              onClick={() => setLightboxImage(photo.photoUrl!)}
                              title="Click to enlarge"
                            />
                            {photo.isStyled && (
                              <span className="absolute top-1 right-1 px-1 py-0.5 text-[9px] font-bold bg-indigo-500 text-white rounded">
                                🎨 STYLED
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                      {photoHash && (
                        <div className="mt-1 text-[9px] font-mono text-gray-500 bg-gray-100 px-1 py-0.5 rounded text-center">
                          🔐 {photoHash}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-xs text-gray-500 italic py-2 text-center bg-gray-100 rounded">
                      {language === 'de' ? 'Foto nicht geladen' : 'Photo not loaded'}
                    </div>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}

      {/* Landmark photos (flat layout only) */}
      {!displayEmptySceneImage && hasLandmarkPhotos && (
        <div className={hasCharacterPhotos ? "mt-4 pt-3 border-t border-pink-200" : "mt-3"}>
          <div className="text-xs font-semibold text-amber-700 mb-2 flex items-center gap-1">
            📍 {language === 'de' ? 'Wahrzeichen-Referenzfotos' : language === 'fr' ? 'Photos de monuments' : 'Landmark Reference Photos'}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {displayLandmarkPhotos!.map((landmark, idx) => {
              // Prefer inline data URI; fall back to R2 URL (post-migration). Reject
              // synthetic schemes the browser can't load (e.g. magicalstory://).
              const urlIsLoadable = typeof landmark.photoUrl === 'string'
                && /^(https?:|data:)/i.test(landmark.photoUrl);
              const src = landmark.photoData || (urlIsLoadable ? landmark.photoUrl! : null);
              return (
              <div key={idx} className="bg-amber-50 rounded-lg p-2 border border-amber-200">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-xs text-gray-800 truncate">{landmark.name}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap bg-amber-100 text-amber-700 border-amber-300">
                    📍 LANDMARK
                  </span>
                </div>
                {src ? (
                  <>
                    <div className="relative">
                      <img
                        src={src}
                        alt={`${landmark.name} landmark`}
                        className="w-full max-h-32 object-contain rounded border border-amber-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={() => setLightboxImage(src)}
                        title="Click to enlarge"
                      />
                    </div>
                    {landmark.attribution && (
                      <div className="mt-1 text-[9px] text-gray-500 bg-gray-100 px-1 py-0.5 rounded truncate" title={landmark.attribution}>
                        📷 {landmark.attribution}
                      </div>
                    )}
                    {landmark.source && (
                      <div className="mt-0.5 text-[9px] text-gray-400">
                        Source: {landmark.source}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-xs text-gray-500 italic py-2 text-center bg-gray-100 rounded">
                    {language === 'de' ? 'Foto nicht geladen' : 'Photo not loaded'}
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Visual Bible Grid (flat layout only) */}
      {!displayEmptySceneImage && hasVBGrid && (
        <div className={hasCharacterPhotos || hasLandmarkPhotos ? "mt-4 pt-3 border-t border-pink-200" : "mt-3"}>
          <div className="text-xs font-semibold text-indigo-700 mb-2 flex items-center gap-1">
            🔲 {language === 'de' ? 'Visual Bible Referenzgitter' : language === 'fr' ? 'Grille Visual Bible' : 'Visual Bible Reference Grid'}
          </div>
          <div className="bg-indigo-50 rounded-lg p-2 border border-indigo-200">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-xs text-gray-800">
                {language === 'de' ? 'Kombinierte Referenzen' : language === 'fr' ? 'Références combinées' : 'Combined References'}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border whitespace-nowrap bg-indigo-100 text-indigo-700 border-indigo-300">
                🔲 VB GRID
              </span>
            </div>
            <div className="text-[10px] text-gray-500 mb-2">
              {language === 'de'
                ? 'Sekundäre Charaktere, Tiere, Artefakte, Fahrzeuge und zusätzliche Wahrzeichen'
                : language === 'fr'
                ? 'Personnages secondaires, animaux, artefacts, véhicules et monuments supplémentaires'
                : 'Secondary characters, animals, artifacts, vehicles, and additional landmarks'}
            </div>
            {displayVBGrid ? (
              <img
                src={displayVBGrid}
                alt="Visual Bible Reference Grid"
                className="w-full max-h-64 object-contain rounded border border-indigo-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => setLightboxImage(displayVBGrid!)}
                title="Click to enlarge"
              />
            ) : (
              <div className="text-xs text-gray-500 italic py-4 text-center bg-gray-100 rounded">
                {isLoading ? (language === 'de' ? 'Wird geladen...' : 'Loading...') : (language === 'de' ? 'Bild nicht geladen' : 'Image not loaded')}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Sent to image model: exact images that went to the API. Always rendered
          so a missing/empty section is visible to dev-mode users (vs the prior
          behavior of hiding the section when nothing was captured, which made
          it impossible to tell whether the image-gen path didn't capture or
          actually sent zero refs). Labels generalize from "Grok" to "image
          model" since Gemini accepts more than 3 slots. */}
      <div className={hasCharacterPhotos || hasLandmarkPhotos || hasVBGrid ? "mt-4 pt-3 border-t border-pink-200" : "mt-3"}>
        <div className="text-xs font-semibold text-orange-700 mb-2 flex items-center gap-1">
          🎯 {language === 'de' ? 'An Bildmodell gesendet' : 'Sent to image model'}
          {grokRefImages && grokRefImages.length > 0 && (
            <span className="text-[10px] font-normal text-orange-500">({grokRefImages.length} {language === 'de' ? 'Bild' + (grokRefImages.length === 1 ? '' : 'er') : 'image' + (grokRefImages.length === 1 ? '' : 's')})</span>
          )}
        </div>
        {grokRefImages && grokRefImages.length > 0 ? (
          <div className="grid grid-cols-3 gap-2">
            {grokRefImages.map((img, idx) => (
              <div key={idx} className="bg-orange-50 rounded-lg p-1 border border-orange-200">
                <div className="text-[10px] text-orange-600 font-medium mb-1 text-center">Slot {idx + 1}</div>
                <img
                  src={img}
                  alt={`Image-model ref slot ${idx + 1}`}
                  className="w-full object-contain rounded border border-orange-200 bg-white cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={(e) => { e.stopPropagation(); setLightboxImage(img); }}
                  title="Click to enlarge"
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-gray-500 italic py-2 px-3 bg-gray-100 rounded">
            {language === 'de'
              ? 'Keine Bilder erfasst (kein API-Aufruf für diese Version oder Erfassung nicht aktiviert)'
              : 'No images captured (no API call for this version, or capture not wired up)'}
          </div>
        )}
      </div>

      {/* Composite-cover 2-pass debug: when version was generated by the
          composite-cover pipeline, render each pass's input + output + prompt.
          Replaces the legacy 3-slot Grok grid with pass-by-pass detail since
          composite is 2× single-image edit, not multi-slot. */}
      {Array.isArray(compositeAttempts) && compositeAttempts.length > 0 && (
        <div className="mt-4 pt-3 border-t border-pink-200">
          <div className="text-xs font-semibold text-purple-700 mb-2 flex items-center gap-1">
            🎨 {language === 'de' ? 'Composite-Cover (2 Durchgänge)' : 'Composite cover (2 passes)'}
            <span className="text-[10px] font-normal text-purple-500">
              ({compositeAttempts.length} {language === 'de' ? 'Durchgang' + (compositeAttempts.length === 1 ? '' : 'e') : 'pass' + (compositeAttempts.length === 1 ? '' : 'es')})
            </span>
          </div>
          {compositeAttempts.map((att) => (
            <div key={att.pass} className="mb-3 bg-purple-50 rounded-lg p-2 border border-purple-200">
              <div className="text-[11px] font-medium text-purple-700 mb-2">
                {language === 'de' ? `Durchgang ${att.pass}` : `Pass ${att.pass}`}
                {att.modelId && <span className="ml-2 text-[10px] font-normal text-purple-500">{att.modelId}</span>}
                {att.elapsedMs != null && <span className="ml-2 text-[10px] font-normal text-purple-500">{(att.elapsedMs / 1000).toFixed(1)}s</span>}
              </div>
              {/* Pass 1 includes a VB grid reference slot when available;
                  pass 2 only has input/output. Layout adapts: 2 cols for
                  input+output, 3 cols when VB grid is also present. */}
              <div className={`grid gap-2 mb-2 ${att.vbGrid ? 'grid-cols-3' : 'grid-cols-2'}`}>
                {att.input && (
                  <div>
                    <div className="text-[10px] text-purple-600 font-medium mb-1 text-center">{language === 'de' ? 'Eingabe' : 'Input'}</div>
                    <img
                      src={att.input}
                      alt={`Composite pass ${att.pass} input`}
                      className="w-full object-contain rounded border border-purple-200 bg-white cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); setLightboxImage(att.input!); }}
                      title="Click to enlarge"
                    />
                  </div>
                )}
                {att.vbGrid && (
                  <div>
                    <div className="text-[10px] text-purple-600 font-medium mb-1 text-center">{language === 'de' ? 'VB-Raster (Ref.)' : 'VB grid (ref)'}</div>
                    <img
                      src={att.vbGrid}
                      alt={`Composite pass ${att.pass} VB grid reference`}
                      className="w-full object-contain rounded border border-purple-200 bg-white cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); setLightboxImage(att.vbGrid!); }}
                      title="Click to enlarge"
                    />
                  </div>
                )}
                {att.output && (
                  <div>
                    <div className="text-[10px] text-purple-600 font-medium mb-1 text-center">{language === 'de' ? 'Ausgabe' : 'Output'}</div>
                    <img
                      src={att.output}
                      alt={`Composite pass ${att.pass} output`}
                      className="w-full object-contain rounded border border-purple-200 bg-white cursor-pointer hover:opacity-80 transition-opacity"
                      onClick={(e) => { e.stopPropagation(); setLightboxImage(att.output!); }}
                      title="Click to enlarge"
                    />
                  </div>
                )}
              </div>
              {att.prompt && (
                <details className="text-[11px] text-purple-700">
                  <summary className="cursor-pointer font-medium">{language === 'de' ? 'Prompt anzeigen' : 'Show prompt'} ({att.prompt.length} {language === 'de' ? 'Zeichen' : 'chars'})</summary>
                  <pre className="mt-1 p-2 bg-white rounded border border-purple-200 whitespace-pre-wrap break-words text-[10px] text-gray-700 max-h-64 overflow-y-auto">{att.prompt}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Lightbox for enlarged view */}
      <ImageLightbox
        src={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </details>
  );
}
