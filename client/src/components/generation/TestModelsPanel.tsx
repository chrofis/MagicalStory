import { useState, useCallback } from 'react';
import { X, Loader2, Check, Clock, AlertTriangle } from 'lucide-react';
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

    // Check if storyService.testModels exists
    const hasTestModelsApi = typeof (storyService as Record<string, unknown>).testModels === 'function';

    const promises = Array.from(selectedModels).map(async (model) => {
      setResults(prev => ({ ...prev, [model]: { loading: true } }));
      const startTime = Date.now();

      try {
        if (hasTestModelsApi) {
          // Use the dedicated testModels API if available
          const response = await (storyService as unknown as {
            testModels: (storyId: string, pageNumber: number, models: string[]) => Promise<{
              results: Record<string, { imageData?: string; error?: string; modelId?: string }>;
            }>;
          }).testModels(storyId, pageNumber, [model]);
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
            },
          }));
        } else {
          // Fallback: use iteratePage with the model override
          const response = await storyService.iteratePage(storyId, pageNumber, model);
          const elapsedMs = Date.now() - startTime;
          setResults(prev => ({
            ...prev,
            [model]: {
              loading: false,
              imageData: response.imageData,
              modelId: response.modelId || model,
              elapsedMs,
            },
          }));
        }
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
  }, [selectedModels, storyId, pageNumber]);

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
                </div>
              );
            })}
          </div>
        )}
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
