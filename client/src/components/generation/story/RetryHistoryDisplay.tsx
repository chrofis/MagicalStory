import { useState } from 'react';
import { History } from 'lucide-react';
import type { RetryAttempt } from '@/types/story';

interface RetryHistoryDisplayProps {
  retryHistory: RetryAttempt[];
  totalAttempts: number;
  language: string;
}

/**
 * Component to display generation retry history with before/after images
 */
export function RetryHistoryDisplay({
  retryHistory,
  totalAttempts,
  language
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
                {/* Fix targets count */}
                {attempt.fixTargetsCount && (
                  <div className="text-xs text-amber-700">
                    Fixed {attempt.fixTargetsCount} target{attempt.fixTargetsCount > 1 ? 's' : ''}
                  </div>
                )}

                {/* Before/After Evaluations */}
                <details className="text-xs">
                  <summary className="cursor-pointer text-amber-700 font-medium">
                    📊 {language === 'de' ? 'Bewertungen anzeigen' : 'View Evaluations'}
                  </summary>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {/* Before evaluation */}
                    <div className="bg-white p-2 rounded border border-red-200">
                      <div className="font-medium text-red-700 mb-1">Before ({attempt.preRepairScore}%)</div>
                      <pre className="text-[10px] whitespace-pre-wrap overflow-auto max-h-40 bg-gray-50 p-1 rounded">
                        {attempt.preRepairEval ? JSON.stringify(attempt.preRepairEval, null, 2) : attempt.reasoning || 'No data'}
                      </pre>
                    </div>
                    {/* After evaluation */}
                    <div className="bg-white p-2 rounded border border-green-200">
                      <div className="font-medium text-green-700 mb-1">After ({attempt.postRepairScore}%)</div>
                      <pre className="text-[10px] whitespace-pre-wrap overflow-auto max-h-40 bg-gray-50 p-1 rounded">
                        {attempt.postRepairEval ? JSON.stringify(attempt.postRepairEval, null, 2) : 'No data'}
                      </pre>
                    </div>
                  </div>
                </details>

                {/* Repair Details with images */}
                {attempt.repairDetails && attempt.repairDetails.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-amber-700 font-medium">
                      🖼️ {language === 'de' ? 'Reparatur-Details' : 'Repair Details'} ({attempt.repairDetails.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {attempt.repairDetails.map((repair, rIdx) => (
                        <div key={rIdx} className="bg-white p-2 rounded border">
                          <div className="font-medium mb-1">{repair.description}</div>
                          <div className="text-gray-600 mb-2">{repair.fixPrompt}</div>
                          <div className="flex gap-2 flex-wrap">
                            {repair.beforeImage && (
                              <div>
                                <div className="text-[10px] text-gray-500 mb-1">Before</div>
                                <img
                                  src={repair.beforeImage}
                                  alt="Before"
                                  className="w-32 h-32 object-contain border rounded cursor-pointer hover:ring-2 hover:ring-amber-400"
                                  onClick={() => setEnlargedImg({ src: repair.beforeImage!, title: 'Before Repair' })}
                                />
                              </div>
                            )}
                            {repair.maskImage && (
                              <div>
                                <div className="text-[10px] text-gray-500 mb-1">Mask</div>
                                <img
                                  src={repair.maskImage}
                                  alt="Mask"
                                  className="w-32 h-32 object-contain border rounded bg-black cursor-pointer hover:ring-2 hover:ring-gray-400"
                                  onClick={() => setEnlargedImg({ src: repair.maskImage!, title: 'Repair Mask' })}
                                />
                              </div>
                            )}
                            {repair.afterImage && (
                              <div>
                                <div className="text-[10px] text-gray-500 mb-1">After</div>
                                <img
                                  src={repair.afterImage}
                                  alt="After"
                                  className="w-32 h-32 object-contain border rounded cursor-pointer hover:ring-2 hover:ring-green-400"
                                  onClick={() => setEnlargedImg({ src: repair.afterImage!, title: 'After Repair' })}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {/* Regular attempt feedback */}
            {attempt.type !== 'auto_repair' && attempt.reasoning ? (
              <details className="text-xs text-gray-600 mb-2">
                <summary className="cursor-pointer">{language === 'de' ? 'Feedback' : 'Feedback'}</summary>
                <pre className="mt-1 whitespace-pre-wrap bg-gray-50 p-2 rounded text-[10px] overflow-auto max-h-40">{attempt.reasoning}</pre>
              </details>
            ) : attempt.type !== 'auto_repair' && attempt.score === 0 && (
              <div className="text-xs text-gray-500 italic mb-2">
                {language === 'de' ? 'Qualitätsbewertung fehlgeschlagen' : language === 'fr' ? 'Évaluation de qualité échouée' : 'Quality evaluation failed'}
              </div>
            )}

            {attempt.imageData && attempt.type !== 'auto_repair' && (
              <details>
                <summary className="cursor-pointer text-xs text-blue-600">
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
