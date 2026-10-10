/**
 * Trial writer: (part 1) VB-FIRST split, (part 2) other models for the single call. Measurement only, nothing wired.
 * Owner 2026-10-10: "Test just the Visual Bible first with low effort, so that this can render. Check also
 * different models. Anything as good as Sonnet but faster?"
 *
 * Part 1: call A (Sonnet 5.5, low) writes ONLY title + Visual Bible + cover scene (no plan, no pages);
 *   call B (Sonnet 5.5, medium) writes the story pages + scene hints with A's output as the binding Visual Bible.
 *   Both templates are derived from prompts/story-trial.txt by moving/removing sections (prompts/experiments/story-trial-vbfirst-{a,b}.txt).
 * Part 2: the unchanged trial prompt on other TEXT_MODELS keys.
 * Inputs: the same 10 stored trial inputs as eval-trial-split-writer.js. Medium baselines are the stored outputs.
 *
 *   node scripts/analysis/eval-trial-vb-first.js --phase=prompts
 *   node scripts/analysis/eval-trial-vb-first.js --phase=p1 --ids=1        # or --ids=2-10 (parallel); cap enforced
 *   node scripts/analysis/eval-trial-vb-first.js --phase=p2 --model=<TEXT_MODELS key> --ids=1-3 [--effort=low|medium]
 *   node scripts/analysis/eval-trial-vb-first.js --phase=blind --arm=p1|<model>   # arm-hidden X/Y files + key
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'prompts';
const CAP = Number(arg('cap') || 3.0);
const BASE = path.join(ROOT, 'evals/runs/2026-10-09_trial-writer-effort');
const V2 = path.join(ROOT, 'evals/runs/2026-10-10_trial-split-writer-v2');
const OUT = path.join(ROOT, 'evals/runs/2026-10-10_trial-vb-first');
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
  t = t.replace(HEAD, "You prepare the illustration side of a {PAGES}-scene children's story BEFORE any page exists: the title, the Visual Bible and the cover scene. You write NO page text and NO page scene hints; a second writer writes the pages afterwards and must use exactly your Visual Bible: its characters, animals, artifacts, locations and backgrounds. So the `pages` of every element and of every background are your commitment: place each element on the scenes where the story built from the idea will use it (introduce in scene 1, tension, setback, resolution as the shape below says), and give the story what it needs and nothing more.");
  return t;
}
function deriveB(tpl) {
  if (!tpl.includes(HEAD)) throw new Error('B: header not found');
  const ho = tpl.indexOf('# OUTPUT FORMAT'), sp = tpl.indexOf('---STORY PAGES---');
  if (ho < 0 || sp < ho) throw new Error('B: sections not found');
  let t = tpl.slice(0, ho).replace(HEAD, "You write children's stories. Create a {PAGES}-scene story. The title, the Visual Bible and the cover scene are FIXED (below) and are already being drawn. Write ONLY the story pages and their scene hints.");
  t += `# THE VISUAL BIBLE (binding)

@@VB@@

The Visual Bible above is final. Every secondary character, animal, artifact and location in your scene hints cites an id from it, on the pages it lists. You add no recurring character, animal, object, location or background to it; a figure the story needs on one page only follows the one-page rule above (no entry). Every location in a scene hint is a location of the Visual Bible, and each scene's setting is the background that lists its page. Use every element of it in the story, and when a beat seems to need something it lacks, tell the beat with what it has. The story is built on the title and the idea.

# OUTPUT FORMAT

Output only the story pages, in this exact form, for ALL {PAGES} pages. No title, no Visual Bible, no cover scene.

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
  fs.writeFileSync(path.join(ROOT, 'prompts/experiments/story-trial-vbfirst-a.txt'), tplA);
  fs.writeFileSync(path.join(ROOT, 'prompts/experiments/story-trial-vbfirst-b.txt'), tplB);
  const build = (tpl, input) => { PROMPT_TEMPLATES.storyTrial = tpl; try { return buildTrialStoryPrompt(input, input.pages); } finally { PROMPT_TEMPLATES.storyTrial = orig; } };
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
    const arm = arg('arm');
    const keyFile = path.join(OUT, `blind-key-${arm}.json`); const key = readJson(keyFile, {});
    const render = (title, pages) => `TITLE: ${title}\n\n` + pages.map(p => {
      const sc = p.hint?.scene || {};
      return `=== PAGE ${p.n} ===\n${p.text}\n[SCENE: ${sc.imageSummary || '?'} | chars: ${(sc.characters || []).map(c => `${c.name} (${c.action || ''})`).join('; ')} | objects: ${(sc.objects || []).map(o => o.name).join(', ')}]\n`;
    }).join('\n');
    for (const id of range(arg('ids'))) {
      const d = path.join(OUT, id);
      let armText;
      if (arm === 'p1') {
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

  if (phase === 'p1') {
    const ids = range(arg('ids')).filter(id => !fs.existsSync(path.join(OUT, id, 'p1-metrics.json')));
    guard(0.25 * ids.length);
    await Promise.all(ids.map(async id => { try {
      const input = loadInput(id); const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
      const mainName = (input.characters.find(c => c.role === 'main') || input.characters[0]).name;
      const a = await timedCall(build(tplA, input), 'claude-sonnet-5-5', 'low');
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
        real: { ...realParse(merged), coverEventWithSentinel: coverEvent }, respect: sa.vb ? vbRespect(sa.vb, sb.pages, mainName) : { error: sa.vbError || 'no vb' },
      };
      fs.writeFileSync(path.join(dir, 'p1-metrics.json'), JSON.stringify(m, null, 2));
      console.log(id, `A vb=${(m.aVbMs / 1000).toFixed(1)}s total=${(a.ms / 1000).toFixed(1)}s | B p1=${(m.bPage1Ms / 1000).toFixed(1)}s total=${(b.ms / 1000).toFixed(1)}s | p1img@${m.page1ImageStartS.toFixed(1)}s all=${m.totalS.toFixed(1)}s $${m.costUsd.toFixed(3)} spend=$${spendOf().toFixed(3)}`);
    } catch (e) { console.log(id, 'ERROR', String(e.message || e).slice(0, 300)); } }));
    console.log('DONE spend', spendOf().toFixed(3));
    return;
  }

  if (phase === 'p2') {
    const model = arg('model'); const effort = arg('effort') || null; const label = arg('label') || (model + (effort ? `-${effort}` : ''));
    if (!TEXT_MODELS[model]) throw new Error(`unknown model ${model}`);
    const est = Number(arg('est') || 0.25);
    const ids = range(arg('ids')).filter(id => !fs.existsSync(path.join(OUT, id, `p2-${label}.json`)));
    guard(est * ids.length);
    await Promise.all(ids.map(async id => {
      const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
      const input = loadInput(id);
      const mainName = (input.characters.find(c => c.role === 'main') || input.characters[0]).name;
      let m;
      try {
        const c = await timedCall(fs.readFileSync(path.join(dir, 'prompt-full.txt'), 'utf8'), model, effort);
        fs.writeFileSync(path.join(dir, `output-${label}.txt`), c.r.text); book({ part: 2, id, label, cost: c.cost });
        const s = parseSimple(c.r.text);
        m = { id, label, model, effort, vbMs: c.ev.vb ?? null, coverMs: c.ev.cover ?? null, page1Ms: c.ev.pages[1] ?? null, totalMs: c.ms, firstMs: c.first, out: c.r.usage?.output_tokens, think: c.r.usage?.thinking_tokens ?? c.r.usage?.reasoning_tokens, costUsd: c.cost, stop: c.r.stop_reason,
          real: realParse(c.r.text), respect: s.vb ? vbRespect(s.vb, s.pages, mainName) : { error: s.vbError || 'no vb' }, truncation: c.r.truncation?.suspected ? c.r.truncation.reason : null };
      } catch (e) { m = { id, label, model, error: String(e.message || e).slice(0, 300) }; }
      fs.writeFileSync(path.join(dir, `p2-${label}.json`), JSON.stringify(m, null, 2));
      console.log(id, label, m.error ? `ERROR ${m.error}` : `vb=${((m.vbMs || 0) / 1000).toFixed(1)}s total=${(m.totalMs / 1000).toFixed(1)}s out=${m.out} $${m.costUsd.toFixed(3)} pages=${m.real.pages} vbOk=${m.real.vbOk} spend=$${spendOf().toFixed(3)}`);
    }));
    console.log('DONE spend', spendOf().toFixed(3));
    return;
  }
})().then(() => process.exit(0)).catch(e => { console.error('ERR', e); process.exit(1); });
