/**
 * Story Stats Tab Component (docs/plans/story-stats-page.md, Task 5)
 *
 * Trends over the story_metrics table: headline scores/cost/duration/repair rate,
 * findings-by-category stacked trend, churn panel, runtime-counter panel and a
 * worst-stories table. All charts are plain inline SVG — no chart library.
 *
 * Data notes baked in:
 * - NUMERIC columns arrive as strings from node-pg → num() coerces.
 * - Backfilled rows have NULL counters / churn / judge fields → every panel
 *   filters NULLs and shows "No data" instead of breaking.
 * - env / pipeline_mode filtering is done client-side on the fetched window so
 *   the dropdowns can list every value present (the API also supports server-side
 *   env/mode params for other consumers).
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, RefreshCw, Copy, Check } from 'lucide-react';
import { adminService } from '@/services';
import { testlabService, type EvalFinding } from '@/services/testlabService';
import type { StoryMetricsRow, NumericField } from '@/types/storyMetrics';
import { Button } from '@/components/common/Button';

// ---------- helpers ----------

function num(v: NumericField | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Swiss local time (Europe/Zurich), marked "CH" — never UTC. */
function fmtDateCH(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(d) + ' CH';
}

/** Day key in Europe/Zurich for bucketing. */
function dayKeyCH(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const fmtScore = (v: number) => v.toFixed(1);
const fmtCost = (v: number) => `$${v.toFixed(2)}`;
const fmtMin = (v: number) => `${v.toFixed(1)} min`;
const fmtPct = (v: number) => `${v.toFixed(1)}%`;
const fmtDelta = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1);

// Fixed categorical order — validated palette (CVD-safe, see dataviz validator).
const CAT_COLORS = ['#4f46e5', '#d97706', '#0d9488', '#e11d48', '#0284c7', '#7c3aed', '#059669'];
const OTHER_COLOR = '#9ca3af';

interface Pt { t: number; v: number; label: string }

// ---------- single-series trend chart ----------

function TrendChart({ title, points, color, fmt, yDomain }: {
  title: string;
  points: Pt[];
  color: string;
  fmt: (v: number) => string;
  yDomain?: [number, number];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 560, H = 150, PL = 40, PR = 10, PT = 10, PB = 18;

  const geom = useMemo(() => {
    if (points.length === 0) return null;
    const ts = points.map(p => p.t);
    const vs = points.map(p => p.v);
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    let v0 = yDomain ? yDomain[0] : Math.min(...vs);
    let v1 = yDomain ? yDomain[1] : Math.max(...vs);
    if (v0 === v1) { v0 -= 1; v1 += 1; }
    const pad = yDomain ? 0 : (v1 - v0) * 0.08;
    v0 -= pad; v1 += pad;
    const x = (t: number) => t1 === t0 ? (PL + (W - PL - PR) / 2) : PL + ((t - t0) / (t1 - t0)) * (W - PL - PR);
    const y = (v: number) => PT + (1 - (v - v0) / (v1 - v0)) * (H - PT - PB);
    return { x, y, v0, v1 };
  }, [points, yDomain]);

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!geom || !svgRef.current || points.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bestD = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geom.x(p.t) - mx);
      if (d < bestD) { bestD = d; best = i; }
    });
    setHover(best);
  };

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">{title}</span>
        {hover !== null && points[hover] && (
          <span className="text-xs text-gray-600">
            {points[hover].label}: <span className="font-semibold text-gray-800">{fmt(points[hover].v)}</span>
          </span>
        )}
      </div>
      {points.length === 0 || !geom ? (
        <div className="h-24 flex items-center justify-center text-sm text-gray-400">No data</div>
      ) : (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          {/* recessive grid: top/mid/bottom */}
          {[geom.v1, (geom.v0 + geom.v1) / 2, geom.v0].map((gv, i) => (
            <g key={i}>
              <line x1={PL} x2={W - PR} y1={geom.y(gv)} y2={geom.y(gv)} stroke="#e5e7eb" strokeWidth={1} />
              <text x={PL - 5} y={geom.y(gv) + 3} textAnchor="end" fontSize={10} fill="#6b7280">{fmt(gv)}</text>
            </g>
          ))}
          <polyline
            points={points.map(p => `${geom.x(p.t)},${geom.y(p.v)}`).join(' ')}
            fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          />
          {points.length === 1 && (
            <circle cx={geom.x(points[0].t)} cy={geom.y(points[0].v)} r={4} fill={color} />
          )}
          {hover !== null && points[hover] && (
            <circle cx={geom.x(points[hover].t)} cy={geom.y(points[hover].v)} r={4.5}
              fill={color} stroke="#ffffff" strokeWidth={2} />
          )}
        </svg>
      )}
    </div>
  );
}

// ---------- stacked category bars (per day) ----------

interface DayBucket { day: string; values: Record<string, number>; total: number }

function StackedBars({ title, buckets, cats }: { title: string; buckets: DayBucket[]; cats: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560, H = 170, PL = 30, PR = 10, PT = 10, PB = 18;
  const max = Math.max(1, ...buckets.map(b => b.total));
  const bw = buckets.length > 0 ? (W - PL - PR) / buckets.length : 0;
  const colorFor = (cat: string) => {
    const i = cats.indexOf(cat);
    return i >= 0 && i < CAT_COLORS.length ? CAT_COLORS[i] : OTHER_COLOR;
  };

  return (
    <div className="bg-white rounded-xl shadow p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">{title}</span>
        {hover !== null && buckets[hover] && (
          <span className="text-xs text-gray-600">
            {buckets[hover].day}: <span className="font-semibold text-gray-800">{buckets[hover].total}</span>
            {' '}({Object.entries(buckets[hover].values).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ')})
          </span>
        )}
      </div>
      {buckets.length === 0 ? (
        <div className="h-24 flex items-center justify-center text-sm text-gray-400">No data</div>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
            <line x1={PL} x2={W - PR} y1={H - PB} y2={H - PB} stroke="#e5e7eb" strokeWidth={1} />
            <text x={PL - 5} y={PT + 4} textAnchor="end" fontSize={10} fill="#6b7280">{max}</text>
            <text x={PL - 5} y={H - PB + 3} textAnchor="end" fontSize={10} fill="#6b7280">0</text>
            {buckets.map((b, bi) => {
              let acc = 0;
              const x = PL + bi * bw + 1;
              const w = Math.max(2, bw - 2);
              return (
                <g key={b.day} onMouseEnter={() => setHover(bi)}>
                  {/* invisible full-height hit target */}
                  <rect x={PL + bi * bw} y={PT} width={bw} height={H - PT - PB} fill="transparent" />
                  {cats.map(cat => {
                    const v = b.values[cat] || 0;
                    if (v <= 0) return null;
                    const h = (v / max) * (H - PT - PB);
                    acc += h;
                    return (
                      <rect key={cat} x={x} y={H - PB - acc} width={w} height={Math.max(1, h - 0)}
                        fill={colorFor(cat)} stroke="#ffffff" strokeWidth={1} />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {cats.map(cat => (
              <span key={cat} className="flex items-center gap-1.5 text-xs text-gray-600">
                <span className="inline-block w-3 h-3 rounded-sm" style={{ backgroundColor: colorFor(cat) }} />
                {cat}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- counter sparkline card ----------

function CounterCard({ name, total, daily }: { name: string; total: number; daily: number[] }) {
  const W = 120, H = 28;
  const max = Math.max(1, ...daily);
  const bw = daily.length > 0 ? W / daily.length : 0;
  return (
    <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
      <p className="text-xs text-gray-500 truncate" title={name}>{name}</p>
      <div className="flex items-end justify-between gap-2 mt-1">
        <p className="text-xl font-bold text-gray-800">{total}</p>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-24 h-7 shrink-0">
          {daily.map((v, i) => (
            <rect key={i} x={i * bw + 0.5} width={Math.max(1, bw - 1)}
              y={H - (v / max) * H} height={Math.max(v > 0 ? 1 : 0, (v / max) * H)}
              fill="#4f46e5" />
          ))}
        </svg>
      </div>
    </div>
  );
}

// ---------- findings registry panel ----------

/**
 * Eval-findings registry (eval_findings table, migration 013): the durable home
 * for evaluator rules + their rationale. Read-only view here — editing lives in
 * the Test Lab. Independent of the story-metrics window, so it fetches on its
 * own and renders even when there are no metrics rows.
 */
const STATUS_BADGE: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  superseded: 'bg-amber-100 text-amber-700',
  rejected: 'bg-red-100 text-red-700',
};

function FindingsRegistryPanel() {
  const [findings, setFindings] = useState<EvalFinding[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    testlabService.listFindings()
      .then(data => { if (!cancelled) setFindings(data.findings || []); })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load findings'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Recent first (endpoint orders by category/slug for the Lab view).
  const sorted = useMemo(() =>
    [...findings].sort((a, b) => {
      const ta = a.updated_at ? new Date(a.updated_at).getTime() : 0;
      const tb = b.updated_at ? new Date(b.updated_at).getTime() : 0;
      return tb - ta;
    }),
  [findings]);

  const catCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const f of findings) {
      const cat = f.category || 'uncategorized';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [findings]);

  return (
    <div className="bg-white rounded-xl shadow overflow-hidden">
      <div className="px-6 py-4 border-b">
        <h3 className="font-semibold text-gray-800">Findings registry</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Durable eval findings (rule + rationale + evidence) — maintained in the Test Lab.
        </p>
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-sm text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-500 mr-2" />
          Loading findings…
        </div>
      ) : error ? (
        <div className="px-6 py-4 text-sm text-red-600">{error}</div>
      ) : findings.length === 0 ? (
        <div className="px-6 py-8 text-center text-sm text-gray-500">No findings recorded yet.</div>
      ) : (
        <>
          {/* per-category counts */}
          <div className="px-6 py-3 border-b bg-gray-50 flex flex-wrap gap-2">
            {catCounts.map(([cat, n]) => (
              <span key={cat} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white border border-gray-200 text-xs text-gray-700">
                {cat}
                <span className="font-semibold text-gray-900">{n}</span>
              </span>
            ))}
            <span className="inline-flex items-center px-2.5 py-1 text-xs text-gray-400 ml-auto">
              {findings.length} total
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Updated</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Slug</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Category</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Finding</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Prompt file</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sorted.map(f => {
                  const expanded = expandedSlug === f.slug;
                  return (
                    <tr
                      key={f.slug}
                      className="hover:bg-gray-50 cursor-pointer align-top"
                      onClick={() => setExpandedSlug(expanded ? null : f.slug)}
                      title={expanded ? 'Collapse' : 'Show rule + rationale'}
                    >
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{fmtDateCH(f.updated_at || f.created_at)}</td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-800 whitespace-nowrap">{f.slug}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{f.category || '—'}</td>
                      <td className="px-4 py-3 text-sm whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[f.status] || 'bg-gray-100 text-gray-600'}`}>
                          {f.status || '—'}
                        </span>
                        {f.superseded_by && (
                          <span className="ml-1.5 text-xs text-gray-400">→ {f.superseded_by}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-800">
                        <p className={expanded ? '' : 'line-clamp-2'}>{f.title || '—'}</p>
                        {expanded && (
                          <div className="mt-2 space-y-2 text-xs">
                            {f.rule_text && (
                              <p className="text-gray-700"><span className="font-semibold text-gray-500">Rule:</span> {f.rule_text}</p>
                            )}
                            <p className="text-gray-600 whitespace-pre-wrap"><span className="font-semibold text-gray-500">Rationale:</span> {f.rationale || '—'}</p>
                            {f.evidence && Object.keys(f.evidence).length > 0 && (
                              <p className="text-gray-500 font-mono break-all">
                                <span className="font-semibold font-sans">Evidence:</span> {JSON.stringify(f.evidence)}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {f.prompt_file || '—'}
                        {f.prompt_section && <span className="text-gray-400"> · {f.prompt_section}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- main tab ----------

export function StoryStatsTab() {
  const [rows, setRows] = useState<StoryMetricsRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(90);
  const [envFilter, setEnvFilter] = useState('');
  const [modeFilter, setModeFilter] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchMetrics = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await adminService.getStoryMetrics(days);
      setRows(data.rows || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load story metrics');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const envOptions = useMemo(() => Array.from(new Set(rows.map(r => r.environment).filter(Boolean))) as string[], [rows]);
  const modeOptions = useMemo(() => Array.from(new Set(rows.map(r => r.pipeline_mode).filter(Boolean))) as string[], [rows]);

  const filtered = useMemo(() => rows.filter(r =>
    (!envFilter || r.environment === envFilter) &&
    (!modeFilter || r.pipeline_mode === modeFilter)
  ), [rows, envFilter, modeFilter]);

  // trend points per metric (skip NULLs)
  const pointsFor = (pick: (r: StoryMetricsRow) => number | null): Pt[] =>
    filtered.flatMap(r => {
      const v = pick(r);
      const t = r.created_at ? new Date(r.created_at).getTime() : NaN;
      if (v === null || isNaN(t)) return [];
      return [{ t, v, label: fmtDateCH(r.created_at) }];
    });

  const scorePts = useMemo(() => pointsFor(r => num(r.mean_page_score)), [filtered]);
  // Per-page normalization so a 4-page smoke story is comparable to a 20-page one.
  // pages NULL/0 → null point (charts skip NULLs).
  const costPts = useMemo(() => pointsFor(r => {
    const v = num(r.cost_usd);
    const pages = num(r.pages);
    return v === null || !pages ? null : v / pages;
  }), [filtered]);
  const durationPts = useMemo(() => pointsFor(r => {
    const v = num(r.duration_s);
    const pages = num(r.pages);
    return v === null || !pages ? null : v / 60 / pages;
  }), [filtered]);
  const repairRatePts = useMemo(() => pointsFor(r => {
    const v = num(r.repair_rate);
    return v === null ? null : v * 100;
  }), [filtered]);
  const textChurnPts = useMemo(() => pointsFor(r => num(r.text_churn_pct)), [filtered]);
  const sceneChurnPts = useMemo(() => pointsFor(r => num(r.scene_churn_pct)), [filtered]);
  const beatsChurnPts = useMemo(() => pointsFor(r => num(r.beats_churn_pct)), [filtered]);
  const repairDeltaPts = useMemo(() => pointsFor(r => num(r.repair_delta_mean)), [filtered]);

  const scoreDomain = useMemo<[number, number] | undefined>(() => {
    if (scorePts.length === 0) return undefined;
    return [Math.min(70, Math.floor(Math.min(...scorePts.map(p => p.v)))), 100];
  }, [scorePts]);

  // findings-by-category stacked trend (bucketed per CH day)
  const { findingBuckets, findingCats } = useMemo(() => {
    const byDay = new Map<string, Record<string, number>>();
    const totals: Record<string, number> = {};
    for (const r of filtered) {
      const day = dayKeyCH(r.created_at);
      if (!day || !r.findings_by_category) continue;
      const bucket = byDay.get(day) || {};
      for (const [cat, v] of Object.entries(r.findings_by_category)) {
        const n = num(v as NumericField) || 0;
        if (n <= 0) continue;
        bucket[cat] = (bucket[cat] || 0) + n;
        totals[cat] = (totals[cat] || 0) + n;
      }
      byDay.set(day, bucket);
    }
    // fixed order by overall volume; top 7 keep their color, rest folds into "Other"
    const ordered = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const top = ordered.slice(0, CAT_COLORS.length);
    const fold = new Set(ordered.slice(CAT_COLORS.length));
    const cats = fold.size > 0 ? [...top, 'Other'] : top;
    const buckets: DayBucket[] = Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, values]) => {
        const folded: Record<string, number> = {};
        let total = 0;
        for (const [cat, v] of Object.entries(values)) {
          const key = fold.has(cat) ? 'Other' : cat;
          folded[key] = (folded[key] || 0) + v;
          total += v;
        }
        return { day, values: folded, total };
      });
    return { findingBuckets: buckets, findingCats: cats };
  }, [filtered]);

  // counters panel: dynamic keys, sum + per-day sums
  const { counterKeys, counterTotals, counterDaily, counterDays } = useMemo(() => {
    const totals: Record<string, number> = {};
    const byDay = new Map<string, Record<string, number>>();
    for (const r of filtered) {
      if (!r.counters) continue; // backfilled rows: NULL — expected
      const day = dayKeyCH(r.created_at) || 'unknown';
      const bucket = byDay.get(day) || {};
      for (const [k, v] of Object.entries(r.counters)) {
        const n = num(v as NumericField) || 0;
        if (n <= 0) continue;
        totals[k] = (totals[k] || 0) + n;
        bucket[k] = (bucket[k] || 0) + n;
      }
      byDay.set(day, bucket);
    }
    const dayList = Array.from(byDay.keys()).sort();
    const keys = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const daily: Record<string, number[]> = {};
    for (const k of keys) daily[k] = dayList.map(d => byDay.get(d)?.[k] || 0);
    return { counterKeys: keys, counterTotals: totals, counterDaily: daily, counterDays: dayList };
  }, [filtered]);

  // worst stories: lowest mean_page_score first, NULL scores excluded
  const worst = useMemo(() =>
    filtered
      .filter(r => num(r.mean_page_score) !== null)
      .sort((a, b) => (num(a.mean_page_score) as number) - (num(b.mean_page_score) as number))
      .slice(0, 15),
  [filtered]);

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch { /* clipboard unavailable */ }
  };

  if (isLoading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-500" />
        <span className="ml-3 text-gray-600">Loading story metrics…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded-lg">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header + filters */}
      <div className="flex flex-wrap justify-between items-center gap-3">
        <h2 className="text-xl font-bold text-gray-800">Story Stats</h2>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-2">
            {[30, 90, 365].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded-lg text-sm font-medium ${
                  days === d ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                {d} days
              </button>
            ))}
          </div>
          <select
            value={envFilter}
            onChange={(e) => setEnvFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm"
          >
            <option value="">All environments</option>
            {envOptions.map(env => <option key={env} value={env}>{env}</option>)}
          </select>
          <select
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value)}
            className="px-3 py-2 border rounded-lg text-sm"
          >
            <option value="">All modes</option>
            {modeOptions.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <Button variant="secondary" onClick={fetchMetrics} disabled={isLoading}>
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
            Refresh
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          No story metrics in this window. Rows appear once the collector runs (or after the backfill script).
        </div>
      ) : (
        <>
          <p className="text-sm text-gray-500">{filtered.length} stories in window</p>

          {/* Headline trends */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TrendChart title="Mean page score" points={scorePts} color="#4f46e5" fmt={fmtScore} yDomain={scoreDomain} />
            <TrendChart title="Cost / page (USD)" points={costPts} color="#059669" fmt={fmtCost} />
            <TrendChart title="Min / page" points={durationPts} color="#0284c7" fmt={fmtMin} />
            <TrendChart title="Repair rate" points={repairRatePts} color="#d97706" fmt={fmtPct} />
          </div>

          {/* Findings by category */}
          <StackedBars title="Findings by category (per day)" buckets={findingBuckets} cats={findingCats} />

          {/* Churn panel */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-2">Churn — how much did redo/repair actually change</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TrendChart title="Text churn (draft → final)" points={textChurnPts} color="#7c3aed" fmt={fmtPct} />
              <TrendChart title="Repair delta (score after − before)" points={repairDeltaPts} color="#e11d48" fmt={fmtDelta} />
              <TrendChart title="Scene churn" points={sceneChurnPts} color="#0d9488" fmt={fmtPct} />
              <TrendChart title="Beats churn" points={beatsChurnPts} color="#d97706" fmt={fmtPct} />
            </div>
          </div>

          {/* Counters panel */}
          <div className="bg-white rounded-xl shadow p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              Process counters
              {counterDays.length > 0 && <span className="ml-2 text-xs font-normal text-gray-400">(sum over window; sparkline per day)</span>}
            </h3>
            {counterKeys.length === 0 ? (
              <p className="text-sm text-gray-400">No counter data yet — backfilled rows have no runtime counters; new stories record them.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {counterKeys.map(k => (
                  <CounterCard key={k} name={k} total={counterTotals[k]} daily={counterDaily[k]} />
                ))}
              </div>
            )}
          </div>

          {/* Worst stories */}
          <div className="bg-white rounded-xl shadow overflow-hidden">
            <div className="px-6 py-4 border-b">
              <h3 className="font-semibold text-gray-800">Worst stories (lowest mean page score)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Story ID</th>
                    <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Created</th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Score</th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Pages &lt; 80</th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Pages</th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Cost</th>
                    <th className="px-4 py-3 text-right text-sm font-semibold text-gray-700">Cost / page</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {worst.map(r => {
                    const score = num(r.mean_page_score);
                    const cost = num(r.cost_usd);
                    const pages = num(r.pages);
                    const costPerPage = cost !== null && pages ? cost / pages : null;
                    return (
                      <tr key={r.story_id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-mono text-gray-800">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate max-w-[220px]" title={r.story_id}>{r.story_id}</span>
                            <button
                              onClick={() => copyId(r.story_id)}
                              className="text-gray-400 hover:text-indigo-500"
                              title="Copy story ID"
                            >
                              {copiedId === r.story_id ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                            </button>
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">{fmtDateCH(r.created_at)}</td>
                        <td className={`px-4 py-3 text-sm text-right font-semibold ${score !== null && score < 80 ? 'text-red-600' : 'text-gray-800'}`}>
                          {score !== null ? score.toFixed(1) : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">{r.pages_below_80 ?? '—'}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">{pages ?? '—'}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">{cost !== null ? fmtCost(cost) : '—'}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600">{costPerPage !== null ? fmtCost(costPerPage) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Findings registry — independent of the story-metrics window */}
      <FindingsRegistryPanel />
    </div>
  );
}
