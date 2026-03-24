import { useState, useCallback } from 'react';
import { X, Loader2, Check, Clock, AlertTriangle, Paintbrush } from 'lucide-react';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import storyService from '@/services/storyService';

interface TestModelsPanelProps {
  storyId: string;
  pageNumber: number;
  onClose: () => void;
  onUseImage?: (imageData: string, modelId: string) => void;
  language: string;
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

export function TestModelsPanel({
  storyId,
  pageNumber,
  onClose,
  onUseImage,
}: TestModelsPanelProps) {
  const [selectedModels, setSelectedModels] = useState<Set<string>>(
    new Set(['grok-imagine', 'gemini-2.5-flash-image'])
  );
  const [results, setResults] = useState<Record<string, ModelTestResult>>({});
  const [isRunning, setIsRunning] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [iterativePlacement, setIterativePlacement] = useState(false);

  // Style Transfer state
  const [styleTargetModel, setStyleTargetModel] = useState<string>('gemini-2.5-flash-image');
  const [styleWithAvatars, setStyleWithAvatars] = useState(false);
  const [styleSource, setStyleSource] = useState<'story' | 'analyzed' | 'custom'>('story');
  const [analyzedStyle, setAnalyzedStyle] = useState<string | null>(null);
  const [customStyle, setCustomStyle] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [styleResult, setStyleResult] = useState<ModelTestResult | null>(null);
  const [isStyleTransferring, setIsStyleTransferring] = useState(false);

  const toggleModel = useCallback((modelId: string) => {
    setSelectedModels(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedModels(new Set(AVAILABLE_MODELS.map(m => m.id)));
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedModels(new Set());
  }, []);

  const allSelected = selectedModels.size === AVAILABLE_MODELS.length;

  const runTest = useCallback(async () => {
    if (selectedModels.size === 0) return;
    setIsRunning(true);
    setResults({});

    const models = Array.from(selectedModels);
    const options = iterativePlacement ? { iterativePlacement: true } : undefined;

    const promises = models.map(async (model) => {
      setResults(prev => ({ ...prev, [model]: { loading: true } }));
      const startTime = Date.now();

      try {
        const response = await storyService.testModels(storyId, pageNumber, [model], options);
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
            pass1Image: (result as any)?.pass1Image,
            pass1Prompt: (result as any)?.pass1Prompt,
            pass2Prompt: (result as any)?.pass2Prompt,
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

    await Promise.allSettled(promises);
    setIsRunning(false);
  }, [selectedModels, storyId, pageNumber, iterativePlacement]);

  const runStyleTransfer = useCallback(async () => {
    if (!styleTargetModel) return;
    setIsStyleTransferring(true);
    setStyleResult({ loading: true });
    const startTime = Date.now();

    try {
      // Determine style description based on source
      const styleDesc = styleSource === 'analyzed' ? (analyzedStyle || undefined)
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
      <div className="bg-white rounded-lg border shadow-lg p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            Test Models — Page {pageNumber}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 hover:text-gray-700 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Model Selection */}
        <div className="mb-4">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            {AVAILABLE_MODELS.map(model => (
              <label
                key={model.id}
                className="flex items-center gap-1.5 cursor-pointer select-none"
              >
                <input
                  type="checkbox"
                  checked={selectedModels.has(model.id)}
                  onChange={() => toggleModel(model.id)}
                  disabled={isRunning}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-gray-700">{model.label}</span>
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-mono">
                  {model.cost}
                </span>
              </label>
            ))}
          </div>
          {/* Iterative Placement checkbox */}
          <label className="flex items-center gap-2 cursor-pointer mb-3">
            <input
              type="checkbox"
              checked={iterativePlacement}
              onChange={e => setIterativePlacement(e.target.checked)}
              disabled={isRunning}
              className="rounded border-gray-300 text-orange-600 focus:ring-orange-500"
            />
            <span className="text-sm text-orange-700 font-medium">Iterative Placement</span>
            <span className="text-[10px] text-gray-400">(2-pass: foreground first, then background)</span>
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={allSelected ? deselectAll : selectAll}
              disabled={isRunning}
              className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400"
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
            <button
              onClick={runTest}
              disabled={isRunning || selectedModels.size === 0}
              className="px-3 py-1.5 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 transition-colors flex items-center gap-1.5"
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
            {hasResults && !isRunning && (
              <span className="text-xs text-gray-500">
                {Object.values(results).filter(r => !r.loading && r.imageData).length} of{' '}
                {Object.keys(results).length} succeeded
              </span>
            )}
          </div>
        </div>

        {/* Results Grid */}
        {hasResults && (
          <div className="grid grid-cols-2 gap-4">
            {AVAILABLE_MODELS.filter(m => results[m.id]).map(model => {
              const result = results[model.id];
              return (
                <div
                  key={model.id}
                  className="border rounded-lg p-3 bg-gray-50 flex flex-col"
                >
                  {/* Model name + cost badge */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-800">
                        {model.label}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600 font-mono">
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
                          <pre className="text-[9px] bg-gray-50 p-1 rounded max-h-24 overflow-auto whitespace-pre-wrap">{result.pass1Prompt.substring(0, 500)}</pre>
                        </div>
                      )}
                      {result.pass2Prompt && (
                        <div className="mt-1">
                          <div className="text-[9px] font-medium text-gray-500">Pass 2 prompt:</div>
                          <pre className="text-[9px] bg-gray-50 p-1 rounded max-h-24 overflow-auto whitespace-pre-wrap">{result.pass2Prompt.substring(0, 500)}</pre>
                        </div>
                      )}
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
