import { useState, useCallback } from 'react';
import { X, Loader2, Check, Clock, AlertTriangle, Paintbrush, ChevronDown, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import storyService from '@/services/storyService';
import type { TestModelsInputSnapshot } from '@/services/storyService';
import { artStyles } from '@/constants/artStyles';
import { StyleLabSection } from './StyleLabSection';

interface TestModelsPanelProps {
  storyId: string;
  pageNumber: number;
  onClose: () => void;
  onUseImage?: (imageData: string, modelId: string) => void;
  language: string;
}

// Verbatim snapshot of what hit the Grok API wire — populated by the API
// wrapper (server/lib/grok.js editWithGrok/generateWithGrok). Same shape for
// every call site, so the dev panel renders one source of truth instead of
// each caller synthesising its own snapshot.
interface SentToGrok {
  endpoint: string;            // '/v1/images/edits' | '/v1/images/generations'
  model: string;
  aspectRatio: string;
  resolution?: string;
  prompt: string;
  promptLength: number;
  referenceImages: Array<{ slot: number; role?: string | null; dataUri: string; sizeKb?: number | null }>;
  capturedAt: string;
  elapsedMs: number;
}

interface CompositeDebugBundle {
  // Stratified-only: pre-step-1 artefacts.
  strategy?: 'stratified' | 'uniform';
  backNames?: string[];
  frontNames?: string[];
  emptyScene?: string;
  emptySceneSource?: string;
  emptyScenePrompt?: string;
  emptySceneSentToGrok?: SentToGrok | null;
  backIdentityPack?: string;
  frontIdentityPack?: string;
  // Step 1 — uniform calls this "populated plate", stratified aliases it.
  populatedPlate?: string;
  populatedPlatePrompt?: string;
  populatedPlateSentToGrok?: SentToGrok | null;
  // Step 2 — depopulate.
  cleanBackground?: string;
  cleanBackgroundPrompt?: string | null;
  cleanBackgroundSource?: string;
  depopulatePrompt?: string;
  depopulateSentToGrok?: SentToGrok | null;
  // Step 3 — stratified-only front-figure plate.
  frontPlate?: string;
  frontPlatePrompt?: string;
  frontPlateSentToGrok?: SentToGrok | null;
  // Step 4 — composited intermediate.
  composited?: string;
  // Step 5 — blend pass.
  blendPrompt?: string;
  blendSentToGrok?: SentToGrok | null;
  bboxes?: Record<string, { x: number; y: number; width: number; height: number; pixels: number }>;
  phantomPoseRenders?: Record<string, { output?: string; phantomCrop?: string; prompt?: string; bbox?: unknown; action?: string | null }>;
  zScores?: Record<string, number>;
  zDecisions?: Array<{ a: string; b: string; aPx: number; bPx: number; winner: string }>;
}

interface ModelTestResult {
  loading: boolean;
  imageData?: string;
  error?: string;
  elapsedMs?: number;
  modelId?: string;
  // Iterative placement debug
  pass1Image?: string;
  pass1Prompt?: string;
  pass2Prompt?: string;
  pass2Failed?: boolean;
  pass2Error?: string;
  // Exact images packed for the model (most useful for "what did it see")
  grokRefImages?: string[] | null;
  // Composite-path intermediates (only present when composite=true was requested)
  compositeDebug?: CompositeDebugBundle | null;
  // Snapshot of the inputs that produced this result (shared across all models in the run)
  inputSnapshot?: TestModelsInputSnapshot | null;
}

interface ModelOption {
  id: string;
  label: string;
  cost: string;
}

const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'grok-imagine', label: 'Grok Standard', cost: '$0.02' },
  { id: 'grok-imagine-pro', label: 'Grok Pro', cost: '$0.07' },
  { id: 'gemini-2.5-flash-image', label: 'Gemini Flash', cost: '$0.04' },
  { id: 'gemini-3-pro-image-preview', label: 'Gemini Pro', cost: '$0.15' },
];

// Distinct stable colours for bbox outlines — palette spaced > 30° in hue.
const BBOX_COLOURS = ['#E60000', '#0050D0', '#00B050', '#F0C000', '#8B00B0', '#00B0B0', '#FF7F00', '#888888'];

/**
 * Render a single `sentToGrok` snapshot — endpoint + model + aspect + prompt
 * + each reference image (with role label) and meta. Source is the API
 * wrapper's verbatim capture, so what's shown is exactly what hit Grok.
 */
function SentToGrokBlock({
  snapshot,
  label,
  onLightbox,
}: {
  snapshot: SentToGrok | null | undefined;
  label: string;
  onLightbox: (src: string) => void;
}) {
  if (!snapshot) {
    return (
      <details className="mt-1">
        <summary className="text-[10px] text-gray-400 cursor-pointer">{label} — sent to Grok (not captured)</summary>
        <div className="text-[10px] text-gray-500 mt-1">No sentToGrok snapshot persisted for this step. (Old story or non-Grok path.)</div>
      </details>
    );
  }
  return (
    <details className="mt-1" open>
      <summary className="text-[10px] font-medium text-purple-600 cursor-pointer">
        {label} — sent to Grok ({snapshot.endpoint}, {snapshot.model}, {snapshot.aspectRatio}, {snapshot.referenceImages?.length || 0} ref{(snapshot.referenceImages?.length || 0) === 1 ? '' : 's'}, {snapshot.elapsedMs}ms)
      </summary>
      <div className="mt-1 space-y-2">
        <details open>
          <summary className="text-[10px] text-gray-500 cursor-pointer">Prompt ({snapshot.promptLength} chars)</summary>
          <pre className="mt-1 text-[10px] bg-gray-50 p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap border">{snapshot.prompt}</pre>
        </details>
        {(snapshot.referenceImages || []).length > 0 && (
          <div>
            <div className="text-[10px] text-gray-500 mb-1">Reference images ({snapshot.referenceImages.length})</div>
            <div className="grid grid-cols-3 gap-2">
              {snapshot.referenceImages.map((ref) => (
                <div key={ref.slot} className="flex flex-col items-center">
                  {ref.dataUri && (
                    <img
                      src={ref.dataUri}
                      alt={`slot ${ref.slot}`}
                      className="max-h-32 w-full object-contain rounded border bg-white cursor-pointer"
                      onClick={() => onLightbox(ref.dataUri)}
                    />
                  )}
                  <span className="text-[9px] font-mono text-gray-700 mt-0.5">
                    Slot {ref.slot} {ref.role ? `· ${ref.role}` : ''} {ref.sizeKb != null ? `· ${ref.sizeKb}KB` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="text-[9px] text-gray-400">captured {snapshot.capturedAt}</div>
      </div>
    </details>
  );
}

/**
 * Crop one bbox out of a source image via SVG. viewBox is the crop region
 * in source-image pixel coords; image is rendered at its full natural size
 * inside, so the rect outside the viewBox gets clipped. Works without
 * knowing the source dimensions ahead of time.
 */
function BboxCrop({
  src,
  bbox,
  colour,
  name,
  onLightbox,
}: {
  src: string;
  bbox: { x: number; y: number; width: number; height: number; pixels: number };
  colour: string;
  name: string;
  onLightbox: (src: string) => void;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Hidden <img> to capture the natural dimensions, then SVG with image href.
  return (
    <div className="flex flex-col items-center">
      <div className="relative w-full" style={{ aspectRatio: `${bbox.width} / ${bbox.height}` }}>
        <img
          src={src}
          alt=""
          className="hidden"
          onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
        {natural && (
          <svg
            viewBox={`${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`}
            preserveAspectRatio="xMidYMid meet"
            className="absolute inset-0 w-full h-full cursor-pointer rounded border bg-white"
            style={{ borderColor: colour, borderWidth: 2 }}
            onClick={() => onLightbox(src)}
          >
            <image href={src} x={0} y={0} width={natural.w} height={natural.h} />
          </svg>
        )}
      </div>
      <span className="text-[10px] font-medium mt-0.5" style={{ color: colour }}>
        {name}
      </span>
      <span className="text-[9px] text-gray-500 font-mono">
        {bbox.width}×{bbox.height} · {bbox.pixels}px
      </span>
    </div>
  );
}

/**
 * Populated-plate image with bbox overlays drawn on top. SVG viewBox is
 * captured from the image's natural dimensions onLoad — so rect coords (in
 * source-image pixels) map exactly onto the rendered image regardless of
 * how CSS scales it.
 */
function PlateWithBboxes({
  src,
  bboxes,
  onLightbox,
  maxH = 'max-h-48',
}: {
  src: string;
  bboxes: Record<string, { x: number; y: number; width: number; height: number; pixels: number }> | undefined;
  onLightbox: (src: string) => void;
  maxH?: string;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const entries = bboxes ? Object.entries(bboxes) : [];
  return (
    <div className="relative inline-block w-full">
      <img
        src={src}
        alt="plate"
        className={`${maxH} w-full object-contain rounded border bg-white cursor-pointer`}
        onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onClick={() => onLightbox(src)}
      />
      {natural && entries.length > 0 && (
        <svg
          viewBox={`0 0 ${natural.w} ${natural.h}`}
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 w-full h-full pointer-events-none"
        >
          {entries.map(([name, b], i) => {
            const colour = BBOX_COLOURS[i % BBOX_COLOURS.length];
            return (
              <g key={name}>
                <rect
                  x={b.x}
                  y={b.y}
                  width={b.width}
                  height={b.height}
                  fill="none"
                  stroke={colour}
                  strokeWidth={Math.max(2, Math.round(natural.w / 256))}
                />
                <rect
                  x={b.x}
                  y={Math.max(0, b.y - Math.round(natural.h / 40))}
                  width={Math.max(60, name.length * 12 + 20)}
                  height={Math.round(natural.h / 40)}
                  fill={colour}
                  opacity={0.92}
                />
                <text
                  x={b.x + 4}
                  y={Math.max(0, b.y - 4)}
                  fill="#fff"
                  fontSize={Math.round(natural.h / 50)}
                  fontFamily="ui-monospace, monospace"
                >
                  {name} {b.width}×{b.height}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

export function TestModelsPanel({
  storyId,
  pageNumber,
  onClose,
  onUseImage,
}: TestModelsPanelProps) {
  // The image model is a single MANDATORY choice — used by every method
  // below. (Composite is Grok-only internally; the choice still matters
  // for the direct-path method.)
  const [selectedModel, setSelectedModel] = useState<string>('grok-imagine');
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  // Method toggles — each method below has its own opt-in switch.
  const [runDirect, setRunDirect] = useState(true);
  // Method 2: legacy silhouette-for-everyone composite (5 steps, optional
  // phantom-pose render per character).
  const [runUniform, setRunUniform] = useState(false);
  // Method 3: stratified composite (back stratum rendered natively in the
  // anchor plate, front stratum cropped from a separate front-figure plate).
  const [runStratified, setRunStratified] = useState(false);
  // Direct-method options
  const [iterativePlacement, setIterativePlacement] = useState(false);
  // Reference-mode + single-pass-scene flags. 'inherit' = use the run-level
  // server default (set in server/config/models.js MODEL_DEFAULTS).
  const [referenceMode, setReferenceMode] = useState<'inherit' | 'strict' | 'loose' | 'styled-only' | 'off'>('inherit');
  const [singlePassScene, setSinglePassScene] = useState<'inherit' | 'on' | 'off'>('inherit');
  // Composite-method options
  const [phantomPoseRender, setPhantomPoseRender] = useState(false);
  const [emptyScene, setEmptyScene] = useState<'reuse' | 'fresh' | 'skip'>('reuse');
  // Direct path: send one cell of the story's 2×4 sheet (matching the page's
  // intended pose) instead of the full styled-avatar image.
  const [useStorySheetCells, setUseStorySheetCells] = useState(false);

  // Style Transfer state
  const [styleTargetModel, setStyleTargetModel] = useState<string>('gemini-2.5-flash-image');
  const [styleWithAvatars, setStyleWithAvatars] = useState(false);
  const [styleSource, setStyleSource] = useState<'story' | 'preset' | 'analyzed' | 'custom'>('story');
  const [presetStyleId, setPresetStyleId] = useState<string>('watercolor');
  const [analyzedStyle, setAnalyzedStyle] = useState<string | null>(null);
  const [customStyle, setCustomStyle] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [styleResult, setStyleResult] = useState<ModelTestResult | null>(null);
  const [isStyleTransferring, setIsStyleTransferring] = useState(false);

  // Fullscreen toggle — composite intermediates are tall and narrow inline.
  // Lifts the whole panel to a viewport-filling modal when on.
  const [fullscreen, setFullscreen] = useState(false);

  const runTest = useCallback(async () => {
    if (!selectedModel) return;
    if (!runDirect && !runUniform && !runStratified) return;
    setIsRunning(true);
    setResults({});

    const models = runDirect ? [selectedModel] : [];
    const baseOptions: {
      iterativePlacement?: boolean;
      referenceMode?: 'strict' | 'loose' | 'styled-only' | 'off';
      singlePassScene?: boolean;
      useStorySheetCells?: boolean;
    } = {};
    if (iterativePlacement) baseOptions.iterativePlacement = true;
    if (referenceMode !== 'inherit') baseOptions.referenceMode = referenceMode;
    if (singlePassScene !== 'inherit') baseOptions.singlePassScene = singlePassScene === 'on';
    if (useStorySheetCells) baseOptions.useStorySheetCells = true;

    const directPromises = models.map(async (model) => {
      setResults(prev => ({ ...prev, [model]: { loading: true } }));
      const startTime = Date.now();

      try {
        const response = await storyService.testModels(storyId, pageNumber, [model], Object.keys(baseOptions).length > 0 ? baseOptions : undefined);
        const result = response.results[model];
        const elapsedMs = Date.now() - startTime;
        setResults(prev => ({
          ...prev,
          [model]: {
            loading: false,
            imageData: result?.imageData,
            error: result?.error,
            modelId: model,
            elapsedMs,
            pass1Image: result?.pass1Image,
            pass1Prompt: result?.pass1Prompt,
            pass2Prompt: result?.pass2Prompt,
            pass2Failed: result?.pass2Failed,
            pass2Error: result?.pass2Error,
            grokRefImages: result?.grokRefImages,
            inputSnapshot: response.inputSnapshot,
          },
        }));
      } catch (err: unknown) {
        const elapsedMs = Date.now() - startTime;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setResults(prev => ({
          ...prev,
          [model]: { loading: false, error: message, elapsedMs },
        }));
      }
    });

    // Composite paths — one independent request per ticked strategy. The
    // server's result-key naming matches: "composite" (stratified, no
    // phantom), "composite+phantomPose" (uniform-with-phantom), and the
    // legacy uniform path adds a "+uniform" suffix.
    const runComposite = async (strategy: 'stratified' | 'uniform', withPhantom: boolean) => {
      const stratSuffix = strategy === 'uniform' ? '+uniform' : '';
      const compositeKey = withPhantom
        ? `composite+phantomPose${stratSuffix}`
        : `composite${stratSuffix}`;
      setResults(prev => ({ ...prev, [compositeKey]: { loading: true } }));
      const startTime = Date.now();
      try {
        const response = await storyService.testModels(storyId, pageNumber, [], {
          ...baseOptions,
          composite: true,
          phantomPoseRender: withPhantom,
          emptyScene,
          compositeStrategy: strategy,
        });
        const r = response.results[compositeKey];
        const elapsedMs = Date.now() - startTime;
        setResults(prev => ({
          ...prev,
          [compositeKey]: {
            loading: false,
            imageData: r?.imageData,
            error: r?.error,
            modelId: r?.modelId || 'scene-composite',
            elapsedMs,
            compositeDebug: (r?.compositeDebug as CompositeDebugBundle) || null,
            inputSnapshot: response.inputSnapshot,
          },
        }));
      } catch (err: unknown) {
        const elapsedMs = Date.now() - startTime;
        const message = err instanceof Error ? err.message : 'Unknown error';
        setResults(prev => ({
          ...prev,
          [compositeKey]: { loading: false, error: message, elapsedMs },
        }));
      }
    };

    const compositePromises: Array<Promise<void>> = [];
    if (runUniform) compositePromises.push(runComposite('uniform', phantomPoseRender));
    if (runStratified) compositePromises.push(runComposite('stratified', false));

    await Promise.allSettled([...directPromises, ...compositePromises]);
    setIsRunning(false);
  }, [selectedModel, runDirect, storyId, pageNumber, iterativePlacement, referenceMode, singlePassScene, runUniform, runStratified, phantomPoseRender, emptyScene, useStorySheetCells]);

  const runStyleTransfer = useCallback(async () => {
    if (!styleTargetModel) return;
    setIsStyleTransferring(true);
    setStyleResult({ loading: true });
    const startTime = Date.now();

    try {
      // Determine style description based on source
      const styleDesc = styleSource === 'preset' ? (artStyles.find(s => s.id === presetStyleId)?.prompt || undefined)
        : styleSource === 'analyzed' ? (analyzedStyle || undefined)
        : styleSource === 'custom' ? (customStyle || undefined)
        : undefined; // 'story' = use story's art style (server default)
      const response = await storyService.styleTransfer(storyId, pageNumber, styleTargetModel, styleWithAvatars, styleDesc);
      const elapsedMs = Date.now() - startTime;
      setStyleResult({
        loading: false,
        imageData: response.imageData,
        modelId: response.modelId,
        elapsedMs,
      });
    } catch (err: unknown) {
      const elapsedMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : 'Unknown error';
      setStyleResult({ loading: false, error: message, elapsedMs });
    } finally {
      setIsStyleTransferring(false);
    }
  }, [storyId, pageNumber, styleTargetModel]);

  const formatElapsed = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const hasResults = Object.keys(results).length > 0;

  return (
    <>
      {/* Fullscreen mode lifts the panel into a viewport-filling modal so
          composite intermediates have room to breathe. The two-column results
          grid and prompt expanders are hard to read in the narrow inline slot. */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-40 bg-black/60"
          onClick={() => setFullscreen(false)}
          aria-hidden
        />
      )}
      <div
        className={
          fullscreen
            ? 'fixed inset-4 z-50 bg-white rounded-lg border shadow-2xl p-4 overflow-y-auto'
            : 'bg-white rounded-lg border shadow-lg p-4'
        }
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            Test Models — Page {pageNumber}
          </h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setFullscreen(v => !v)}
              className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* ── Model (mandatory, single) — applies to every method below ── */}
        <div className="mb-4 p-3 rounded-lg bg-blue-50 border border-blue-200">
          <div className="text-xs font-semibold text-blue-900 mb-2">
            Image model <span className="text-blue-600">— picks one. Applied by every method below.</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {AVAILABLE_MODELS.map(model => (
              <label
                key={model.id}
                className="flex items-center gap-1.5 cursor-pointer select-none"
              >
                <input
                  type="radio"
                  name="testModelsImageModel"
                  checked={selectedModel === model.id}
                  onChange={() => setSelectedModel(model.id)}
                  disabled={isRunning}
                  className="text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">{model.label}</span>
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-white text-gray-500 font-mono">
                  {model.cost}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* ── Method 1: Direct path ── */}
        <div className="mb-3 p-3 rounded-lg bg-orange-50 border border-orange-200">
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={runDirect}
              onChange={e => setRunDirect(e.target.checked)}
              disabled={isRunning}
              className="rounded border-gray-300 text-orange-600 focus:ring-orange-500"
            />
            <span className="text-sm font-semibold text-orange-900">Method 1 — Direct</span>
            <span className="text-[11px] text-orange-700">One model call: prompt + character refs → page image.</span>
          </label>
          <div className={`flex flex-wrap gap-3 mt-2 ${runDirect ? '' : 'opacity-50'}`}>
            <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
              <span className="text-xs font-medium text-orange-700">Reference mode</span>
              <select
                value={referenceMode}
                onChange={e => setReferenceMode(e.target.value as typeof referenceMode)}
                disabled={isRunning || !runDirect}
                className="rounded border-gray-300 text-xs p-1"
              >
                <option value="inherit">inherit (server default)</option>
                <option value="strict">strict — all refs + VB grid</option>
                <option value="loose">loose — refs only on close-ups</option>
                <option value="styled-only">styled-only — keep refs, no shot filter</option>
                <option value="off">off — no character refs / landmarks</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
              <span className="text-xs font-medium text-orange-700">Empty-scene plate</span>
              <select
                value={singlePassScene}
                onChange={e => setSinglePassScene(e.target.value as typeof singlePassScene)}
                disabled={isRunning || !runDirect}
                className="rounded border-gray-300 text-xs p-1"
              >
                <option value="inherit">inherit (server default)</option>
                <option value="off">use plate (two-pass)</option>
                <option value="on">skip plate (single-pass)</option>
              </select>
            </label>
            <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-[260px]">
              <input
                type="checkbox"
                checked={useStorySheetCells}
                onChange={e => setUseStorySheetCells(e.target.checked)}
                disabled={isRunning || !runDirect}
                className="mt-0.5 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
              />
              <span className="flex flex-col">
                <span className="text-xs text-orange-700 font-medium">Use 2×4 cell refs</span>
                <span className="text-[10px] text-gray-500">Send ONE body cell from the story's 2×4 sheet at the scene's intended pose, instead of the full styled-avatar.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-[260px]">
              <input
                type="checkbox"
                checked={iterativePlacement}
                onChange={e => setIterativePlacement(e.target.checked)}
                disabled={isRunning || !runDirect}
                className="mt-0.5 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
              />
              <span className="flex flex-col">
                <span className="text-xs text-orange-700 font-medium">Iterative placement <span className="font-normal text-gray-500">(legacy)</span></span>
                <span className="text-[10px] text-gray-500">2-pass — render characters first, then composite onto a separate empty-BG plate. Pre-dates the composite method below.</span>
              </span>
            </label>
          </div>
        </div>

        {/* ── Method 2: Uniform Composite (legacy) ── */}
        <div className="mb-3 p-3 rounded-lg bg-purple-50 border border-purple-200">
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={runUniform}
              onChange={e => setRunUniform(e.target.checked)}
              disabled={isRunning}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            <span className="text-sm font-semibold text-purple-900">Method 2 — Uniform Composite (legacy)</span>
            <span className="text-[11px] text-purple-700">populated plate (all silhouettes) → depopulate → bbox detect → cutouts from 2×4 sheet → blend</span>
          </label>
          <div className={`flex flex-wrap gap-3 mt-2 ${runUniform ? '' : 'opacity-50'}`}>
            <label className="flex items-start gap-2 cursor-pointer flex-1 min-w-[260px]">
              <input
                type="checkbox"
                checked={phantomPoseRender}
                onChange={e => setPhantomPoseRender(e.target.checked)}
                disabled={isRunning || !runUniform}
                className="mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
              />
              <span className="flex flex-col">
                <span className="text-xs text-purple-700 font-medium">Phantom-pose render</span>
                <span className="text-[10px] text-gray-500">Re-render each character in the silhouette's exact pose via Grok edit (+1 call per cast member).</span>
              </span>
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-[200px]">
              <span className="text-xs font-medium text-purple-700">Populated plate (step 1)</span>
              <select
                value={emptyScene}
                onChange={e => setEmptyScene(e.target.value as typeof emptyScene)}
                disabled={isRunning || (!runUniform && !runStratified)}
                className="rounded border-gray-300 text-xs p-1"
              >
                <option value="fresh">regenerate fresh (Grok call)</option>
                <option value="reuse">reuse last (if cached)</option>
                <option value="skip">skip — let composite decide</option>
              </select>
            </label>
          </div>
        </div>

        {/* ── Method 3: Stratified Composite (new) ── */}
        <div className="mb-3 p-3 rounded-lg bg-emerald-50 border border-emerald-200">
          <label className="flex items-center gap-2 cursor-pointer mb-2">
            <input
              type="checkbox"
              checked={runStratified}
              onChange={e => setRunStratified(e.target.checked)}
              disabled={isRunning}
              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="text-sm font-semibold text-emerald-900">Method 3 — Stratified Composite</span>
            <span className="text-[11px] text-emerald-700">anchor plate (back native + front silhouettes) → depopulate front → front-figure plate → crop + composite → blend</span>
          </label>
          <p className={`text-[11px] mt-1 ${runStratified ? 'text-emerald-700' : 'text-gray-500'}`}>
            Cast is split by depth: back half rendered natively in step 1 (no cutout), front half drawn together in step 3 then diff-cropped onto the depopulated back plate. Flat 4 Grok calls regardless of cast size. N=1 short-circuits to the anchor plate only.
          </p>
        </div>

        {/* Run button */}
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={runTest}
            disabled={isRunning || !selectedModel || (!runDirect && !runUniform && !runStratified)}
            className="px-4 py-2 text-sm font-semibold rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 transition-colors flex items-center gap-1.5"
          >
            {isRunning ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Running...
              </>
            ) : (
              'Run Test'
            )}
          </button>
          {!runDirect && !runUniform && !runStratified && (
            <span className="text-xs text-red-600">Tick at least one method above.</span>
          )}
          {hasResults && !isRunning && (
            <span className="text-xs text-gray-500">
              {Object.values(results).filter(r => !r.loading && r.imageData).length} of{' '}
              {Object.keys(results).length} succeeded
            </span>
          )}
        </div>

        {/* Results Grid */}
        {hasResults && (
          <div className={fullscreen ? 'grid grid-cols-1 lg:grid-cols-2 gap-6' : 'grid grid-cols-2 gap-4'}>
            {[
              ...AVAILABLE_MODELS.filter(m => results[m.id]).map(m => ({ id: m.id, label: m.label, cost: m.cost })),
              // Composite-path result(s). Possible keys:
              //   "composite"                      → stratified
              //   "composite+uniform"              → uniform, no phantom-pose
              //   "composite+phantomPose+uniform"  → uniform + phantom-pose
              ...Object.keys(results).filter(k => k.startsWith('composite')).map(k => {
                const isUniform = k.includes('+uniform');
                const hasPhantom = k.includes('+phantomPose');
                let label: string;
                if (!isUniform) label = 'Stratified Composite';
                else if (hasPhantom) label = 'Uniform Composite + Phantom-Pose';
                else label = 'Uniform Composite';
                return { id: k, label, cost: 'method' };
              }),
            ].map(model => {
              const result = results[model.id];
              // Composite tiles get the full row width — they carry many
              // intermediate-step images stacked vertically and look cramped
              // in a half-column slot.
              const isComposite = model.cost === 'method';
              return (
                <div
                  key={model.id}
                  className={`border rounded-lg p-3 bg-gray-50 flex flex-col ${isComposite ? 'col-span-2 lg:col-span-2' : ''}`}
                >
                  {/* Model name + cost badge */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-800">
                        {model.label}
                      </span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-mono ${model.cost === 'method' ? 'bg-purple-200 text-purple-700' : 'bg-gray-200 text-gray-600'}`}>
                        {model.cost}
                      </span>
                    </div>
                    {result.elapsedMs != null && !result.loading && (
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Clock size={12} />
                        {formatElapsed(result.elapsedMs)}
                      </div>
                    )}
                  </div>

                  {/* Content area */}
                  {result.loading ? (
                    <div className="flex items-center justify-center h-48 bg-white rounded border border-dashed border-gray-300">
                      <div className="flex flex-col items-center gap-2 text-gray-400">
                        <Loader2 size={24} className="animate-spin" />
                        <span className="text-xs">Generating...</span>
                      </div>
                    </div>
                  ) : result.error ? (
                    <div className="flex items-center justify-center h-48 bg-red-50 rounded border border-red-200">
                      <div className="flex flex-col items-center gap-2 text-red-500 px-3 text-center">
                        <AlertTriangle size={24} />
                        <span className="text-xs">{result.error}</span>
                      </div>
                    </div>
                  ) : result.imageData ? (
                    <div className="relative group">
                      <img
                        src={
                          result.imageData.startsWith('data:')
                            ? result.imageData
                            : `data:image/png;base64,${result.imageData}`
                        }
                        alt={`${model.label} result`}
                        className="max-h-64 w-full object-contain rounded border bg-white cursor-pointer"
                        onClick={() =>
                          setLightboxImage(
                            result.imageData!.startsWith('data:')
                              ? result.imageData!
                              : `data:image/png;base64,${result.imageData!}`
                          )
                        }
                      />
                      {/* "Use This" button */}
                      {onUseImage && (
                        <button
                          onClick={() =>
                            onUseImage(result.imageData!, result.modelId || model.id)
                          }
                          className="absolute bottom-2 right-2 px-2 py-1 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 shadow"
                        >
                          <Check size={12} />
                          Use This
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-48 bg-gray-100 rounded border border-dashed border-gray-300">
                      <span className="text-xs text-gray-400">No image returned</span>
                    </div>
                  )}
                  {/* Iterative placement debug: show Pass 1 image and prompts */}
                  {result.pass2Failed && (
                    <div className="mt-1 px-2 py-1 bg-red-50 border border-red-200 rounded text-xs text-red-700">
                      Pass 2 failed{result.pass2Error ? `: ${result.pass2Error}` : ''} — showing Pass 1 only
                    </div>
                  )}
                  {result.pass1Image && (
                    <div className="mt-2 space-y-1">
                      <div className="text-[10px] font-medium text-orange-600">Pass 1 (foreground only):</div>
                      <img
                        src={result.pass1Image.startsWith('data:') ? result.pass1Image : `data:image/png;base64,${result.pass1Image}`}
                        alt="Pass 1"
                        className="max-h-32 w-full object-contain rounded border bg-white cursor-pointer"
                        onClick={() => setLightboxImage(result.pass1Image!.startsWith('data:') ? result.pass1Image! : `data:image/png;base64,${result.pass1Image!}`)}
                      />
                    </div>
                  )}
                  {(result.pass1Prompt || result.pass2Prompt) && (
                    <details className="mt-1">
                      <summary className="text-[10px] text-gray-400 cursor-pointer">Prompts</summary>
                      {result.pass1Prompt && (
                        <div className="mt-1">
                          <div className="text-[9px] font-medium text-gray-500">Pass 1 prompt:</div>
                          <pre className="text-xs bg-gray-50 p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap">{result.pass1Prompt}</pre>
                        </div>
                      )}
                      {result.pass2Prompt && (
                        <div className="mt-1">
                          <div className="text-[9px] font-medium text-gray-500">Pass 2 prompt:</div>
                          <pre className="text-xs bg-gray-50 p-2 rounded max-h-48 overflow-auto whitespace-pre-wrap">{result.pass2Prompt}</pre>
                        </div>
                      )}
                    </details>
                  )}
                  {/* Composite intermediate steps — shown for every composite-method
                      result so you can see populated plate, depopulate (derived clean
                      BG), per-character phantom-pose renders, and the composited
                      image before the final blend. */}
                  {result.compositeDebug && (
                    <details className="mt-2 border-t border-purple-200 pt-2" open>
                      <summary className="text-[10px] font-semibold text-purple-700 cursor-pointer">
                        Composite intermediate steps (actual pipeline order)
                      </summary>
                      <div className="mt-2 space-y-3">
                        {/* Stratified-only: cast split + step-0 inputs (empty scene + identity packs). */}
                        {result.compositeDebug.strategy === 'stratified' && (
                          <div className="rounded border border-emerald-300 bg-emerald-50 p-2 space-y-2">
                            <div className="text-[10px] font-semibold text-emerald-800">
                              Stratified Composite — cast split
                            </div>
                            <div className="flex flex-wrap gap-3 text-[10px]">
                              <span><strong>back</strong> (rendered native): {(result.compositeDebug.backNames || []).join(', ') || '—'}</span>
                              <span><strong>front</strong> (silhouette → cutout): {(result.compositeDebug.frontNames || []).join(', ') || '—'}</span>
                            </div>
                            {(result.compositeDebug.emptyScene || result.compositeDebug.backIdentityPack || result.compositeDebug.frontIdentityPack) && (
                              <div className={fullscreen ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-3 gap-1'}>
                                {result.compositeDebug.emptyScene && (
                                  <div className="flex flex-col">
                                    <div className="text-[9px] font-medium text-emerald-800 mb-0.5">
                                      0. Empty scene <span className="text-gray-500 font-normal">({result.compositeDebug.emptySceneSource || 'generated'})</span>
                                    </div>
                                    <img
                                      src={result.compositeDebug.emptyScene}
                                      alt="empty scene"
                                      className={`${fullscreen ? 'max-h-48' : 'max-h-32'} w-full object-contain rounded border bg-white cursor-pointer`}
                                      onClick={() => setLightboxImage(result.compositeDebug!.emptyScene!)}
                                    />
                                  </div>
                                )}
                                {result.compositeDebug.backIdentityPack && (
                                  <div className="flex flex-col">
                                    <div className="text-[9px] font-medium text-emerald-800 mb-0.5">Back identity pack</div>
                                    <img
                                      src={result.compositeDebug.backIdentityPack}
                                      alt="back identity pack"
                                      className={`${fullscreen ? 'max-h-48' : 'max-h-32'} w-full object-contain rounded border bg-white cursor-pointer`}
                                      onClick={() => setLightboxImage(result.compositeDebug!.backIdentityPack!)}
                                    />
                                  </div>
                                )}
                                {result.compositeDebug.frontIdentityPack && (
                                  <div className="flex flex-col">
                                    <div className="text-[9px] font-medium text-emerald-800 mb-0.5">Front identity pack</div>
                                    <img
                                      src={result.compositeDebug.frontIdentityPack}
                                      alt="front identity pack"
                                      className={`${fullscreen ? 'max-h-48' : 'max-h-32'} w-full object-contain rounded border bg-white cursor-pointer`}
                                      onClick={() => setLightboxImage(result.compositeDebug!.frontIdentityPack!)}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                            {result.compositeDebug.emptySceneSentToGrok && (
                              <SentToGrokBlock
                                snapshot={result.compositeDebug.emptySceneSentToGrok}
                                label="Empty scene (step 0)"
                                onLightbox={setLightboxImage}
                              />
                            )}
                          </div>
                        )}
                        {/* Step 1 — populated plate with bbox overlay */}
                        {result.compositeDebug.populatedPlate && (
                          <div>
                            <div className="text-[10px] font-semibold text-purple-700 mb-1">
                              1. {result.compositeDebug.strategy === 'stratified' ? 'Anchor plate' : 'Populated plate'} <span className="text-gray-500 font-normal">— {result.compositeDebug.strategy === 'stratified' ? 'Grok edit on empty scene + identity packs, back chars rendered native + front as silhouettes' : 'Grok generate, scene + silhouettes in one call'}</span>
                            </div>
                            <PlateWithBboxes
                              src={result.compositeDebug.populatedPlate}
                              bboxes={result.compositeDebug.bboxes}
                              onLightbox={setLightboxImage}
                              maxH={fullscreen ? 'max-h-[60vh]' : 'max-h-64'}
                            />
                            {result.compositeDebug.bboxes && Object.keys(result.compositeDebug.bboxes).length > 0 && (
                              <div className="mt-1 text-[10px] text-gray-700 flex flex-wrap gap-1.5">
                                {Object.entries(result.compositeDebug.bboxes).map(([name, b], i) => (
                                  <span
                                    key={name}
                                    className="px-1.5 py-0.5 rounded font-mono border"
                                    style={{ borderColor: BBOX_COLOURS[i % BBOX_COLOURS.length], color: BBOX_COLOURS[i % BBOX_COLOURS.length] }}
                                  >
                                    {name}: {b.width}×{b.height}@({b.x},{b.y}) · {b.pixels}px
                                  </span>
                                ))}
                              </div>
                            )}
                            <SentToGrokBlock
                              snapshot={result.compositeDebug.populatedPlateSentToGrok}
                              label="Populated plate"
                              onLightbox={setLightboxImage}
                            />
                            {/* Fallback for stories generated before sentToGrok existed. */}
                            {!result.compositeDebug.populatedPlateSentToGrok && result.compositeDebug.populatedPlatePrompt && (
                              <details className="mt-1">
                                <summary className="text-[10px] text-gray-400 cursor-pointer">populated-plate prompt (legacy — pre-sentToGrok) ({result.compositeDebug.populatedPlatePrompt.length} chars)</summary>
                                <pre className="mt-1 text-[10px] bg-gray-50 p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap border">{result.compositeDebug.populatedPlatePrompt}</pre>
                              </details>
                            )}
                          </div>
                        )}
                        {/* Step 2 — depopulate (derived clean BG) */}
                        {result.compositeDebug.cleanBackground && (
                          <div>
                            <div className="text-[10px] font-semibold text-purple-700 mb-1">
                              2. Depopulate <span className="text-gray-500 font-normal">— Grok edit removes silhouettes → derived clean BG ({result.compositeDebug.cleanBackgroundSource || 'derived-from-populated-plate'})</span>
                            </div>
                            <img
                              src={result.compositeDebug.cleanBackground}
                              alt="derived clean background"
                              className={`${fullscreen ? 'max-h-[60vh]' : 'max-h-64'} w-full object-contain rounded border bg-white cursor-pointer`}
                              onClick={() => setLightboxImage(result.compositeDebug!.cleanBackground!)}
                            />
                            <SentToGrokBlock
                              snapshot={result.compositeDebug.depopulateSentToGrok}
                              label="Depopulate"
                              onLightbox={setLightboxImage}
                            />
                            {!result.compositeDebug.depopulateSentToGrok && result.compositeDebug.depopulatePrompt && (
                              <details className="mt-1">
                                <summary className="text-[10px] text-gray-400 cursor-pointer">depopulate prompt (legacy — pre-sentToGrok) ({result.compositeDebug.depopulatePrompt.length} chars)</summary>
                                <pre className="mt-1 text-[10px] bg-gray-50 p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap border">{result.compositeDebug.depopulatePrompt}</pre>
                              </details>
                            )}
                          </div>
                        )}
                        {/* Stratified-only: Step 3 — front-figure plate (real front
                            chars rendered together where the silhouettes were). */}
                        {result.compositeDebug.frontPlate && (
                          <div>
                            <div className="text-[10px] font-semibold text-emerald-800 mb-1">
                              3. Front-figure plate <span className="text-gray-500 font-normal">— Grok edit replaces front silhouettes with real characters (one call, all front chars together)</span>
                            </div>
                            <img
                              src={result.compositeDebug.frontPlate}
                              alt="front figure plate"
                              className={`${fullscreen ? 'max-h-[60vh]' : 'max-h-64'} w-full object-contain rounded border bg-white cursor-pointer`}
                              onClick={() => setLightboxImage(result.compositeDebug!.frontPlate!)}
                            />
                            <SentToGrokBlock
                              snapshot={result.compositeDebug.frontPlateSentToGrok}
                              label="Front-figure plate"
                              onLightbox={setLightboxImage}
                            />
                            {!result.compositeDebug.frontPlateSentToGrok && result.compositeDebug.frontPlatePrompt && (
                              <details className="mt-1">
                                <summary className="text-[10px] text-gray-400 cursor-pointer">front-plate prompt (legacy — pre-sentToGrok) ({result.compositeDebug.frontPlatePrompt.length} chars)</summary>
                                <pre className="mt-1 text-[10px] bg-gray-50 p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap border">{result.compositeDebug.frontPlatePrompt}</pre>
                              </details>
                            )}
                          </div>
                        )}
                        {/* Step 3/4 — diff-based bbox detect. Show per-character crops
                            from the populated plate so the result is concrete. */}
                        {result.compositeDebug.bboxes && Object.keys(result.compositeDebug.bboxes).length > 0 && result.compositeDebug.populatedPlate && (
                          <div>
                            <div className="text-[10px] font-semibold text-purple-700 mb-1">
                              3. Bbox detect <span className="text-gray-500 font-normal">— diff(populated, clean BG) ∩ hue → {Object.keys(result.compositeDebug.bboxes).length} silhouettes detected. Each crop below is the populated plate clipped to that character's bbox.</span>
                            </div>
                            <div className={fullscreen ? 'grid grid-cols-4 gap-3' : 'grid grid-cols-3 gap-2'}>
                              {Object.entries(result.compositeDebug.bboxes).map(([name, b], i) => (
                                <BboxCrop
                                  key={name}
                                  src={result.compositeDebug!.populatedPlate!}
                                  bbox={b}
                                  colour={BBOX_COLOURS[i % BBOX_COLOURS.length]}
                                  name={name}
                                  onLightbox={setLightboxImage}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Step 4 — phantom-pose renders (one per character, only when phantomPoseRender=true) */}
                        {result.compositeDebug.phantomPoseRenders && Object.keys(result.compositeDebug.phantomPoseRenders).length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold text-purple-700 mb-1">
                              4. Phantom-pose renders <span className="text-gray-500 font-normal">— Grok edit re-poses each character in the silhouette's pose ({Object.keys(result.compositeDebug.phantomPoseRenders).length} chars)</span>
                            </div>
                            <div className={fullscreen ? 'grid grid-cols-4 gap-2' : 'grid grid-cols-3 gap-1'}>
                              {Object.entries(result.compositeDebug.phantomPoseRenders).map(([name, ppr]) => (
                                <div key={name} className="flex flex-col items-center">
                                  {ppr.output && (
                                    <img
                                      src={ppr.output}
                                      alt={`${name} phantom-pose`}
                                      className={`${fullscreen ? 'max-h-48' : 'max-h-32'} w-full object-contain rounded border bg-white cursor-pointer`}
                                      onClick={() => setLightboxImage(ppr.output!)}
                                    />
                                  )}
                                  <span className="text-[10px] font-medium text-gray-700 mt-0.5">{name}</span>
                                  {ppr.prompt && (
                                    <details className="w-full">
                                      <summary className="text-[9px] text-gray-400 cursor-pointer">prompt</summary>
                                      <pre className="text-[9px] bg-gray-50 p-1 rounded max-h-24 overflow-auto whitespace-pre-wrap">{ppr.prompt}</pre>
                                    </details>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Step 5 — composited image (sharp paste before blend) */}
                        {result.compositeDebug.composited && (
                          <div>
                            <div className="text-[10px] font-semibold text-purple-700 mb-1">
                              5. Composited <span className="text-gray-500 font-normal">— cutouts pasted onto derived clean BG (server-side sharp, z-ordered by occlusion)</span>
                            </div>
                            <img
                              src={result.compositeDebug.composited}
                              alt="composited"
                              className={`${fullscreen ? 'max-h-[60vh]' : 'max-h-64'} w-full object-contain rounded border bg-white cursor-pointer`}
                              onClick={() => setLightboxImage(result.compositeDebug!.composited!)}
                            />
                          </div>
                        )}
                        {/* Z-order decisions (from occlusion detection) */}
                        {result.compositeDebug.zDecisions && result.compositeDebug.zDecisions.length > 0 && (
                          <details open>
                            <summary className="text-[10px] font-medium text-purple-600 cursor-pointer">Z-order (occlusion-based)</summary>
                            <div className="mt-1 text-[10px] text-gray-700 space-y-0.5 font-mono">
                              {result.compositeDebug.zDecisions.map((d, i) => (
                                <div key={i}>{d.a}={d.aPx}px vs {d.b}={d.bPx}px → <strong>{d.winner}</strong> in front</div>
                              ))}
                              {result.compositeDebug.zScores && (
                                <div className="mt-1 text-purple-700">scores: {Object.entries(result.compositeDebug.zScores).map(([n, s]) => `${n}=${s}`).join(', ')}</div>
                              )}
                            </div>
                          </details>
                        )}
                        {/* Step 6 — final blend (the top-of-card image IS this output) */}
                        {(result.compositeDebug.blendSentToGrok || result.compositeDebug.blendPrompt) && (
                          <div>
                            <div className="text-[10px] font-semibold text-purple-700 mb-1">
                              6. Blend <span className="text-gray-500 font-normal">— Grok edit harmonises lighting/edges/required objects (final blend is the top-of-card image above)</span>
                            </div>
                            <SentToGrokBlock
                              snapshot={result.compositeDebug.blendSentToGrok}
                              label="Blend"
                              onLightbox={setLightboxImage}
                            />
                            {!result.compositeDebug.blendSentToGrok && result.compositeDebug.blendPrompt && (
                              <details>
                                <summary className="text-[10px] text-gray-400 cursor-pointer">blend prompt (legacy — pre-sentToGrok) ({result.compositeDebug.blendPrompt.length} chars)</summary>
                                <pre className="mt-1 text-[10px] bg-gray-50 p-2 rounded max-h-40 overflow-auto whitespace-pre-wrap border">{result.compositeDebug.blendPrompt}</pre>
                              </details>
                            )}
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                  {/* Test parameters + exact inputs sent to the model — keeps the
                      history self-explanatory (refMode, plate, refs, prompt). */}
                  {result.inputSnapshot && (
                    <details className="mt-2 border-t border-gray-200 pt-2">
                      <summary className="text-[10px] font-medium text-indigo-600 cursor-pointer flex items-center gap-1">
                        <ChevronRight size={10} className="inline group-open:hidden" />
                        <ChevronDown size={10} className="hidden group-open:inline" />
                        Test parameters & inputs sent
                      </summary>
                      <div className="mt-2 space-y-2 text-[10px] text-gray-700">
                        <div className="flex flex-wrap gap-2">
                          <span className="px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200">
                            referenceMode: <strong>{result.inputSnapshot.referenceMode}</strong>
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200">
                            singlePassScene: <strong>{String(result.inputSnapshot.singlePassScene)}</strong>
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-200">
                            iterativePlacement: <strong>{String(result.inputSnapshot.iterativePlacement)}</strong>
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-gray-100 border border-gray-200">
                            promptLength: {result.inputSnapshot.promptLength}
                          </span>
                        </div>
                        {/* Reference images sent to the model */}
                        {(result.inputSnapshot.characterPhotos.length > 0
                          || result.inputSnapshot.landmarkPhotos.length > 0
                          || result.inputSnapshot.visualBibleGrid
                          || result.inputSnapshot.sceneBackground
                          || (result.grokRefImages && result.grokRefImages.length > 0)) && (
                          <div>
                            <div className="text-[9px] font-medium text-gray-500 mb-1">Images sent to model:</div>
                            <div className="flex flex-wrap gap-1">
                              {result.inputSnapshot.sceneBackground && (
                                <div className="flex flex-col items-center">
                                  <img
                                    src={result.inputSnapshot.sceneBackground.startsWith('data:')
                                      ? result.inputSnapshot.sceneBackground
                                      : `data:image/jpeg;base64,${result.inputSnapshot.sceneBackground}`}
                                    alt="Empty-scene plate"
                                    className="h-16 w-16 object-cover rounded border bg-white cursor-pointer"
                                    onClick={() => setLightboxImage(result.inputSnapshot!.sceneBackground!.startsWith('data:')
                                      ? result.inputSnapshot!.sceneBackground!
                                      : `data:image/jpeg;base64,${result.inputSnapshot!.sceneBackground!}`)}
                                  />
                                  <span className="text-[8px] text-gray-500 mt-0.5">plate</span>
                                </div>
                              )}
                              {result.inputSnapshot.visualBibleGrid && (
                                <div className="flex flex-col items-center">
                                  <img
                                    src={result.inputSnapshot.visualBibleGrid}
                                    alt="VB grid"
                                    className="h-16 w-16 object-cover rounded border bg-white cursor-pointer"
                                    onClick={() => setLightboxImage(result.inputSnapshot!.visualBibleGrid!)}
                                  />
                                  <span className="text-[8px] text-gray-500 mt-0.5">VB grid</span>
                                </div>
                              )}
                              {result.inputSnapshot.characterPhotos.map((p, i) => p.photoUrl ? (
                                <div key={`char-${i}`} className="flex flex-col items-center">
                                  <img
                                    src={p.photoUrl}
                                    alt={p.name}
                                    className="h-16 w-16 object-cover rounded border bg-white cursor-pointer"
                                    onClick={() => setLightboxImage(p.photoUrl!)}
                                  />
                                  <span className="text-[8px] text-gray-500 mt-0.5 truncate max-w-[64px]">{p.name}</span>
                                </div>
                              ) : null)}
                              {result.inputSnapshot.landmarkPhotos.map((l, i) => l.photoData ? (
                                <div key={`lm-${i}`} className="flex flex-col items-center">
                                  <img
                                    src={l.photoData.startsWith('data:') ? l.photoData : `data:image/jpeg;base64,${l.photoData}`}
                                    alt={l.name}
                                    className="h-16 w-16 object-cover rounded border bg-white cursor-pointer"
                                    onClick={() => setLightboxImage(l.photoData!.startsWith('data:') ? l.photoData! : `data:image/jpeg;base64,${l.photoData!}`)}
                                  />
                                  <span className="text-[8px] text-gray-500 mt-0.5 truncate max-w-[64px]">{l.name}</span>
                                </div>
                              ) : null)}
                            </div>
                          </div>
                        )}
                        {/* Exact images packed for Grok (after letterboxing/etc) */}
                        {result.grokRefImages && result.grokRefImages.length > 0 && (
                          <div>
                            <div className="text-[9px] font-medium text-gray-500 mb-1">Packed Grok refs ({result.grokRefImages.length}):</div>
                            <div className="flex flex-wrap gap-1">
                              {result.grokRefImages.map((img, i) => (
                                <img
                                  key={`grok-${i}`}
                                  src={img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`}
                                  alt={`Grok ref ${i + 1}`}
                                  className="h-16 w-16 object-cover rounded border bg-white cursor-pointer"
                                  onClick={() => setLightboxImage(img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`)}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Full prompt for verification — collapsed by default */}
                        <details>
                          <summary className="text-[9px] font-medium text-gray-500 cursor-pointer">Full prompt</summary>
                          <pre className="text-[10px] bg-gray-50 p-2 rounded max-h-64 overflow-auto whitespace-pre-wrap mt-1">{result.inputSnapshot.promptFull}</pre>
                        </details>
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Style Transfer Section */}
        <div className="mt-4 pt-4 border-t border-gray-200">
          <div className="flex items-center gap-2 mb-3">
            <Paintbrush size={16} className="text-purple-600" />
            <h4 className="text-sm font-semibold text-gray-800">Style Transfer</h4>
            <span className="text-[10px] text-gray-400">Re-render current page image in the story art style using a different model</span>
          </div>
          {/* Style source selector */}
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <label className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input type="radio" name="styleSource" checked={styleSource === 'story'} onChange={() => setStyleSource('story')} className="text-purple-600" />
              Story art style
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input type="radio" name="styleSource" checked={styleSource === 'preset'} onChange={() => setStyleSource('preset')} className="text-purple-600" />
              Preset
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input type="radio" name="styleSource" checked={styleSource === 'analyzed'} onChange={() => setStyleSource('analyzed')} className="text-purple-600" />
              Analyzed from image
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input type="radio" name="styleSource" checked={styleSource === 'custom'} onChange={() => setStyleSource('custom')} className="text-purple-600" />
              Custom
            </label>
            {styleSource === 'analyzed' && (
              <button
                onClick={async () => {
                  setIsAnalyzing(true);
                  try {
                    const result = await storyService.analyzeStyle(storyId, pageNumber);
                    setAnalyzedStyle(result.style);
                  } catch (err) {
                    setAnalyzedStyle('Analysis failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
                  } finally {
                    setIsAnalyzing(false);
                  }
                }}
                disabled={isAnalyzing}
                className="px-2 py-1 text-xs font-medium rounded bg-gray-600 text-white hover:bg-gray-700 disabled:bg-gray-300"
              >
                {isAnalyzing ? 'Analyzing...' : 'Analyze Current Image'}
              </button>
            )}
          </div>
          {styleSource === 'preset' && (
            <select
              value={presetStyleId}
              onChange={e => setPresetStyleId(e.target.value)}
              disabled={isStyleTransferring}
              className="w-full rounded border-gray-300 text-sm p-1.5 mb-2"
            >
              {artStyles.map(s => (
                <option key={s.id} value={s.id}>{s.name.en}</option>
              ))}
            </select>
          )}
          {styleSource === 'analyzed' && analyzedStyle && (
            <textarea
              value={analyzedStyle}
              onChange={e => setAnalyzedStyle(e.target.value)}
              className="w-full text-xs border border-gray-300 rounded p-2 mb-2 h-20 resize-y"
              placeholder="Analyzed style description (editable)"
            />
          )}
          {styleSource === 'custom' && (
            <textarea
              value={customStyle}
              onChange={e => setCustomStyle(e.target.value)}
              className="w-full text-xs border border-gray-300 rounded p-2 mb-2 h-20 resize-y"
              placeholder="Describe the art style you want... e.g. 'Soft watercolor with visible brush strokes, warm pastel palette, children's book illustration'"
            />
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={styleTargetModel}
              onChange={e => setStyleTargetModel(e.target.value)}
              disabled={isStyleTransferring}
              className="flex-1 rounded border-gray-300 text-sm p-1.5"
            >
              {AVAILABLE_MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.label} ({m.cost})</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 cursor-pointer text-sm">
              <input type="checkbox" checked={styleWithAvatars} onChange={e => setStyleWithAvatars(e.target.checked)} className="text-purple-600" />
              With Avatars
            </label>
            <button
              onClick={runStyleTransfer}
              disabled={isStyleTransferring || !styleTargetModel || (styleSource === 'analyzed' && !analyzedStyle) || (styleSource === 'custom' && !customStyle)}
              className="px-3 py-1.5 text-sm font-medium rounded bg-purple-600 text-white hover:bg-purple-700 disabled:bg-gray-300 disabled:text-gray-500 transition-colors flex items-center gap-1.5"
            >
              {isStyleTransferring ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Transferring...
                </>
              ) : (
                <>
                  <Paintbrush size={14} />
                  Apply Style Transfer
                </>
              )}
            </button>
          </div>

          {/* Style Transfer Result */}
          {styleResult && (
            <div className="mt-3 border rounded-lg p-3 bg-purple-50">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-purple-800">
                  Style Transfer Result
                  {styleResult.modelId && ` (${AVAILABLE_MODELS.find(m => m.id === styleResult.modelId)?.label || styleResult.modelId})`}
                </span>
                {styleResult.elapsedMs != null && !styleResult.loading && (
                  <div className="flex items-center gap-1 text-xs text-gray-500">
                    <Clock size={12} />
                    {formatElapsed(styleResult.elapsedMs)}
                  </div>
                )}
              </div>
              {styleResult.loading ? (
                <div className="flex items-center justify-center h-48 bg-white rounded border border-dashed border-purple-300">
                  <div className="flex flex-col items-center gap-2 text-purple-400">
                    <Loader2 size={24} className="animate-spin" />
                    <span className="text-xs">Applying style transfer...</span>
                  </div>
                </div>
              ) : styleResult.error ? (
                <div className="flex items-center justify-center h-48 bg-red-50 rounded border border-red-200">
                  <div className="flex flex-col items-center gap-2 text-red-500 px-3 text-center">
                    <AlertTriangle size={24} />
                    <span className="text-xs">{styleResult.error}</span>
                  </div>
                </div>
              ) : styleResult.imageData ? (
                <div className="relative group">
                  <img
                    src={
                      styleResult.imageData.startsWith('data:')
                        ? styleResult.imageData
                        : `data:image/png;base64,${styleResult.imageData}`
                    }
                    alt="Style transfer result"
                    className="max-h-64 w-full object-contain rounded border bg-white cursor-pointer"
                    onClick={() =>
                      setLightboxImage(
                        styleResult.imageData!.startsWith('data:')
                          ? styleResult.imageData!
                          : `data:image/png;base64,${styleResult.imageData!}`
                      )
                    }
                  />
                  {onUseImage && (
                    <button
                      onClick={() =>
                        onUseImage(styleResult.imageData!, styleResult.modelId || styleTargetModel)
                      }
                      className="absolute bottom-2 right-2 px-2 py-1 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 shadow"
                    >
                      <Check size={12} />
                      Use This
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Style Lab Section */}
        <StyleLabSection
          storyId={storyId}
          pageNumber={pageNumber}
          onUseImage={onUseImage}
        />
      </div>

      {/* Lightbox */}
      <ImageLightbox
        src={lightboxImage}
        alt="Test model result"
        onClose={() => setLightboxImage(null)}
      />
    </>
  );
}

export default TestModelsPanel;
