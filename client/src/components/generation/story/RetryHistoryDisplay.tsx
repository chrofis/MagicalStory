import { useState } from 'react';
import { History, ChevronRight, ChevronDown, Download } from 'lucide-react';
import type { RetryAttempt } from '@/types/story';

/**
 * Download text content as a file
 */
function downloadAsText(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Format evaluation data as readable text for download
 */
function formatEvaluationAsText(data: unknown, indent = 0): string {
  const prefix = '  '.repeat(indent);

  if (data === null || data === undefined) return `${prefix}null`;
  if (typeof data === 'boolean') return `${prefix}${data ? 'YES' : 'NO'}`;
  if (typeof data === 'number') return `${prefix}${data}`;
  if (typeof data === 'string') return `${prefix}${data}`;

  if (Array.isArray(data)) {
    if (data.length === 0) return `${prefix}[]`;
    return data.map((item, i) => `${prefix}[${i}]: ${formatEvaluationAsText(item, 0)}`).join('\n');
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return `${prefix}{}`;
    return entries.map(([k, v]) => {
      const valueStr = formatEvaluationAsText(v, indent + 1);
      if (typeof v === 'object' && v !== null) {
        return `${prefix}${k}:\n${valueStr}`;
      }
      return `${prefix}${k}: ${valueStr.trim()}`;
    }).join('\n');
  }

  return `${prefix}${String(data)}`;
}

interface RetryHistoryDisplayProps {
  retryHistory: RetryAttempt[];
  totalAttempts: number;
  language: string;
  onRevertRepair?: (attemptIndex: number, beforeImage: string) => void;
}

/**
 * Format and display evaluation data with expandable sections
 */
function EvaluationDisplay({ data, language, title }: { data: unknown; language: string; title?: string }) {
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  if (!data) {
    return <div className="text-gray-400 italic text-sm">{language === 'de' ? 'Keine Daten' : 'No data'}</div>;
  }

  // Parse string data if needed
  let parsed = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      // If it's not JSON, show as text
      return (
        <div>
          <div className="flex justify-end mb-1">
            <button
              onClick={() => downloadAsText(data, `${title || 'evaluation'}.txt`)}
              className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
              title="Download as text file"
            >
              <Download size={12} /> Download
            </button>
          </div>
          <pre className="text-sm whitespace-pre-wrap bg-gray-50 p-3 rounded max-h-80 overflow-auto font-mono">{data}</pre>
        </div>
      );
    }
  }

  const toggleSection = (key: string) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedSections(newExpanded);
  };

  // Download handler for parsed data
  const handleDownload = () => {
    const textContent = formatEvaluationAsText(parsed);
    downloadAsText(textContent, `${title || 'evaluation'}.txt`);
  };

  // Render evaluation object with nice formatting
  const renderValue = (key: string, value: unknown, depth = 0): JSX.Element => {
    const isExpanded = expandedSections.has(key);

    if (value === null || value === undefined) {
      return <span className="text-gray-400">null</span>;
    }

    if (typeof value === 'boolean') {
      return <span className={value ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>{value ? '✓' : '✗'}</span>;
    }

    if (typeof value === 'number') {
      // Color-code scores
      const color = value >= 70 ? 'text-green-600' : value >= 50 ? 'text-yellow-600' : 'text-red-600';
      return <span className={`font-bold ${color}`}>{value}</span>;
    }

    if (typeof value === 'string') {
      // Truncate long strings
      if (value.length > 100) {
        return (
          <div>
            <button
              onClick={() => toggleSection(key)}
              className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {isExpanded ? 'Collapse' : `Show (${value.length} chars)`}
            </button>
            {isExpanded && (
              <div className="mt-1 p-2 bg-gray-100 rounded text-sm whitespace-pre-wrap font-mono">{value}</div>
            )}
          </div>
        );
      }
      return <span className="text-gray-700">{value}</span>;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return <span className="text-gray-400">[]</span>;
      return (
        <div className="ml-2 border-l-2 border-gray-200 pl-2">
          {value.map((item, idx) => (
            <div key={idx} className="mb-1">
              <span className="text-gray-400 text-xs">[{idx}]</span> {renderValue(`${key}.${idx}`, item, depth + 1)}
            </div>
          ))}
        </div>
      );
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return <span className="text-gray-400">{'{}'}</span>;

      // For nested objects, make them collapsible
      if (depth > 0) {
        return (
          <div>
            <button
              onClick={() => toggleSection(key)}
              className="text-blue-600 hover:text-blue-800 flex items-center gap-1"
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {isExpanded ? 'Collapse' : `{${entries.length} fields}`}
            </button>
            {isExpanded && (
              <div className="ml-2 mt-1 border-l-2 border-gray-200 pl-2">
                {entries.map(([k, v]) => (
                  <div key={k} className="mb-1">
                    <span className="font-medium text-gray-600">{k}:</span> {renderValue(`${key}.${k}`, v, depth + 1)}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }

      return (
        <div className="space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="font-medium text-gray-600 min-w-[100px]">{k}:</span>
              <div className="flex-1">{renderValue(`${key}.${k}`, v, depth + 1)}</div>
            </div>
          ))}
        </div>
      );
    }

    return <span>{String(value)}</span>;
  };

  return (
    <div className="text-sm space-y-1 max-h-96 overflow-auto">
      <div className="flex justify-end mb-2">
        <button
          onClick={handleDownload}
          className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 px-2 py-1 bg-blue-50 rounded hover:bg-blue-100"
          title="Download as text file"
        >
          <Download size={12} /> Download
        </button>
      </div>
      {renderValue('root', parsed)}
    </div>
  );
}

/**
 * Component to show mask overlay on an image
 * Mask: white = area to edit, black = area to preserve
 */
function MaskOverlayImage({
  beforeImage,
  maskImage,
  onEnlarge
}: {
  beforeImage: string;
  maskImage: string;
  onEnlarge: (src: string, title: string) => void;
}) {
  return (
    <div
      className="relative w-40 h-40 cursor-pointer hover:ring-2 hover:ring-amber-400 rounded overflow-hidden border"
      onClick={() => onEnlarge(beforeImage, 'Before with Mask')}
    >
      <img
        src={beforeImage}
        alt="Before"
        className="w-full h-full object-contain"
      />
      {/* Mask overlay - white areas (edit regions) shown as red tint */}
      <div
        className="absolute inset-0 w-full h-full"
        style={{
          backgroundImage: `url(${maskImage})`,
          backgroundSize: 'contain',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          mixBlendMode: 'multiply',
          opacity: 0.5
        }}
      />
      {/* Red tint for white mask areas */}
      <img
        src={maskImage}
        alt="Mask overlay"
        className="absolute inset-0 w-full h-full object-contain pointer-events-none"
        style={{
          mixBlendMode: 'screen',
          opacity: 0.7,
          filter: 'sepia(1) saturate(5) hue-rotate(-50deg)'
        }}
      />
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent text-white text-[10px] text-center py-1 font-medium">
        🎯 Edit Area
      </div>
    </div>
  );
}

/**
 * Component to display generation retry history with before/after images
 */
export function RetryHistoryDisplay({
  retryHistory,
  totalAttempts,
  language,
  onRevertRepair
}: RetryHistoryDisplayProps) {
  const [enlargedImg, setEnlargedImg] = useState<{ src: string; title: string } | null>(null);

  if (!retryHistory || retryHistory.length === 0) return null;

  // Count repairs in history
  const repairCount = retryHistory.filter(a => a.type === 'auto_repair').length;

  return (
    <>
      {/* Enlarged image modal */}
      {enlargedImg && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setEnlargedImg(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh]">
            <div className="absolute -top-8 left-0 text-white text-sm">{enlargedImg.title}</div>
            <img
              src={enlargedImg.src}
              alt={enlargedImg.title}
              className="max-w-full max-h-[85vh] object-contain rounded-lg"
            />
            <button
              className="absolute -top-8 right-0 text-white hover:text-gray-300"
              onClick={() => setEnlargedImg(null)}
            >
              ✕ Close
            </button>
          </div>
        </div>
      )}

      <details className="bg-purple-50 border border-purple-300 rounded-lg p-3">
        <summary className="cursor-pointer text-sm font-semibold text-purple-700 flex items-center justify-between">
          <span className="flex items-center gap-2">
            <History size={14} />
            {language === 'de' ? 'Generierungshistorie' : language === 'fr' ? 'Historique de génération' : 'Generation History'}
            {repairCount > 0 && (
              <span className="text-xs bg-amber-200 text-amber-800 px-1.5 py-0.5 rounded">
                🔧 {repairCount} {language === 'de' ? 'Reparatur' : 'repair'}{repairCount > 1 ? (language === 'de' ? 'en' : 's') : ''}
              </span>
            )}
          </span>
          <span className="text-purple-600">
            {totalAttempts} {language === 'de' ? 'Versuche' : language === 'fr' ? 'tentatives' : 'attempts'}
          </span>
        </summary>
      <div className="mt-3 space-y-3">
        {retryHistory.map((attempt, idx) => (
          <div key={idx} className={`border rounded-lg p-3 ${
            attempt.type === 'auto_repair' ? 'bg-amber-50 border-amber-300' :
            idx === retryHistory.length - 1
              ? 'bg-green-50 border-green-300'
              : 'bg-white border-gray-200'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-sm">
                {attempt.type === 'auto_repair' ? (
                  <span className="text-amber-700">🔧 Auto-Repair</span>
                ) : (
                  <>
                    {language === 'de' ? `Versuch ${attempt.attempt}` : language === 'fr' ? `Tentative ${attempt.attempt}` : `Attempt ${attempt.attempt}`}
                  </>
                )}
                {attempt.type === 'text_edit' && (
                  <span className="text-xs ml-2 text-blue-600">(text edit)</span>
                )}
                {attempt.type === 'text_edit_failed' && (
                  <span className="text-xs ml-2 text-red-600">(text edit failed)</span>
                )}
                {attempt.type === 'auto_repair_failed' && (
                  <span className="text-xs ml-2 text-red-600">(auto-repair failed)</span>
                )}
                {idx === retryHistory.length - 1 && attempt.type !== 'auto_repair' && (
                  <span className="text-xs ml-2 text-green-600 font-bold">✓ USED</span>
                )}
              </span>
              {/* Show score change for auto-repair */}
              {attempt.type === 'auto_repair' && attempt.preRepairScore !== undefined && attempt.postRepairScore !== undefined ? (
                <span className="font-bold text-sm">
                  <span className={attempt.preRepairScore >= 70 ? 'text-green-600' : attempt.preRepairScore >= 50 ? 'text-yellow-600' : 'text-red-600'}>
                    {attempt.preRepairScore}%
                  </span>
                  <span className="text-gray-400 mx-1">→</span>
                  <span className={attempt.postRepairScore >= 70 ? 'text-green-600' : attempt.postRepairScore >= 50 ? 'text-yellow-600' : 'text-red-600'}>
                    {attempt.postRepairScore}%
                  </span>
                </span>
              ) : attempt.score !== undefined && (
                <span className={`font-bold ${
                  attempt.score >= 70 ? 'text-green-600' :
                  attempt.score >= 50 ? 'text-yellow-600' :
                  'text-red-600'
                }`}>
                  {Math.round(attempt.score)}%
                </span>
              )}
            </div>

            {attempt.error && (
              <div className="text-xs text-red-600 mb-2">Error: {attempt.error}</div>
            )}

            {attempt.textIssue && attempt.textIssue !== 'NONE' && (
              <div className="text-xs text-orange-600 mb-2">
                Text issue: {attempt.textIssue}
                {attempt.expectedText && <span className="block">Expected: "{attempt.expectedText}"</span>}
                {attempt.actualText && <span className="block">Actual: "{attempt.actualText}"</span>}
              </div>
            )}

            {/* Auto-repair specific display */}
            {attempt.type === 'auto_repair' && (
              <div className="space-y-2">
                {/* Fix targets count and revert button */}
                <div className="flex items-center justify-between">
                  {attempt.fixTargetsCount && (
                    <div className="text-xs text-amber-700">
                      Fixed {attempt.fixTargetsCount} target{attempt.fixTargetsCount > 1 ? 's' : ''}
                    </div>
                  )}
                  {/* Revert button - show when score went down or stayed same */}
                  {onRevertRepair && attempt.repairDetails?.[0]?.beforeImage &&
                   attempt.postRepairScore !== undefined && attempt.preRepairScore !== undefined &&
                   attempt.postRepairScore <= attempt.preRepairScore && (
                    <button
                      onClick={() => onRevertRepair(idx, attempt.repairDetails![0].beforeImage!)}
                      className="text-xs px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded border border-red-300 transition-colors"
                    >
                      ↩️ {language === 'de' ? 'Zurücksetzen' : 'Revert to Original'}
                    </button>
                  )}
                </div>

                {/* Warning if score went down */}
                {attempt.postRepairScore !== undefined && attempt.preRepairScore !== undefined &&
                 attempt.postRepairScore < attempt.preRepairScore && (
                  <div className="text-xs text-red-600 bg-red-50 p-2 rounded border border-red-200">
                    ⚠️ {language === 'de'
                      ? `Bewertung verschlechtert: ${attempt.preRepairScore}% → ${attempt.postRepairScore}%`
                      : `Score decreased: ${attempt.preRepairScore}% → ${attempt.postRepairScore}%`}
                  </div>
                )}

                {/* Before/After Evaluations */}
                <details className="text-sm">
                  <summary className="cursor-pointer text-amber-700 font-medium hover:text-amber-900">
                    📊 {language === 'de' ? 'Bewertungen anzeigen' : 'View Evaluations'}
                  </summary>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    {/* Before evaluation */}
                    <div className="bg-white p-4 rounded-lg border-2 border-red-200 shadow-sm">
                      <div className="font-bold text-red-700 mb-2 text-base flex items-center gap-2">
                        <span className="bg-red-100 px-2 py-0.5 rounded">Before</span>
                        <span className="text-red-600">{attempt.preRepairScore}%</span>
                      </div>
                      <EvaluationDisplay
                        data={attempt.preRepairEval || attempt.reasoning}
                        language={language}
                        title={`evaluation-before-attempt-${idx}`}
                      />
                    </div>
                    {/* After evaluation */}
                    <div className="bg-white p-4 rounded-lg border-2 border-green-200 shadow-sm">
                      <div className="font-bold text-green-700 mb-2 text-base flex items-center gap-2">
                        <span className="bg-green-100 px-2 py-0.5 rounded">After</span>
                        <span className="text-green-600">{attempt.postRepairScore}%</span>
                      </div>
                      <EvaluationDisplay
                        data={attempt.postRepairEval}
                        language={language}
                        title={`evaluation-after-attempt-${idx}`}
                      />
                    </div>
                  </div>
                </details>

                {/* Repair Details with images */}
                {attempt.repairDetails && attempt.repairDetails.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-amber-700 font-medium hover:text-amber-900">
                      🖼️ {language === 'de' ? 'Reparatur-Details' : 'Repair Details'} ({attempt.repairDetails.length})
                    </summary>
                    <div className="mt-3 space-y-3">
                      {attempt.repairDetails.map((repair, rIdx) => (
                        <div key={rIdx} className="bg-white p-4 rounded-lg border shadow-sm">
                          <div className="flex justify-between items-start mb-2">
                            <div className="font-medium text-amber-800 text-base">{repair.description}</div>
                            {repair.modelId && (
                              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">{repair.modelId}</span>
                            )}
                          </div>
                          <details className="mb-3">
                            <summary className="text-gray-500 cursor-pointer hover:text-gray-700 text-sm flex items-center gap-2">
                              Show fix prompt
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  downloadAsText(repair.fullPrompt || repair.fixPrompt || '', `fix-prompt-${rIdx}.txt`);
                                }}
                                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 px-2 py-0.5 bg-blue-50 rounded"
                              >
                                <Download size={10} /> Download
                              </button>
                            </summary>
                            <div className="mt-2 p-3 bg-gray-50 rounded text-sm text-gray-600 whitespace-pre-wrap font-mono max-h-96 overflow-auto">{repair.fullPrompt || repair.fixPrompt}</div>
                          </details>
                          <div className="flex gap-4 items-start">
                            {/* Before with Mask Overlay */}
                            {repair.beforeImage && repair.maskImage ? (
                              <div>
                                <div className="text-xs text-gray-500 mb-1 font-medium">Before + Mask</div>
                                <MaskOverlayImage
                                  beforeImage={repair.beforeImage}
                                  maskImage={repair.maskImage}
                                  onEnlarge={(src, title) => setEnlargedImg({ src, title })}
                                />
                              </div>
                            ) : repair.beforeImage && (
                              <div>
                                <div className="text-xs text-gray-500 mb-1 font-medium">Before</div>
                                <img
                                  src={repair.beforeImage}
                                  alt="Before"
                                  className="w-32 h-32 object-contain border rounded cursor-pointer hover:ring-2 hover:ring-amber-400"
                                  onClick={() => setEnlargedImg({ src: repair.beforeImage!, title: 'Before Repair' })}
                                />
                              </div>
                            )}
                            {/* Arrow */}
                            <div className="flex items-center h-32 text-gray-400 text-2xl">→</div>
                            {/* After */}
                            {repair.afterImage && (
                              <div>
                                <div className="text-xs text-gray-500 mb-1 font-medium">After</div>
                                <img
                                  src={repair.afterImage}
                                  alt="After"
                                  className="w-32 h-32 object-contain border-2 border-green-300 rounded cursor-pointer hover:ring-2 hover:ring-green-400"
                                  onClick={() => setEnlargedImg({ src: repair.afterImage!, title: 'After Repair' })}
                                />
                              </div>
                            )}
                          </div>
                          {/* Verification Results */}
                          {repair.verification && (
                            <div className="mt-3 p-3 bg-gray-50 rounded border text-sm">
                              <div className="font-medium text-gray-700 mb-2">🔍 Verification:</div>
                              <div className="grid grid-cols-2 gap-2">
                                {/* LPIPS Result */}
                                {repair.verification.lpips && (
                                  <div className={`p-2 rounded ${repair.verification.lpips.changed ? 'bg-green-100' : 'bg-yellow-100'}`}>
                                    <span className="font-medium">LPIPS: </span>
                                    <span className={repair.verification.lpips.changed ? 'text-green-700' : 'text-yellow-700'}>
                                      {repair.verification.lpips.lpipsScore?.toFixed(4)}
                                    </span>
                                    <span className="text-gray-500 ml-1">
                                      ({repair.verification.lpips.changed ? '✓ changed' : '⚠ unchanged'})
                                    </span>
                                  </div>
                                )}
                                {/* LLM Result */}
                                {repair.verification.llm && (
                                  <div className={`p-2 rounded ${repair.verification.llm.fixed ? 'bg-green-100' : 'bg-red-100'}`}>
                                    <span className="font-medium">LLM: </span>
                                    <span className={repair.verification.llm.fixed ? 'text-green-700' : 'text-red-700'}>
                                      {repair.verification.llm.fixed ? '✓ Fixed' : '✗ Not fixed'}
                                    </span>
                                    <span className="text-gray-500 ml-1">
                                      ({Math.round(repair.verification.llm.confidence * 100)}%)
                                    </span>
                                  </div>
                                )}
                              </div>
                              {/* LLM Explanation */}
                              {repair.verification.llm?.explanation && (
                                <div className="mt-2 text-gray-600 text-sm italic">
                                  {repair.verification.llm.explanation}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Regular attempt feedback */}
            {attempt.type !== 'auto_repair' && attempt.reasoning ? (
              <details className="text-sm text-gray-600 mb-2">
                <summary className="cursor-pointer">{language === 'de' ? 'Feedback' : 'Feedback'}</summary>
                <pre className="mt-2 whitespace-pre-wrap bg-gray-50 p-3 rounded text-sm overflow-auto max-h-60 font-mono">{attempt.reasoning}</pre>
              </details>
            ) : attempt.type !== 'auto_repair' && attempt.score === 0 && (
              <div className="text-sm text-gray-500 italic mb-2">
                {language === 'de' ? 'Qualitätsbewertung fehlgeschlagen' : language === 'fr' ? 'Évaluation de qualité échouée' : 'Quality evaluation failed'}
              </div>
            )}

            {attempt.imageData && attempt.type !== 'auto_repair' && (
              <details>
                <summary className="cursor-pointer text-sm text-blue-600">
                  {language === 'de' ? 'Bild anzeigen' : language === 'fr' ? 'Voir image' : 'View image'}
                </summary>
                <img
                  src={attempt.imageData}
                  alt={`Attempt ${attempt.attempt}`}
                  className={`mt-2 w-full rounded border ${idx === retryHistory.length - 1 ? 'border-green-300' : 'border-gray-200 opacity-75'}`}
                />
              </details>
            )}

            <div className="text-xs text-gray-400 mt-1">
              {new Date(attempt.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </details>
    </>
  );
}
