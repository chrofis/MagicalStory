import { useState } from 'react';
import { History, ChevronRight, ChevronDown, Download } from 'lucide-react';
import type { RetryAttempt, GridRepairData } from '@/types/story';

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
    <div className="text-sm space-y-1 max-h-[500px] overflow-auto">
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

  // Count repairs in history (both legacy and grid-based)
  const repairCount = retryHistory.filter(a => a.type === 'auto_repair' || a.type === 'grid_repair').length;
  const gridRepairCount = retryHistory.filter(a => a.type === 'grid_repair').length;

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
                {gridRepairCount > 0 && <span className="ml-1">({gridRepairCount} grid)</span>}
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
            attempt.type === 'grid_repair' ? 'bg-violet-50 border-violet-300' :
            attempt.type === 'auto_repair' ? 'bg-amber-50 border-amber-300' :
            idx === retryHistory.length - 1
              ? 'bg-green-50 border-green-300'
              : 'bg-white border-gray-200'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-sm">
                {attempt.type === 'grid_repair' ? (
                  <span className="text-violet-700">🔲 Grid Repair</span>
                ) : attempt.type === 'auto_repair' ? (
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

                {/* Two-Stage Bounding Box Detection (old per-issue format) */}
                {attempt.bboxDetection && Array.isArray(attempt.bboxDetection) && attempt.bboxDetection.length > 0 && (
                  <details className="text-sm mb-2">
                    <summary className="cursor-pointer text-blue-700 font-medium hover:text-blue-900">
                      📦 {language === 'de' ? 'Bounding Box Erkennung' : 'Bounding Box Detection'} ({attempt.bboxDetection.length})
                    </summary>
                    <div className="mt-3 space-y-2">
                      {(attempt.bboxDetection as Array<{success: boolean; issue: string; severity: string; type: string; faceBox?: number[]; bodyBox?: number[]; label?: string; usage?: {input_tokens: number; output_tokens: number}}>).map((detection, dIdx) => (
                        <div key={dIdx} className={`p-3 rounded-lg border ${detection.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                          <div className="flex items-center justify-between mb-2">
                            <span className={`font-medium text-sm ${detection.success ? 'text-green-800' : 'text-red-800'}`}>
                              {detection.success ? '✓' : '✗'} {detection.issue.substring(0, 60)}{detection.issue.length > 60 ? '...' : ''}
                            </span>
                            <span className={`text-xs px-2 py-0.5 rounded ${
                              detection.severity === 'CRITICAL' ? 'bg-red-200 text-red-800' :
                              detection.severity === 'MAJOR' ? 'bg-orange-200 text-orange-800' :
                              detection.severity === 'MODERATE' ? 'bg-yellow-200 text-yellow-800' :
                              'bg-gray-200 text-gray-800'
                            }`}>
                              {detection.severity} • {detection.type}
                            </span>
                          </div>
                          {detection.success && (
                            <div className="grid grid-cols-2 gap-3 text-xs">
                              <div className={`p-2 rounded ${detection.faceBox ? 'bg-purple-100' : 'bg-gray-100'}`}>
                                <span className="font-medium text-purple-800">Face Box:</span>
                                {detection.faceBox ? (
                                  <span className="ml-1 font-mono text-purple-600">
                                    [{detection.faceBox.map(v => (v * 100).toFixed(0) + '%').join(', ')}]
                                  </span>
                                ) : (
                                  <span className="ml-1 text-gray-500 italic">not detected</span>
                                )}
                              </div>
                              <div className={`p-2 rounded ${detection.bodyBox ? 'bg-blue-100' : 'bg-gray-100'}`}>
                                <span className="font-medium text-blue-800">Body Box:</span>
                                {detection.bodyBox ? (
                                  <span className="ml-1 font-mono text-blue-600">
                                    [{detection.bodyBox.map(v => (v * 100).toFixed(0) + '%').join(', ')}]
                                  </span>
                                ) : (
                                  <span className="ml-1 text-gray-500 italic">not detected</span>
                                )}
                              </div>
                            </div>
                          )}
                          {detection.label && detection.label !== detection.issue && (
                            <div className="mt-2 text-xs text-gray-600">
                              <span className="font-medium">Detected as:</span> {detection.label}
                            </div>
                          )}
                          {detection.usage && (
                            <div className="mt-1 text-xs text-gray-400">
                              Tokens: {detection.usage.input_tokens} in / {detection.usage.output_tokens} out
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
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
                            <div className="mt-2 p-3 bg-gray-50 rounded text-sm text-gray-600 whitespace-pre-wrap font-mono max-h-[500px] overflow-auto">{repair.fullPrompt || repair.fixPrompt}</div>
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

            {/* Grid Repair specific display */}
            {attempt.type === 'grid_repair' && (
              <div className="space-y-2">
                {/* Stats row */}
                <div className="flex items-center gap-4 text-sm">
                  {attempt.gridTotalIssues !== undefined && (
                    <span className="text-violet-700">
                      {language === 'de' ? 'Probleme:' : 'Issues:'} {attempt.gridTotalIssues}
                    </span>
                  )}
                  {attempt.gridFixedCount !== undefined && (
                    <span className="text-green-600">
                      ✓ {language === 'de' ? 'Behoben:' : 'Fixed:'} {attempt.gridFixedCount}
                    </span>
                  )}
                  {attempt.gridFailedCount !== undefined && attempt.gridFailedCount > 0 && (
                    <span className="text-red-600">
                      ✗ {language === 'de' ? 'Fehlgeschlagen:' : 'Failed:'} {attempt.gridFailedCount}
                    </span>
                  )}
                </div>

                {/* Step 1: Annotated Original with Bounding Boxes */}
                {attempt.annotatedOriginal && (
                  <details className="text-sm" open>
                    <summary className="cursor-pointer text-violet-700 font-medium hover:text-violet-900">
                      📍 {language === 'de' ? 'Schritt 1: Erkannte Probleme' : 'Step 1: Detected Issues'}
                    </summary>
                    <div className="mt-3 bg-white p-4 rounded-lg border shadow-sm">
                      <div className="text-xs text-gray-500 mb-2 font-medium">
                        {language === 'de' ? 'Originalbild mit markierten Problembereichen' : 'Original image with marked issue regions'}
                        <span className="ml-2 text-gray-400">
                          (🔴 {language === 'de' ? 'kritisch' : 'critical'}, 🟠 {language === 'de' ? 'wichtig' : 'major'}, 🟡 {language === 'de' ? 'gering' : 'minor'})
                        </span>
                      </div>
                      <img
                        src={`data:image/jpeg;base64,${attempt.annotatedOriginal}`}
                        alt="Annotated original"
                        className="max-w-md border rounded cursor-pointer hover:ring-2 hover:ring-violet-400"
                        onClick={() => setEnlargedImg({
                          src: `data:image/jpeg;base64,${attempt.annotatedOriginal}`,
                          title: language === 'de' ? 'Erkannte Probleme' : 'Detected Issues'
                        })}
                      />
                    </div>
                  </details>
                )}

                {/* Before/After Evaluations */}
                <details className="text-sm">
                  <summary className="cursor-pointer text-violet-700 font-medium hover:text-violet-900">
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
                        title={`evaluation-before-grid-${idx}`}
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
                        title={`evaluation-after-grid-${idx}`}
                      />
                    </div>
                  </div>
                </details>

                {/* Grid images display */}
                {attempt.grids && attempt.grids.length > 0 && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-violet-700 font-medium hover:text-violet-900">
                      🔲 {language === 'de' ? 'Grid-Details' : 'Grid Details'} ({attempt.grids.length} {attempt.grids.length === 1 ? 'grid' : 'grids'})
                    </summary>
                    <div className="mt-3 space-y-4">
                      {attempt.grids.map((grid: GridRepairData, gIdx: number) => (
                        <div key={gIdx} className="bg-white p-4 rounded-lg border shadow-sm">
                          <div className="flex justify-between items-center mb-3">
                            <span className="font-medium text-violet-800">
                              {language === 'de' ? 'Grid' : 'Grid'} {grid.batchNum || gIdx + 1}
                            </span>
                            {grid.manifest?.issues && (
                              <span className="text-xs text-gray-500">
                                {grid.manifest.issues.length} {language === 'de' ? 'Regionen' : 'regions'}
                              </span>
                            )}
                          </div>

                          {/* Issue descriptions */}
                          {grid.manifest?.issues && grid.manifest.issues.length > 0 && (
                            <div className="mb-3 p-2 bg-violet-50 rounded text-sm">
                              <div className="font-medium text-violet-800 mb-1">
                                {language === 'de' ? 'Zu reparierende Probleme:' : 'Issues to repair:'}
                              </div>
                              <div className="space-y-1">
                                {grid.manifest.issues.map((issue, iIdx: number) => (
                                  <div key={iIdx} className="flex gap-2">
                                    <span className="font-mono font-bold text-violet-600 min-w-[20px]">{issue.letter}:</span>
                                    <span className="text-gray-700">{issue.fixInstruction || issue.description || 'Unknown issue'}</span>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Repair Prompt */}
                          {grid.prompt && (
                            <details className="mb-3">
                              <summary className="text-gray-500 cursor-pointer hover:text-gray-700 text-sm flex items-center gap-2">
                                {language === 'de' ? 'Reparatur-Prompt anzeigen' : 'Show repair prompt'}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    downloadAsText(grid.prompt || '', `grid-repair-prompt-${gIdx}.txt`);
                                  }}
                                  className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 px-2 py-0.5 bg-blue-50 rounded"
                                >
                                  <Download size={10} /> Download
                                </button>
                              </summary>
                              <div className="mt-2 p-3 bg-gray-50 rounded text-sm text-gray-600 whitespace-pre-wrap font-mono max-h-[500px] overflow-auto">
                                {grid.prompt}
                              </div>
                            </details>
                          )}

                          {/* Grid Images: Before and After */}
                          <div className="flex gap-4 items-start flex-wrap">
                            {/* Original Grid */}
                            {grid.original && (
                              <div>
                                <div className="text-xs text-gray-500 mb-1 font-medium">
                                  {language === 'de' ? 'Original-Grid' : 'Input Grid'}
                                </div>
                                <img
                                  src={`data:image/jpeg;base64,${grid.original}`}
                                  alt="Input grid"
                                  className="max-w-xs border rounded cursor-pointer hover:ring-2 hover:ring-violet-400"
                                  onClick={() => setEnlargedImg({ src: `data:image/jpeg;base64,${grid.original}`, title: language === 'de' ? 'Original-Grid' : 'Input Grid' })}
                                />
                              </div>
                            )}
                            {/* Arrow */}
                            {grid.original && grid.repaired && (
                              <div className="flex items-center self-center text-gray-400 text-2xl">→</div>
                            )}
                            {/* Repaired Grid */}
                            {grid.repaired && (
                              <div>
                                <div className="text-xs text-gray-500 mb-1 font-medium">
                                  {language === 'de' ? 'Repariertes Grid' : 'Repaired Grid'}
                                </div>
                                <img
                                  src={`data:image/jpeg;base64,${grid.repaired}`}
                                  alt="Repaired grid"
                                  className="max-w-xs border-2 border-green-300 rounded cursor-pointer hover:ring-2 hover:ring-green-400"
                                  onClick={() => setEnlargedImg({ src: `data:image/jpeg;base64,${grid.repaired}`, title: language === 'de' ? 'Repariertes Grid' : 'Repaired Grid' })}
                                />
                              </div>
                            )}
                          </div>

                          {/* Per-repair verification table */}
                          {grid.repairs && grid.repairs.length > 0 && (
                            <div className="mt-4">
                              <div className="font-medium text-violet-800 mb-2">
                                ✅ {language === 'de' ? 'Verifizierungsergebnisse' : 'Verification Results'}
                              </div>
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm border-collapse">
                                  <thead>
                                    <tr className="bg-violet-100 text-violet-800">
                                      <th className="px-2 py-1 text-left border">{language === 'de' ? 'Ltr' : 'Ltr'}</th>
                                      <th className="px-2 py-1 text-left border">{language === 'de' ? 'Problem' : 'Issue'}</th>
                                      <th className="px-2 py-1 text-center border">{language === 'de' ? 'Vorher' : 'Before'}</th>
                                      <th className="px-2 py-1 text-center border">{language === 'de' ? 'Nachher' : 'After'}</th>
                                      <th className="px-2 py-1 text-center border">{language === 'de' ? 'Status' : 'Status'}</th>
                                      <th className="px-2 py-1 text-center border">{language === 'de' ? 'Konfidenz' : 'Confidence'}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {grid.repairs.map((repair, rIdx) => (
                                      <tr key={rIdx} className={repair.verification?.accepted ? 'bg-green-50' : 'bg-red-50'}>
                                        <td className="px-2 py-1 border font-mono font-bold text-violet-600">{repair.letter}</td>
                                        <td className="px-2 py-1 border text-gray-700 max-w-[200px] truncate" title={repair.description}>
                                          <span className={`inline-block px-1 py-0.5 rounded text-xs mr-1 ${
                                            repair.severity === 'critical' ? 'bg-red-200 text-red-800' :
                                            repair.severity === 'major' ? 'bg-orange-200 text-orange-800' :
                                            'bg-yellow-200 text-yellow-800'
                                          }`}>
                                            {repair.type || 'unknown'}
                                          </span>
                                          {repair.description?.substring(0, 40)}{(repair.description?.length || 0) > 40 ? '...' : ''}
                                        </td>
                                        <td className="px-2 py-1 border text-center">
                                          {repair.originalThumbnail && (
                                            <img
                                              src={`data:image/jpeg;base64,${repair.originalThumbnail}`}
                                              alt="Before"
                                              className="w-12 h-12 object-contain inline-block cursor-pointer hover:ring-2 hover:ring-violet-400 rounded"
                                              onClick={() => setEnlargedImg({
                                                src: `data:image/jpeg;base64,${repair.originalThumbnail}`,
                                                title: `${repair.letter}: Before`
                                              })}
                                            />
                                          )}
                                        </td>
                                        <td className="px-2 py-1 border text-center">
                                          {repair.repairedThumbnail && (
                                            <img
                                              src={`data:image/jpeg;base64,${repair.repairedThumbnail}`}
                                              alt="After"
                                              className={`w-12 h-12 object-contain inline-block cursor-pointer hover:ring-2 rounded ${
                                                repair.verification?.accepted ? 'hover:ring-green-400 border-green-300' : 'hover:ring-red-400 border-red-300'
                                              }`}
                                              onClick={() => setEnlargedImg({
                                                src: `data:image/jpeg;base64,${repair.repairedThumbnail}`,
                                                title: `${repair.letter}: After`
                                              })}
                                            />
                                          )}
                                        </td>
                                        <td className="px-2 py-1 border text-center">
                                          {repair.verification?.accepted ? (
                                            <span className="text-green-600 font-bold">✓</span>
                                          ) : (
                                            <span className="text-red-600 font-bold">✗</span>
                                          )}
                                        </td>
                                        <td className="px-2 py-1 border text-center">
                                          <span className={`font-medium ${
                                            (repair.verification?.confidence ?? 0) >= 0.7 ? 'text-green-600' :
                                            (repair.verification?.confidence ?? 0) >= 0.5 ? 'text-yellow-600' :
                                            'text-red-600'
                                          }`}>
                                            {Math.round((repair.verification?.confidence ?? 0) * 100)}%
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              {/* Explanation for failed repairs */}
                              {grid.repairs.filter(r => !r.verification?.accepted).map((repair, rIdx) => (
                                <div key={rIdx} className="mt-2 text-sm text-red-600 bg-red-50 p-2 rounded border border-red-200">
                                  <span className="font-mono font-bold">{repair.letter}:</span>{' '}
                                  {repair.verification?.reason || repair.verification?.explanation || 'Unknown failure reason'}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Bbox Detection Display (for all types including bbox_detection_only) */}
            {attempt.bboxDetection && typeof attempt.bboxDetection === 'object' && 'figures' in attempt.bboxDetection && (
              <details className="text-sm mb-2">
                <summary className="cursor-pointer text-blue-700 font-medium hover:text-blue-900 flex items-center gap-2">
                  📦 {language === 'de' ? 'Objekterkennung' : 'Object Detection'}
                  <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                    {(attempt.bboxDetection as { figures?: unknown[]; objects?: unknown[] }).figures?.length || 0} {language === 'de' ? 'Figuren' : 'figures'},
                    {' '}{(attempt.bboxDetection as { figures?: unknown[]; objects?: unknown[] }).objects?.length || 0} {language === 'de' ? 'Objekte' : 'objects'}
                  </span>
                </summary>
                <div className="mt-3 space-y-3">
                  {/* Bbox Overlay Image */}
                  {attempt.bboxOverlayImage && (
                    <div>
                      <div className="text-xs text-gray-500 mb-1 font-medium">
                        {language === 'de' ? 'Erkannte Regionen' : 'Detected Regions'}
                        <span className="ml-2 text-gray-400">(🟢 Body, 🔵 Face, 🟠 Object)</span>
                      </div>
                      <img
                        src={attempt.bboxOverlayImage}
                        alt="Bbox overlay"
                        className="max-w-md border rounded cursor-pointer hover:ring-2 hover:ring-blue-400"
                        onClick={() => setEnlargedImg({ src: attempt.bboxOverlayImage!, title: language === 'de' ? 'Erkannte Regionen' : 'Detected Regions' })}
                      />
                    </div>
                  )}

                  {/* Figures list */}
                  {(attempt.bboxDetection as { figures?: Array<{ label?: string; bodyBox?: number[]; faceBox?: number[]; position?: string }> }).figures && (attempt.bboxDetection as { figures: Array<{ label?: string; bodyBox?: number[]; faceBox?: number[]; position?: string }> }).figures.length > 0 && (
                    <div className="bg-green-50 p-3 rounded border border-green-200">
                      <div className="font-medium text-green-800 mb-2">
                        {language === 'de' ? 'Figuren' : 'Figures'} ({(attempt.bboxDetection as { figures: unknown[] }).figures.length})
                      </div>
                      <div className="space-y-2">
                        {(attempt.bboxDetection as { figures: Array<{ label?: string; bodyBox?: number[]; faceBox?: number[]; position?: string }> }).figures.map((fig, fIdx) => (
                          <div key={fIdx} className="text-sm bg-white p-2 rounded border">
                            <div className="font-medium text-green-700">{fig.label || `Figure ${fIdx + 1}`}</div>
                            <div className="text-xs text-gray-500 mt-1 grid grid-cols-2 gap-2">
                              {fig.bodyBox && (
                                <span>Body: [{fig.bodyBox.map(v => (v * 100).toFixed(0) + '%').join(', ')}]</span>
                              )}
                              {fig.faceBox && (
                                <span>Face: [{fig.faceBox.map(v => (v * 100).toFixed(0) + '%').join(', ')}]</span>
                              )}
                              {fig.position && <span>Pos: {fig.position}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Objects list */}
                  {(attempt.bboxDetection as { objects?: Array<{ label?: string; bodyBox?: number[]; position?: string }> }).objects && (attempt.bboxDetection as { objects: Array<{ label?: string; bodyBox?: number[]; position?: string }> }).objects.length > 0 && (
                    <div className="bg-orange-50 p-3 rounded border border-orange-200">
                      <div className="font-medium text-orange-800 mb-2">
                        {language === 'de' ? 'Objekte' : 'Objects'} ({(attempt.bboxDetection as { objects: unknown[] }).objects.length})
                      </div>
                      <div className="space-y-2">
                        {(attempt.bboxDetection as { objects: Array<{ label?: string; bodyBox?: number[]; position?: string }> }).objects.map((obj, oIdx) => (
                          <div key={oIdx} className="text-sm bg-white p-2 rounded border">
                            <div className="font-medium text-orange-700">{obj.label || `Object ${oIdx + 1}`}</div>
                            <div className="text-xs text-gray-500 mt-1">
                              {obj.bodyBox && (
                                <span>Box: [{obj.bodyBox.map(v => (v * 100).toFixed(0) + '%').join(', ')}]</span>
                              )}
                              {obj.position && <span className="ml-2">Pos: {obj.position}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Raw JSON download */}
                  <button
                    onClick={() => downloadAsText(JSON.stringify(attempt.bboxDetection, null, 2), `bbox-detection-attempt-${idx}.json`)}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 px-2 py-1 bg-blue-50 rounded hover:bg-blue-100"
                  >
                    <Download size={12} /> {language === 'de' ? 'JSON herunterladen' : 'Download JSON'}
                  </button>
                </div>
              </details>
            )}

            {/* Input Prompt (for regular attempts) */}
            {attempt.type !== 'auto_repair' && attempt.type !== 'grid_repair' && attempt.prompt && (
              <details className="text-sm mb-2">
                <summary className="cursor-pointer text-blue-700 font-medium hover:text-blue-900 flex items-center gap-2">
                  📤 {language === 'de' ? 'Eingabe-Prompt' : 'Input Prompt'}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadAsText(attempt.prompt || '', `prompt-attempt-${attempt.attempt}.txt`);
                    }}
                    className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 px-2 py-0.5 bg-blue-50 rounded"
                  >
                    <Download size={10} /> Download
                  </button>
                </summary>
                <pre className="mt-2 whitespace-pre-wrap bg-blue-50 p-3 rounded text-sm overflow-auto max-h-[500px] font-mono border border-blue-200">{attempt.prompt}</pre>
              </details>
            )}

            {/* Regular attempt feedback */}
            {attempt.type !== 'auto_repair' && attempt.type !== 'grid_repair' && attempt.reasoning ? (
              <details className="text-sm text-gray-600 mb-2">
                <summary className="cursor-pointer font-medium">📥 {language === 'de' ? 'Bewertungs-Feedback' : 'Evaluation Feedback'}</summary>
                <pre className="mt-2 whitespace-pre-wrap bg-gray-50 p-3 rounded text-sm overflow-auto max-h-[500px] font-mono">{attempt.reasoning}</pre>
              </details>
            ) : attempt.type !== 'auto_repair' && attempt.type !== 'grid_repair' && attempt.score === 0 && (
              <div className="text-sm text-gray-500 italic mb-2">
                {language === 'de' ? 'Qualitätsbewertung fehlgeschlagen' : language === 'fr' ? 'Évaluation de qualité échouée' : 'Quality evaluation failed'}
              </div>
            )}

            {/* Image - show directly for regular attempts, not hidden */}
            {attempt.imageData && attempt.type !== 'auto_repair' && attempt.type !== 'grid_repair' && (
              <div className="mt-2">
                <div className="text-xs text-gray-500 mb-1 font-medium">
                  {language === 'de' ? 'Generiertes Bild' : 'Generated Image'}
                </div>
                <img
                  src={attempt.imageData}
                  alt={`Attempt ${attempt.attempt}`}
                  className={`w-48 h-48 object-contain rounded border cursor-pointer hover:ring-2 ${idx === retryHistory.length - 1 ? 'border-green-300 hover:ring-green-400' : 'border-gray-200 opacity-75 hover:ring-gray-400'}`}
                  onClick={() => setEnlargedImg({ src: attempt.imageData!, title: `${language === 'de' ? 'Versuch' : 'Attempt'} ${attempt.attempt}` })}
                />
              </div>
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
