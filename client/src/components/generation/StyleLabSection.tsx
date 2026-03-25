import { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, Clock, AlertTriangle, FlaskConical, ChevronDown, ChevronRight, RotateCw, History } from 'lucide-react';
import { ImageLightbox } from '@/components/common/ImageLightbox';
import { artStyles } from '@/constants/artStyles';
import storyService from '@/services/storyService';

interface StyleLabSectionProps {
  storyId: string;
  pageNumber: number;
  onUseImage?: (imageData: string, modelId: string) => void;
}

interface ModelResult {
  imageData?: string;
  modelId: string;
  elapsed: number;
  error?: string;
}

interface Evaluation {
  similarity: number;
  dimensions: Record<string, number>;
  summary: string;
}

interface HistoryRun {
  runId: string;
  pageNumber: number;
  artStyleId: string;
  baseStylePrompt: string;
  perModelOverrides: Record<string, string>;
  models: string[];
  thumbnails: Record<string, string>;
  evaluation?: Evaluation;
  createdAt: string;
}

const GROK_MODELS = [
  { id: 'grok-imagine', label: 'Grok Standard', cost: '$0.02' },
  { id: 'grok-imagine-pro', label: 'Grok Pro', cost: '$0.07' },
];

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-image', label: 'Gemini Flash', cost: '$0.04' },
  { id: 'gemini-3-pro-image-preview', label: 'Gemini Pro', cost: '$0.15' },
];

export function StyleLabSection({ storyId, pageNumber, onUseImage }: StyleLabSectionProps) {
  // Style selection
  const [artStyleId, setArtStyleId] = useState('watercolor');
  const [baseStylePrompt, setBaseStylePrompt] = useState('');
  const [showOverrides, setShowOverrides] = useState(false);
  const [overrideA, setOverrideA] = useState('');
  const [overrideB, setOverrideB] = useState('');

  // Model selection
  const [modelA, setModelA] = useState('grok-imagine');
  const [modelB, setModelB] = useState('gemini-2.5-flash-image');

  // Run state
  const [runId, setRunId] = useState<string | null>(null);
  const [resultA, setResultA] = useState<ModelResult | null>(null);
  const [resultB, setResultB] = useState<ModelResult | null>(null);
  const [loadingA, setLoadingA] = useState(false);
  const [loadingB, setLoadingB] = useState(false);

  // Evaluation
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);

  // History
  const [history, setHistory] = useState<HistoryRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedImages, setExpandedImages] = useState<Record<string, { imageData: string; stylePrompt: string; elapsed: number }> | null>(null);
  const [loadingExpand, setLoadingExpand] = useState(false);

  // UI
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Initialize base prompt from selected style
  useEffect(() => {
    if (artStyleId === 'custom') {
      // Keep current prompt for custom
      return;
    }
    const style = artStyles.find(s => s.id === artStyleId);
    if (style) {
      setBaseStylePrompt(style.prompt);
    }
  }, [artStyleId]);

  // Load history on mount
  useEffect(() => {
    loadHistory();
  }, [storyId, pageNumber]);

  const loadHistory = useCallback(async () => {
    try {
      const data = await storyService.styleLabHistory(storyId, pageNumber);
      setHistory(data.runs || []);
    } catch {
      // History load failure is non-critical
    }
  }, [storyId, pageNumber]);

  const formatElapsed = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  const toSrc = (img: string) => img.startsWith('data:') ? img : `data:image/png;base64,${img}`;

  const getEffectivePrompt = (model: string) => {
    if (!showOverrides) return baseStylePrompt;
    if (model === modelA && overrideA.trim()) return overrideA;
    if (model === modelB && overrideB.trim()) return overrideB;
    return baseStylePrompt;
  };

  const runModels = useCallback(async (models: string[]) => {
    const isRunA = models.includes(modelA);
    const isRunB = models.includes(modelB);
    if (isRunA) { setLoadingA(true); setResultA(null); }
    if (isRunB) { setLoadingB(true); setResultB(null); }
    if (models.length > 1) setEvaluation(null);

    const perModelOverrides: Record<string, string> = {};
    if (showOverrides) {
      if (overrideA.trim() && overrideA !== baseStylePrompt) perModelOverrides[modelA] = overrideA;
      if (overrideB.trim() && overrideB !== baseStylePrompt) perModelOverrides[modelB] = overrideB;
    }

    try {
      const response = await storyService.styleLab(storyId, pageNumber, {
        models,
        baseStylePrompt,
        artStyleId,
        perModelOverrides: Object.keys(perModelOverrides).length > 0 ? perModelOverrides : undefined,
        runId: models.length === 1 ? (runId || undefined) : undefined,
      });

      setRunId(response.runId);

      if (isRunA && response.results[modelA]) {
        setResultA(response.results[modelA]);
      }
      if (isRunB && response.results[modelB]) {
        setResultB(response.results[modelB]);
      }

      // Refresh history
      loadHistory();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (isRunA) setResultA({ modelId: modelA, elapsed: 0, error: msg });
      if (isRunB) setResultB({ modelId: modelB, elapsed: 0, error: msg });
    } finally {
      if (isRunA) setLoadingA(false);
      if (isRunB) setLoadingB(false);
    }
  }, [storyId, pageNumber, modelA, modelB, baseStylePrompt, artStyleId, showOverrides, overrideA, overrideB, runId, loadHistory]);

  const runEvaluation = useCallback(async () => {
    if (!runId) return;
    setIsEvaluating(true);
    try {
      const result = await storyService.styleLabEvaluate(storyId, pageNumber, runId);
      setEvaluation(result);
      loadHistory();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setEvaluation({ similarity: -1, dimensions: {}, summary: `Error: ${msg}` });
    } finally {
      setIsEvaluating(false);
    }
  }, [storyId, pageNumber, runId, loadHistory]);

  const expandRun = useCallback(async (run: HistoryRun) => {
    if (expandedRunId === run.runId) {
      setExpandedRunId(null);
      setExpandedImages(null);
      return;
    }
    setExpandedRunId(run.runId);
    setExpandedImages(null);
    setLoadingExpand(true);
    try {
      const data = await storyService.styleLabRunImages(storyId, pageNumber, run.runId);
      setExpandedImages(data.results);
    } catch {
      setExpandedImages(null);
    } finally {
      setLoadingExpand(false);
    }
  }, [storyId, pageNumber, expandedRunId]);

  const resumeFrom = useCallback((run: HistoryRun) => {
    setArtStyleId(run.artStyleId);
    setBaseStylePrompt(run.baseStylePrompt);
    if (Object.keys(run.perModelOverrides || {}).length > 0) {
      setShowOverrides(true);
      const models = run.models || [];
      setOverrideA(run.perModelOverrides[models[0]] || run.baseStylePrompt);
      setOverrideB(run.perModelOverrides[models[1]] || run.baseStylePrompt);
      if (models[0]) setModelA(models[0]);
      if (models[1]) setModelB(models[1]);
    } else {
      setShowOverrides(false);
      setOverrideA('');
      setOverrideB('');
    }
  }, []);

  const isRunning = loadingA || loadingB;
  const bothHaveResults = resultA?.imageData && resultB?.imageData;

  const modelALabel = [...GROK_MODELS, ...GEMINI_MODELS].find(m => m.id === modelA)?.label || modelA;
  const modelBLabel = [...GROK_MODELS, ...GEMINI_MODELS].find(m => m.id === modelB)?.label || modelB;

  return (
    <>
      <div className="mt-4 pt-4 border-t border-gray-200">
        {/* Header */}
        <div className="flex items-center gap-2 mb-3">
          <FlaskConical size={16} className="text-indigo-600" />
          <h4 className="text-sm font-semibold text-gray-800">Style Lab</h4>
          <span className="text-[10px] text-gray-400">Compare art style convergence between models</span>
        </div>

        {/* Art Style Dropdown */}
        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-600 mb-1">Art Style</label>
          <select
            value={artStyleId}
            onChange={e => setArtStyleId(e.target.value)}
            disabled={isRunning}
            className="w-full rounded border-gray-300 text-sm p-1.5"
          >
            {artStyles.map(s => (
              <option key={s.id} value={s.id}>{s.name.en}</option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </div>

        {/* Base Style Prompt */}
        <div className="mb-3">
          <label className="block text-xs font-medium text-gray-600 mb-1">Base Style Prompt</label>
          <textarea
            value={baseStylePrompt}
            onChange={e => setBaseStylePrompt(e.target.value)}
            disabled={isRunning}
            rows={3}
            className="w-full text-xs border border-gray-300 rounded p-2 resize-y"
            placeholder="Describe the art style..."
          />
        </div>

        {/* Per-model overrides toggle */}
        <button
          onClick={() => {
            setShowOverrides(!showOverrides);
            if (!showOverrides) {
              // Pre-fill overrides with base prompt
              if (!overrideA) setOverrideA(baseStylePrompt);
              if (!overrideB) setOverrideB(baseStylePrompt);
            }
          }}
          className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 mb-2"
        >
          {showOverrides ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Per-model prompt overrides
        </button>

        {showOverrides && (
          <div className="space-y-2 mb-3 pl-3 border-l-2 border-indigo-200">
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">
                {modelALabel} (Model A)
              </label>
              <textarea
                value={overrideA}
                onChange={e => setOverrideA(e.target.value)}
                disabled={isRunning}
                rows={2}
                className="w-full text-xs border border-gray-300 rounded p-2 resize-y"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-500 mb-0.5">
                {modelBLabel} (Model B)
              </label>
              <textarea
                value={overrideB}
                onChange={e => setOverrideB(e.target.value)}
                disabled={isRunning}
                rows={2}
                className="w-full text-xs border border-gray-300 rounded p-2 resize-y"
              />
            </div>
          </div>
        )}

        {/* Model Selectors + Run Buttons */}
        <div className="flex items-end gap-3 mb-4 flex-wrap">
          <div className="flex-1 min-w-[120px]">
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Model A</label>
            <select
              value={modelA}
              onChange={e => setModelA(e.target.value)}
              disabled={isRunning}
              className="w-full rounded border-gray-300 text-xs p-1.5"
            >
              {[...GROK_MODELS, ...GEMINI_MODELS].map(m => (
                <option key={m.id} value={m.id}>{m.label} ({m.cost})</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="block text-[10px] font-medium text-gray-500 mb-0.5">Model B</label>
            <select
              value={modelB}
              onChange={e => setModelB(e.target.value)}
              disabled={isRunning}
              className="w-full rounded border-gray-300 text-xs p-1.5"
            >
              {[...GROK_MODELS, ...GEMINI_MODELS].map(m => (
                <option key={m.id} value={m.id}>{m.label} ({m.cost})</option>
              ))}
            </select>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => runModels([modelA, modelB])}
              disabled={isRunning || !baseStylePrompt.trim()}
              className="px-3 py-1.5 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-gray-300 disabled:text-gray-500 transition-colors flex items-center gap-1"
            >
              {isRunning ? <Loader2 size={12} className="animate-spin" /> : null}
              Run Both
            </button>
            <button
              onClick={() => runModels([modelA])}
              disabled={isRunning || !baseStylePrompt.trim()}
              className="px-2 py-1.5 text-xs font-medium rounded bg-indigo-500 text-white hover:bg-indigo-600 disabled:bg-gray-300 disabled:text-gray-500 transition-colors"
              title={`Run ${modelALabel} only`}
            >
              A
            </button>
            <button
              onClick={() => runModels([modelB])}
              disabled={isRunning || !baseStylePrompt.trim()}
              className="px-2 py-1.5 text-xs font-medium rounded bg-indigo-500 text-white hover:bg-indigo-600 disabled:bg-gray-300 disabled:text-gray-500 transition-colors"
              title={`Run ${modelBLabel} only`}
            >
              B
            </button>
          </div>
        </div>

        {/* Results Grid */}
        {(resultA || resultB || loadingA || loadingB) && (
          <div className="grid grid-cols-2 gap-3 mb-4">
            {/* Model A Result */}
            <ResultCard
              label={modelALabel}
              model={modelA}
              result={resultA}
              loading={loadingA}
              prompt={getEffectivePrompt(modelA)}
              onClickImage={setLightboxImage}
              onUseImage={onUseImage}
              onRerun={() => runModels([modelA])}
              isRunning={isRunning}
            />
            {/* Model B Result */}
            <ResultCard
              label={modelBLabel}
              model={modelB}
              result={resultB}
              loading={loadingB}
              prompt={getEffectivePrompt(modelB)}
              onClickImage={setLightboxImage}
              onUseImage={onUseImage}
              onRerun={() => runModels([modelB])}
              isRunning={isRunning}
            />
          </div>
        )}

        {/* Evaluation */}
        {bothHaveResults && (
          <div className="mb-4">
            <div className="flex items-center gap-2">
              <button
                onClick={runEvaluation}
                disabled={isEvaluating}
                className="px-3 py-1.5 text-xs font-medium rounded bg-amber-600 text-white hover:bg-amber-700 disabled:bg-gray-300 disabled:text-gray-500 transition-colors flex items-center gap-1"
              >
                {isEvaluating ? <Loader2 size={12} className="animate-spin" /> : null}
                Compare Styles
              </button>
              {evaluation && evaluation.similarity >= 0 && (
                <span className={`text-sm font-bold ${
                  evaluation.similarity >= 80 ? 'text-green-600' :
                  evaluation.similarity >= 60 ? 'text-amber-600' : 'text-red-600'
                }`}>
                  {evaluation.similarity}/100
                </span>
              )}
            </div>
            {evaluation && (
              <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-xs">
                {evaluation.similarity < 0 ? (
                  <span className="text-red-500">{evaluation.summary}</span>
                ) : (
                  <>
                    <p className="text-gray-700 mb-1">{evaluation.summary}</p>
                    {evaluation.dimensions && Object.keys(evaluation.dimensions).length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-1">
                        {Object.entries(evaluation.dimensions).map(([key, val]) => (
                          <span key={key} className="px-1.5 py-0.5 rounded bg-white border text-[10px]">
                            <span className="text-gray-500">{key}:</span>{' '}
                            <span className={`font-medium ${
                              val >= 80 ? 'text-green-600' : val >= 60 ? 'text-amber-600' : 'text-red-600'
                            }`}>{val}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="border-t border-gray-200 pt-3">
            <div className="flex items-center gap-1.5 mb-2">
              <History size={12} className="text-gray-500" />
              <span className="text-xs font-medium text-gray-600">
                History ({history.length} runs)
              </span>
            </div>

            {/* Thumbnail strip */}
            <div className="flex gap-2 overflow-x-auto pb-2 mb-2">
              {history.map(run => {
                const thumbs = run.thumbnails || {};
                const models = run.models || [];
                const isExpanded = expandedRunId === run.runId;
                return (
                  <button
                    key={run.runId}
                    onClick={() => expandRun(run)}
                    className={`flex-shrink-0 p-1.5 rounded border transition-colors ${
                      isExpanded ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    <div className="flex gap-0.5 mb-1">
                      {models.map(m => (
                        <div key={m} className="w-[30px] h-[30px] bg-gray-100 rounded overflow-hidden">
                          {thumbs[m] ? (
                            <img src={toSrc(thumbs[m])} alt={m} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[8px] text-gray-400">?</div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="text-[9px] text-center">
                      {run.evaluation ? (
                        <span className={`font-bold ${
                          run.evaluation.similarity >= 80 ? 'text-green-600' :
                          run.evaluation.similarity >= 60 ? 'text-amber-600' : 'text-red-600'
                        }`}>{run.evaluation.similarity}</span>
                      ) : (
                        <span className="text-gray-400">--</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Expanded run detail */}
            {expandedRunId && (
              <div className="p-3 rounded border border-indigo-200 bg-indigo-50/50">
                {loadingExpand ? (
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Loader2 size={12} className="animate-spin" /> Loading...
                  </div>
                ) : expandedImages ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 mb-2">
                      {Object.entries(expandedImages).map(([model, data]) => (
                        <div key={model} className="text-center">
                          <div className="text-[10px] font-medium text-gray-600 mb-1">
                            {[...GROK_MODELS, ...GEMINI_MODELS].find(m => m.id === model)?.label || model}
                            {data.elapsed ? ` (${formatElapsed(data.elapsed)})` : ''}
                          </div>
                          <img
                            src={toSrc(data.imageData)}
                            alt={model}
                            className="max-h-48 w-full object-contain rounded border bg-white cursor-pointer"
                            onClick={() => setLightboxImage(toSrc(data.imageData))}
                          />
                          <details className="mt-1 text-left">
                            <summary className="text-[9px] text-gray-400 cursor-pointer">Prompt</summary>
                            <pre className="text-[9px] bg-white p-1 rounded max-h-20 overflow-auto whitespace-pre-wrap mt-0.5">
                              {data.stylePrompt}
                            </pre>
                          </details>
                        </div>
                      ))}
                    </div>
                    {/* Evaluation for this history run */}
                    {(() => {
                      const run = history.find(r => r.runId === expandedRunId);
                      return run?.evaluation ? (
                        <div className="text-xs p-2 bg-white rounded border mb-2">
                          <span className="font-medium">Score: {run.evaluation.similarity}/100</span>
                          {' — '}{run.evaluation.summary}
                        </div>
                      ) : null;
                    })()}
                    <button
                      onClick={() => {
                        const run = history.find(r => r.runId === expandedRunId);
                        if (run) resumeFrom(run);
                      }}
                      className="px-2 py-1 text-xs font-medium rounded bg-indigo-600 text-white hover:bg-indigo-700 flex items-center gap-1"
                    >
                      <RotateCw size={10} />
                      Resume from this run
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-gray-400">Failed to load images</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <ImageLightbox
        src={lightboxImage}
        alt="Style Lab result"
        onClose={() => setLightboxImage(null)}
      />
    </>
  );
}

/** Individual model result card */
function ResultCard({
  label, model, result, loading, prompt, onClickImage, onUseImage, onRerun, isRunning,
}: {
  label: string;
  model: string;
  result: ModelResult | null;
  loading: boolean;
  prompt: string;
  onClickImage: (src: string) => void;
  onUseImage?: (imageData: string, modelId: string) => void;
  onRerun: () => void;
  isRunning: boolean;
}) {
  const toSrc = (img: string) => img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
  const formatElapsed = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;

  return (
    <div className="border rounded-lg p-3 bg-gray-50 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-gray-800">{label}</span>
        <div className="flex items-center gap-1.5">
          {result?.elapsed != null && !loading && (
            <span className="flex items-center gap-0.5 text-xs text-gray-500">
              <Clock size={10} />{formatElapsed(result.elapsed)}
            </span>
          )}
          {!loading && result?.imageData && (
            <button
              onClick={onRerun}
              disabled={isRunning}
              className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 disabled:opacity-30"
              title="Re-run this model"
            >
              <RotateCw size={12} />
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-48 bg-white rounded border border-dashed border-gray-300">
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <Loader2 size={24} className="animate-spin" />
            <span className="text-xs">Generating...</span>
          </div>
        </div>
      ) : result?.error ? (
        <div className="flex items-center justify-center h-48 bg-red-50 rounded border border-red-200">
          <div className="flex flex-col items-center gap-2 text-red-500 px-3 text-center">
            <AlertTriangle size={24} />
            <span className="text-xs">{result.error}</span>
          </div>
        </div>
      ) : result?.imageData ? (
        <div className="relative group">
          <img
            src={toSrc(result.imageData)}
            alt={`${label} result`}
            className="max-h-64 w-full object-contain rounded border bg-white cursor-pointer"
            onClick={() => onClickImage(toSrc(result.imageData!))}
          />
          {onUseImage && (
            <button
              onClick={() => onUseImage(result.imageData!, result.modelId || model)}
              className="absolute bottom-2 right-2 px-2 py-1 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 shadow"
            >
              <Check size={12} />
              Use This
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-center h-48 bg-gray-100 rounded border border-dashed border-gray-300">
          <span className="text-xs text-gray-400">Not yet run</span>
        </div>
      )}

      {/* Prompt used */}
      {result?.imageData && (
        <details className="mt-1">
          <summary className="text-[9px] text-gray-400 cursor-pointer">Style prompt</summary>
          <pre className="text-[9px] bg-white p-1 rounded max-h-20 overflow-auto whitespace-pre-wrap mt-0.5">
            {prompt}
          </pre>
        </details>
      )}
    </div>
  );
}

export default StyleLabSection;
