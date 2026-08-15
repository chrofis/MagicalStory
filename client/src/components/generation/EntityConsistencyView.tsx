import { useState, useEffect, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import storyService from '@/services/storyService';
import type { EntityConsistencyReport, StoryLanguageCode } from '@/types/story';

interface EntityHistoryEntry {
  runIndex: number;
  timestamp: string;
  triggeredBy?: string;
  report: EntityConsistencyReport | null;
}

interface EntityConsistencyViewProps {
  storyId: string;
  /** Latest / live report. May have grid bytes stripped (lazy-load by gridIndex). */
  entity: EntityConsistencyReport | null;
  /** Per-run history. Grids stripped — lazy-loaded by runIndex + gridIndex. */
  entityHistory: EntityHistoryEntry[];
  language?: StoryLanguageCode;
  /** Lift lightbox to parent so it integrates with the parent's image viewer. */
  onLightbox?: (img: string) => void;
}

/**
 * Reusable consistency view with round-browsing.
 *
 * Lazy-loads grid images for the active round (live or historical). Embedded
 * grid bytes (e.g. fresh workflow runs) are used immediately when present.
 */
export function EntityConsistencyView({
  storyId,
  entity,
  entityHistory,
  language = 'en',
  onLightbox,
}: EntityConsistencyViewProps) {
  // null = show live latest. number = show that runIndex from history.
  const [selectedRunIndex, setSelectedRunIndex] = useState<number | null>(null);
  // Lazy-loaded grid images, keyed `${runIndex ?? 'live'}:${gridIndex}`.
  const [loadedGrids, setLoadedGrids] = useState<Record<string, string>>({});
  const [loadingGrids, setLoadingGrids] = useState<Set<string>>(new Set());

  const liveReport = entity;
  const isViewingLive = selectedRunIndex === null;
  const historicalEntry = !isViewingLive
    ? entityHistory.find(h => h.runIndex === selectedRunIndex) || null
    : null;

  // If entity is null but history has entries, default to the last history entry.
  const fallbackHistEntry = !entity && entityHistory.length > 0
    ? entityHistory[entityHistory.length - 1]
    : null;

  const displayedReport: EntityConsistencyReport | null = isViewingLive
    ? (liveReport || fallbackHistEntry?.report || null)
    : (historicalEntry?.report || null);

  const displayedRunIndex = isViewingLive
    ? ((liveReport as any)?.runIndex ?? fallbackHistEntry?.runIndex)
    : selectedRunIndex;

  const activeHistEntry = isViewingLive ? fallbackHistEntry : historicalEntry;

  // Cache key prefix for grids in the active round
  const cacheKeyPrefix = isViewingLive ? 'live' : String(selectedRunIndex);

  // Auto-fetch missing grids whenever the active round changes.
  useEffect(() => {
    if (!storyId || !displayedReport) return;
    const grids = (displayedReport as any).grids || [];
    const runIdxForFetch = isViewingLive ? undefined : selectedRunIndex!;
    const toFetch: Array<{ gridIndex: number; key: string }> = [];
    for (let i = 0; i < grids.length; i++) {
      const g = grids[i];
      const gridIndex = g.gridIndex ?? i;
      // Skip if inline bytes already present
      if (g.gridImage) continue;
      // Skip when there is nothing to load on the server side
      if (g.hasGridImage === false) continue;
      const key = `${cacheKeyPrefix}:${gridIndex}`;
      if (loadedGrids[key] || loadingGrids.has(key)) continue;
      toFetch.push({ gridIndex, key });
    }
    if (toFetch.length === 0) return;

    setLoadingGrids(prev => {
      const next = new Set(prev);
      for (const t of toFetch) next.add(t.key);
      return next;
    });

    Promise.all(toFetch.map(async ({ gridIndex, key }) => {
      try {
        const result = await storyService.getEntityGridImageByIndex(storyId, gridIndex, runIdxForFetch);
        // Keep the head (face) grid too — this auto-fetch path used to drop it,
        // and since it fills every grid on mount, the "Load All" button (the
        // only path that kept heads) never appeared: faces were unreachable.
        return { key, gridImage: result?.gridImage, headGridImage: (result as any)?.headGridImage };
      } catch (err) {
        console.error(`Failed to load entity grid image for ${key}:`, err);
        return { key, gridImage: undefined, headGridImage: undefined };
      }
    })).then(results => {
      setLoadedGrids(prev => {
        const next = { ...prev };
        for (const r of results) {
          if (r.gridImage) next[r.key] = r.gridImage;
          if (r.headGridImage) next[r.key + ':head'] = r.headGridImage;
        }
        return next;
      });
      setLoadingGrids(prev => {
        const next = new Set(prev);
        for (const r of results) next.delete(r.key);
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, displayedReport, isViewingLive, selectedRunIndex]);

  // Compute unloaded grid count for the "Load All" button.
  const unloadedGridCount = useMemo(() => {
    if (!displayedReport) return 0;
    const grids = (displayedReport as any).grids || [];
    let count = 0;
    for (let i = 0; i < grids.length; i++) {
      const g = grids[i];
      if (g.gridImage) continue;
      if (g.hasGridImage === false) continue;
      const gridIndex = g.gridIndex ?? i;
      const key = `${cacheKeyPrefix}:${gridIndex}`;
      if (!loadedGrids[key]) count++;
    }
    return count;
  }, [displayedReport, loadedGrids, cacheKeyPrefix]);

  // "Load All" trigger — scopes to the active round (uses the same auto-fetch path).
  const loadAllForActiveRound = async () => {
    if (!storyId || !displayedReport) return;
    const grids = (displayedReport as any).grids || [];
    const runIdxForFetch = isViewingLive ? undefined : selectedRunIndex!;
    const toFetch: Array<{ gridIndex: number; key: string }> = [];
    for (let i = 0; i < grids.length; i++) {
      const g = grids[i];
      const gridIndex = g.gridIndex ?? i;
      if (g.gridImage) continue;
      if (g.hasGridImage === false) continue;
      const key = `${cacheKeyPrefix}:${gridIndex}`;
      if (loadedGrids[key] || loadingGrids.has(key)) continue;
      toFetch.push({ gridIndex, key });
    }
    if (toFetch.length === 0) return;

    setLoadingGrids(prev => {
      const next = new Set(prev);
      for (const t of toFetch) next.add(t.key);
      return next;
    });
    const results = await Promise.all(toFetch.map(async ({ gridIndex, key }) => {
      try {
        const result = await storyService.getEntityGridImageByIndex(storyId, gridIndex, runIdxForFetch);
        return { key, gridImage: result?.gridImage, headGridImage: (result as any)?.headGridImage };
      } catch (err) {
        console.error(`Failed to load entity grid image for ${key}:`, err);
        return { key, gridImage: undefined, headGridImage: undefined };
      }
    }));
    setLoadedGrids(prev => {
      const next = { ...prev };
      for (const r of results) {
        if (r.gridImage) next[r.key] = r.gridImage;
        if (r.headGridImage) next[r.key + ':head'] = r.headGridImage;
      }
      return next;
    });
    setLoadingGrids(prev => {
      const next = new Set(prev);
      for (const r of results) next.delete(r.key);
      return next;
    });
  };

  // Resolve grid images for a (charName, clothing) cell.
  // Prefers inline bytes; falls back to lazy-loaded cache for the active round.
  const resolveGridImages = (charName: string, clothing: string, clothingResult: any): string[] => {
    // BODY grids come from the inline result when it has them; HEAD grids only
    // ever live on the grids[] manifest, so the manifest is ALWAYS consulted.
    //
    // This used to `return` as soon as an inline body grid was found, which is
    // every character on every story — so the head grid, the one image that
    // actually shows faces, was never displayed even though it is built, sent
    // to the judge and persisted. Measured on job_1786780194082_s980g4s9a:
    // byClothing carries gridImage (and gridImages for multi-grid entities) but
    // never headGridImage, while every grids[] entry has one.
    const out: string[] = [];
    if (clothingResult.gridImages && clothingResult.gridImages.length > 0) out.push(...clothingResult.gridImages);
    else if (clothingResult.gridImage) out.push(clothingResult.gridImage);
    if (clothingResult.headGridImage) out.push(clothingResult.headGridImage);

    if (!displayedReport) return out;
    const grids = (displayedReport as any).grids || [];
    const haveBody = out.length > 0;
    for (let i = 0; i < grids.length; i++) {
      const g = grids[i];
      if (g.entityName !== charName) continue;
      if (g.clothingCategory !== undefined && g.clothingCategory !== clothing) continue;
      const gridIndex = g.gridIndex ?? i;
      const key = `${cacheKeyPrefix}:${gridIndex}`;
      if (!haveBody) {
        const img = g.gridImage || loadedGrids[key];
        if (img && !out.includes(img)) out.push(img);
      }
      const headImg = g.headGridImage || loadedGrids[key + ':head'];
      if (headImg && !out.includes(headImg)) out.push(headImg);
    }
    return out;
  };

  // Empty state: nothing to render
  if (!displayedReport && entityHistory.length === 0) return null;

  const loadAllLabel = (() => {
    if (loadingGrids.size > 0) {
      return language === 'de'
        ? `Lade ${loadingGrids.size} Grids...`
        : language === 'fr'
          ? `Chargement de ${loadingGrids.size} grilles...`
          : `Loading ${loadingGrids.size} grids...`;
    }
    return language === 'de'
      ? `Alle Grids laden (${unloadedGridCount})`
      : language === 'fr'
        ? `Charger toutes les grilles (${unloadedGridCount})`
        : `Load All Grids (${unloadedGridCount})`;
  })();

  return (
    <div className="space-y-3">
      {/* Round selector — shown only when history has more than one entry */}
      {entityHistory.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-gray-500">Round:</span>
          {entityHistory.map((h) => {
            const isSelected = !isViewingLive && selectedRunIndex === h.runIndex;
            const isLatestInHistory = h.runIndex === entityHistory[entityHistory.length - 1].runIndex;
            return (
              <button
                key={h.runIndex}
                onClick={() => setSelectedRunIndex(h.runIndex)}
                className={`px-2 py-1 rounded border ${
                  isSelected
                    ? 'bg-amber-600 text-white border-amber-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                }`}
                title={`${new Date(h.timestamp).toLocaleString()} - ${h.triggeredBy || 'manual'} - ${h.report?.totalIssues ?? '?'} issues`}
              >
                R{h.runIndex}{isLatestInHistory ? ' (saved)' : ''}
              </button>
            );
          })}
          <button
            onClick={() => setSelectedRunIndex(null)}
            className={`px-2 py-1 rounded border ${
              isViewingLive
                ? 'bg-amber-600 text-white border-amber-600'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
            title="Live latest result in this session"
          >
            Live
          </button>
          {displayedRunIndex !== undefined && (
            <span className="text-gray-400 ml-auto">
              runIndex {displayedRunIndex}
              {activeHistEntry?.timestamp && ` - ${new Date(activeHistEntry.timestamp).toLocaleString()}`}
            </span>
          )}
        </div>
      )}

      {displayedReport && (
        <>
          {/* Summary panel */}
          <div className={`p-3 rounded-lg border ${
            displayedReport.overallConsistent
              ? 'bg-green-50 border-green-200'
              : 'bg-amber-50 border-amber-200'
          }`}>
            <h5 className="text-sm font-medium mb-1">
              {displayedReport.overallConsistent
                ? (language === 'de'
                    ? 'Alle Charaktere konsistent!'
                    : language === 'fr'
                      ? 'Tous les personnages sont cohérents !'
                      : 'All characters consistent!')
                : (language === 'de'
                    ? `${displayedReport.totalIssues} Konsistenzprobleme gefunden`
                    : language === 'fr'
                      ? `${displayedReport.totalIssues} problèmes de cohérence trouvés`
                      : `${displayedReport.totalIssues} consistency issues found`)}
            </h5>
            <p className="text-xs text-gray-600">{displayedReport.summary}</p>
          </div>

          {/* Load All Grids button — scoped to the active round */}
          {unloadedGridCount > 0 && (
            <button
              onClick={loadAllForActiveRound}
              disabled={loadingGrids.size > 0}
              className="text-xs px-3 py-1.5 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-blue-300"
            >
              {loadAllLabel}
            </button>
          )}

          {/* Per-character grids */}
          {Object.entries(displayedReport.characters || {}).map(([charName, charResult]) => (
            <div key={charName} className="border rounded-lg overflow-hidden">
              <div className={`px-3 py-2 text-sm font-medium flex items-center justify-between ${
                charResult.overallConsistent ? 'bg-green-50' : 'bg-amber-50'
              }`}>
                <span>{charName}</span>
                {/* The 0-10 score was vestigial (null on current runs, used by
                    nothing downstream). What the pipeline actually charges is a
                    per-page deduction from each issue's severity — show that. */}
                <span className={`text-xs px-2 py-0.5 rounded ${
                  charResult.overallConsistent
                    ? 'bg-green-200 text-green-800'
                    : 'bg-amber-200 text-amber-800'
                }`}>
                  {(() => {
                    const pts: Record<string, number> = { catastrophic: 50, critical: 25, major: 15, moderate: 5, minor: 2 };
                    const all: any[] = [
                      ...(charResult.issues || []),
                      ...Object.values(charResult.byClothing || {}).flatMap((c: any) => c.issues || []),
                    ];
                    const perPage: Record<string, number> = {};
                    for (const iss of all) {
                      const pages = iss.pageNumbers || iss.pagesToFix || (iss.pageNumber != null ? [iss.pageNumber] : []);
                      for (const pg of pages) {
                        if (pg < 0) continue; // reference-cell finding, not a story page
                        perPage[pg] = (perPage[pg] || 0) + (pts[String(iss.severity || '').toLowerCase()] || 0);
                      }
                    }
                    const entries = Object.entries(perPage).sort((a, b) => Number(a[0]) - Number(b[0]));
                    if (entries.length === 0) return all.length > 0 ? `${all.length} issue(s)` : 'OK';
                    return entries.map(([pg, pen]) => `P${pg}: −${pen}`).join('  ');
                  })()}
                </span>
              </div>
              <div className="p-3 bg-white space-y-2 text-sm">
                {/* Per-clothing breakdown */}
                {charResult.byClothing && Object.entries(charResult.byClothing).map(([clothing, clothingResult]) => {
                  const gridImages = resolveGridImages(charName, clothing, clothingResult);
                  // Determine if any matching grid is currently loading.
                  const grids = (displayedReport as any).grids || [];
                  const matchingGrid = grids.find((g: any) => g.entityName === charName && g.clothingCategory === clothing);
                  const matchingKey = matchingGrid
                    ? `${cacheKeyPrefix}:${matchingGrid.gridIndex ?? grids.indexOf(matchingGrid)}`
                    : null;
                  const isLoading = matchingKey ? loadingGrids.has(matchingKey) : false;
                  return (
                    <div key={clothing} className="border-l-2 border-gray-200 pl-3">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-700">{clothing}</span>
                        {typeof clothingResult.score === 'number' && (
                          <span className={`text-xs ${clothingResult.score >= 7 ? 'text-green-600' : 'text-amber-600'}`}>
                            {clothingResult.score}/10
                          </span>
                        )}
                      </div>
                      {gridImages.length === 0 && isLoading && (
                        <div className="mt-2 mb-2 h-24 flex items-center justify-center text-xs text-gray-400 bg-gray-50 rounded border border-gray-200">
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          {language === 'de' ? 'Grid wird geladen...' : language === 'fr' ? 'Chargement de la grille...' : 'Loading grid...'}
                        </div>
                      )}
                      {gridImages.map((img: string, gridIdx: number) => (
                        <div key={gridIdx} className="mt-2 mb-2">
                          <img
                            src={img}
                            alt={`${charName} - ${clothing} consistency grid${gridImages.length > 1 ? ` ${gridIdx + 1}` : ''}`}
                            className="w-full max-h-48 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                            onClick={() => onLightbox?.(img)}
                            title="Click to enlarge"
                          />
                        </div>
                      ))}
                      {clothingResult.issues && clothingResult.issues.length > 0 && (
                        <ul className="mt-1 space-y-1">
                          {clothingResult.issues.map((issue, i) => (
                            <li key={i} className="text-xs text-gray-600 flex items-start gap-1">
                              <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                                issue.severity === 'critical' ? 'bg-red-400' :
                                issue.severity === 'major' ? 'bg-amber-400' : 'bg-gray-400'
                              }`} />
                              <span>
                                {issue.description}
                                {issue.pagesToFix && issue.pagesToFix.length > 0 && (
                                  <span className="text-gray-400 ml-1">(pages {issue.pagesToFix.join(', ')})</span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
                {/* Top-level issues — current runs store issues here while
                    byClothing groups exist but are empty; render them always
                    (this list is what went invisible). */}
                {charResult.byClothing && charResult.issues && charResult.issues.length > 0 && (
                  <ul className="space-y-1 border-l-2 border-amber-200 pl-3">
                    {charResult.issues.map((issue, i) => (
                      <li key={i} className="text-xs text-gray-600 flex items-start gap-1">
                        <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                          issue.severity?.toLowerCase() === 'critical' ? 'bg-red-400' :
                          issue.severity?.toLowerCase() === 'major' ? 'bg-amber-400' : 'bg-gray-400'
                        }`} />
                        <span>
                          {issue.description}
                          {(issue as any).pageNumbers && (issue as any).pageNumbers.filter((n: number) => n > 0).length > 0 && (
                            <span className="text-gray-400 ml-1">(pages {(issue as any).pageNumbers.filter((n: number) => n > 0).join(', ')})</span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {/* Legacy flat issues (backward compat) */}
                {!charResult.byClothing && (
                  <>
                    {charResult.gridImage && (
                      <div className="mb-2">
                        <img
                          src={charResult.gridImage}
                          alt={`${charName} consistency grid`}
                          className="w-full max-h-48 object-contain rounded border border-gray-200 bg-gray-50 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => charResult.gridImage && onLightbox?.(charResult.gridImage)}
                          title="Click to enlarge"
                        />
                      </div>
                    )}
                    {charResult.issues && charResult.issues.length > 0 && (
                      <ul className="space-y-1">
                        {charResult.issues.map((issue, i) => (
                          <li key={i} className="text-xs text-gray-600 flex items-start gap-1">
                            <span className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                              issue.severity === 'critical' ? 'bg-red-400' :
                              issue.severity === 'major' ? 'bg-amber-400' : 'bg-gray-400'
                            }`} />
                            <span>{issue.description}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                {/* No issues */}
                {(!charResult.byClothing || Object.values(charResult.byClothing).every(c => !c.issues?.length)) &&
                 (!charResult.issues || charResult.issues.length === 0) && (
                  <p className="text-xs text-green-600">
                    {language === 'de' ? 'Keine Probleme gefunden' : language === 'fr' ? 'Aucun problème trouvé' : 'No issues found'}
                  </p>
                )}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
