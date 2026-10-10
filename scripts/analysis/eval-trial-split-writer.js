/**
 * Trial SPLIT writer experiment: call A (effort low) = title + Visual Bible + cover + per page PLAN line +
 * scene hint, no prose; call B (effort medium) = page TEXTS only, with A's output as the binding plan.
 * Same 5 stored inputs as scripts/analysis/eval-trial-writer-effort.js (reads its inputData.json).
 * Both templates are derived from prompts/story-trial.txt by removal/replacement (nothing wired in
 * production); the real buildTrialStoryPrompt fills them via an in-process template override.
 *
 *   node scripts/analysis/eval-trial-split-writer.js --phase=prompts   # free: build + store prompts
 *   node scripts/analysis/eval-trial-split-writer.js --phase=run [--cap=3.0]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
const phase = arg('phase') || 'prompts';
const CAP = Number(arg('cap') || 3.0);
const BASE = path.join(ROOT, 'evals/runs/2026-10-09_trial-writer-effort');
const OUT = path.join(ROOT, 'evals/runs/2026-10-10_trial-split-writer');
const IDS = [
  'job_1791579344291_rk2bno6av', 'job_1791496820206_qwcnrq30r', 'job_1791391658361_4eylyr1w4',
  'job_1791554548909_kl0phznw2', 'job_1791551298726_19tfcxccl',
];

// ---- template derivation (removal/replacement only) ----
const PROSE_ONLY = [
  '- {PAGE_LENGTH_RULE}', '- {PAGE_OPENING_VARIETY}', '{STYLE_RULEBOOK}', '- {NEIGHBOUR_PHRASE}', '- {NO_DASH}', '- {MOTIVE_AT_THE_ACT}',
  '- The text never asserts a position', '- A sentence never gives one thing two states',
  '- Where a figure looks, faces or turns', "- Never describe a character's or creature's hair",
  '- No onomatopoeia',
];
const HEAD = "You write children's stories. Create a {PAGES}-scene story.";
function deriveA(tpl) {
  const lines = tpl.split('\n');
  const kept = lines.filter(l => !PROSE_ONLY.some(p => l.startsWith(p)));
  if (lines.length - kept.length !== PROSE_ONLY.length) throw new Error(`A: removed ${lines.length - kept.length} lines, expected ${PROSE_ONLY.length}`);
  let t = kept.join('\n');
  if (!t.includes(HEAD)) throw new Error('A: header not found');
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
  const inputs = {};
  for (const id of IDS) inputs[id] = JSON.parse(fs.readFileSync(path.join(BASE, id, 'inputData.json'), 'utf8'));

  if (phase === 'prompts') {
    for (const id of IDS) {
      const d = path.join(OUT, id); fs.mkdirSync(d, { recursive: true });
      const a = build(tplA, inputs[id]), b = build(tplB, inputs[id]);
      fs.writeFileSync(path.join(d, 'prompt-A.txt'), a); fs.writeFileSync(path.join(d, 'prompt-B-template.txt'), b);
      const base = fs.readFileSync(path.join(BASE, id, 'prompt.txt'), 'utf8');
      console.log(id, 'baseline', base.length, 'A', a.length, 'B', b.length, 'unfilled', (a + b).match(/\{[A-Z_]{4,}\}/g));
    }
    return;
  }

  const { callTextModelStreaming } = require(path.join(ROOT, 'server/lib/textModels'));
  const { ProgressiveUnifiedParser } = require(path.join(ROOT, 'server/lib/outlineParser'));
  const { priceUsage } = require(path.join(ROOT, 'server/config/models'));
  const metricsFile = path.join(OUT, 'metrics.json');
  const metrics = fs.existsSync(metricsFile) ? JSON.parse(fs.readFileSync(metricsFile, 'utf8')) : [];
  let spend = metrics.reduce((n, m) => n + (m.costUsd || 0), 0);

  for (const id of IDS) {
    if (metrics.find(m => m.id === id)) continue;
    if (spend + 0.35 > CAP) { console.log(`STOP: spend ${spend.toFixed(3)} + 0.35 > cap ${CAP}`); process.exit(0); }
    const dir = path.join(OUT, id);
    const promptA = build(tplA, inputs[id]);
    const t0 = Date.now(); const since = () => Date.now() - t0;
    const ev = { title: null, vb: null, cover: null, pages: {} };
    const parser = new ProgressiveUnifiedParser({
      onTitle: () => { ev.title = ev.title ?? since(); },
      onVisualBible: () => { ev.vb = ev.vb ?? since(); },
      onCoverScene: () => { ev.cover = ev.cover ?? since(); },
      onPageComplete: p => { ev.pages[p.pageNumber] = since(); },
    }, { isTrial: true });
    const rA = await callTextModelStreaming(promptA, null, (c, full) => parser.processChunk(c, full), null, { usageLabel: 'unified_story', effort: 'low' });
    const aMs = since(); parser.finalize();
    fs.writeFileSync(path.join(dir, 'output-A.txt'), rA.text);
    const costA = priceUsage(rA.modelId || 'claude-sonnet-5-5', rA.usage || {});
    spend += costA;

    const promptB = build(tplB, inputs[id]).replace('@@PLAN@@', () => rA.text.trim());
    fs.writeFileSync(path.join(dir, 'prompt-B.txt'), promptB);
    const tB = Date.now();
    const rB = await callTextModelStreaming(promptB, null, () => {}, null, { usageLabel: 'unified_story', effort: 'medium' });
    const bMs = Date.now() - tB;
    fs.writeFileSync(path.join(dir, 'output-B.txt'), rB.text);
    const costB = priceUsage(rB.modelId || 'claude-sonnet-5-5', rB.usage || {});
    spend += costB;
    metrics.push({
      id, aVbMs: ev.vb, aTitleMs: ev.title, aCoverMs: ev.cover, aPageCompleteMs: ev.pages, aTotalMs: aMs, bTotalMs: bMs, combinedMs: aMs + bMs,
      aOut: rA.usage?.output_tokens, bOut: rB.usage?.output_tokens, aIn: rA.usage?.input_tokens, bIn: rB.usage?.input_tokens,
      costA, costB, costUsd: costA + costB, aStop: rA.stop_reason, bStop: rB.stop_reason,
    });
    fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
    console.log(id, `vb=${(ev.vb / 1000).toFixed(1)}s A=${(aMs / 1000).toFixed(1)}s B=${(bMs / 1000).toFixed(1)}s cost=$${(costA + costB).toFixed(3)} spend=$${spend.toFixed(3)}`);
  }
  console.log('DONE spend', spend.toFixed(3));
})().catch(e => { console.error('ERR', e); process.exit(1); });
