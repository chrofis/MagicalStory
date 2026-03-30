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
  rawResponse?: string;
  parsed?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  elapsedMs?: number;
  modelUsed?: string;
  modelId?: string;
  error?: string;
  // Quality eval fields
  qualityScore?: number;
  verdict?: string;
  issuesSummary?: string;
  fixableIssues?: Array<{ description?: string; issue?: string; severity?: string; type?: string }>;
  figures?: Array<{ name?: string; confidence?: string; label?: string }>;
  matches?: Array<{ figure?: string; character?: string; score?: number }>;
  // Semantic eval fields
  semanticScore?: number;
  semanticIssues?: Array<{ problem?: string; type?: string; severity?: string; expected?: string; actual?: string }>;
  // Visual inventory fields
  items?: Array<{ name?: string; found?: boolean; description?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
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
  if (score >= 80) return 'text-green-600';
  if (score >= 60) return 'text-yellow-600';
  return 'text-red-600';
}

function scoreBgColor(score: number): string {
  if (score >= 80) return 'bg-green-50 border-green-300';
  if (score >= 60) return 'bg-yellow-50 border-yellow-300';
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
        modelUsed: data.modelUsed || data.modelId || undefined,
        inputTokens: data.inputTokens ?? data.usage?.input_tokens,
        outputTokens: data.outputTokens ?? data.usage?.output_tokens,
        rawOutput: data.rawOutput || data.rawResponse || undefined,
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

            {/* Score + Verdict */}
            {result.score !== undefined && (
              <div className={`border rounded p-3 ${scoreBgColor(result.score)}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">
                    {isDE ? 'Ergebnis' : 'Score'}
                  </span>
                  <div className="flex items-center gap-2">
                    {result.verdict && (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                        result.verdict === 'PASS' ? 'bg-green-200 text-green-800' :
                        result.verdict === 'SOFT_FAIL' ? 'bg-yellow-200 text-yellow-800' :
                        'bg-red-200 text-red-800'
                      }`}>{result.verdict}</span>
                    )}
                    <span className={`text-2xl font-bold ${scoreColor(result.score)}`}>
                      {Math.round(result.score)}
                    </span>
                  </div>
                </div>
                {result.issuesSummary && (
                  <p className="mt-2 text-xs text-gray-600 italic">{result.issuesSummary}</p>
                )}
              </div>
            )}

            {/* Fixable Issues */}
            {result.fixableIssues && result.fixableIssues.length > 0 && (
              <div className="bg-orange-50 border border-orange-300 rounded p-3">
                <div className="text-xs font-semibold text-orange-800 mb-1.5">
                  {result.fixableIssues.length} {isDE ? 'Probleme erkannt' : 'Issues Detected'}:
                </div>
                <ul className="space-y-1">
                  {result.fixableIssues.map((issue, idx) => (
                    <li key={idx} className="text-xs text-orange-700 flex items-start gap-1.5">
                      <span className={`shrink-0 px-1 py-0.5 rounded text-[10px] font-bold ${
                        issue.severity === 'critical' ? 'bg-red-200 text-red-800' :
                        issue.severity === 'major' ? 'bg-orange-200 text-orange-800' :
                        'bg-yellow-200 text-yellow-800'
                      }`}>{(issue.severity || 'medium').toUpperCase()}</span>
                      <span>{issue.description || issue.issue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Semantic Issues */}
            {result.semanticIssues && result.semanticIssues.length > 0 && (
              <div className="bg-purple-50 border border-purple-300 rounded p-3">
                <div className="text-xs font-semibold text-purple-800 mb-1.5">
                  {result.semanticIssues.length} {isDE ? 'Semantische Probleme' : 'Semantic Issues'}:
                </div>
                <ul className="space-y-1">
                  {result.semanticIssues.map((issue, idx) => (
                    <li key={idx} className="text-xs text-purple-700">
                      <span className="font-medium">{issue.type}: </span>
                      {issue.problem}
                      {issue.expected && <span className="text-purple-500"> (expected: {issue.expected})</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Character Matches */}
            {result.figures && result.figures.length > 0 && (
              <div className="bg-indigo-50 border border-indigo-200 rounded p-3">
                <div className="text-xs font-semibold text-indigo-800 mb-1.5">
                  {isDE ? 'Erkannte Figuren' : 'Detected Figures'} ({result.figures.length}):
                </div>
                <div className="space-y-0.5">
                  {result.figures.map((fig, idx) => {
                    const match = result.matches?.find(m => m.figure === fig.name || m.figure === fig.label);
                    return (
                      <div key={idx} className="text-xs text-indigo-700 flex items-center gap-2">
                        <span className="font-medium">{fig.name || fig.label}</span>
                        {fig.confidence && <span className="text-indigo-400">({fig.confidence})</span>}
                        {match && <span className="text-green-600">→ {match.character} {match.score ? `(${match.score}%)` : ''}</span>}
                      </div>
                    );
                  })}
                </div>
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
          </div>
        )}
      </div>
    </details>
  );
}
