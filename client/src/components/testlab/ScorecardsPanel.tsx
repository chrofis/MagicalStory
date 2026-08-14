import { useEffect, useMemo, useState } from 'react';
import { testlabService, type ScoreRow, type TextModelInfo } from '@/services/testlabService';

// One section per part. round = review/refine pass; model is a separate axis.
const PARTS = ['full', 'beats', 'scene', 'storyText', 'visualBible'] as const;
const PART_LABEL: Record<string, string> = {
  full: 'Full story (overall)', beats: 'Beats', scene: 'Scenes', storyText: 'Story text', visualBible: 'Visual bible',
};
// part → the rerun stage. Passing both model + reviewModel covers all stages.
const PART_STAGE: Record<string, string> = {
  full: 'story_scorecard', beats: 'beats_review_replay', scene: 'scene_review_replay',
  storyText: 'story_text_replay', visualBible: 'story_bible_replay',
};

type CellModal = { kind: 'cell'; row: ScoreRow } | { kind: 'prompt'; version: string; prompt: string } | null;

export default function ScorecardsPanel() {
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [models, setModels] = useState<TextModelInfo[]>([]);
  const [evalSel, setEvalSel] = useState<'all' | '1.0' | '1.1'>('all');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<CellModal>(null);
  const [rerun, setRerun] = useState<{ storyId: string; part: string } | null>(null);
  const [rerunModel, setRerunModel] = useState('');
  const [rerunMsg, setRerunMsg] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setRows((await testlabService.getScores()).scores || []); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    load();
    testlabService.getTextModels().then(r => setModels(r.models || [])).catch(() => {});
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(() => rows.filter(r => evalSel === 'all' || r.eval_version === evalSel), [rows, evalSel]);
  const allVersions = [...new Set(rows.map(r => r.eval_version))];

  // Per part: group by (story, model); within a group the rounds ordered.
  const sections = useMemo(() => PARTS.map(part => {
    const rs = visible.filter(r => r.artifact === part);
    const groups = new Map<string, ScoreRow[]>();
    for (const r of rs) { const k = `${r.story_id}||${r.model || '(none)'}||${r.eval_version}`; (groups.get(k) || groups.set(k, []).get(k)!).push(r); }
    const lines = [...groups.values()].map(g => {
      const sorted = [...g].sort((a, b) => a.round - b.round);
      const maxRound = Math.max(...sorted.map(r => r.round));
      return { story: sorted[0].title || sorted[0].story_id, storyId: sorted[0].story_id, model: sorted[0].model || '(none)', version: sorted[0].eval_version, rounds: sorted, maxRound };
    }).sort((a, b) => (a.story + a.model).localeCompare(b.story + b.model));
    return { part, lines };
  }).filter(s => s.lines.length), [visible]);

  const openPrompt = async (version: string) => {
    try { const r = await testlabService.getEvalVersionPrompt(version); setModal({ kind: 'prompt', version, prompt: r.prompt }); }
    catch (e) { setModal({ kind: 'prompt', version, prompt: `error: ${e instanceof Error ? e.message : e}` }); }
  };

  const doRerun = async () => {
    if (!rerun || !rerunModel) return;
    setRerunMsg('starting…');
    try {
      await testlabService.createExperiment({
        stage: PART_STAGE[rerun.part],
        params: { model: rerunModel, reviewModel: rerunModel, scoreOutput: true, evalVersion: evalSel === 'all' ? '1.1' : evalSel, ...(rerun.part === 'beats' ? { passes: 2 } : {}) },
        targets: [{ storyId: rerun.storyId }],
      });
      setRerunMsg('running — new round will appear on refresh'); setRerun(null); setTimeout(load, 4000);
    } catch (e) { setRerunMsg(`failed: ${e instanceof Error ? e.message : e}`); }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-sm font-semibold">Model-comparison scorecards</div>
        <div className="flex items-center gap-3 text-xs text-gray-600">
          <div className="flex rounded overflow-hidden border border-gray-300">
            {(['all', '1.0', '1.1'] as const).map(v => (
              <button key={v} className={`px-2 py-1 ${evalSel === v ? 'bg-indigo-600 text-white' : 'bg-white'}`} onClick={() => setEvalSel(v)}>{v === 'all' ? 'all evals' : `v${v}`}</button>
            ))}
          </div>
          {allVersions.length > 1 && evalSel === 'all' && <span className="text-amber-600">⚠ mixing evaluator versions — compare within one</span>}
          <button className="text-indigo-600 hover:underline" onClick={load} disabled={loading}>{loading ? 'refreshing…' : 'refresh'}</button>
          <span className="opacity-60">auto 20s</span>
        </div>
      </div>
      {err && <div className="text-red-600 text-xs mb-2">{err}</div>}
      {!sections.length && !loading && <div className="text-gray-500 text-xs">No scores yet. Run story_scorecard, a *_replay with scoreOutput, or generate a story with auto-score on.</div>}

      {sections.map(sec => (
        <div key={sec.part} className="mb-5">
          <div className="text-sm font-semibold text-indigo-900 border-b border-indigo-200 pb-1 mb-1">{PART_LABEL[sec.part]}</div>
          <div className="overflow-x-auto">
            <table className="text-xs w-full">
              <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3">story</th><th className="pr-3">model</th><th className="pr-3">rounds (score per pass · final ✱)</th><th className="pr-3">eval</th><th></th></tr></thead>
              <tbody>
                {sec.lines.map((ln, i) => (
                  <tr key={i} className="border-t border-gray-100 align-top">
                    <td className="py-1 pr-3">{ln.story}</td>
                    <td className="pr-3 font-mono">{ln.model}</td>
                    <td className="pr-3">
                      {ln.rounds.map(r => (
                        <button key={r.id} className="mr-1 mb-1 inline-block px-1.5 py-0.5 rounded bg-gray-100 hover:bg-indigo-100 font-mono"
                          title={`round ${r.round} · ${r.source}${r.label ? ' · ' + r.label : ''} · click for feedback + evaluated text`} onClick={() => setModal({ kind: 'cell', row: r })}>
                          {r.round}:{r.score}{r.round === ln.maxRound ? '✱' : ''}
                        </button>
                      ))}
                    </td>
                    <td className="pr-3"><button className="text-indigo-600 hover:underline font-mono" onClick={() => openPrompt(ln.version)}>v{ln.version}</button></td>
                    <td><button className="text-indigo-600 hover:underline" onClick={() => { setRerun({ storyId: ln.storyId, part: sec.part }); setRerunMsg(null); }}>rerun ▾</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rerun && rerun.part === sec.part && (
            <div className="mt-1 flex items-center gap-2 text-xs bg-indigo-50 border border-indigo-200 rounded p-2">
              <span>Rerun <b>{PART_LABEL[sec.part]}</b> for <span className="font-mono">{rerun.storyId.slice(0, 24)}</span> with model:</span>
              <select className="border rounded px-1 py-0.5" value={rerunModel} onChange={e => setRerunModel(e.target.value)}>
                <option value="">— pick model —</option>
                {models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
              </select>
              <button className="px-2 py-0.5 bg-indigo-600 text-white rounded disabled:opacity-40" disabled={!rerunModel} onClick={doRerun}>run</button>
              <button className="text-gray-500" onClick={() => setRerun(null)}>cancel</button>
              {rerunMsg && <span className="text-gray-600">{rerunMsg}</span>}
            </div>
          )}
        </div>
      ))}

      {modal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[80vh] overflow-auto p-4 text-xs" onClick={e => e.stopPropagation()}>
            {modal.kind === 'prompt' && (<>
              <div className="font-semibold mb-2">Evaluator v{modal.version} — judge prompt</div>
              <pre className="whitespace-pre-wrap bg-gray-50 p-3 rounded">{modal.prompt}</pre>
            </>)}
            {modal.kind === 'cell' && (<>
              <div className="font-semibold mb-1">{PART_LABEL[modal.row.artifact] || modal.row.artifact} · round {modal.row.round} · {modal.row.model} · v{modal.row.eval_version}</div>
              <div className="mb-2">score <b>{modal.row.score}</b> · judge <span className="font-mono">{modal.row.judge_model}</span> · {modal.row.source}</div>
              <div className="font-semibold">Dimensions</div>
              <pre className="whitespace-pre-wrap bg-gray-50 p-2 rounded mb-2">{JSON.stringify(modal.row.dims, null, 1)}</pre>
              <div className="font-semibold">Judge feedback</div>
              <div className="bg-gray-50 p-2 rounded mb-2">{modal.row.notes || '(no note stored)'}</div>
              <div className="font-semibold">Evaluated text</div>
              <pre className="whitespace-pre-wrap bg-gray-50 p-2 rounded max-h-64 overflow-auto">{modal.row.artifact_text || '(not captured for this row)'}</pre>
            </>)}
            <div className="mt-3 text-right"><button className="px-3 py-1 bg-gray-200 rounded" onClick={() => setModal(null)}>close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
