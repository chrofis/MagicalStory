import { useState } from 'react';
import { Loader2, Download } from 'lucide-react';
import type { BboxSceneDetection, RetryAttempt } from '@/types/story';

interface ObjectDetectionDisplayProps {
  retryHistory?: RetryAttempt[];
  language: string;
  storyId?: string | null;
  pageNumber?: number;
}

/**
 * Extract bbox detection data from retry history
 * Looks for the most recent entry with bboxDetection data
 */
function extractBboxData(retryHistory?: RetryAttempt[]): {
  bboxDetection: BboxSceneDetection | null;
  bboxOverlayImage: string | null;
  hasBboxOverlay: boolean;
} {
  if (!retryHistory || retryHistory.length === 0) {
    return { bboxDetection: null, bboxOverlayImage: null, hasBboxOverlay: false };
  }

  // Find the entry with bbox detection data (prefer bbox_detection_only, then others)
  const bboxEntry = retryHistory.find(r => r.type === 'bbox_detection_only' && r.bboxDetection) ||
    retryHistory.find(r => r.bboxDetection);

  if (!bboxEntry) {
    return { bboxDetection: null, bboxOverlayImage: null, hasBboxOverlay: false };
  }

  // Check if it's the new scene detection format (has figures array)
  const detection = bboxEntry.bboxDetection;
  if (detection && typeof detection === 'object' && 'figures' in detection) {
    return {
      bboxDetection: detection as BboxSceneDetection,
      bboxOverlayImage: bboxEntry.bboxOverlayImage || null,
      hasBboxOverlay: !!bboxEntry.hasBboxOverlay || !!bboxEntry.bboxOverlayImage
    };
  }

  return { bboxDetection: null, bboxOverlayImage: null, hasBboxOverlay: false };
}

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
 * Standalone Object Detection display component
 * Shows detected figures, objects, expected positions, and mismatches
 */
export function ObjectDetectionDisplay({
  retryHistory,
  language,
  storyId,
  pageNumber
}: ObjectDetectionDisplayProps) {
  const [enlargedImg, setEnlargedImg] = useState<{ src: string; title: string } | null>(null);
  const [loadedOverlay, setLoadedOverlay] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const { bboxDetection, bboxOverlayImage, hasBboxOverlay } = extractBboxData(retryHistory);

  // Nothing to show if no detection data
  if (!bboxDetection) {
    return null;
  }

  const figureCount = bboxDetection.figures?.length || 0;
  const objectCount = bboxDetection.objects?.length || 0;

  // Fetch overlay image from server
  const fetchOverlay = async () => {
    if (!storyId || pageNumber === undefined || isLoading) return;

    // Find the retry index that has bbox data
    const retryIdx = retryHistory?.findIndex(r =>
      (r.type === 'bbox_detection_only' && r.bboxDetection) || r.bboxDetection
    ) ?? 0;

    setIsLoading(true);
    try {
      const token = localStorage.getItem('auth_token');
      const params = new URLSearchParams({
        page: String(pageNumber),
        type: 'retry',
        index: String(retryIdx),
        field: 'bboxOverlay'
      });
      const response = await fetch(`/api/stories/${storyId}/dev-image?${params}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
      });
      if (response.ok) {
        const data = await response.json();
        if (data.bboxOverlayImage) {
          setLoadedOverlay(data.bboxOverlayImage);
        }
      }
    } catch (err) {
      console.error('Failed to load bbox overlay:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const overlayImage = bboxOverlayImage || loadedOverlay;

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

      <details className="bg-blue-50 border border-blue-300 rounded-lg p-3">
        <summary className="cursor-pointer text-sm font-semibold text-blue-700 flex items-center justify-between">
          <span className="flex items-center gap-2">
            📦 {language === 'de' ? 'Objekterkennung' : 'Object Detection'}
            <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
              {figureCount} {language === 'de' ? 'Figuren' : 'figures'},
              {' '}{objectCount} {language === 'de' ? 'Objekte' : 'objects'}
            </span>
            {bboxDetection.positionMismatches && bboxDetection.positionMismatches.length > 0 && (
              <span className="text-xs bg-yellow-200 text-yellow-800 px-1.5 py-0.5 rounded">
                ⚠️ {bboxDetection.positionMismatches.length} {language === 'de' ? 'Abweichungen' : 'mismatches'}
              </span>
            )}
            {bboxDetection.missingCharacters && bboxDetection.missingCharacters.length > 0 && (
              <span className="text-xs bg-red-200 text-red-800 px-1.5 py-0.5 rounded">
                ❌ {bboxDetection.missingCharacters.length} {language === 'de' ? 'fehlt' : 'missing'}
              </span>
            )}
          </span>
        </summary>

        <div className="mt-3 space-y-3">
          {/* Bbox Overlay Image */}
          {overlayImage ? (
            <div>
              <div className="text-xs text-gray-500 mb-1 font-medium">
                {language === 'de' ? 'Erkannte Regionen' : 'Detected Regions'}
                <span className="ml-2 text-gray-400">(🟢 Body, 🔵 Face, 🟠 Object, 🟣 Matched)</span>
              </div>
              <img
                src={overlayImage}
                alt="Bbox overlay"
                className="max-w-md border rounded cursor-pointer hover:ring-2 hover:ring-blue-400"
                onClick={() => setEnlargedImg({ src: overlayImage, title: language === 'de' ? 'Erkannte Regionen' : 'Detected Regions' })}
              />
            </div>
          ) : hasBboxOverlay && storyId && pageNumber !== undefined ? (
            <button
              onClick={fetchOverlay}
              disabled={isLoading}
              className="text-sm px-3 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded border border-blue-300 flex items-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <><Loader2 size={14} className="animate-spin" /> {language === 'de' ? 'Lädt...' : 'Loading...'}</>
              ) : (
                <>📦 {language === 'de' ? 'Erkannte Regionen laden' : 'Load Detected Regions'}</>
              )}
            </button>
          ) : null}

          {/* Expected Positions from Scene Description */}
          {bboxDetection.expectedPositions && Object.keys(bboxDetection.expectedPositions).length > 0 && (
            <div className="bg-purple-50 p-3 rounded border border-purple-200">
              <div className="font-medium text-purple-800 mb-2">
                📍 {language === 'de' ? 'Erwartete Positionen' : 'Expected Positions'}
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(bboxDetection.expectedPositions).map(([charName, position]) => (
                  <div key={charName} className="bg-white p-2 rounded border flex justify-between items-center">
                    <span className="font-medium text-purple-700">{charName}</span>
                    <span className="text-gray-600 text-xs">{position}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Position Mismatches Warning */}
          {bboxDetection.positionMismatches && bboxDetection.positionMismatches.length > 0 && (
            <div className="bg-yellow-50 p-3 rounded border border-yellow-300">
              <div className="font-medium text-yellow-800 mb-2">
                ⚠️ {language === 'de' ? 'Positionsabweichungen' : 'Position Mismatches'} ({bboxDetection.positionMismatches.length})
              </div>
              <div className="space-y-2">
                {bboxDetection.positionMismatches.map((mismatch, mIdx) => (
                  <div key={mIdx} className="text-sm bg-white p-2 rounded border border-yellow-200">
                    <div className="font-medium text-yellow-700">{mismatch.character}</div>
                    <div className="text-xs text-gray-600 mt-1 flex gap-3">
                      <span>
                        {language === 'de' ? 'Erwartet' : 'Expected'}: <span className="font-medium text-purple-600">{mismatch.expected}</span>
                        <span className="text-gray-400 ml-1">({mismatch.expectedLCR})</span>
                      </span>
                      <span className="text-gray-400">→</span>
                      <span>
                        {language === 'de' ? 'Erkannt' : 'Actual'}: <span className="font-medium text-orange-600">{mismatch.actual}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Missing Characters Warning */}
          {bboxDetection.missingCharacters && bboxDetection.missingCharacters.length > 0 && (
            <div className="bg-red-50 p-3 rounded border border-red-300">
              <div className="font-medium text-red-800 mb-2">
                ❌ {language === 'de' ? 'Fehlende Charaktere' : 'Missing Characters'} ({bboxDetection.missingCharacters.length})
              </div>
              <div className="text-sm text-red-700">
                {language === 'de'
                  ? 'Diese Charaktere wurden in der Szene erwartet, aber nicht im Bild gefunden:'
                  : 'These characters were expected in the scene but not detected in the image:'}
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {bboxDetection.missingCharacters.map((charName, cIdx) => (
                  <span key={cIdx} className="bg-white px-2 py-1 rounded border border-red-200 text-sm font-medium text-red-700">
                    {charName}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Figures list */}
          {bboxDetection.figures && bboxDetection.figures.length > 0 && (
            <div className="bg-green-50 p-3 rounded border border-green-200">
              <div className="font-medium text-green-800 mb-2">
                {language === 'de' ? 'Figuren' : 'Figures'} ({bboxDetection.figures.length})
              </div>
              <div className="space-y-2">
                {bboxDetection.figures.map((fig, fIdx) => (
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
          {bboxDetection.objects && bboxDetection.objects.length > 0 && (
            <div className="bg-orange-50 p-3 rounded border border-orange-200">
              <div className="font-medium text-orange-800 mb-2">
                {language === 'de' ? 'Objekte' : 'Objects'} ({bboxDetection.objects.length})
              </div>
              <div className="space-y-2">
                {bboxDetection.objects.map((obj, oIdx) => (
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
            onClick={() => downloadAsText(JSON.stringify(bboxDetection, null, 2), `object-detection-page-${pageNumber}.json`)}
            className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1 px-2 py-1 bg-blue-50 rounded hover:bg-blue-100"
          >
            <Download size={12} /> {language === 'de' ? 'JSON herunterladen' : 'Download JSON'}
          </button>
        </div>
      </details>
    </>
  );
}
