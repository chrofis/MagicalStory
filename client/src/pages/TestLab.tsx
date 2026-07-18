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
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/** Banner when a new deploy landed while this tab was open — stale SPA
 * bundles caused repeated "I can't see the new feature" confusion. */
function NewVersionBanner() {
  const [newVersion, setNewVersion] = useState(false);
  useEffect(() => {
    let initial: string | null = null;
    const check = async () => {
      try {
        const h = await (await fetch('/api/health')).json();
        if (!h?.commit) return;
        if (initial === null) initial = h.commit;
        else if (h.commit !== initial) setNewVersion(true);
      } catch { /* offline — ignore */ }
    };
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);
  if (!newVersion) return null;
  return (
    <div className="bg-amber-500 text-white rounded-lg px-4 py-2 mb-4 flex items-center justify-between">
      <span className="text-sm font-medium">A new version was deployed — this tab is running old code.</span>
      <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>Reload now</Button>
    </div>
  );
}

export default function TestLab() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('stories');

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        <NewVersionBanner />
        <LightboxHost />
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
  const [repairBackend, setRepairBackend] = useState('grok');
  const [compareAll, setCompareAll] = useState(false);
  const [whiteoutTarget, setWhiteoutTarget] = useState('face');
  const [freshDetection, setFreshDetection] = useState(false);
  const [paramsJson, setParamsJson] = useState('');
  const [storyIdInput, setStoryIdInput] = useState('');
  const [coverType, setCoverType] = useState('frontCover');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stageInfo = TESTLAB_STAGES.find(s => s.id === stage);
  const isStoryLevel = !!(stageInfo as { storyLevel?: boolean } | undefined)?.storyLevel;
  const isCharacterLevel = !!(stageInfo as { characterLevel?: boolean } | undefined)?.characterLevel;
  const needsCharacter = stage === 'char_repair' || stage === 'qwen_insert' || isCharacterLevel;
  // Characters on the selected benchmark pages (from their snapshots).
  const charOptions = [...new Set(
    benchmarks
      .filter(b => selectedBench.includes(b.id))
      .flatMap(b => b.snapshot?.characterNames || [])
  )];
  // How many targets the Run button would fire on.
  const targetCount = isStoryLevel || isCharacterLevel
    ? (storyIdInput.trim() ? 1 : [...new Set(benchmarks.filter(b => selectedBench.includes(b.id)).map(b => b.storyId))].length)
    : selectedBench.length;
  const canStart = targetCount > 0 && (!needsCharacter || !!charName.trim());

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
    // Story-level and character-level stages take story targets (from the
    // input or the selected benchmarks' stories); page stages take pages.
    let storyTargets: { storyId: string; coverType?: string; character?: string }[] = [];
    if (isStoryLevel || isCharacterLevel) {
      const ids = storyIdInput.trim()
        ? [storyIdInput.trim()]
        : [...new Set(benchmarks.filter(b => selectedBench.includes(b.id)).map(b => b.storyId))];
      if (ids.length === 0) { alert('Enter a story ID or select benchmark pages (their stories are used).'); return; }
      storyTargets = ids.map(id => {
        if (stage === 'cover') return { storyId: id, coverType };
        if (isCharacterLevel) return { storyId: id, character: charName.trim() };
        return { storyId: id };
      });
    } else if (selectedBench.length === 0) {
      alert('Select at least one benchmark target.'); return;
    }
    if (needsCharacter && !charName.trim()) { alert('This stage needs a character — pick one from the dropdown.'); return; }
    setStarting(true);
    setError(null);
    try {
      let params: Record<string, unknown> = { autoEval };
      if (needsCharacter) params.characterName = charName.trim();
      if (stage === 'char_repair') {
        if (compareAll) {
          // ONE experiment: fresh detection first, then every engine/mode as
          // Options A–F against the same fresh boxes.
          params.rerunDetection = true;
          // Every option runs through the shared SAM-union blend (mandatory).
          params.variants = [
            { label: 'A: Grok crosshatch', params: { backend: 'grok', repairMode: 'fullscene' } },
            { label: 'B: Grok crop-input', params: { backend: 'grok', repairMode: 'cutout' } },
            { label: 'C: Grok blended face', params: { backend: 'grok', repairMode: 'blended', whiteoutTarget: 'face' } },
            { label: 'D: Grok blended body', params: { backend: 'grok', repairMode: 'blended', whiteoutTarget: 'body' } },
            { label: 'E: Gemini repaint', params: { backend: 'gemini', repairMode: 'auto' } },
            { label: 'F: Qwen whiteout', params: { backend: 'qwen' } },
          ];
        } else {
          params.backend = repairBackend;
          if (repairBackend === 'grok' || repairBackend === 'qwen') params.whiteoutTarget = whiteoutTarget;
          if (freshDetection) params.freshDetection = true;
        }
      }
      if (stage === 'qwen_insert' && freshDetection) params.freshDetection = true;
      if (stage === 'cover') params.coverType = coverType;
      if (paramsJson.trim()) {
        try { params = { ...params, ...JSON.parse(paramsJson) }; }
        catch { alert('Params JSON is not valid JSON.'); setStarting(false); return; }
      }
      const res = await testlabService.createExperiment({
        stage,
        label: label || undefined,
        promptOverride: override.trim() ? override : null,
        params,
        ...(isStoryLevel || isCharacterLevel ? { targets: storyTargets } : { benchmarkIds: selectedBench }),
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
          {needsCharacter && (charOptions.length > 0 ? (
            <select
              className="border rounded-lg px-3 py-2 text-sm w-44"
              value={charName}
              onChange={e => setCharName(e.target.value)}
            >
              <option value="">Character…</option>
              {charOptions.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          ) : (
            <input
              className="border rounded-lg px-3 py-2 text-sm w-44"
              placeholder="Character name (select target pages first)"
              value={charName}
              onChange={e => setCharName(e.target.value)}
            />
          ))}
          {stage === 'char_repair' && (
            <>
              <label className="text-sm flex items-center gap-1.5 font-medium text-indigo-700">
                <input type="checkbox" checked={compareAll} onChange={e => setCompareAll(e.target.checked)} />
                Compare ALL engines (fresh detection + Options A–F, one experiment)
              </label>
              <label className="text-sm flex items-center gap-1.5">
                Engine
                <select className="border rounded-lg px-3 py-2 text-sm" value={repairBackend} onChange={e => setRepairBackend(e.target.value)}>
                  <option value="grok">Grok (blended)</option>
                  <option value="gemini">Gemini</option>
                  <option value="qwen">Qwen (crop insert)</option>
                </select>
              </label>
              {(repairBackend === 'grok' || repairBackend === 'qwen') && (
                <label className="text-sm flex items-center gap-1.5">
                  Repair
                  <select className="border rounded-lg px-3 py-2 text-sm" value={whiteoutTarget} onChange={e => setWhiteoutTarget(e.target.value)}>
                    <option value="face">Face only</option>
                    <option value="body">Whole figure</option>
                  </select>
                </label>
              )}
            </>
          )}
          {(stage === 'char_repair' || stage === 'qwen_insert') && (
            <label className="text-sm flex items-center gap-1.5">
              <input type="checkbox" checked={freshDetection} onChange={e => setFreshDetection(e.target.checked)} />
              Re-detect character (ignore stored box)
            </label>
          )}
          {stage === 'cover' && (
            <select className="border rounded-lg px-3 py-2 text-sm" value={coverType} onChange={e => setCoverType(e.target.value)}>
              <option value="frontCover">Front cover</option>
              <option value="initialPage">Initial page</option>
              <option value="backCover">Back cover</option>
            </select>
          )}
          {(isStoryLevel || isCharacterLevel) && (
            <input
              className="border rounded-lg px-3 py-2 text-sm w-72"
              placeholder="Story ID (empty = selected benchmarks' stories)"
              value={storyIdInput}
              onChange={e => setStoryIdInput(e.target.value)}
            />
          )}
        </div>
        <div className="mb-4">
          <input
            className="border rounded-lg px-3 py-2 text-sm w-full font-mono"
            placeholder={stage === 'qwen_insert'
              ? 'Params JSON — e.g. {"crop":{"x":0.1,"y":0.5,"w":0.3,"h":0.45},"pose":"standing on the grass, arms raised","base":"empty_scene"}'
              : 'Params JSON (optional — extra stage parameters)'}
            value={paramsJson}
            onChange={e => setParamsJson(e.target.value)}
          />
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
              <div className="text-sm font-medium text-gray-700">
                {(stageInfo as { noTemplate?: boolean }).noTemplate ? 'Instruction text' : 'Prompt override (empty = current template)'}
              </div>
              {!(stageInfo as { noTemplate?: boolean }).noTemplate && (
                <button className="text-xs text-indigo-600 hover:underline" onClick={loadTemplate}>Load current template</button>
              )}
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
          <Button onClick={start} disabled={starting || !canStart}>
            {starting ? 'Starting…' : `Run on ${targetCount} target(s)`}
          </Button>
          <span className="text-xs text-gray-500">
            {stageInfo?.producesImage
              ? `~$${(targetCount * 0.05).toFixed(2)} est. (${targetCount} × image gen + eval) — stored as test versions, invisible to users.`
              : `~$${(targetCount * 0.01).toFixed(2)} est. (LLM/eval only, no images saved to the story).`}
          </span>
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
  // index -> number of redo entries we expect to see before the spinner stops
  const [pendingRedos, setPendingRedos] = useState<Record<number, number>>({});

  const countRedos = (results: ExperimentResult[], index: number) =>
    results.filter(r => r.redoOf === index).length;

  const redo = async (index: number) => {
    try {
      // Empty textarea on an A/B experiment would silently reuse the stored
      // override — pass useCurrentTemplates so "empty = current templates"
      // actually holds, matching the placeholder text.
      const text = redoOverride.trim();
      // scene_variant: the redo textarea is the NEXT RULE attempt (appended
      // to the current template), not a full template override.
      if (detail.stage === 'scene_variant') {
        await testlabService.redo(detail.id, index, undefined, false, text || undefined);
      } else {
        await testlabService.redo(detail.id, index, text || undefined, !text && !!detail.promptOverride);
      }
      setPendingRedos(p => ({ ...p, [index]: countRedos(detail.results, index) + 1 }));
    } catch (e) {
      alert(`Redo failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  // Poll while any redo is in flight; clear pendings once their entry lands.
  useEffect(() => {
    if (Object.keys(pendingRedos).length === 0) return;
    const t = setInterval(onRefresh, 5000);
    return () => clearInterval(t);
  }, [pendingRedos, onRefresh]);
  useEffect(() => {
    setPendingRedos(p => {
      const next = { ...p };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (countRedos(detail.results, Number(k)) >= next[Number(k)]) { delete next[Number(k)]; changed = true; }
      }
      return changed ? next : p;
    });
  }, [detail]);

  // Display order: originals in sequence, each followed by ALL its redos —
  // including redos of redos: every redo entry resolves its redoOf CHAIN back
  // to the root original, so second-level redos still render (they used to
  // vanish: their redoOf pointed at a redo entry, not an original).
  const rootOf = (idx: number): number => {
    const seen = new Set<number>();
    let cur = idx;
    while (typeof detail.results[cur]?.redoOf === 'number' && !seen.has(cur)) {
      seen.add(cur);
      cur = detail.results[cur].redoOf as number;
    }
    return cur;
  };
  const displayList: { r: ExperimentResult; i: number; isRedo: boolean; superseded: boolean }[] = [];
  detail.results.forEach((r, i) => {
    if (typeof r.redoOf === 'number') return; // attached below its root original
    const redos = detail.results.map((x, j) => ({ x, j }))
      .filter(({ x, j }) => typeof x.redoOf === 'number' && rootOf(j) === i);
    displayList.push({ r, i, isRedo: false, superseded: redos.length > 0 });
    redos.forEach(({ x, j }) => displayList.push({ r: x, i: j, isRedo: true, superseded: false }));
  });

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
        {Array.isArray((detail.params as { genericityWarnings?: string[] })?.genericityWarnings) && (
          <div className="mt-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
            <b>Genericity check:</b> this prompt change may be story-specific —{' '}
            {((detail.params as { genericityWarnings?: string[] }).genericityWarnings || []).join('; ')}
          </div>
        )}
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
              placeholder="Paste + edit a prompt here, then hit Redo on any result below — it reruns that single unit with this prompt. Empty = redo with the CURRENT templates (to redo with this experiment's A/B prompt, copy it from 'Show prompt override' above)."
              value={redoOverride}
              onChange={e => setRedoOverride(e.target.value)}
            />
          )}
        </div>
      </div>

      {displayList.map(({ r, i, isRedo, superseded }) => (
        <ResultCard key={`${r.storyId}-${r.pageNumber}-${i}`} result={r} stage={detail.stage}
          onRedo={() => redo(i)} redoing={pendingRedos[i] !== undefined}
          isRedo={isRedo} superseded={superseded} />
      ))}
      {detail.status === 'running' && (
        <div className="bg-white rounded-2xl shadow-lg p-6 text-center text-sm text-gray-500">
          Running… next target in progress (auto-refreshes every 5s)
        </div>
      )}
    </div>
  );
}

// One-line scene headline from an Art Director description: the JSON
// imageSummary when present, else the first prose line. This is the line a
// human actually reads to compare variants — raw diffs are backup detail.
function sceneHeadline(desc: string | null | undefined): string {
  if (!desc) return '';
  const m = desc.match(/"imageSummary"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  // No summary field → compose one from the interactions: who does what.
  // That's the staging info a human compares variants by ("is anyone
  // rowing?"), unlike the first prose line (a character-clothing wall).
  const inter = [...desc.matchAll(/"character"\s*:\s*"([^"]+)"[^}]*?"where"\s*:\s*"([^"]+)"/g)]
    .map(x => `${x[1]}: ${x[2]}`);
  if (inter.length) return inter.join(' · ').slice(0, 300);
  const line = desc.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('{') && !l.startsWith('```'));
  return (line || '').slice(0, 220);
}

// Line-level A/B diff: lines only in A (removed, red) / only in B (added,
// green). Set-based — good enough to surface what a prompt rule changed in
// the Art Director's output without a full LCS diff.
function DescriptionDiff({ a, b }: { a: string; b: string }) {
  const linesA = a.split('\n').map(l => l.trim()).filter(Boolean);
  const linesB = b.split('\n').map(l => l.trim()).filter(Boolean);
  const setA = new Set(linesA);
  const setB = new Set(linesB);
  const removed = linesA.filter(l => !setB.has(l));
  const added = linesB.filter(l => !setA.has(l));
  if (removed.length === 0 && added.length === 0) {
    return <div className="text-xs text-gray-400 italic">Scene descriptions are identical.</div>;
  }
  return (
    <div className="text-xs font-mono bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-72 overflow-y-auto space-y-0.5">
      {removed.map((l, i) => (
        <div key={`r${i}`} className="text-red-700 bg-red-50 rounded px-1 whitespace-pre-wrap">− {l}</div>
      ))}
      {added.map((l, i) => (
        <div key={`a${i}`} className="text-emerald-700 bg-emerald-50 rounded px-1 whitespace-pre-wrap">+ {l}</div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Lightbox — click any result/step image to inspect it full-screen and
// arrow through the set (←/→ or buttons, Esc to close).
// ─────────────────────────────────────────────────────────────────────

type LightboxImage = { src: string; label: string };
let _openLightbox: (imgs: LightboxImage[], index: number) => void = () => {};
export const openLightbox = (imgs: LightboxImage[], index: number) => _openLightbox(imgs, index);

function LightboxHost() {
  const [state, setState] = useState<{ imgs: LightboxImage[]; index: number } | null>(null);
  const [zoom, setZoom] = useState(1); // 1 = fit; 2/3/4 = 200/300/400% of NATIVE pixels
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  useEffect(() => { _openLightbox = (imgs, index) => { setState({ imgs, index }); setZoom(1); setNat(null); }; return () => { _openLightbox = () => {}; }; }, []);
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setState(null);
      if (e.key === 'ArrowRight') { setState(s => s && { ...s, index: (s.index + 1) % s.imgs.length }); setZoom(1); setNat(null); }
      if (e.key === 'ArrowLeft') { setState(s => s && { ...s, index: (s.index - 1 + s.imgs.length) % s.imgs.length }); setZoom(1); setNat(null); }
      if (e.key === '+' || e.key === '=') setZoom(z => Math.min(4, z + 1));
      if (e.key === '-') setZoom(z => Math.max(1, z - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);
  if (!state) return null;
  const cur = state.imgs[state.index];
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={() => setState(null)}>
      <div className="flex items-center justify-between px-6 py-3 text-white" onClick={e => e.stopPropagation()}>
        <div className="text-sm font-medium">{cur.label} <span className="text-white/50 ml-2">{state.index + 1} / {state.imgs.length}</span></div>
        <div className="flex items-center gap-3">
          <button className="text-white/70 hover:text-white text-xl px-2" onClick={() => setZoom(z => Math.max(1, +(z - 0.5).toFixed(2)))}>−</button>
          <span className="text-sm text-white/70 w-14 text-center">{zoom <= 1 ? 'fit' : `${Math.round(zoom * 100)}%`}</span>
          <button className="text-white/70 hover:text-white text-xl px-2" onClick={() => setZoom(z => Math.min(6, +(z + 0.5).toFixed(2)))}>+</button>
          <button className="text-white/70 hover:text-white text-2xl leading-none ml-4" onClick={() => setState(null)}>×</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 relative" onClick={e => e.stopPropagation()}>
        <button
          className="absolute left-2 top-1/2 -translate-y-1/2 z-10 text-white/70 hover:text-white text-4xl px-3 py-6 bg-black/40 rounded-r-lg"
          onClick={() => { setState(s => s && { ...s, index: (s.index - 1 + s.imgs.length) % s.imgs.length }); setZoom(1); }}
        >‹</button>
        {/* Mouse wheel = zoom (true pixel scale), click-drag = pan. */}
        <div
          ref={scrollRef}
          className={`absolute inset-0 overflow-auto ${zoom > 1 ? (dragRef.current ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
          onWheel={e => {
            e.preventDefault();
            setZoom(z => Math.min(6, Math.max(1, +(z * (e.deltaY < 0 ? 1.25 : 0.8)).toFixed(2))));
          }}
          onPointerDown={e => {
            if (zoom <= 1 || !scrollRef.current) return;
            dragRef.current = { x: e.clientX, y: e.clientY, sl: scrollRef.current.scrollLeft, st: scrollRef.current.scrollTop };
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={e => {
            if (!dragRef.current || !scrollRef.current) return;
            scrollRef.current.scrollLeft = dragRef.current.sl - (e.clientX - dragRef.current.x);
            scrollRef.current.scrollTop = dragRef.current.st - (e.clientY - dragRef.current.y);
          }}
          onPointerUp={() => { dragRef.current = null; }}
          onPointerCancel={() => { dragRef.current = null; }}
        >
          {zoom <= 1 ? (
            <div className="w-full h-full flex items-center justify-center px-16">
              <img
                src={cur.src} alt={cur.label}
                className="max-h-full max-w-full object-contain"
                draggable={false}
                onLoad={e => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
            </div>
          ) : (
            <img
              src={cur.src} alt={cur.label}
              draggable={false}
              style={{
                width: nat ? `${Math.round(nat.w * zoom)}px` : `${zoom * 100}%`,
                maxWidth: 'none', maxHeight: 'none', display: 'block', margin: '0 auto',
                userSelect: 'none',
              }}
              onLoad={e => { if (!nat) setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight }); }}
            />
          )}
        </div>
        <button
          className="absolute right-2 top-1/2 -translate-y-1/2 z-10 text-white/70 hover:text-white text-4xl px-3 py-6 bg-black/40 rounded-l-lg"
          onClick={() => { setState(s => s && { ...s, index: (s.index + 1) % s.imgs.length }); setZoom(1); }}
        >›</button>
      </div>
    </div>,
    document.body
  );
}

/** Intermediate-step image strip (presentational — the card owns loading so
 * the lightbox can arrow through ORIGINAL → steps → FINAL as one sequence). */
function StepsStrip({ steps, images, onOpen }: {
  steps: { label: string; imageType: string; versionIndex: number }[];
  images: Record<number, string>;
  onOpen: (versionIndex: number) => void;
}) {
  return (
    <div className="mt-3">
      <div className="text-xs font-medium text-gray-500 mb-1">Pipeline steps</div>
      <div className="flex gap-3 overflow-x-auto">
        {steps.map(s => (
          <div key={s.versionIndex} className="shrink-0 w-56">
            <div className="text-[11px] text-gray-500 mb-1">{s.label}</div>
            {images[s.versionIndex]
              ? <img src={images[s.versionIndex]} alt={s.label} className="rounded-lg w-full cursor-zoom-in" onClick={() => onOpen(s.versionIndex)} />
              : <div className="text-xs text-gray-400 border rounded-lg p-6 text-center">loading…</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultCard({ result, stage, onRedo, redoing, isRedo, superseded }: { result: ExperimentResult; stage: string; onRedo?: () => void; redoing?: boolean; isRedo?: boolean; superseded?: boolean }) {
  const [baseline, setBaseline] = useState<string | null>(null);
  const [variant, setVariant] = useState<string | null>(null);
  const [variantB, setVariantB] = useState<string | null>(null);
  const [stepImgs, setStepImgs] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [promoted, setPromoted] = useState(false);
  const producesImage = result.versionIndex !== undefined && result.imageType;
  // Avatar-sheet entries (stage 'avatars') have no page; "baseline" is the
  // realistic pass-1 sheet instead of a story page. Pass-1 entries have no
  // baseline at all — the anchor IS the result.
  const isAvatar = result.imageType === 'tl_avatar';
  const isPass1 = isAvatar && (result as { pass?: number }).pass === 1;
  const isCover = ['frontCover', 'initialPage', 'backCover'].includes(result.imageType || '');
  const hasPage = typeof result.pageNumber === 'number';

  // Auto-load — the final image is the whole point of a run; a manual
  // "Load" click hid it while the steps strip showed automatically.
  useEffect(() => { if (result.ok && !loaded) loadImages(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Step images load here (not in StepsStrip) so ORIGINAL → steps → FINAL is
  // one lightbox sequence.
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const s of result.steps || []) {
        try {
          const img = await testlabService.getTestImage(result.storyId, s.imageType, result.pageNumber ?? null, s.versionIndex);
          if (alive) setStepImgs(prev => ({ ...prev, [s.versionIndex]: img.imageData }));
        } catch { /* placeholder stays */ }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.steps]);

  // The full inspection sequence: ORIGINAL → every pipeline step → FINAL.
  const gallery = (): { src: string; label: string }[] => [
    ...(baseline ? [{ src: baseline, label: 'ORIGINAL (baseline / active version)' }] : []),
    ...(result.steps || []).filter(s => stepImgs[s.versionIndex]).map(s => ({ src: stepImgs[s.versionIndex], label: s.label })),
    ...(variant ? [{ src: variant, label: `FINAL result (test v${result.versionIndex})` }] : []),
    ...(variantB ? [{ src: variantB, label: `Variant B (test v${result.variantVersionIndex})` }] : []),
  ];
  const openAt = (label: string) => {
    const g = gallery();
    const idx = g.findIndex(x => x.label === label);
    openLightbox(g, idx >= 0 ? idx : 0);
  };

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
      } else if (isCover) {
        const base = await testlabService.getBaselineCover(result.storyId, result.imageType!);
        setBaseline(base.imageData);
      } else if (hasPage) {
        const base = await testlabService.getBaselineImage(result.storyId, result.pageNumber);
        setBaseline(base.imageData);
      } else {
        setBaseline('');
      }
    } catch { setBaseline(''); }
    if (producesImage) {
      try {
        const v = await testlabService.getTestImage(result.storyId, result.imageType!, isAvatar || isCover ? null : result.pageNumber ?? null, result.versionIndex!);
        setVariant(v.imageData);
      } catch { setVariant(''); }
    }
    // scene_expansion_ab: second (rule-variant) image rides in variantVersionIndex
    if (result.variantVersionIndex !== undefined) {
      try {
        const vb = await testlabService.getTestImage(result.storyId, result.imageType!, result.pageNumber ?? null, result.variantVersionIndex);
        setVariantB(vb.imageData);
      } catch { setVariantB(''); }
    }
  };

  const promotable = producesImage && (result.imageType === 'scene' || isCover);
  const promote = async () => {
    if (!promotable) return;
    if (!window.confirm(`Promote this test image into the story's real version list and set it active (pinned)? The story owner will see it.`)) return;
    try {
      await testlabService.promote(result.storyId, result.pageNumber ?? null, result.versionIndex!, true, isCover ? result.imageType! : undefined);
      setPromoted(true);
    } catch (e) {
      alert(`Promote failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <div className={`bg-white rounded-2xl shadow-lg p-4 ${superseded ? 'opacity-60' : ''} ${isRedo ? 'ml-6 border-l-4 border-indigo-200' : ''}`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm font-semibold">
          {result.character ? result.character : `${result.storyId}${typeof result.pageNumber === 'number' ? ` · P${result.pageNumber}` : result.coverType ? ` · ${result.coverType}` : ''}`}
          {result.artStyle && <span className="ml-2 bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full">{result.artStyle}</span>}
          {result.label && <span className="ml-2 bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded-full">{result.label}</span>}
          {isRedo && <span className="ml-2 bg-indigo-100 text-indigo-700 text-xs px-2 py-0.5 rounded-full">redo{result.promptOverridden ? ' · edited prompt' : ''}</span>}
          {superseded && <span className="ml-2 bg-gray-200 text-gray-600 text-xs px-2 py-0.5 rounded-full">superseded</span>}
          {!result.ok && <span className="ml-2 bg-red-100 text-red-700 text-xs px-2 py-0.5 rounded-full">failed</span>}
          {promoted && <span className="ml-2 bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded-full">promoted</span>}
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          {onRedo && (
            <Button variant="secondary" size="sm" onClick={onRedo} disabled={redoing}>
              {redoing ? (<><RefreshCw size={14} className="animate-spin" /> Redoing…</>) : 'Redo'}
            </Button>
          )}
          {result.elapsedMs !== undefined && <span>{(result.elapsedMs / 1000).toFixed(1)}s</span>}
          {result.modelId && <span>{result.modelId}</span>}
          {result.scores?.final != null && <span className="font-semibold text-gray-700">final {result.scores.final}</span>}
          {result.scores?.quality != null && <span>quality {result.scores.quality}</span>}
          {result.scores?.semantic != null && <span>semantic {result.scores.semantic}</span>}
          {result.scores?.verdict && <span>{result.scores.verdict}</span>}
          {result.qc && !result.qc.error && (
            <span className={result.qc.pass ? 'text-emerald-600 font-semibold' : 'text-red-600 font-semibold'}>
              QC {result.qc.pass ? 'pass' : 'fail'}
            </span>
          )}
          {result.method && <span>{result.method}</span>}
          {result.blendRule && <span className="bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">blend: {result.blendRule}</span>}
          {result.samBlend && !result.blendRule && <span className="bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">blend: OLD generation</span>}
          {result.styleMatch && (
            <span className={`px-2 py-0.5 rounded-full ${result.styleMatch.sameStyle ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}
              title={`A: ${result.styleMatch.styleA} / B: ${result.styleMatch.styleB}`}>
              style {result.styleMatch.sameStyle ? 'match' : 'DRIFT'}
            </span>
          )}
          {result.detectionBackend && (
            <span className={`px-2 py-0.5 rounded-full ${result.detectionBackend === 'grounding-dino' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}`}>
              {result.detectionBackend}
            </span>
          )}
          {result.scores?.error && <span className="text-red-600 font-semibold" title={result.scores.error}>eval failed</span>}
        </div>
      </div>

      {!result.ok && <div className="text-sm text-red-600 mt-2">{result.error}</div>}

      {/* Warnings/faults captured DURING this run — silent fallbacks, gate
          skips, cold-service retries. Always visible when present; full log
          behind a toggle so nothing hides in Railway. */}
      {!!result.logWarnings?.length && (
        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-lg p-2 text-xs text-amber-900">
          <div className="font-semibold mb-1">⚠ {result.logWarnings.length} warning{result.logWarnings.length > 1 ? 's' : ''} during this run</div>
          {result.logWarnings.map((w, i) => <div key={i} className="font-mono whitespace-pre-wrap">{w}</div>)}
        </div>
      )}
      {!!result.logLines?.length && (
        <details className="mt-1 text-xs text-gray-500">
          <summary className="cursor-pointer select-none">run log ({result.logLines.length} lines)</summary>
          <pre className="mt-1 bg-gray-50 border border-gray-200 rounded-lg p-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-gray-600">{result.logLines.join('\n')}</pre>
        </details>
      )}
      {!result.ok && !!result.steps?.length && (
        <StepsStrip steps={result.steps} images={stepImgs} onOpen={vi => { const g = gallery(); const s = (result.steps || []).find(x => x.versionIndex === vi); const idx = s ? g.findIndex(x => x.label === s.label) : 0; openLightbox(g, idx >= 0 ? idx : 0); }} />
      )}

      {result.ok && (
        <>
          {result.storedBaseline && (
            <div className="text-xs text-gray-500 mt-1">
              Stored baseline scores: quality {result.storedBaseline.qualityScore ?? '—'} · semantic {result.storedBaseline.semanticScore ?? '—'}
            </div>
          )}

          {!loaded ? (
            <div className="text-xs text-gray-400 mt-3">loading images…</div>
          ) : (
            <div className={`grid gap-4 mt-3 ${result.variantVersionIndex !== undefined ? 'grid-cols-1 md:grid-cols-3' : producesImage && !isPass1 ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'}`}>
              {!isPass1 && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">
                    {isAvatar ? 'Realistic anchor (pass 1)' : 'Baseline (active version)'}
                    {result.bbox && result.characterName && <> — <span className="text-indigo-600">red box = "{result.characterName}" ({result.boxSource || 'box'})</span></>}
                  </div>
                  {baseline ? (
                    <div className="relative">
                      <img
                        src={baseline} alt="baseline" className="rounded-lg w-full cursor-zoom-in"
                        onClick={() => openAt('ORIGINAL (baseline / active version)')}
                      />
                      {result.bbox?.length === 4 && (
                        <div
                          className="absolute border-2 border-red-500 pointer-events-none"
                          style={{
                            top: `${result.bbox[0] * 100}%`, left: `${result.bbox[1] * 100}%`,
                            height: `${(result.bbox[2] - result.bbox[0]) * 100}%`, width: `${(result.bbox[3] - result.bbox[1]) * 100}%`,
                          }}
                        />
                      )}
                      {result.crop && (
                        <div
                          className="absolute border-2 border-red-500 pointer-events-none"
                          style={{
                            top: `${result.crop.y * 100}%`, left: `${result.crop.x * 100}%`,
                            height: `${result.crop.h * 100}%`, width: `${result.crop.w * 100}%`,
                          }}
                        />
                      )}
                    </div>
                  ) : <div className="text-xs text-gray-400">unavailable</div>}
                </div>
              )}
              {producesImage && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">{isPass1 ? `Realistic anchor (pass 1, test v${result.versionIndex})` : isAvatar ? `Styled sheet (pass 2, test v${result.versionIndex})` : result.variantVersionIndex !== undefined ? `A: current template (test v${result.versionIndex})` : `FINAL result (test v${result.versionIndex})`}</div>
                  {variant ? (
                    <img
                      src={variant} alt="final result" className="rounded-lg w-full cursor-zoom-in"
                      onClick={() => openAt(`FINAL result (test v${result.versionIndex})`)}
                    />
                  ) : <div className="text-xs text-gray-400">unavailable</div>}
                  {result.variantVersionIndex !== undefined && result.scores?.final != null && (
                    <div className="text-xs text-gray-600 mt-1">final {result.scores.final}</div>
                  )}
                  {promotable && !promoted && (
                    <div className="mt-2">
                      <Button variant="secondary" size="sm" onClick={promote}>Promote to story</Button>
                    </div>
                  )}
                </div>
              )}
              {result.variantVersionIndex !== undefined && (
                <div>
                  <div className="text-xs font-medium text-gray-500 mb-1">B: with extra rule (test v{result.variantVersionIndex})</div>
                  {variantB ? <img src={variantB} alt="variant B" className="rounded-lg w-full" /> : <div className="text-xs text-gray-400">unavailable</div>}
                  {result.variantScores?.final != null && (
                    <div className="text-xs text-gray-600 mt-1">final {result.variantScores.final}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Single-variant stage (scene_variant). The CONTRACT — and the only
              always-visible text: THIS IMAGE DEPICTS + EXACT POSES, both
              verbatim from the prompt that was sent. Everything else (rule,
              full prompt) toggles. */}
          {result.variantVersionIndex === undefined && (result.extraRule || result.imagePrompt) && (() => {
            const contract = (p: string | null | undefined) => ({
              depicts: p?.match(/THIS IMAGE DEPICTS:\*{0,2}\s*([^\n]+)/)?.[1]?.trim(),
              poses: p?.match(/EXACT POSES:\s*\n((?:\s*-[^\n]*\n?)+)/)?.[1]?.trimEnd(),
            });
            const now = contract(result.imagePrompt);
            const base = contract(result.baselinePrompt);
            const block = (label: string, c: { depicts?: string; poses?: string }, tone: string) => (
              (c.depicts || c.poses) ? (
                <div className={`rounded-lg px-3 py-2 ${tone}`}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide opacity-60 mb-1">{label}</div>
                  {c.depicts && <div className="text-sm"><b>THIS IMAGE DEPICTS:</b> {c.depicts}</div>}
                  {c.poses && <pre className="text-sm whitespace-pre-wrap font-sans mt-1"><b>EXACT POSES:</b>{'\n'}{c.poses}</pre>}
                </div>
              ) : null
            );
            return (
              <div className="mt-3 space-y-2">
                {block('Original contract', base, 'bg-gray-50 text-gray-800')}
                {block('New contract (this result)', now, 'bg-indigo-50 text-indigo-900')}
                {!now.depicts && !now.poses && result.imagePrompt && (
                  <div className="text-xs text-red-600">Prompt sent without DEPICTS/EXACT POSES sections — contract violation, inspect the full prompt below.</div>
                )}
                <details className="text-xs">
                  <summary className="cursor-pointer text-indigo-600">Rule + full prompts</summary>
                  <div className="mt-1 space-y-2">
                    {result.extraRule && (
                      <div className="font-mono text-emerald-700 bg-emerald-50 rounded-lg px-2 py-1.5 whitespace-pre-wrap">+ {result.extraRule}</div>
                    )}
                    {result.imagePrompt && (
                      <div>
                        <div className="font-medium text-gray-500 mb-1">Full image prompt sent (this result)</div>
                        <pre className="bg-gray-50 rounded-lg p-3 overflow-x-auto overflow-y-auto max-h-80 whitespace-pre-wrap">{result.imagePrompt}</pre>
                      </div>
                    )}
                    {result.baselinePrompt && (
                      <div>
                        <div className="font-medium text-gray-500 mb-1">Full image prompt (original)</div>
                        <pre className="bg-gray-50 rounded-lg p-3 overflow-x-auto overflow-y-auto max-h-80 whitespace-pre-wrap">{result.baselinePrompt}</pre>
                      </div>
                    )}
                  </div>
                </details>
              </div>
            );
          })()}

          {/* A/B stage: readable summary first — the rule + one headline per
              variant. The raw line diff is backup detail behind a toggle. */}
          {result.variantVersionIndex !== undefined && (
            <div className="mt-3 space-y-2">
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">Prompt change (B vs A)</div>
                {result.promptOverridden ? (
                  <div className="text-xs text-gray-600">Custom variant-B template (full override) — see "Show details" for both prompts.</div>
                ) : (
                  <div className="text-xs font-mono text-emerald-700 bg-emerald-50 rounded-lg px-2 py-1.5 whitespace-pre-wrap">+ {result.extraRule}</div>
                )}
              </div>
              {result.newSceneDescriptionA && (
                <div className="text-xs bg-gray-50 rounded-lg px-2 py-1.5">
                  <span className="font-semibold text-gray-600">A:</span> {sceneHeadline(result.newSceneDescriptionA)}
                </div>
              )}
              {result.newSceneDescriptionB && (
                <div className="text-xs bg-indigo-50 rounded-lg px-2 py-1.5">
                  <span className="font-semibold text-indigo-700">B:</span> {sceneHeadline(result.newSceneDescriptionB)}
                </div>
              )}
              {result.newSceneDescriptionA && result.newSceneDescriptionB && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-indigo-600">Line diff (A − / B +)</summary>
                  <div className="mt-1"><DescriptionDiff a={result.newSceneDescriptionA} b={result.newSceneDescriptionB} /></div>
                </details>
              )}
            </div>
          )}

          {!!result.steps?.length && (
            <StepsStrip steps={result.steps} images={stepImgs} onOpen={vi => { const g = gallery(); const s = (result.steps || []).find(x => x.versionIndex === vi); const idx = s ? g.findIndex(x => x.label === s.label) : 0; openLightbox(g, idx >= 0 ? idx : 0); }} />
          )}

          {result.decision && (
            <div className="text-xs text-gray-600 mt-2">
              <b>Repair decision:</b> {result.decision.method}{result.decision.charName ? ` [${result.decision.charName}]` : ''} — {result.decision.reason}
              {result.skippedRepair && <span className="text-gray-400"> (nothing to repair)</span>}
            </div>
          )}
          {(result.issuesSummary || result.scores?.issuesSummary || result.semanticIssues?.length || result.figures?.length || result.report || result.fixableIssues?.length || result.promptUsed || result.plan || result.dedupedIssues != null || result.consolidateError || result.skipped === true || result.textZone || result.newSceneDescription || result.newSceneDescriptionA || result.versions?.length || result.note || result.comparedVersions || result.inpaintInstruction || result.artifactRepair) && (
            <div className="mt-3">
              <button className="text-xs text-indigo-600 hover:underline" onClick={() => setShowDetails(v => !v)}>
                {showDetails ? 'Hide' : 'Show'} details
              </button>
              {showDetails && (
                <div className="mt-2 space-y-2">
                  {result.issuesSummary && <div className="text-xs text-gray-600"><b>Issues:</b> {result.issuesSummary}</div>}
                  {result.qc && !result.qc.pass && !result.qc.error && (
                    <div className="text-xs text-gray-600">
                      <b>QC issues:</b> {(result.qc.issues || []).join('; ') || '—'}
                      {result.qc.visionFeedback && <> · <b>Vision:</b> {result.qc.visionFeedback}</>}
                    </div>
                  )}
                  {!!result.semanticIssues?.length && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(result.semanticIssues, null, 2)}</pre>
                  )}
                  {!!result.fixableIssues?.length && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(result.fixableIssues, null, 2)}</pre>
                  )}
                  {(stage === 'bbox' || result.detectionBackend) && (result.figures || result.objects) && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify({ backend: result.detectionBackend, figures: result.figures, objects: result.objects }, null, 2)}</pre>
                  )}
                  {(stage === 'entity' || stage === 'style_check' || stage === 'avatar_eval' || stage === 'repair_verify') && result.report != null && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64">{JSON.stringify(result.report, null, 2)}</pre>
                  )}
                  {result.comparedVersions && (
                    <div className="text-xs text-gray-600"><b>Compared:</b> original v{String(result.comparedVersions.original)} vs repaired v{String(result.comparedVersions.repaired)}</div>
                  )}
                  {stage === 'quality_eval' && !!result.figures?.length && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(result.figures, null, 2)}</pre>
                  )}
                  {result.scores?.issuesSummary && (
                    <div className="text-xs text-gray-600"><b>Eval issues:</b> {result.scores.issuesSummary}</div>
                  )}
                  {result.dedupedIssues != null && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(result.dedupedIssues, null, 2)}</pre>
                  )}
                  {result.consolidateError && (
                    <div className="text-xs text-red-600"><b>Consolidator error:</b> {result.consolidateError}</div>
                  )}
                  {result.skipped === true && stage === 'consolidate' && (
                    <div className="text-xs text-gray-500">Consolidator skipped — no issues to consolidate on this page.</div>
                  )}
                  {result.inpaintInstruction && (
                    <div className="text-xs text-gray-600"><b>Inpaint instruction:</b> {result.inpaintInstruction}</div>
                  )}
                  {result.plan != null && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64">{JSON.stringify(result.plan, null, 2)}</pre>
                  )}
                  {result.textZone && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(result.textZone, null, 2)}</pre>
                  )}
                  {result.artifactRepair && (
                    <div className="text-xs text-gray-600"><b>Artifact repair:</b> fixed {result.artifactRepair.fixedCount}/{result.artifactRepair.totalIssues} (failed {result.artifactRepair.failedCount})</div>
                  )}
                  {!!result.versions?.length && (
                    <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify({ versions: result.versions, winner: result.winner, active: result.active }, null, 2)}</pre>
                  )}
                  {result.note && <div className="text-xs text-gray-500">{result.note}</div>}
                  {result.newSceneDescription && (
                    <div className="grid md:grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">Stored scene description</div>
                        <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64 whitespace-pre-wrap">{result.storedSceneDescription || '—'}</pre>
                      </div>
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">New (this run)</div>
                        <pre className="text-xs bg-indigo-50 rounded-lg p-3 overflow-x-auto max-h-64 whitespace-pre-wrap">{result.newSceneDescription}</pre>
                      </div>
                    </div>
                  )}
                  {result.newSceneDescriptionA && (
                    <div className="grid md:grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">Scene description A (current template)</div>
                        <pre className="text-xs bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64 whitespace-pre-wrap">{result.newSceneDescriptionA}</pre>
                      </div>
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">Scene description B (with extra rule)</div>
                        <pre className="text-xs bg-indigo-50 rounded-lg p-3 overflow-x-auto max-h-64 whitespace-pre-wrap">{result.newSceneDescriptionB}</pre>
                      </div>
                    </div>
                  )}
                  {result.promptUsed && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-indigo-600">Prompt sent</summary>
                      <pre className="bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64 mt-1">{result.promptUsed}</pre>
                    </details>
                  )}
                  {result.promptUsedA && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-indigo-600">Prompt A (current template)</summary>
                      <pre className="bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64 mt-1">{result.promptUsedA}</pre>
                    </details>
                  )}
                  {result.promptUsedB && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-indigo-600">Prompt B (variant)</summary>
                      <pre className="bg-gray-50 rounded-lg p-3 overflow-x-auto max-h-64 mt-1">{result.promptUsedB}</pre>
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
