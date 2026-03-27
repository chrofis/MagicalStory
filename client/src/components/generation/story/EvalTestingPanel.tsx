import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import api from '@/services/api';

interface EvalTestingPanelProps {
  storyId: string;
  pageNumber: number;
  language: string;
}

type EvalType = 'quality' | 'semantic' | 'visual-inventory';

interface EvalResult {
  score?: number;
  prompt?: string;
  rawOutput?: string;
  parsed?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs?: number;
  modelUsed?: string;
  error?: string;
}

const EVAL_TYPES: { value: EvalType; label: string; labelDe: string }[] = [
  { value: 'quality', label: 'Quality', labelDe: 'Qualität' },
  { value: 'semantic', label: 'Semantic', labelDe: 'Semantisch' },
  { value: 'visual-inventory', label: 'Visual Inventory', labelDe: 'Visuelle Inventur' },
];

const EVAL_MODELS = [
  { value: '', label: 'Default' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { value: 'grok-4-fast', label: 'Grok 4 Fast' },
];

function scoreColor(score: number): string {
  if (score >= 70) return 'text-green-600';
  if (score >= 50) return 'text-yellow-600';
  return 'text-red-600';
}

function scoreBgColor(score: number): string {
  if (score >= 70) return 'bg-green-50 border-green-300';
  if (score >= 50) return 'bg-yellow-50 border-yellow-300';
  return 'bg-red-50 border-red-300';
}

export function EvalTestingPanel({ storyId, pageNumber, language }: EvalTestingPanelProps) {
  const [evalType, setEvalType] = useState<EvalType>('quality');
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<EvalResult | null>(null);

  const isDE = language === 'de';

  const runEval = async () => {
    setLoading(true);
    setResult(null);
    const start = Date.now();
    try {
      const data = await api.post<EvalResult>(
        `/api/stories/${storyId}/evaluate-single/${pageNumber}`,
        {
          evalType,
          ...(model ? { model } : {}),
        }
      );
      setResult({
        ...data,
        elapsedMs: data.elapsedMs ?? (Date.now() - start),
      });
    } catch (err) {
      setResult({
        error: err instanceof Error ? err.message : 'Unknown error',
        elapsedMs: Date.now() - start,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
      <summary className="cursor-pointer text-sm font-semibold text-blue-700 flex items-center gap-2">
        {isDE ? 'Eval Testing' : 'Eval Testing'}
        {result && result.score !== undefined && (
          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${scoreColor(result.score)}`}>
            {Math.round(result.score)}
          </span>
        )}
      </summary>

      <div className="mt-3 space-y-3">
        {/* Eval type selector */}
        <div className="flex items-center gap-3">
          {EVAL_TYPES.map((t) => (
            <label key={t.value} className="flex items-center gap-1.5 cursor-pointer text-xs">
              <input
                type="radio"
                name={`eval-type-${pageNumber}`}
                value={t.value}
                checked={evalType === t.value}
                onChange={() => setEvalType(t.value)}
                className="text-blue-600"
              />
              <span className={evalType === t.value ? 'font-semibold text-blue-700' : 'text-gray-600'}>
                {isDE ? t.labelDe : t.label}
              </span>
            </label>
          ))}
        </div>

        {/* Model selector + Run button */}
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="text-xs px-1.5 py-1 border border-gray-300 rounded bg-white"
          >
            {EVAL_MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            onClick={runEval}
            disabled={loading}
            className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded flex items-center gap-1.5 disabled:opacity-50"
          >
            {loading ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {isDE ? 'Läuft...' : 'Running...'}
              </>
            ) : (
              <>
                <Play size={12} />
                {isDE ? 'Ausführen' : 'Run'}
              </>
            )}
          </button>
        </div>

        {/* Results */}
        {result && (
          <div className="space-y-2">
            {/* Error */}
            {result.error && (
              <div className="bg-red-50 border border-red-300 rounded p-2 text-xs text-red-700">
                {result.error}
              </div>
            )}

            {/* Score */}
            {result.score !== undefined && (
              <div className={`border rounded p-3 flex items-center justify-between ${scoreBgColor(result.score)}`}>
                <span className="text-sm font-medium text-gray-700">
                  {isDE ? 'Ergebnis' : 'Score'}
                </span>
                <span className={`text-2xl font-bold ${scoreColor(result.score)}`}>
                  {Math.round(result.score)}
                </span>
              </div>
            )}

            {/* Cost / Tokens / Time */}
            <div className="flex items-center gap-3 text-xs text-gray-500">
              {result.modelUsed && (
                <span className="bg-gray-100 px-1.5 py-0.5 rounded">{result.modelUsed}</span>
              )}
              {result.inputTokens !== undefined && (
                <span>{result.inputTokens.toLocaleString()} in</span>
              )}
              {result.outputTokens !== undefined && (
                <span>{result.outputTokens.toLocaleString()} out</span>
              )}
              {result.elapsedMs !== undefined && (
                <span>{(result.elapsedMs / 1000).toFixed(1)}s</span>
              )}
            </div>

            {/* Prompt */}
            {result.prompt && (
              <details className="bg-gray-50 border border-gray-200 rounded p-2">
                <summary className="cursor-pointer text-xs font-medium text-gray-700">
                  {isDE ? 'Prompt' : 'Prompt'}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs bg-white p-2 rounded border border-gray-200">
                  {result.prompt}
                </pre>
              </details>
            )}

            {/* Raw Output */}
            {result.rawOutput && (
              <details className="bg-gray-50 border border-gray-200 rounded p-2">
                <summary className="cursor-pointer text-xs font-medium text-gray-700">
                  {isDE ? 'Rohe Ausgabe' : 'Raw Output'}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs bg-white p-2 rounded border border-gray-200">
                  {result.rawOutput}
                </pre>
              </details>
            )}

            {/* Parsed Results */}
            {result.parsed && Object.keys(result.parsed).length > 0 && (
              <details className="bg-gray-50 border border-gray-200 rounded p-2">
                <summary className="cursor-pointer text-xs font-medium text-gray-700">
                  {isDE ? 'Geparste Ergebnisse' : 'Parsed Results'}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs bg-white p-2 rounded border border-gray-200">
                  {JSON.stringify(result.parsed, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
