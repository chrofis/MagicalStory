/**
 * Trial writer: FLASH writes the ARC + Visual Bible + cover, SONNET medium writes the pages. Measurement only, nothing wired.
 * Owner 2026-10-10: "What about a Flash to create an arc and visual bible, and Sonnet medium for the text. Try it."
 * Call A (gemini-3.7-flash): per-page arc, title, Visual Bible, cover scene. Call B (claude-sonnet-5-5 medium): page texts + scene hints
 * bound to A's arc and bible. Templates are derived from prompts/story-trial.txt (prompts/experiments/story-trial-flasharc-{a,b}.txt).
 * Copy of the harness of eval-trial-vb-first.js (that file runs on load, so it cannot be imported).
 *
 *   node scripts/analysis/eval-trial-flash-arc-vb.js --phase=prompts
 *   node scripts/analysis/eval-trial-flash-arc-vb.js --phase=run --ids=1-10 [--cap=2.5]
 *   node scripts/analysis/eval-trial-flash-arc-vb.js --phase=blind --ids=1-10
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'prompts';
const CAP = Number(arg('cap') || 2.5);
const BASE = path.join(ROOT, 'evals/runs/2026-10-09_trial-writer-effort');
const V2 = path.join(ROOT, 'evals/runs/2026-10-10_trial-split-writer-v2');
// --v=2 (owner 2026-10-10 "Run it"): mandatory cast & objects line from the characters' special details + Flash reasoning effort low
const V2ON = arg('v') === '2';
const OUT = path.join(ROOT, V2ON ? 'evals/runs/2026-10-10_trial-flash-arc-vb-v2' : 'evals/runs/2026-10-10_trial-flash-arc-vb');
const VBF = path.join(ROOT, 'evals/runs/2026-10-10_trial-vb-first');
const OLD_IDS = ['job_1791579344291_rk2bno6av', 'job_1791496820206_qwcnrq30r', 'job_1791391658361_4eylyr1w4', 'job_1791554548909_kl0phznw2', 'job_1791551298726_19tfcxccl'];
const NEW_IDS = ['job_1791450452362_pv0l5hf49', 'job_1791450270543_n1iu8ipsu', 'job_1790769860433_2bhhj0pyi', 'job_1790680992018_nd95o89r7', 'job_1791500208126_at0wow7xa'];
const IDS = [...OLD_IDS, ...NEW_IDS];
const inputDir = id => (OLD_IDS.includes(id) ? path.join(BASE, id) : path.join(V2, id));
const range = s => { if (!s) return IDS; const [a, b] = s.split('-').map(Number); return IDS.slice(a - 1, (b || a)); };
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);

// ---- template derivation (moving/removing only) ----
const HEAD = "You write children's stories. Create a {PAGES}-scene story.";
// rules about page prose / page flow: they belong to call B
const A_DROP = [
  '- {PAGE_LENGTH_RULE}', '- {PAGE_OPENING_VARIETY}', '{STYLE_RULEBOOK}', '- {NEIGHBOUR_PHRASE}', '- {NO_DASH}', '- {MOTIVE_AT_THE_ACT}',
  '- The text never asserts a position', '- A sentence never gives one thing two states', '- Where a figure looks, faces or turns',
  "- Never describe a character's or creature's hair", '- No onomatopoeia', '- Page 1 starts with action', '- Show character personality',
  '- {PAGE_CONTINUITY}', '- {CLOSING_MOMENT}', "- A figure's first scene brings them in",
];
function deriveA(tpl) {
  const lines = tpl.split('\n');
  const kept = lines.filter(l => !A_DROP.some(p => l.startsWith(p)));
  if (lines.length - kept.length !== A_DROP.length) throw new Error(`A: removed ${lines.length - kept.length}, expected ${A_DROP.length}`);
  let t = kept.join('\n');
  if (!t.includes(HEAD)) throw new Error('A: header not found');
  const hs = t.indexOf('# Scene Hint Format'), ho = t.indexOf('# OUTPUT FORMAT'), sp = t.indexOf('---STORY PAGES---');
  if (hs < 0 || ho < hs || sp < ho) throw new Error('A: sections not found');
  const english = 'Every field of a scene hint is written in English, whatever the story language: a word of the story language for a thing, a dish or a creature becomes its English noun in the hint. A real place\'s name stays as the LANDMARKS list gives it.\n\n';
  t = t.slice(0, hs) + english + t.slice(ho, sp).trimEnd() + '\n';
  t = t.replace(HEAD, "You plan a {PAGES}-scene children's story and prepare its illustration side BEFORE any page exists. You write the ARC (a per-page plan), the title, the Visual Bible and the cover scene. You write NO page text and NO page scene hints; a second writer writes the pages afterwards, page by page, and must follow your arc beat by beat and use exactly your Visual Bible. So your arc is the story's logic and your Visual Bible its cast and props: both must be complete, because the second writer may not add a recurring figure, animal or object, and may not drop a beat.");
  const arcSection = `---STORY ARC---
One line per scene, all {PAGES} scenes, written in English (planning notes, not story prose):
PAGE [n]: [1-3 sentences: what happens, who does it and why, what is at stake or changes] | WITH: [every figure, animal and object that takes part, by name, separated by semicolons] | STATE: [any object whose state changes or whose holder or place changes on this page, e.g. "the letter gets soaked", "the key is set down on the bench"; "none" otherwise]

The arc is the whole story, so build it right: every beat follows from the one before it for a reason the reader can see, the low point has a scene of its own, and an object keeps its state and its place until a beat changes it (a wet thing stays wet until time or a drying beat; a thing set down stays there until someone picks it up). Every figure, animal and object the Story Idea names, and every one it plainly implies (a companion, a toy, a creature, an object the plot turns on), appears in the arc on the scenes where it matters.

`;
  t = t.replace('---TITLE---', arcSection + '---TITLE---');
  t = t.replace('Output all sections in this exact order. Do not skip any.', 'Output all sections in this exact order. Do not skip any. The Visual Bible must contain every figure, animal and object that the Story Idea names or that your arc uses on two or more scenes, each under the name the arc uses; the maximums below yield to this (the idea own named figures and objects always get their entry), and a figure or object that the arc uses on one scene only follows the one-scene rule below.');
  return t;
}
function deriveB(tpl) {
  if (!tpl.includes(HEAD)) throw new Error('B: header not found');
  const ho = tpl.indexOf('# OUTPUT FORMAT'), sp = tpl.indexOf('---STORY PAGES---');
  if (ho < 0 || sp < ho) throw new Error('B: sections not found');
  let t = tpl.slice(0, ho).replace(HEAD, "You write children's stories. Create a {PAGES}-scene story. A planner has already written the story's ARC, TITLE, Visual Bible and cover scene (below). They are FIXED, and the Visual Bible is already being drawn. You write ONLY the story pages and their scene hints: the prose of every page, in the story language.");
  t += `# THE PLAN (binding)

@@VB@@

The plan above is final. The ARC is the story: write page n from arc line n, so that everything it says happens on that page, happens on that page and for the reason it gives, and nothing a later line says has happened yet. You may not drop a beat, reorder beats or merge two pages. Every figure, animal and object on a line's WITH list is in that page's scene hint and in its text where the beat needs it; every STATE change is told on its page, and an object keeps the state and place the arc gave it until a later line changes it. Every secondary character, animal, artifact and location in your scene hints cites an id from the Visual Bible, on the pages it lists. You add no recurring character, animal, object, location or background; a figure the story needs on one page only follows the one-page rule above (no entry). Each scene's setting is the background that lists its page. The planner wrote English planning notes: take no wording, number word or name of a thing from them for the prose; the prose is yours, in the story language and the reading level, and the arc's facts are the only thing you carry over. The title is fixed; write no title.

# OUTPUT FORMAT

Output only the story pages, in this exact form, for ALL {PAGES} pages. No arc, no title, no Visual Bible, no cover scene.

`;
  t += tpl.slice(sp);
  return t;
}

// ---- harness ----
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
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { buildTrialStoryPrompt } = require(path.join(ROOT, 'server/lib/promptBuilders'));
  const orig = PROMPT_TEMPLATES.storyTrial;
  const tplA = deriveA(orig), tplB = deriveB(orig);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'prompts/experiments'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'prompts/experiments/story-trial-flasharc-a.txt'), tplA);
  fs.writeFileSync(path.join(ROOT, 'prompts/experiments/story-trial-flasharc-b.txt'), tplB);
  /** v2: the same character fields the trial prompt renders (traits.specialDetails, array traits, customTraits), as one binding line before the Story Idea */
  const mandatoryLine = input => {
    const items = [];
    for (const c of input.characters || []) {
      const t = c.traits; const bits = [];
      if (t && !Array.isArray(t) && t.specialDetails) bits.push(t.specialDetails);
      if (Array.isArray(t)) bits.push(...t);
      if (c.customTraits && !bits.includes(c.customTraits)) bits.push(c.customTraits);
      if (bits.length) items.push(c.name + ': ' + bits.join('; '));
    }
    return items.length ? '- **MANDATORY CAST & OBJECTS** (from the characters special details; binding): ' + items.join(' | ') + '. Every named figure, pet, toy and object here, and the object or creature of every activity named, appears in the arc AND in the Visual Bible with a role in the story, on the scenes where it matters (a toy, pet or object gets its own entry; an activity becomes something the character does or uses in the story). The maximums below yield to this.\n' : '';
  };
  const build = (tpl, input) => { PROMPT_TEMPLATES.storyTrial = tpl; try { let t = buildTrialStoryPrompt(input, input.pages); if (V2ON) { const m = mandatoryLine(input); if (m) { if (!t.includes('- **Story Idea**:')) throw new Error('story idea line not found'); t = t.replace('- **Story Idea**:', () => m + '- **Story Idea**:'); } } return t; } finally { PROMPT_TEMPLATES.storyTrial = orig; } };
  const loadInput = id => JSON.parse(fs.readFileSync(path.join(inputDir(id), 'inputData.json'), 'utf8'));
  const mediumFile = id => {
    if (!OLD_IDS.includes(id)) return path.join(V2, id, 'output-medium.txt');
    const k = readJson(path.join(BASE, 'arms-key.json'), {})[id];
    return path.join(BASE, id, `output-${['A', 'B'].find(l => k[l] === 'medium')}.txt`);
  };

  if (phase === 'prompts') {
    for (const id of IDS) {
      const input = loadInput(id); const d = path.join(OUT, id); fs.mkdirSync(d, { recursive: true });
      const a = build(tplA, input), b = build(tplB, input), full = build(orig, input);
      fs.writeFileSync(path.join(d, 'prompt-A.txt'), a); fs.writeFileSync(path.join(d, 'prompt-B-template.txt'), b); fs.writeFileSync(path.join(d, 'prompt-full.txt'), full);
      console.log(id, 'A', a.length, 'B', b.length, 'full', full.length, 'unfilled', (a + b).match(/\{[A-Z_]{4,}\}/g));
    }
    return;
  }

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

  const { callTextModelStreaming, TEXT_MODELS } = require(path.join(ROOT, 'server/lib/textModels'));
  const { ProgressiveUnifiedParser, UnifiedStoryParser } = require(path.join(ROOT, 'server/lib/outlineParser'));
  const { priceUsage } = require(path.join(ROOT, 'server/config/models'));

  /** one streamed call; `prefix` (call B) is call A's text, so the progressive parser sees the merged document. */
  async function timedCall(prompt, modelKey, effort, prefix = '') {
    const t0 = Date.now(); const ev = { pages: {} }; const since = () => Date.now() - t0;
    const parser = new ProgressiveUnifiedParser({
      onTitle: () => { ev.title = ev.title ?? since(); }, onVisualBible: () => { ev.vb = ev.vb ?? since(); },
      onCoverScene: () => { ev.cover = ev.cover ?? since(); }, onPageComplete: p => { ev.pages[p.pageNumber] = since(); },
    }, { isTrial: true });
    const isAnthropic = TEXT_MODELS[modelKey].provider === 'anthropic';
    const options = { usageLabel: 'unified_story', ...(effort ? (isAnthropic ? { effort } : { reasoning: { effort } }) : {}) };
    let first = null;
    const r = await callTextModelStreaming(prompt, null, (c, full) => { if (first === null) first = since(); parser.processChunk(c, prefix ? `${prefix}\n\n${full}` : full); }, modelKey, options);
    const ms = since(); parser.finalize();
    return { r, ms, ev, first, cost: priceUsage(r.modelId || TEXT_MODELS[modelKey].modelId, r.usage || {}) };
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

  if (phase === 'run') {
    const ids = range(arg('ids')).filter(id => !fs.existsSync(path.join(OUT, id, 'run-metrics.json')));
    guard(0.2 * ids.length);
    await Promise.all(ids.map(async id => { try {
      const input = loadInput(id); const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
      const mainName = (input.characters.find(c => c.role === 'main') || input.characters[0]).name;
      const a = await timedCall(build(tplA, input), 'gemini-3.7-flash', V2ON ? 'low' : 'medium');
      fs.writeFileSync(path.join(dir, 'output-A.txt'), a.r.text); book({ part: 1, id, call: 'A', cost: a.cost });
      const promptB = build(tplB, input).replace('@@VB@@', () => a.r.text.trim());
      fs.writeFileSync(path.join(dir, 'prompt-B.txt'), promptB);
      const b = await timedCall(promptB, 'claude-sonnet-5-5', 'medium', a.r.text.trim());
      fs.writeFileSync(path.join(dir, 'output-B.txt'), b.r.text); book({ part: 1, id, call: 'B', cost: b.cost });
      // the progressive parser closes the cover only at the next marker; A ends on the cover, so a sentinel marks where the parse is judged
      let coverEvent = false;
      const cp = new ProgressiveUnifiedParser({ onCoverScene: () => { coverEvent = true; } }, { isTrial: true });
      cp.processChunk('', `${a.r.text.trim()}

---STORY PAGES---
`); cp.finalize();
      const merged = `${a.r.text.trim()}\n\n${b.r.text.trim()}`;
      const sa = parseSimple(a.r.text), sb = parseSimple(b.r.text);
      const m = {
        id, aVbMs: a.ev.vb, aCoverMs: a.ev.cover, aTitleMs: a.ev.title, aTotalMs: a.ms, aOut: a.r.usage?.output_tokens, aIn: a.r.usage?.input_tokens, aCost: a.cost,
        bFirstMs: b.first, bPage1Ms: b.ev.pages[1], bPagesMs: b.ev.pages, bTotalMs: b.ms, bOut: b.r.usage?.output_tokens, bIn: b.r.usage?.input_tokens, bCost: b.cost,
        page1ImageStartS: (a.ms + b.ev.pages[1]) / 1000, totalS: (a.ms + b.ms) / 1000, costUsd: a.cost + b.cost, stops: [a.r.stop_reason, b.r.stop_reason],
        real: { ...realParse(merged), coverEventWithSentinel: coverEvent }, respect: sa.vb ? vbRespect(sa.vb, sb.pages, mainName) : { error: sa.vbError || 'no vb' }, arcRespect: arcRespect(parseArc(a.r.text), sb.pages, sa.vb), arcLines: parseArc(a.r.text).length,
      };
      fs.writeFileSync(path.join(dir, 'run-metrics.json'), JSON.stringify(m, null, 2));
      console.log(id, `A vb=${(m.aVbMs / 1000).toFixed(1)}s total=${(a.ms / 1000).toFixed(1)}s | B p1=${(m.bPage1Ms / 1000).toFixed(1)}s total=${(b.ms / 1000).toFixed(1)}s | p1img@${m.page1ImageStartS.toFixed(1)}s all=${m.totalS.toFixed(1)}s $${m.costUsd.toFixed(3)} spend=$${spendOf().toFixed(3)}`);
    } catch (e) { console.log(id, 'ERROR', String(e.message || e).slice(0, 300)); } }));
    console.log('DONE spend', spendOf().toFixed(3));
    return;
  }

})().then(() => process.exit(0)).catch(e => { console.error('ERR', e); process.exit(1); });
