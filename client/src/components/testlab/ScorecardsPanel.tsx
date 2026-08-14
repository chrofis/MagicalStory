import { useEffect, useMemo, useState } from 'react';
import { testlabService, type ScoreRow } from '@/services/testlabService';

const PARTS = ['full', 'beats', 'scene', 'storyText', 'visualBible'];
const PART_LABEL: Record<string, string> = {
  full: 'Full story', beats: 'Beats', scene: 'Scenes', storyText: 'Story text', visualBible: 'Visual bible',
};

/**
 * Live model-comparison scores. Pivots story_scores: per story, rows = the part
 * scored, columns = the generating model, cell = the latest score (+ evaluator
 * version). Rerun a part with a different model and a new column appears; score
 * a new story and it shows up. Auto-refreshes; scores are only comparable within
 * one evaluator version, so a mix is flagged.
 */
export default function ScorecardsPanel() {
  const [rows, setRows] = useState<ScoreRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const load = async () => {
    setLoading(true);
    try { const r = await testlabService.getScores(); setRows(r.scores || []); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open) return;
    load();
    const id = setInterval(load, 20000); // live: refresh every 20s
    return () => clearInterval(id);
  }, [open]);

  // Group rows by story, then pivot part × model to the newest score.
  const stories = useMemo(() => {
    const byStory = new Map<string, ScoreRow[]>();
    for (const r of rows) { const k = r.story_id; (byStory.get(k) || byStory.set(k, []).get(k)!).push(r); }
    return [...byStory.entries()].map(([storyId, rs]) => {
      const models = [...new Set(rs.map(r => r.model || '(none)'))].sort();
      const versions = [...new Set(rs.map(r => r.eval_version))];
      const cell = (part: string, model: string) => {
        const match = rs.filter(r => r.artifact === part && (r.model || '(none)') === model);
        if (!match.length) return null;
        return match.reduce((a, b) => (a.created_at > b.created_at ? a : b)); // newest
      };
      const partsPresent = PARTS.filter(p => rs.some(r => r.artifact === p));
      const title = rs.find(r => r.title)?.title || storyId;
      return { storyId, title, models, versions, partsPresent, cell };
    });
  }, [rows]);

  const allVersions = [...new Set(rows.map(r => r.eval_version))];

  return (
    <div className="mb-4 rounded-lg border border-indigo-200 bg-white">
      <div className="flex items-center justify-between px-4 py-2 bg-indigo-50 border-b border-indigo-200">
        <button className="font-semibold text-sm text-indigo-900" onClick={() => setOpen(v => !v)}>
          {open ? '▾' : '▸'} Model-comparison scorecards {rows.length ? `(${stories.length} stories)` : ''}
        </button>
        <div className="flex items-center gap-3 text-xs text-gray-600">
          {allVersions.length > 1 && <span className="text-red-600 font-medium">⚠ mixed evaluator versions ({allVersions.join(', ')}) — not comparable</span>}
          <span>evaluator {allVersions.join(', ') || '—'}</span>
          <button className="text-indigo-600 hover:underline" onClick={load} disabled={loading}>{loading ? 'refreshing…' : 'refresh'}</button>
          <span className="opacity-60">auto 20s</span>
        </div>
      </div>
      {open && (
        <div className="p-3 overflow-x-auto">
          {err && <div className="text-red-600 text-xs mb-2">{err}</div>}
          {!rows.length && !loading && <div className="text-gray-500 text-xs">No scores yet. Run story_scorecard or a *_replay with scoreOutput, or generate a story with auto-score on.</div>}
          {stories.map(s => (
            <div key={s.storyId} className="mb-4">
              <div className="text-sm font-medium">{s.title} <span className="text-xs text-gray-400 font-normal">{s.storyId}</span></div>
              <table className="text-xs mt-1 border-collapse">
                <thead>
                  <tr className="text-left"><th className="pr-4 py-1">part</th>{s.models.map(m => <th key={m} className="px-3 py-1 font-mono">{m}</th>)}</tr>
                </thead>
                <tbody>
                  {s.partsPresent.map(part => (
                    <tr key={part} className="border-t border-gray-100">
                      <td className="pr-4 py-1 font-medium">{PART_LABEL[part] || part}</td>
                      {s.models.map(m => {
                        const c = s.cell(part, m);
                        return (
                          <td key={m} className="px-3 py-1 font-mono">
                            {c ? <span title={`v${c.eval_version} · judge ${c.judge_model} · ${c.source}${c.label ? ' · ' + c.label : ''} · ${new Date(c.created_at).toLocaleString()}`}>{c.score}<span className="opacity-40"> v{c.eval_version}</span></span> : <span className="opacity-30">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
