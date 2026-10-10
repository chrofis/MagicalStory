/**
 * Trial writer measurement harness: the PRODUCTION two-call trial writer (server/lib/trialWriter.js: planner
 * gemini-3.7-flash at reasoning low, then the Sonnet pages writer) over stored trial inputs, with timings from
 * the production progressive-parser events, id-binding checks and a blind-read file writer. Text only.
 * Owner 2026-10-10: "Fix Flash's arc" (v4); the run it measured is evals/runs/2026-10-10_trial-flash-arc-vb-v4.
 * Earlier variants (v1 to v3, the single-call baseline, the template derivation) lived in this file until commit
 * 4e5386fbf; their numbers are in docs/decisions.md.
 *
 *   node scripts/analysis/eval-trial-flash-arc-vb.js --phase=run   --ids=1-13 [--cap=1.5] [--out=evals/runs/<dir>]
 *   node scripts/analysis/eval-trial-flash-arc-vb.js --phase=blind --ids=1-13
 *   node scripts/analysis/eval-trial-flash-arc-vb.js --phase=pages --ids=1-13 --arcs=evals/runs/2026-10-10_trial-flash-arc-vb-v4 --out=<dir>
 *     (pages call B only, over the stored planner output A of an earlier run: measures a pages-prompt change)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'run';
const CAP = Number(arg('cap') || 1.5);
const OUT = path.join(ROOT, arg('out') || 'evals/runs/2026-10-10_trial-flash-arc-vb-v4');
// stored inputs and single-Sonnet-medium baselines of the 13 measured inputs
const BASE = path.join(ROOT, 'evals/runs/2026-10-09_trial-writer-effort');
const V2 = path.join(ROOT, 'evals/runs/2026-10-10_trial-split-writer-v2');
const FRESH_DIR = path.join(ROOT, 'evals/runs/2026-10-10_trial-flash-arc-vb-v2-fresh');
const OLD_IDS = ['job_1791579344291_rk2bno6av', 'job_1791496820206_qwcnrq30r', 'job_1791391658361_4eylyr1w4', 'job_1791554548909_kl0phznw2', 'job_1791551298726_19tfcxccl'];
const NEW_IDS = ['job_1791450452362_pv0l5hf49', 'job_1791450270543_n1iu8ipsu', 'job_1790769860433_2bhhj0pyi', 'job_1790680992018_nd95o89r7', 'job_1791500208126_at0wow7xa'];
const FRESH3 = ['job_1791490151653_r9mypyn0c', 'job_1789944735873_vmbd0or30', 'job_1791497394846_v01s6ndpn'];
// the owner's first live trial on the two-call writer (staging, unnamed toy): inputData, planner output A and pages B as stored
const STORED_DIR = path.join(ROOT, 'evals/runs/2026-10-10_trial-pages-openings-stored');
const STORED = ['job_1791628382638_yka3zzxte'];
const IDS = [...OLD_IDS, ...NEW_IDS, ...FRESH3, ...STORED];
const inputDir = id => (STORED.includes(id) ? path.join(STORED_DIR, id) : FRESH3.includes(id) ? path.join(FRESH_DIR, id) : OLD_IDS.includes(id) ? path.join(BASE, id) : path.join(V2, id));
const range = s => { if (!s) return IDS; const [a, b] = s.split('-').map(Number); return IDS.slice(a - 1, (b || a)); };
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const mediumFile = id => {
  if (FRESH3.includes(id)) return path.join(FRESH_DIR, id, 'output-medium.txt');
  if (!OLD_IDS.includes(id)) return path.join(V2, id, 'output-medium.txt');
  const k = readJson(path.join(BASE, 'arms-key.json'), {})[id];
  return path.join(BASE, id, `output-${['A', 'B'].find(l => k[l] === 'medium')}.txt`);
};
const ledgerFile = path.join(OUT, 'ledger.jsonl');
const spendOf = () => (fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).reduce((n, l) => n + JSON.parse(l).cost, 0) : 0);
const book = (rec) => fs.appendFileSync(ledgerFile, JSON.stringify(rec) + '\n');

function jsonBlock(body) { const m = body.match(/```json\s*([\s\S]*?)```/); if (!m) return null; try { return JSON.parse(m[1]); } catch (e) { return null; } }
function parseSimple(text) {
  const out = { title: (text.match(/TITLE:\s*(.*)/) || [])[1] || null, pages: [] };
  const vbm = text.match(/---VISUAL BIBLE---\s*```json\s*([\s\S]*?)```/);
  if (vbm) { try { out.vb = JSON.parse(vbm[1]); } catch (e) { out.vbError = e.message; } }
  const parts = text.split(/--- Page (\d+) ---/);
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1];
    const tm = body.match(/TEXT:\s*([\s\S]*?)(?:\n\s*SCENE HINT:|$)/);
    out.pages.push({ n: Number(parts[i]), text: tm ? tm[1].trim() : '', hint: jsonBlock(body) });
  }
  return out;
}


(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const loadInput = id => JSON.parse(fs.readFileSync(path.join(inputDir(id), 'inputData.json'), 'utf8'));
  const { loadPromptTemplates } = require(path.join(ROOT, 'server/services/prompts'));
  const { runTrialWriter } = require(path.join(ROOT, 'server/lib/trialWriter'));
  const { ProgressiveUnifiedParser, UnifiedStoryParser } = require(path.join(ROOT, 'server/lib/outlineParser'));
  const { priceUsage } = require(path.join(ROOT, 'server/config/models'));

  if (phase === 'blind') {
    const arm = 'run';
    const keyFile = path.join(OUT, `blind-key-${arm}.json`); const key = readJson(keyFile, {});
    const render = (title, pages) => `TITLE: ${title}\n\n` + pages.map(p => {
      const sc = p.hint?.scene || {};
      return `=== PAGE ${p.n} ===\n${p.text}\n[SCENE: ${sc.imageSummary || '?'} | chars: ${(sc.characters || []).map(c => `${c.name} (${c.action || ''})`).join('; ')} | objects: ${(sc.objects || []).map(o => o.name).join(', ')}]\n`;
    }).join('\n');
    for (const id of range(arg('ids'))) {
      const d = path.join(OUT, id);
      let armText;
      if (arm === 'run') {
        const a = parseSimple(fs.readFileSync(path.join(d, 'output-A.txt'), 'utf8'));
        const b = parseSimple(fs.readFileSync(path.join(d, 'output-B.txt'), 'utf8'));
        armText = render(a.title, b.pages);
      } else {
        const f = path.join(d, `output-${arm}.txt`); if (!fs.existsSync(f)) continue;
        const s = parseSimple(fs.readFileSync(f, 'utf8')); armText = render(s.title, s.pages);
      }
      const med = parseSimple(fs.readFileSync(mediumFile(id), 'utf8'));
      const arms = { test: armText, medium: render(med.title, med.pages) };
      if (!key[id]) key[id] = Math.random() < 0.5 ? { X: 'test', Y: 'medium' } : { X: 'medium', Y: 'test' };
      fs.writeFileSync(path.join(d, `blind-${arm}-X.txt`), arms[key[id].X]); fs.writeFileSync(path.join(d, `blind-${arm}-Y.txt`), arms[key[id].Y]);
    }
    fs.writeFileSync(keyFile, JSON.stringify(key, null, 2));
    console.log('blind files written for', Object.keys(key).length);
    return;
  }

  /** the real parser over the merged document */
  function realParse(text) {
    const p = new UnifiedStoryParser(text, { isTrial: true });
    const out = {};
    try { out.title = !!p.extractTitle(); } catch (e) { out.titleErr = e.message; }
    try { const vb = p.extractVisualBible(); out.vbOk = !!vb; out.vbCounts = vb ? { sec: (vb.secondaryCharacters || []).length, ani: (vb.animals || []).length, art: (vb.artifacts || []).length, loc: (vb.locations || []).length, bg: (vb.backgrounds || []).length } : null; } catch (e) { out.vbErr = e.message; }
    try { const c = p.extractCoverHints(); out.coverOk = !!(c && (c.titlePage || c.frontCover || Object.keys(c).length)); } catch (e) { out.coverErr = e.message; }
    try { const pg = p.extractPages(); out.pages = pg.length; out.hints = pg.filter(x => x.sceneHint || x.hint || x.scene).length; out.pageKeys = pg[0] ? Object.keys(pg[0]).join(',') : ''; } catch (e) { out.pagesErr = e.message; }
    return out;
  }
  /** arc lines: PAGE n: ... | WITH: a; b | STATE: ... */
function parseArc(text) {
  const m = text.match(/---STORY ARC---\s*([\s\S]*?)(?=---[A-Z\s]+---|$)/i); if (!m) return [];
  return m[1].split(/\r?\n/).map(l => l.match(/^\s*PAGE\s+(\d+)\s*:\s*(.*?)\|\s*WITH\s*:\s*(.*?)(?:\|\s*STATE\s*:\s*(.*))?$/i)).filter(Boolean)
    .map(x => ({ n: Number(x[1]), what: x[2].trim(), with: x[3].split(';').map(w => w.trim()).filter(Boolean), state: (x[4] || '').trim() }));
}
/** names the arc puts on page n vs the names in that page's hint (characters, objects, and the location); fuzzy by shared word stems, ids/names only */
function arcRespect(arc, hints, vb) {
  const norm = w => String(w).toLowerCase().replace(/[^a-z0-9äöüéèàß ]/g, ' ').split(/\s+/).filter(x => x.length > 2);
  const el = []; for (const list of [vb?.secondaryCharacters, vb?.animals, vb?.artifacts, vb?.locations]) for (const e of list || []) el.push([e.name, e.label, e.properName].filter(Boolean).join(' '));
  let total = 0, inHint = 0, inVb = 0; const missing = [], notInVb = [];
  for (const a of arc) {
    const h = hints.find(x => x.n === a.n)?.hint?.scene; if (!h) continue;
    const hay = new Set(norm([...(h.characters || []).map(c => c.name), ...(h.objects || []).map(o => o.name), h.setting?.location, h.imageSummary].join(' ')));
    for (const w of a.with) { total++; const ws = norm(w);
      if (ws.some(t => hay.has(t))) inHint++; else missing.push(`p${a.n}:${w}`);
      if (el.some(txt => { const set = new Set(norm(txt)); return ws.some(t => set.has(t)); })) inVb++; else notInVb.push(`p${a.n}:${w}`); }
  }
  return { arcPages: arc.length, withItems: total, inHint, inVb, missing, notInVb };
}
/** VB respect, by ids and enums only (no prose reading): ids B cites that A's VB lacks, VB ids no hint cites, citations outside the VB's pages, unlisted figures/objects */
  function vbRespect(vb, hints, mainName) {
    const el = {};
    for (const [k, list] of [['sec', vb.secondaryCharacters], ['ani', vb.animals], ['art', vb.artifacts], ['loc', vb.locations]]) for (const e of list || []) if (e?.id) el[e.id] = { kind: k, name: e.name || e.label, pages: e.pages || [] };
    const cited = {}; const foreign = []; const outside = []; const unlistedFigs = []; const unlistedObjs = []; const badLoc = [];
    for (const h of hints) {
      const sc = h.hint?.scene; if (!sc) continue;
      const note = (id, n) => { if (!id) return; cited[id] = (cited[id] || 0) + 1; if (!el[id]) foreign.push(`p${n}:${id}`); else if (el[id].pages.length && !el[id].pages.includes(n)) outside.push(`p${n}:${id}`); };
      for (const c of sc.characters || []) { if (c.id) note(c.id, h.n); else if (c.name && c.name !== mainName) unlistedFigs.push(`p${h.n}:${c.name}`); }
      for (const o of sc.objects || []) { if (o.id) note(o.id, h.n); else if (o.name) unlistedObjs.push(`p${h.n}:${o.name}`); }
      const lm = String(sc.setting?.location || '').match(/LOC\d+/); if (lm) note(lm[0], h.n); else badLoc.push(`p${h.n}`);
    }
    const unused = Object.keys(el).filter(id => !cited[id]);
    return { vbIds: Object.keys(el).length, foreign, outside, unused, unlistedFigs, unlistedObjs, noLocId: badLoc };
  }
  const guard = (est) => { const s = spendOf(); if (s + est > CAP) { console.log(`STOP: spend ${s.toFixed(3)} + est ${est} > cap ${CAP}`); process.exit(0); } };

  if (phase === 'pages') {
    await loadPromptTemplates();
    const { buildTrialPagesPrompt } = require(path.join(ROOT, 'server/lib/promptBuilders'));
    const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
    const { MODEL_DEFAULTS } = require(path.join(ROOT, 'server/config/models'));
    const arcsDir = path.join(ROOT, arg('arcs'));
    const ids = range(arg('ids')).filter(id => !fs.existsSync(path.join(OUT, id, 'output-B.txt')));
    guard(0.095 * ids.length);
    await Promise.all(ids.map(async id => { try {
      const input = loadInput(id); const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
      const arcFile = path.join(arcsDir, id, 'output-A.txt');
      const arcText = fs.readFileSync(fs.existsSync(arcFile) ? arcFile : path.join(STORED_DIR, id, 'output-A.txt'), 'utf8');
      const prompt = buildTrialPagesPrompt(input, input.pages, arcText);
      const r = await callTextModelStreaming(prompt, null, () => {}, 'claude-sonnet', { usageLabel: 'unified_story', effort: MODEL_DEFAULTS.trialStoryEffort });
      const cost = priceUsage(r.modelId, r.usage || {});
      fs.writeFileSync(path.join(dir, 'output-B.txt'), String(r.text || '').trim()); fs.writeFileSync(path.join(dir, 'prompt-B.txt'), prompt);
      book({ id, cost }); console.log(id, `$${cost.toFixed(3)} spend=$${spendOf().toFixed(3)}`);
    } catch (e) { console.log(id, 'ERROR', String(e.message || e).slice(0, 300)); } }));
    console.log('DONE spend', spendOf().toFixed(3));
    return;
  }

  if (phase === 'run') {
    await loadPromptTemplates();
    const ids = range(arg('ids')).filter(id => !fs.existsSync(path.join(OUT, id, 'run-metrics.json')));
    guard(0.11 * ids.length);
    await Promise.all(ids.map(async id => { try {
      const input = loadInput(id); const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
      const mainName = (input.characters.find(c => c.role === 'main') || input.characters[0]).name;
      const t0 = Date.now(); const ev = { pages: {} }; const since = () => Date.now() - t0;
      const parser = new ProgressiveUnifiedParser({
        onTitle: () => { ev.title = ev.title ?? since(); }, onVisualBible: () => { ev.vb = ev.vb ?? since(); },
        onCoverScene: () => { ev.cover = ev.cover ?? since(); }, onPageComplete: p => { ev.pages[p.pageNumber] = since(); },
      }, { isTrial: true });
      const w = await runTrialWriter({
        inputData: input, sceneCount: input.pages, pagesModel: 'claude-sonnet',
        onArcText: (a, merged) => { ev.arcDone = since(); parser.processChunk('', merged); },
        onPagesChunk: (c, merged) => parser.processChunk(c, merged),
      });
      parser.finalize(); const ms = since();
      const aCost = priceUsage(w.arcResult.modelId, w.arcResult.usage || {}), bCost = priceUsage(w.pagesResult.modelId, w.pagesResult.usage || {});
      fs.writeFileSync(path.join(dir, 'output-A.txt'), w.arcText); fs.writeFileSync(path.join(dir, 'output-B.txt'), w.pagesText);
      fs.writeFileSync(path.join(dir, 'prompt-A.txt'), w.arcPrompt); fs.writeFileSync(path.join(dir, 'prompt-B.txt'), w.pagesPrompt);
      book({ id, cost: aCost + bCost });
      const sa = parseSimple(w.arcText), sb = parseSimple(w.pagesText);
      const m = {
        id, aVbMs: ev.vb, aCoverMs: ev.cover, aTitleMs: ev.title, aTotalMs: ev.arcDone, aCost, bCost,
        page1ImageStartS: ev.pages[1] / 1000, totalS: ms / 1000, costUsd: aCost + bCost, pagesMs: ev.pages,
        real: realParse(w.text), respect: sa.vb ? vbRespect(sa.vb, sb.pages, mainName) : { error: sa.vbError || 'no vb' }, arcRespect: arcRespect(parseArc(w.arcText), sb.pages, sa.vb),
      };
      fs.writeFileSync(path.join(dir, 'run-metrics.json'), JSON.stringify(m, null, 2));
      console.log(id, `bible=${(ev.vb / 1000).toFixed(1)}s p1img@${m.page1ImageStartS.toFixed(1)}s all=${m.totalS.toFixed(1)}s $${m.costUsd.toFixed(3)} spend=$${spendOf().toFixed(3)}`);
    } catch (e) { console.log(id, 'ERROR', String(e.message || e).slice(0, 300)); } }));
    console.log('DONE spend', spendOf().toFixed(3));
    return;
  }
})().then(() => process.exit(0)).catch(e => { console.error('ERR', e); process.exit(1); });
