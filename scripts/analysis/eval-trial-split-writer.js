/**
 * Trial SPLIT writer experiment: call A (effort low) = title + Visual Bible + cover + per page PLAN line +
 * scene hint, no prose; call B (effort medium) = page TEXTS only, with A's output as the binding plan.
 * v2 (2026-10-10, owner: "test it on 10 stories, can Jev detect the issues, any fast way to fix them"):
 *   - call A's rules say every introduced figure keeps a role and a changed object stays changed;
 *   - a plan check on A's PLAN (code: a Visual Bible figure no scene hint cites; Jev: defect-worded questions);
 *   - when it flags, call A is re-run ONCE (low) with the reasons fed back, then B as usual.
 * v1 (commit b57daf310) had no rules and no check; its results stay in evals/runs/2026-10-10_trial-split-writer/.
 * Both templates are derived from prompts/story-trial.txt by removal/replacement (nothing wired in
 * production); the real buildTrialStoryPrompt fills them via an in-process template override.
 *
 *   node scripts/analysis/eval-trial-split-writer.js --phase=prompts          # free: build + store prompts
 *   node scripts/analysis/eval-trial-split-writer.js --phase=inputs           # free: load the 5 new inputs from stored stories
 *   node scripts/analysis/eval-trial-split-writer.js --phase=run [--cap=3.4]  # paid: split v2 with check + fix, all 10 inputs
 *   node scripts/analysis/eval-trial-split-writer.js --phase=baseline [--cap=3.4]  # paid: single medium call on the 5 new inputs
 *   node scripts/analysis/eval-trial-split-writer.js --phase=blind            # free: arm-hidden files X / Y per input + blind-key.json
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'prompts';
const CAP = Number(arg('cap') || 3.4);
const BASE = path.join(ROOT, 'evals/runs/2026-10-09_trial-writer-effort');
const OUT = path.join(ROOT, 'evals/runs/2026-10-10_trial-split-writer-v2');
const OLD_IDS = [
  'job_1791579344291_rk2bno6av', 'job_1791496820206_qwcnrq30r', 'job_1791391658361_4eylyr1w4',
  'job_1791554548909_kl0phznw2', 'job_1791551298726_19tfcxccl',
];
// new inputs: stored trial stories (story rows keep the inputs); value = which database holds the row
const NEW_IDS = {
  job_1791450452362_pv0l5hf49: 'STAGING_DATABASE_URL', // en, 5, life-challenge being-patient, Baden landmarks
  job_1791450270543_n1iu8ipsu: 'STAGING_DATABASE_URL', // de, 3, adventure ninja, 2 landmarks
  job_1790769860433_2bhhj0pyi: 'DATABASE_URL',         // fr-ch, 8, life-challenge screen-time, no landmarks
  job_1790680992018_nd95o89r7: 'DATABASE_URL',         // de-ch, 8, adventure unicorn, no landmarks
  job_1791500208126_at0wow7xa: 'STAGING_DATABASE_URL', // en, 7, adventure wizard, 2 landmarks
};
const IDS = [...OLD_IDS, ...Object.keys(NEW_IDS)];
const inputDir = id => (OLD_IDS.includes(id) ? path.join(BASE, id) : path.join(OUT, id));

// ---- template derivation (removal/replacement only) ----
const PROSE_ONLY = [
  '- {PAGE_LENGTH_RULE}', '- {PAGE_OPENING_VARIETY}', '{STYLE_RULEBOOK}', '- {NEIGHBOUR_PHRASE}', '- {NO_DASH}', '- {MOTIVE_AT_THE_ACT}',
  '- The text never asserts a position', '- A sentence never gives one thing two states',
  '- Where a figure looks, faces or turns', "- Never describe a character's or creature's hair",
  '- No onomatopoeia',
];
const HEAD = "You write children's stories. Create a {PAGES}-scene story.";
const PLAN_ANCHOR = "- A figure's first scene brings them in, by arriving or by a name someone present says, before they speak or act\n";
// v2 plan rules (owner 2026-10-10): the two slips the v1 blind read found. Generic wording.
const PLAN_RULES = [
  '- Every figure the idea or the Visual Bible introduces (person, creature, toy) keeps a role: it appears in the scenes it matters to, and no PLAN line leaves it out or forgets it without a reason.',
  '- A change to an object stays in every later PLAN line (torn, lost, broken, eaten, spilled) unless a scene changes it back. Check each PLAN line against the earlier ones.',
].join('\n') + '\n';
function deriveA(tpl) {
  const lines = tpl.split('\n');
  const kept = lines.filter(l => !PROSE_ONLY.some(p => l.startsWith(p)));
  if (lines.length - kept.length !== PROSE_ONLY.length) throw new Error(`A: removed ${lines.length - kept.length} lines, expected ${PROSE_ONLY.length}`);
  let t = kept.join('\n');
  if (!t.includes(HEAD)) throw new Error('A: header not found');
  if (!t.includes(PLAN_ANCHOR)) throw new Error('A: plan-rule anchor not found');
  t = t.replace(PLAN_ANCHOR, () => PLAN_ANCHOR + PLAN_RULES);
  t = t.replace(HEAD, "You plan children's stories for illustration. Plan a {PAGES}-scene story: the title, the Visual Bible, the cover scene and, per scene, a PLAN line and a scene hint. You write NO page prose: a second writer writes the page texts from your plan alone, in the story language. So each PLAN line (plain English, 1-3 sentences) carries what the text needs and the hint cannot show: who does what and why, what each figure knows, what is said or decided, what the page sets up or pays off. The hint shows exactly what is drawn.");
  const before = t;
  t = t.replace('TEXT:\n[Story text, {PAGE_WORDS} words]', 'PLAN:\n[1-3 plain English sentences, no prose]').replace('TEXT:\n[Story continues...]', 'PLAN:\n[...]');
  if (t === before || t.includes('{PAGE_WORDS}')) throw new Error('A: TEXT blocks not replaced');
  return t;
}
function deriveB(tpl) {
  if (!tpl.includes(HEAD)) throw new Error('B: header not found');
  const i = tpl.indexOf('# Scene Hint Format');
  if (i < 0) throw new Error('B: scene hint section not found');
  let t = tpl.slice(0, i).replace(HEAD, "You write children's stories. The plan of a {PAGES}-scene story is FIXED (below): its title, Visual Bible, cover and, per scene, a plan line and a scene hint. Write ONLY the page texts. Each page's text tells what that page's plan line and scene hint say, and nothing the hint does not stage: the figures, the place and the action of the hint are what the picture shows. Plan lines and hints are never changed, extended or contradicted.");
  t += `# THE PLAN (binding)

@@PLAN@@

# OUTPUT FORMAT

Output only the page texts, in this exact form, for ALL {PAGES} pages. No title, no scene hints.

--- Page 1 ---
TEXT:
[Story text, {PAGE_WORDS} words]

--- Page 2 ---
TEXT:
[Story continues...]

... continue for ALL {PAGES} pages ...
`;
  return t;
}

// ---- parsing call A / medium output ----
function parseStory(text) {
  const out = { title: (text.match(/TITLE:\s*(.*)/) || [])[1] || null, vb: null, pages: [] };
  const vbm = text.match(/---VISUAL BIBLE---\s*```json\s*([\s\S]*?)```/);
  if (vbm) { try { out.vb = JSON.parse(vbm[1]); } catch (e) { out.vbError = e.message; } }
  const parts = text.split(/--- Page (\d+) ---/);
  for (let i = 1; i < parts.length; i += 2) {
    const body = parts[i + 1];
    const hm = body.match(/```json\s*([\s\S]*?)```/);
    let hint = null; if (hm) { try { hint = JSON.parse(hm[1]); } catch (e) { hint = null; } }
    const tm = body.match(/(PLAN|TEXT):\s*([\s\S]*?)(?:\n\s*SCENE HINT:|$)/);
    out.pages.push({ n: Number(parts[i]), kind: tm ? tm[1] : null, body: tm ? tm[2].trim() : '', hint });
  }
  return out;
}

// ---- the plan check ----
const FLAG_AT = 0.5; // P(defect) at or above this flags (fixed before the run, not tuned)
// Defect wording (docs/decisions.md "Jev idea rubric": defect wording beat positive wording). Plan only.
const QUESTIONS = {
  CAST_LOST: { q: 'A person, creature or toy that the given cast or the idea names has no part in the plan: it is never used, or it is brought in and then forgotten.',
    fix: 'a figure from the given cast or the idea has no role in the plan; give every such figure a part in the scenes it matters to' },
  OBJ_STATE: { q: 'A thing that is torn, lost, broken, eaten, spilled or otherwise changed on one page is whole or back in its old state on a later page, and no page changes it back.',
    fix: 'a thing changed on one page (torn, lost, broken, eaten) is intact or back later without a page that changes it back; keep every change in all later PLAN lines' },
  NOT_FOLLOW: { q: 'Some page of the plan starts from something that the pages before it did not set up, or ignores what the page before it ended with.',
    fix: 'a page plan does not follow from the page before it; every PLAN line starts from where the previous page ended' },
};
function planState(input, promptText, story) {
  const main = (input.characters || []).find(c => c.role === 'main') || input.characters[0];
  const chars = (promptText.match(/- \*\*Characters\*\*[^\n]*/) || [''])[0].replace(/^- \*\*Characters\*\*[^:]*:\s*/, '').trim();
  const topic = String(input.storyTopic || '').replace(/-/g, ' ').trim();
  return `A PICTURE BOOK STORY PLAN, ONE LINE PER PAGE, WRITTEN BEFORE THE PAGE TEXTS.\nThe main character is ${main.name}, a child aged ${main.age}.\n${topic ? `The hard thing this story was asked for: ${topic}.\n` : ''}\nTHE GIVEN CAST: ${chars}\nTHE IDEA:\n${String(input.storyDetails || '').trim()}\n\nTHE PLAN:\n` + story.pages.map(p => `Page ${p.n}: ${p.body.replace(/\s+/g, ' ')}`).join('\n');
}
/** Structure: a Visual Bible figure (secondary character / animal / artifact: a toy character is an artifact) that no scene hint cites by id or name. */
function codeCheck(story) {
  const vb = story.vb || {};
  const figs = [...(vb.secondaryCharacters || []), ...(vb.animals || []), ...(vb.artifacts || [])].filter(f => f && f.id);
  const cited = new Set(); const names = new Set();
  for (const p of story.pages) {
    const sc = p.hint?.scene || {};
    for (const c of sc.characters || []) { if (c.id) cited.add(c.id); if (c.name) names.add(String(c.name).toLowerCase()); }
    for (const o of sc.objects || []) { if (o.id) cited.add(o.id); if (o.name) names.add(String(o.name).toLowerCase()); }
  }
  return figs.filter(f => !cited.has(f.id) && !names.has(String(f.name || '').toLowerCase())).map(f => `${f.id} ${f.name}`);
}
async function planCheck(input, promptText, story, J) {
  const { RUBRIC } = require(path.join(ROOT, 'server/lib/ideaJevRubric'));
  const questions = {}; const fix = {};
  for (const [id, d] of Object.entries(QUESTIONS)) { questions[id] = { type: 'noul', instructions: d.q }; fix[id] = d.fix; }
  if (input.storyTopic) {
    questions.TOPIC = { type: 'noul', instructions: RUBRIC.FORCED.B.q({}) };
    fix.TOPIC = 'the topic is not what the situation calls for; the main character must need it to get past what stands in the way';
  }
  const t0 = Date.now();
  const r = await J.callJev({ state: planState(input, promptText, story), questions });
  const p = {}; for (const id of Object.keys(questions)) p[id] = r.answers[id].noul;
  return { p, fix, ms: Date.now() - t0, cost: r.cost || 0 };
}

(async () => {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require(path.join(ROOT, 'server/services/prompts'));
  await loadPromptTemplates();
  const { buildTrialStoryPrompt } = require(path.join(ROOT, 'server/lib/promptBuilders'));
  const orig = PROMPT_TEMPLATES.storyTrial;
  const tplA = deriveA(orig), tplB = deriveB(orig);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'prompts/experiments'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'prompts/experiments/story-trial-split-a.txt'), tplA);
  fs.writeFileSync(path.join(ROOT, 'prompts/experiments/story-trial-split-b.txt'), tplB);
  const build = (tpl, input) => { PROMPT_TEMPLATES.storyTrial = tpl; try { return buildTrialStoryPrompt(input, input.pages); } finally { PROMPT_TEMPLATES.storyTrial = orig; } };
  const loadInput = id => JSON.parse(fs.readFileSync(path.join(inputDir(id), 'inputData.json'), 'utf8'));

  if (phase === 'inputs') {
    const { Pool } = require('pg');
    for (const [id, env] of Object.entries(NEW_IDS)) {
      const pool = new Pool({ connectionString: process.env[env], ssl: { rejectUnauthorized: false } });
      const st = (await pool.query('select data from stories where id=$1', [id])).rows[0]?.data;
      await pool.end();
      if (!st) throw new Error(`no stored story ${id}`);
      const input = {};
      for (const k of ['pages', 'layout', 'artStyle', 'ideaKind', 'ideaPick', 'language', 'characters', 'storyTheme', 'storyTopic', 'storyDetails', 'userLocation', 'languageLevel', 'storyCategory']) if (st[k] !== undefined) input[k] = st[k];
      if (st.replayInputs?.availableLandmarks) input.availableLandmarks = st.replayInputs.availableLandmarks;
      input.trialMode = true;
      input.characters = (input.characters || []).map(c => { const { photos, avatars, ...rest } = c; return rest; });
      const d = path.join(OUT, id); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'inputData.json'), JSON.stringify(input, null, 2));
      const p = buildTrialStoryPrompt(input, input.pages);
      fs.writeFileSync(path.join(d, 'prompt.txt'), p);
      console.log(id, input.language, input.storyCategory, input.characters.map(c => c.age).join(','), 'landmarks=' + (input.availableLandmarks || []).length, 'pages=' + input.pages, 'promptChars=' + p.length);
    }
    return;
  }

  if (phase === 'prompts') {
    for (const id of IDS) {
      const input = loadInput(id); const d = path.join(OUT, id); fs.mkdirSync(d, { recursive: true });
      const a = build(tplA, input), b = build(tplB, input);
      fs.writeFileSync(path.join(d, 'prompt-A.txt'), a); fs.writeFileSync(path.join(d, 'prompt-B-template.txt'), b);
      console.log(id, 'A', a.length, 'B', b.length, 'unfilled', (a + b).match(/\{[A-Z_]{4,}\}/g));
    }
    return;
  }

  if (phase === 'blind') {
    const keyFile = path.join(OUT, 'blind-key.json');
    const key = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : {};
    const armsKey = JSON.parse(fs.readFileSync(path.join(BASE, 'arms-key.json'), 'utf8'));
    const render = (title, pages) => `TITLE: ${title}\n\n` + pages.map(p => {
      const sc = p.hint?.scene || {};
      return `=== PAGE ${p.n} ===\n${p.text}\n[SCENE: ${sc.imageSummary || '?'} | chars: ${(sc.characters || []).map(c => `${c.name} (${c.action || ''})`).join('; ')} | objects: ${(sc.objects || []).map(o => o.name).join(', ')}]\n`;
    }).join('\n');
    for (const id of IDS) {
      const d = path.join(OUT, id);
      const final = JSON.parse(fs.readFileSync(path.join(d, 'plan-final.json'), 'utf8'));
      const aStory = parseStory(fs.readFileSync(path.join(d, final.usedRerun ? 'output-A2.txt' : 'output-A.txt'), 'utf8'));
      const bStory = parseStory(fs.readFileSync(path.join(d, 'output-B.txt'), 'utf8'));
      const splitPages = aStory.pages.map(p => ({ n: p.n, hint: p.hint, text: (bStory.pages.find(q => q.n === p.n) || {}).body || '[MISSING TEXT]' }));
      const medLabel = OLD_IDS.includes(id) ? Object.entries(armsKey[id]).find(([k, v]) => (k === 'A' || k === 'B') && v === 'medium')[0] : null;
      const medFile = OLD_IDS.includes(id) ? path.join(BASE, id, `output-${medLabel}.txt`) : path.join(d, 'output-medium.txt');
      const med = parseStory(fs.readFileSync(medFile, 'utf8'));
      const arms = { split: render(aStory.title, splitPages), medium: render(med.title, med.pages.map(p => ({ n: p.n, hint: p.hint, text: p.body }))) };
      if (!key[id]) key[id] = Math.random() < 0.5 ? { X: 'split', Y: 'medium' } : { X: 'medium', Y: 'split' };
      fs.writeFileSync(path.join(d, 'blind-X.txt'), arms[key[id].X]); fs.writeFileSync(path.join(d, 'blind-Y.txt'), arms[key[id].Y]);
    }
    fs.writeFileSync(keyFile, JSON.stringify(key, null, 2));
    console.log('blind files written for', IDS.length, 'inputs');
    return;
  }

  const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
  const { ProgressiveUnifiedParser } = require(path.join(ROOT, 'server/lib/outlineParser'));
  const { priceUsage } = require(path.join(ROOT, 'server/config/models'));
  const J = require(path.join(ROOT, 'server/lib/jevAudit'));
  const timedCall = async (prompt, effort) => {
    const t0 = Date.now(); const ev = { pages: {} }; const since = () => Date.now() - t0;
    const parser = new ProgressiveUnifiedParser({
      onTitle: () => { ev.title = ev.title ?? since(); }, onVisualBible: () => { ev.vb = ev.vb ?? since(); },
      onCoverScene: () => { ev.cover = ev.cover ?? since(); }, onPageComplete: p => { ev.pages[p.pageNumber] = since(); },
    }, { isTrial: true });
    const r = await callTextModelStreaming(prompt, null, (c, full) => parser.processChunk(c, full), null, { usageLabel: 'unified_story', effort });
    const ms = since(); parser.finalize();
    return { r, ms, vbMs: ev.vb, cost: priceUsage(r.modelId || 'claude-sonnet-5-5', r.usage || {}) };
  };
  const baselineFile = path.join(OUT, 'baseline-metrics.json');
  const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
  const metricsFile = path.join(OUT, 'metrics.json');
  const spendOf = () => readJson(metricsFile, []).reduce((n, m) => n + m.costUsd, 0) + readJson(baselineFile, []).reduce((n, m) => n + m.costUsd, 0);

  if (phase === 'baseline') {
    const metrics = readJson(baselineFile, []);
    // all missing inputs at once (owner 2026-10-10: wall-clock); 5 x ~0.21 USD is checked against the cap up front
    const todo = Object.keys(NEW_IDS).filter(id => !metrics.find(m => m.id === id));
    if (spendOf() + 0.25 * todo.length > CAP) { console.log(`STOP: spend ${spendOf().toFixed(3)} + ${todo.length} x 0.25 > cap ${CAP}`); process.exit(0); }
    await Promise.all(todo.map(async id => {
      const d = path.join(OUT, id);
      const c = await timedCall(fs.readFileSync(path.join(d, 'prompt.txt'), 'utf8'), 'medium');
      fs.writeFileSync(path.join(d, 'output-medium.txt'), c.r.text);
      metrics.push({ id, vbMs: c.vbMs, totalMs: c.ms, out: c.r.usage?.output_tokens, costUsd: c.cost, stop: c.r.stop_reason });
      fs.writeFileSync(baselineFile, JSON.stringify(metrics, null, 2));
      console.log(id, `medium vb=${(c.vbMs / 1000).toFixed(1)}s total=${(c.ms / 1000).toFixed(1)}s cost=$${c.cost.toFixed(3)}`);
    }));
    console.log('DONE baseline spend', spendOf().toFixed(3));
    return;
  }

  // phase === 'run': split v2 with plan check + one fix
  const metrics = readJson(metricsFile, []);
  for (const id of IDS) {
    if (metrics.find(m => m.id === id)) continue;
    if (spendOf() + 0.40 > CAP) { console.log(`STOP: spend ${spendOf().toFixed(3)} + 0.40 > cap ${CAP}`); process.exit(0); }
    const input = loadInput(id); const dir = path.join(OUT, id); fs.mkdirSync(dir, { recursive: true });
    const promptA = build(tplA, input);
    const a1 = await timedCall(promptA, 'low');
    fs.writeFileSync(path.join(dir, 'output-A.txt'), a1.r.text);
    const s1 = parseStory(a1.r.text);
    const code = codeCheck(s1);
    const jev1 = await planCheck(input, promptA, s1, J);
    const reasons = [];
    for (const [qid, p] of Object.entries(jev1.p)) if (p >= FLAG_AT) reasons.push(qid);
    if (code.length) reasons.push('CODE_CAST');
    fs.writeFileSync(path.join(dir, 'check-1.json'), JSON.stringify({ code, jev: jev1.p, ms: jev1.ms, reasons }, null, 2));
    let final = a1, usedRerun = false, a2 = null, jev2 = null;
    if (reasons.length) {
      const why = reasons.map(r => (r === 'CODE_CAST' ? `the Visual Bible lists ${code.map(c => c.split(' ').slice(1).join(' ')).join(', ')} but no scene hint shows them; every listed figure appears in a scene or leaves the Visual Bible` : jev1.fix[r])).join('; ');
      const promptA2 = promptA + `\n\n# REVISION\nA first plan for this story was rejected: ${why}.\nPlan the whole story again, with this fixed.\n`;
      a2 = await timedCall(promptA2, 'low'); usedRerun = true; final = a2;
      fs.writeFileSync(path.join(dir, 'output-A2.txt'), a2.r.text);
      const s2 = parseStory(a2.r.text);
      jev2 = await planCheck(input, promptA, s2, J); // informational (hand labels), triggers nothing
      fs.writeFileSync(path.join(dir, 'check-2.json'), JSON.stringify({ code: codeCheck(s2), jev: jev2.p }, null, 2));
    }
    const promptB = build(tplB, input).replace('@@PLAN@@', () => final.r.text.trim());
    fs.writeFileSync(path.join(dir, 'prompt-B.txt'), promptB);
    const b = await timedCall(promptB, 'medium');
    fs.writeFileSync(path.join(dir, 'output-B.txt'), b.r.text);
    fs.writeFileSync(path.join(dir, 'plan-final.json'), JSON.stringify({ usedRerun }, null, 2));
    const checkMs = jev1.ms;
    const m = {
      id, flagged: reasons, usedRerun, a1VbMs: a1.vbMs, a1TotalMs: a1.ms, checkMs, a2VbMs: a2?.vbMs ?? null, a2TotalMs: a2?.ms ?? null, bTotalMs: b.ms,
      vbReadySpeculativeS: a1.vbMs / 1000,
      vbReadyAfterCheckS: (usedRerun ? a1.ms + checkMs + a2.vbMs : a1.ms + checkMs) / 1000,
      totalS: (a1.ms + checkMs + (a2?.ms || 0) + b.ms) / 1000,
      rerunAddedS: usedRerun ? (a2.ms + checkMs) / 1000 : 0,
      costA1: a1.cost, costA2: a2?.cost || 0, costB: b.cost, costJev: jev1.cost + (jev2?.cost || 0),
      costUsd: a1.cost + (a2?.cost || 0) + b.cost + jev1.cost + (jev2?.cost || 0), stops: [a1.r.stop_reason, a2?.r.stop_reason, b.r.stop_reason],
    };
    metrics.push(m);
    fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
    console.log(id, `flag=[${reasons}] vbSpec=${m.vbReadySpeculativeS.toFixed(1)}s vbAfterCheck=${m.vbReadyAfterCheckS.toFixed(1)}s total=${m.totalS.toFixed(1)}s cost=$${m.costUsd.toFixed(3)} spend=$${spendOf().toFixed(3)}`);
  }
  console.log('DONE spend', spendOf().toFixed(3));
})().then(() => process.exit(0)).catch(e => { console.error("ERR", e); process.exit(1); });
