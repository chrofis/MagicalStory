import { useEffect, useMemo, useState } from 'react';
import { testlabService, type ScoreRow, type TextModelInfo } from '@/services/testlabService';

// One section per part. round = review/refine pass; model is a separate axis.
const PARTS = ['full', 'beats', 'scene', 'storyText', 'visualBible'] as const;
const PART_LABEL: Record<string, string> = {
  full: 'Full story (overall)', beats: 'Beats', scene: 'Scenes', storyText: 'Story text', visualBible: 'Visual bible',
};
// part → the rerun stage. Passing both model + reviewModel covers all stages.
// Scorer names mirror server/lib/storyScorecard.js EVALUATORS. From v2 the
// version pins the judge: x.1 sonnet, x.2 grok, x.3 gemini. Gen 3 = premise-aware.
const SCORER_NAMES: Record<string, string> = { '2.1': 'sonnet', '2.2': 'grok', '2.3': 'gemini', '3.1': 'sonnet', '3.2': 'grok', '3.3': 'gemini' };
const scorerLabel = (v: string) => (SCORER_NAMES[v] ? `${v} ${SCORER_NAMES[v]}` : `v${v}`);

// beats_review_replay retired 2026-09-01 (beats-review/audit machinery
// deleted, docs/decisions.md) — "beats" keeps no rerun stage, but its scores
// stay visible above; only the "＋ next round" control is suppressed for it.
const PART_STAGE: Record<string, string | null> = {
  full: 'story_scorecard', beats: null, scene: 'scene_review_replay',
  storyText: 'story_text_replay', visualBible: 'story_bible_replay',
};

type CellModal = { kind: 'cell'; row: ScoreRow } | { kind: 'prompt'; version: string; prompt: string } | null;

const fmt = (n: number | null | undefined) => (n == null ? '—' : Number(n).toFixed(4));
const secs = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`);

export default function ScorecardsPanel() {
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [models, setModels] = useState<TextModelInfo[]>([]);
  const [evalSel, setEvalSel] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [modal, setModal] = useState<CellModal>(null);
  const [nr, setNr] = useState<{ storyId: string; part: string; version: string; row: ScoreRow } | null>(null);
  const [nrModel, setNrModel] = useState('');
  const [nrMsg, setNrMsg] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null); // spinner label while a round runs

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
  const allVersions = [...new Set(rows.map(r => r.eval_version))].sort();

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

  // "＋ next round": continue a line's FINAL round → run one more review/refine
  // pass with a chosen model, persisted as round+1. Works for every part via the
  // part→stage map; each stage reads the model under its own param name, so all
  // four are passed. The prior round's frozen text (artifact_text) is the input.
  const doNextRound = async () => {
    if (!nr || !nrModel) return;
    const row = nr.row;
    const stage = PART_STAGE[nr.part];
    if (!stage) { setNrMsg('this part has no rerun stage'); return; }
    if (!row.artifact_text) { setNrMsg('this round has no stored text to continue from'); return; }
    setNrMsg('starting…');
    try {
      await testlabService.createExperiment({
        stage,
        params: {
          fromText: row.artifact_text, fromRound: row.round,
          model: nrModel, reviewModel: nrModel, textModel: nrModel, bibleModel: nrModel,
          scoreOutput: true, evalVersion: nr.version,
        },
        targets: [{ storyId: nr.storyId }],
      });
      setNrMsg(null);
      setRunning(`${PART_LABEL[nr.part]} r${row.round}→r${row.round + 1} · ${nrModel}`);
      setNr(null);
      setTimeout(load, 5000); setTimeout(() => setRunning(null), 100000);
    } catch (e) { setNrMsg(`failed: ${e instanceof Error ? e.message : e}`); }
  };

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-sm font-semibold">Model-comparison scorecards</div>
        <div className="flex items-center gap-3 text-xs text-gray-600">
          <div className="flex rounded overflow-hidden border border-gray-300">
            {['all', ...allVersions].map(v => (
              <button key={v} className={`px-2 py-1 ${evalSel === v ? 'bg-indigo-600 text-white' : 'bg-white'}`} onClick={() => setEvalSel(v)}>{v === 'all' ? 'all scorers' : scorerLabel(v)}</button>
            ))}
          </div>
          {running && <span className="inline-flex items-center gap-1 text-indigo-600 font-medium"><span className="inline-block w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" /> running {running}…</span>}
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
              <thead><tr className="text-left text-gray-500"><th className="py-1 pr-3">story</th><th className="pr-3">model</th><th className="pr-3">rounds (score per pass · final ✱)</th><th className="pr-3">Σ cost · time</th><th className="pr-3">judge</th><th className="pr-3">eval</th><th></th></tr></thead>
              <tbody>
                {sec.lines.map((ln, i) => (
                  <tr key={i} className="border-t border-gray-100 align-top">
                    <td className="py-1 pr-3">{ln.story}</td>
                    <td className="pr-3 font-mono">{ln.model}</td>
                    <td className="pr-3">
                      {ln.rounds.map(r => (
                        <button key={r.id} className="mr-1 mb-1 inline-block px-1.5 py-0.5 rounded bg-gray-100 hover:bg-indigo-100 font-mono"
                          title={`round ${r.round} · ${r.label || r.source} · gen $${fmt(r.gen_cost_usd)}/${r.gen_ms ?? '—'}ms · judge $${fmt(r.judge_cost_usd)}/${r.judge_ms ?? '—'}ms · click for feedback + text`} onClick={() => setModal({ kind: 'cell', row: r })}>
                          {r.round}:{r.score}{r.round === ln.maxRound ? '✱' : ''}
                        </button>
                      ))}
                    </td>
                    <td className="pr-3 font-mono opacity-70">${fmt(ln.rounds.reduce((s, r) => s + (Number(r.gen_cost_usd) || 0) + (Number(r.judge_cost_usd) || 0), 0))} · {secs(ln.rounds.reduce((s, r) => s + (Number(r.gen_ms) || 0) + (Number(r.judge_ms) || 0), 0))}</td>
                    <td className="pr-3 font-mono opacity-70">{[...new Set(ln.rounds.map(r => r.judge_model).filter(Boolean))].join(', ') || '—'}</td>
                    <td className="pr-3"><button className="text-indigo-600 hover:underline font-mono" onClick={() => openPrompt(ln.version)}>{scorerLabel(ln.version)}</button></td>
                    <td>{PART_STAGE[sec.part] && (
                      <button className="text-indigo-600 hover:underline whitespace-nowrap" title={`continue from round ${ln.maxRound} → round ${ln.maxRound + 1} with a model you pick`}
                        onClick={() => { const fin = ln.rounds.find(r => r.round === ln.maxRound)!; setNr({ storyId: ln.storyId, part: sec.part, version: ln.version, row: fin }); setNrModel(''); setNrMsg(null); }}>＋ next round ▾</button>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nr && nr.part === sec.part && (
            <div className="mt-1 flex items-center gap-2 text-xs bg-indigo-50 border border-indigo-200 rounded p-2 flex-wrap">
              <span>Continue <b>{PART_LABEL[sec.part]}</b> from <span className="font-mono">round {nr.row.round}</span> of <span className="font-mono">{nr.row.model}</span> (v{nr.version}) → <b>round {nr.row.round + 1}</b>, with model:</span>
              <select className="border rounded px-1 py-0.5" value={nrModel} onChange={e => setNrModel(e.target.value)}>
                <option value="">— pick model —</option>
                {models.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
              </select>
              <button className="px-2 py-0.5 bg-indigo-600 text-white rounded disabled:opacity-40" disabled={!nrModel} onClick={doNextRound}>run →</button>
              <button className="text-gray-500" onClick={() => setNr(null)}>cancel</button>
              {sec.part === 'visualBible' && <span className="text-amber-600">bible has no critique step yet — this re-generates from beats (labeled)</span>}
              {nrMsg && <span className="text-gray-600">{nrMsg}</span>}
            </div>
          )}
        </div>
      ))}

      {modal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setModal(null)}>
          <div className="bg-white rounded-lg max-w-4xl w-full max-h-[85vh] overflow-auto p-4 text-xs" onClick={e => e.stopPropagation()}>
            {modal.kind === 'prompt' && (<>
              <div className="font-semibold mb-2">Evaluator {scorerLabel(modal.version)} — judge prompt</div>
              <pre className="whitespace-pre-wrap bg-gray-50 p-3 rounded">{modal.prompt}</pre>
            </>)}
            {modal.kind === 'cell' && (<>
              <div className="font-semibold mb-1">{PART_LABEL[modal.row.artifact] || modal.row.artifact} · round {modal.row.round} · {modal.row.model} · {scorerLabel(modal.row.eval_version)}</div>
              <div className="mb-1">score <b>{modal.row.score}</b> · judge <span className="font-mono">{modal.row.judge_model}</span> · {modal.row.source}</div>
              <div className="mb-2 opacity-70">generation: ${fmt(modal.row.gen_cost_usd)} · {secs(modal.row.gen_ms)} &nbsp;|&nbsp; judge: ${fmt(modal.row.judge_cost_usd)} · {secs(modal.row.judge_ms)}</div>
              <div className="font-semibold">Dimensions</div>
              <pre className="whitespace-pre-wrap bg-gray-50 p-2 rounded mb-2">{JSON.stringify(modal.row.dims, null, 1)}</pre>
              <div className="font-semibold">Judge feedback</div>
              <div className="bg-gray-50 p-2 rounded mb-2">{modal.row.notes || '(no note stored)'}</div>
              {modal.row.chain && (<>
                <div className="font-semibold">Review chain — what produced this round{modal.row.chain.reviewModel ? <span className="font-mono font-normal"> ({modal.row.chain.reviewModel})</span> : null}</div>
                {modal.row.chain.analysis && (<>
                  <div className="mt-1 text-gray-600">Reviewer analysis (all checks):</div>
                  <pre className="whitespace-pre-wrap bg-amber-50 p-2 rounded max-h-64 overflow-auto mb-2">{modal.row.chain.analysis}</pre>
                </>)}
                {(modal.row.chain.rewrites?.length ?? 0) > 0 ? (
                  <div className="mb-2">
                    <div className="text-gray-600">Rewrites ({modal.row.chain.rewrites!.length} page{modal.row.chain.rewrites!.length > 1 ? 's' : ''}):</div>
                    {modal.row.chain.rewrites!.map(rw => (
                      <div key={rw.page} className="border border-gray-200 rounded mt-1">
                        <div className="px-2 py-0.5 bg-gray-100 font-semibold">Page {rw.page}</div>
                        <div className="grid grid-cols-2 gap-0 divide-x divide-gray-200">
                          <pre className="whitespace-pre-wrap p-2 bg-red-50/50 overflow-auto max-h-48">{rw.before}</pre>
                          <pre className="whitespace-pre-wrap p-2 bg-green-50/50 overflow-auto max-h-48">{rw.after}</pre>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <div className="text-gray-500 mb-2">(reviewer rewrote nothing this pass)</div>}
              </>)}
              <div className="font-semibold">Evaluated text</div>
              <pre className="whitespace-pre-wrap bg-gray-50 p-2 rounded max-h-64 overflow-auto">{modal.row.artifact_text || '(not captured for this row)'}</pre>
              <div className="mt-2 text-gray-500">To run another round, close this and use <b>＋ next round</b> on the row.</div>
            </>)}
            <div className="mt-3 text-right"><button className="px-3 py-1 bg-gray-200 rounded" onClick={() => setModal(null)}>close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
