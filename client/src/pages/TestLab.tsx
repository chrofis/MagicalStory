/**
 * Test Lab — admin prompt-regression tooling (/admin/test-lab).
 *
 * Tabs:
 *  - Stories: cross-user recent stories, open read-only (no impersonation),
 *    add pages to the benchmark set.
 *  - Benchmark: the curated reference pages used for A/B runs.
 *  - Experiments: run one pipeline stage against benchmark pages with the
 *    current templates or a prompt-override variant; compare baseline vs
 *    variant side-by-side with eval scores; promote a test image if wanted.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, RefreshCw, Trash2, ExternalLink, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/common/Button';
import {
  testlabService,
  TESTLAB_STAGES,
  type TestLabStory,
  type TestLabPagination,
  type BenchmarkScene,
  type ExperimentSummary,
  type ExperimentDetail,
  type ExperimentResult,
} from '@/services/testlabService';

type Tab = 'stories' | 'benchmark' | 'experiments';

const tabBtn = (active: boolean) =>
  `px-4 py-2 rounded-lg font-medium transition-colors ${active ? 'bg-indigo-500 text-white' : 'bg-white text-gray-700 hover:bg-gray-100'}`;

export default function TestLab() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('stories');

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <FlaskConical className="text-indigo-500" size={28} /> Test Lab
          </h1>
          <Button variant="secondary" size="sm" onClick={() => navigate('/admin')}>Admin Dashboard</Button>
        </div>

        <div className="flex gap-2 mb-6">
          <button className={tabBtn(tab === 'stories')} onClick={() => setTab('stories')}>Stories</button>
          <button className={tabBtn(tab === 'benchmark')} onClick={() => setTab('benchmark')}>Benchmark</button>
          <button className={tabBtn(tab === 'experiments')} onClick={() => setTab('experiments')}>Experiments</button>
        </div>

        {tab === 'stories' && <StoriesTab />}
        {tab === 'benchmark' && <BenchmarkTab />}
        {tab === 'experiments' && <ExperimentsTab />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Stories tab
// ─────────────────────────────────────────────────────────────────────

function StoriesTab() {
  const [stories, setStories] = useState<TestLabStory[]>([]);
  const [pagination, setPagination] = useState<TestLabPagination | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [artStyle, setArtStyle] = useState('');
  const [days, setDays] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await testlabService.getStories({
        page,
        limit: 25,
        search: search || undefined,
        artStyle: artStyle || undefined,
        days: days ? parseInt(days, 10) : undefined,
      });
      setStories(res.stories);
      setPagination(res.pagination);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load stories');
    } finally {
      setLoading(false);
    }
  }, [page, search, artStyle, days]);

  useEffect(() => { load(); }, [load]);

  const addToBenchmark = async (story: TestLabStory) => {
    const pageStr = window.prompt(`Add which page of "${story.title || story.id}" to the benchmark? (1-${story.pages})`);
    if (!pageStr) return;
    const pageNum = parseInt(pageStr, 10);
    if (!Number.isFinite(pageNum) || pageNum < 1) return;
    const label = window.prompt('Optional label for this benchmark entry:') || undefined;
    try {
      await testlabService.addBenchmark(story.id, pageNum, label);
      alert(`Added ${story.title || story.id} P${pageNum} to benchmark.`);
      load();
    } catch (e) {
      alert(`Failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
      <div className="p-4 border-b bg-gray-50 flex flex-wrap gap-2 items-center">
        <input
          className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-48"
          placeholder="Search title or user email…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
        />
        <input
          className="border rounded-lg px-3 py-2 text-sm w-36"
          placeholder="Art style"
          value={artStyle}
          onChange={e => { setArtStyle(e.target.value); setPage(1); }}
        />
        <select className="border rounded-lg px-3 py-2 text-sm" value={days} onChange={e => { setDays(e.target.value); setPage(1); }}>
          <option value="">All time</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
        <Button variant="secondary" size="sm" onClick={load}><RefreshCw size={14} /></Button>
      </div>

      {error && <div className="p-4 text-red-600 text-sm">{error}</div>}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Title</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">User</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Style</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Type</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Lang</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Pages</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Created</th>
              <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {stories.map(s => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium">
                  {s.title || <span className="text-gray-400 italic">untitled</span>}
                  {s.hasBenchmark && <span className="ml-2 bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full">benchmark</span>}
                </td>
                <td className="px-4 py-3 text-sm text-gray-600">{s.userEmail || s.username}</td>
                <td className="px-4 py-3 text-sm">{s.artStyle}</td>
                <td className="px-4 py-3 text-sm">{s.storyType}</td>
                <td className="px-4 py-3 text-sm">{s.language}</td>
                <td className="px-4 py-3 text-sm">{s.pages}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{new Date(s.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-sm">
                  <div className="flex gap-2">
                    <Button variant="secondary" size="sm" onClick={() => window.open(`/create?storyId=${s.id}`, '_blank')}>
                      <ExternalLink size={14} /> Open
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => addToBenchmark(s)}>
                      <Plus size={14} /> Benchmark
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!loading && stories.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400 text-sm">No stories found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="p-4 border-t bg-gray-50 flex justify-center items-center gap-2">
          <Button variant="secondary" size="sm" disabled={!pagination.hasPrevPage} onClick={() => setPage(p => p - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span className="text-sm text-gray-600">Page {pagination.page} of {pagination.totalPages}</span>
          <Button variant="secondary" size="sm" disabled={!pagination.hasNextPage} onClick={() => setPage(p => p + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Benchmark tab
// ─────────────────────────────────────────────────────────────────────

function BenchmarkTab() {
  const [benchmarks, setBenchmarks] = useState<BenchmarkScene[]>([]);
  const [previews, setPreviews] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await testlabService.getBenchmarks();
      setBenchmarks(res.benchmarks);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load benchmarks');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadPreview = async (b: BenchmarkScene) => {
    try {
      const res = await testlabService.getBaselineImage(b.storyId, b.pageNumber);
      setPreviews(p => ({ ...p, [b.id]: res.imageData }));
    } catch {
      setPreviews(p => ({ ...p, [b.id]: '' }));
    }
  };

  const remove = async (b: BenchmarkScene) => {
    if (!window.confirm(`Remove benchmark "${b.label || `${b.storyTitle} P${b.pageNumber}`}"?`)) return;
    await testlabService.deleteBenchmark(b.id);
    load();
  };

  return (
    <div className="space-y-4">
      {error && <div className="p-4 text-red-600 text-sm bg-white rounded-2xl shadow">{error}</div>}
      {benchmarks.length === 0 && (
        <div className="bg-white rounded-2xl shadow-lg p-8 text-center text-gray-500 text-sm">
          No benchmark entries yet. Add pages from the Stories tab — pick a diverse set
          (different art styles, story types, character counts) so prompt changes are
          validated broadly, not on one story.
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {benchmarks.map(b => (
          <div key={b.id} className="bg-white rounded-2xl shadow-lg p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold text-sm">{b.label || `${b.storyTitle || b.storyId} — P${b.pageNumber}`}</div>
                <div className="text-xs text-gray-500 mt-1">{b.storyTitle} · Page {b.pageNumber}</div>
              </div>
              <button className="text-gray-400 hover:text-red-500" onClick={() => remove(b)} title="Remove">
                <Trash2 size={16} />
              </button>
            </div>
            <div className="flex flex-wrap gap-1 mt-2">
              {b.tags.artStyle && <span className="bg-indigo-50 text-indigo-700 text-xs px-2 py-0.5 rounded-full">{b.tags.artStyle}</span>}
              {b.tags.storyType && <span className="bg-emerald-50 text-emerald-700 text-xs px-2 py-0.5 rounded-full">{b.tags.storyType}</span>}
              {b.tags.language && <span className="bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded-full">{b.tags.language}</span>}
              {typeof b.tags.characterCount === 'number' && <span className="bg-amber-50 text-amber-700 text-xs px-2 py-0.5 rounded-full">{b.tags.characterCount} chars</span>}
              {b.tags.hasLandmark && <span className="bg-sky-50 text-sky-700 text-xs px-2 py-0.5 rounded-full">landmark</span>}
            </div>
            <div className="mt-3">
              {previews[b.id] === undefined ? (
                <button className="text-xs text-indigo-600 hover:underline" onClick={() => loadPreview(b)}>Load preview</button>
              ) : previews[b.id] ? (
                <img src={previews[b.id]} alt={`P${b.pageNumber}`} className="rounded-lg w-full" />
              ) : (
                <span className="text-xs text-gray-400">Preview unavailable</span>
              )}
            </div>
            {b.snapshot?.sceneText && (
              <p className="text-xs text-gray-500 mt-2 line-clamp-3">{b.snapshot.sceneText}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Experiments tab
// ─────────────────────────────────────────────────────────────────────

function ExperimentsTab() {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkScene[]>([]);
  const [selected, setSelected] = useState<ExperimentDetail | null>(null);

  // New-experiment form state
  const [stage, setStage] = useState<string>('image');
  const [label, setLabel] = useState('');
  const [selectedBench, setSelectedBench] = useState<number[]>([]);
  const [override, setOverride] = useState('');
  const [autoEval, setAutoEval] = useState(true);
  const [charName, setCharName] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stageInfo = TESTLAB_STAGES.find(s => s.id === stage);

  const load = useCallback(async () => {
    try {
      const [exps, bench] = await Promise.all([testlabService.getExperiments(), testlabService.getBenchmarks()]);
      setExperiments(exps.experiments);
      setBenchmarks(bench.benchmarks);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll while any experiment is running (or the detail view shows a running one).
  useEffect(() => {
    const anyRunning = experiments.some(e => e.status === 'running') || selected?.status === 'running';
    if (!anyRunning) return;
    const t = setInterval(async () => {
      load();
      if (selected) {
        try { setSelected(await testlabService.getExperiment(selected.id)); } catch { /* keep last */ }
      }
    }, 5000);
    return () => clearInterval(t);
  }, [experiments, selected, load]);

  const loadTemplate = async () => {
    try {
      const res = await testlabService.getTemplates();
      const tpl = res.templates[stage];
      if (tpl) setOverride(tpl);
      else alert('No overridable template for this stage.');
    } catch (e) {
      alert(`Failed to load template: ${e instanceof Error ? e.message : e}`);
    }
  };

  const start = async () => {
    if (selectedBench.length === 0) { alert('Select at least one benchmark target.'); return; }
    if (stage === 'char_repair' && !charName.trim()) { alert('Character repair needs a character name.'); return; }
    setStarting(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { autoEval };
      if (stage === 'char_repair') params.characterName = charName.trim();
      const res = await testlabService.createExperiment({
        stage,
        label: label || undefined,
        promptOverride: override.trim() ? override : null,
        params,
        benchmarkIds: selectedBench,
      });
      setLabel('');
      await load();
      setSelected(await testlabService.getExperiment(res.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start experiment');
    } finally {
      setStarting(false);
    }
  };

  if (selected) {
    return <ExperimentDetailView detail={selected} onBack={() => { setSelected(null); load(); }} onRefresh={async () => setSelected(await testlabService.getExperiment(selected.id))} />;
  }

  return (
    <div className="space-y-6">
      {/* New experiment */}
      <div className="bg-white rounded-2xl shadow-lg p-6">
        <h2 className="font-semibold text-gray-900 mb-4">New experiment</h2>
        {error && <div className="text-red-600 text-sm mb-3">{error}</div>}
        <div className="flex flex-wrap gap-3 items-center mb-4">
          <select className="border rounded-lg px-3 py-2 text-sm" value={stage} onChange={e => { setStage(e.target.value); setOverride(''); }}>
            {TESTLAB_STAGES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <input
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-48"
            placeholder="Label (e.g. 'calm-zone wording v2')"
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
          {stage === 'image' && (
            <label className="text-sm flex items-center gap-1.5">
              <input type="checkbox" checked={autoEval} onChange={e => setAutoEval(e.target.checked)} />
              Auto-eval result
            </label>
          )}
          {stage === 'char_repair' && (
            <input
              className="border rounded-lg px-3 py-2 text-sm w-44"
              placeholder="Character name"
              value={charName}
              onChange={e => setCharName(e.target.value)}
            />
          )}
        </div>

        <div className="mb-4">
          <div className="text-sm font-medium text-gray-700 mb-2">Targets (benchmark pages)</div>
          {benchmarks.length === 0 && <div className="text-sm text-gray-400">No benchmark entries yet — add some in the Benchmark tab.</div>}
          <div className="flex flex-wrap gap-2">
            {benchmarks.map(b => (
              <label key={b.id} className={`text-xs px-3 py-1.5 rounded-full border cursor-pointer ${selectedBench.includes(b.id) ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-white text-gray-700 hover:bg-gray-50'}`}>
                <input
                  type="checkbox"
                  className="hidden"
                  checked={selectedBench.includes(b.id)}
                  onChange={e => setSelectedBench(prev => e.target.checked ? [...prev, b.id] : prev.filter(id => id !== b.id))}
                />
                {b.label || `${b.storyTitle || b.storyId} P${b.pageNumber}`} {b.tags.artStyle ? `· ${b.tags.artStyle}` : ''}
              </label>
            ))}
          </div>
          {benchmarks.length > 0 && (
            <button
              className="text-xs text-indigo-600 hover:underline mt-2"
              onClick={() => setSelectedBench(selectedBench.length === benchmarks.length ? [] : benchmarks.map(b => b.id))}
            >
              {selectedBench.length === benchmarks.length ? 'Deselect all' : 'Select all'}
            </button>
          )}
        </div>

        {stageInfo?.overridable && (
          <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-gray-700">Prompt override (empty = current template)</div>
              <button className="text-xs text-indigo-600 hover:underline" onClick={loadTemplate}>Load current template</button>
            </div>
            <textarea
              className="border rounded-lg px-3 py-2 text-xs font-mono w-full h-48"
              placeholder="Leave empty to run with the templates currently deployed. Paste + edit the current template here for an A/B variant."
              value={override}
              onChange={e => setOverride(e.target.value)}
            />
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={start} disabled={starting || selectedBench.length === 0}>
            {starting ? 'Starting…' : `Run on ${selectedBench.length} page(s)`}
          </Button>
          {stageInfo?.producesImage && (
            <span className="text-xs text-gray-500">
              Generates {selectedBench.length} image(s) — results stored as test versions, invisible to users.
            </span>
          )}
        </div>
      </div>

      {/* Experiment list */}
      <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
        <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Past experiments</h2>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw size={14} /></Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">#</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Stage</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Label</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Override</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Progress</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Status</th>
                <th className="px-4 py-3 text-left text-sm font-semibold text-gray-700">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {experiments.map(e => (
                <tr key={e.id} className="hover:bg-gray-50 cursor-pointer" onClick={async () => setSelected(await testlabService.getExperiment(e.id))}>
                  <td className="px-4 py-3 text-sm">{e.id}</td>
                  <td className="px-4 py-3 text-sm">{e.stage}</td>
                  <td className="px-4 py-3 text-sm">{e.label || <span className="text-gray-400">—</span>}</td>
                  <td className="px-4 py-3 text-sm">{e.hasOverride ? 'A/B variant' : 'current'}</td>
                  <td className="px-4 py-3 text-sm">{e.doneCount}/{e.targetCount}</td>
                  <td className="px-4 py-3 text-sm">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${e.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : e.status === 'running' ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                      {e.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{new Date(e.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {experiments.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400 text-sm">No experiments yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Experiment detail — baseline vs variant grid
// ─────────────────────────────────────────────────────────────────────

function ExperimentDetailView({ detail, onBack, onRefresh }: { detail: ExperimentDetail; onBack: () => void; onRefresh: () => void }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const [redoOverride, setRedoOverride] = useState('');
  const [showRedoOverride, setShowRedoOverride] = useState(false);
  const [redoing, setRedoing] = useState<number | null>(null);

  const redo = async (index: number) => {
    setRedoing(index);
    try {
      await testlabService.redo(detail.id, index, redoOverride.trim() || undefined);
      onRefresh();
    } catch (e) {
      alert(`Redo failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setRedoing(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-lg p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">
              Experiment #{detail.id} — {detail.stage} {detail.label ? `· ${detail.label}` : ''}
            </h2>
            <div className="text-sm text-gray-500 mt-1">
              {detail.status} · {detail.results.length}/{detail.targets.length} targets ·
              {detail.promptOverride ? ' A/B prompt variant' : ' current templates'} · by {detail.createdBy}
            </div>
          </div>
          <div className="flex gap-2">
            {detail.status === 'running' && <Button variant="secondary" size="sm" onClick={onRefresh}><RefreshCw size={14} /></Button>}
            <Button variant="secondary" size="sm" onClick={onBack}>Back</Button>
          </div>
        </div>
        {detail.error && <div className="text-red-600 text-sm mt-2">{detail.error}</div>}
        {detail.promptOverride && (
          <div className="mt-3">
            <button className="text-xs text-indigo-600 hover:underline" onClick={() => setShowPrompt(v => !v)}>
              {showPrompt ? 'Hide' : 'Show'} prompt override
            </button>
            {showPrompt && <pre className="mt-2 text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64">{detail.promptOverride}</pre>}
          </div>
        )}
        <div className="mt-3">
          <button className="text-xs text-indigo-600 hover:underline" onClick={() => setShowRedoOverride(v => !v)}>
            {showRedoOverride ? 'Hide' : 'Set'} prompt override for redos
          </button>
          {showRedoOverride && (
            <textarea
              className="border rounded-lg px-3 py-2 text-xs font-mono w-full h-40 mt-2"
              placeholder="Paste + edit a prompt here, then hit Redo on any result below — it reruns that single unit with this prompt. Empty = redo with the current templates."
              value={redoOverride}
              onChange={e => setRedoOverride(e.target.value)}
            />
          )}
        </div>
      </div>

      {detail.results.map((r, i) => (
        <ResultCard key={`${r.storyId}-${r.pageNumber}-${i}`} result={r} stage={detail.stage}
          onRedo={() => redo(i)} redoing={redoing === i} />
      ))}
      {detail.status === 'running' && (
        <div className="bg-white rounded-2xl shadow-lg p-6 text-center text-sm text-gray-500">
          Running… next target in progress (auto-refreshes every 5s)
        </div>
      )}
    </div>
  );
}

function ResultCard({ result, stage, onRedo, redoing }: { result: ExperimentResult; stage: string; onRedo?: () => void; redoing?: boolean }) {
  const [baseline, setBaseline] = useState<string | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const producesImage = result.versionIndex !== undefined && result.imageType;
  // Avatar-sheet entries (stage 'avatars') have no page; "baseline" is the
  // realistic pass-1 sheet instead of a story page. Pass-1 entries have no
  // baseline at all — the anchor IS the result.
  const isAvatar = result.imageType === 'tl_avatar';
  const isPass1 = isAvatar && (result as { pass?: number }).pass === 1;
  const hasPage = typeof result.pageNumber === 'number';

  const loadImages = async () => {
    setLoaded(true);
    try {
      if (isAvatar) {
        if (result.realisticVersionIndex != null) {
          const base = await testlabService.getTestImage(result.storyId, 'tl_avatar', null, result.realisticVersionIndex);
          setBaseline(base.imageData);
        } else {
          setBaseline('');
        }
      } else if (hasPage) {
        const base = await testlabService.getBaselineImage(result.storyId, result.pageNumber);
        setBaseline(base.imageData);
      } else {
        setBaseline('');
      }
    } catch { setBaseline(''); }
    if (producesImage) {
      try {
        const v = await testlabService.getTestImage(result.storyId, result.imageType!, isAvatar ? null : result.pageNumber, result.versionIndex!);
        setVariant(v.imageData);
      } catch { setVariant(''); }
    }
  };

  const promote = async () => {
    if (!producesImage || result.imageType !== 'scene') return;
    if (!window.confirm(`Promote this test image into the story's real version list and set it active (pinned)? The story owner will see it.`)) return;
    try {
      await testlabService.promote(result.storyId, result.pageNumber, result.versionIndex!);
      setPromoted(true);
    } catch (e) {
      alert(`Promote failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-lg p-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm font-semibold">
          {result.character ? result.character : `${result.storyId} · P${result.pageNumber}`}
          {result.artStyle && <span className="ml-2 bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full">{result.artStyle}</span>}
          {!result.ok && <span className="ml-2 bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">failed</span>}
          {promoted && <span className="ml-2 bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded-full">promoted</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {onRedo && (
            <Button variant="secondary" size="sm" onClick={onRedo} disabled={redoing}>
              {redoing ? 'Redoing…' : 'Redo'}
            </Button>
          )}
          {result.elapsedMs !== undefined && <span>{(result.elapsedMs / 1000).toFixed(1)}s</span>}
          {result.modelId && <span>{result.modelId}</span>}
          {result.scores?.final != null && <span className="font-semibold text-gray-700">final {result.scores.final}</span>}
          {result.scores?.quality != null && <span>quality {result.scores.quality}</span>}
          {result.scores?.semantic != null && <span>semantic {result.scores.semantic}</span>}
          {result.scores?.verdict && <span>{result.scores.verdict}</span>}
        </div>
      </div>

      {!result.ok && <div className="text-sm text-red-600 mt-2">{result.error}</div>}

      {result.ok && (
        <>
          {result.storedBaseline && (
            <div className="text-xs text-gray-500 mt-1">
              Stored baseline scores: quality {result.storedBaseline.qualityScore ?? '—'} · semantic {result.storedBaseline.semanticScore ?? '—'}
            </div>
          )}

          {!loaded ? (
            <button className="text-xs text-indigo-600 hover:underline mt-3" onClick={loadImages}>
              {isAvatar ? 'Load avatar sheets' : producesImage ? 'Load baseline vs variant' : 'Load page image'}
            </button>
          ) : (
            <div className={`grid gap-4 mt-3 ${producesImage && !isPass1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
              {!isPass1 && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">{isAvatar ? 'Realistic anchor (pass 1)' : 'Baseline (active version)'}</div>
                  {baseline ? <img src={baseline} alt="baseline" className="rounded-lg w-full" /> : <div className="text-xs text-gray-400">unavailable</div>}
                </div>
              )}
              {producesImage && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">{isPass1 ? `Realistic anchor (pass 1, test v${result.versionIndex})` : isAvatar ? `Styled sheet (pass 2, test v${result.versionIndex})` : `Variant (test v${result.versionIndex})`}</div>
                  {variant ? <img src={variant} alt="variant" className="rounded-lg w-full" /> : <div className="text-xs text-gray-400">unavailable</div>}
                  {result.imageType === 'scene' && !promoted && (
                    <div className="mt-2">
                      <Button variant="secondary" size="sm" onClick={promote}>Promote to story</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {(result.issuesSummary || result.semanticIssues?.length || result.figures?.length || result.report || result.fixableIssues?.length || result.promptUsed) && (
            <div className="mt-3">
              <button className="text-xs text-indigo-600 hover:underline" onClick={() => setShowDetails(v => !v)}>
                {showDetails ? 'Hide' : 'Show'} details
              </button>
              {showDetails && (
                <div className="mt-2 space-y-2">
                  {result.issuesSummary && <div className="text-xs text-gray-600"><b>Issues:</b> {result.issuesSummary}</div>}
                  {!!result.semanticIssues?.length && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(result.semanticIssues, null, 2)}</pre>
                  )}
                  {!!result.fixableIssues?.length && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(result.fixableIssues, null, 2)}</pre>
                  )}
                  {stage === 'bbox' && (result.figures || result.objects) && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify({ backend: result.detectionBackend, figures: result.figures, objects: result.objects }, null, 2)}</pre>
                  )}
                  {stage === 'entity' && result.report != null && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64">{JSON.stringify(result.report, null, 2)}</pre>
                  )}
                  {result.promptUsed && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-indigo-600">Prompt sent</summary>
                      <pre className="bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64 mt-1">{result.promptUsed}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
