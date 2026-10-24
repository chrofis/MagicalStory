/**
 * Re-judge STORED pages with the REAL semantic judge (testlab.runSemanticEvalStage - the
 * exact inputs the production run hands it) to measure the `wrong_state` rule
 * (docs/decisions.md 2026-10-24): does a page whose element is drawn in a different state
 * than the page gives it come back as `wrong_state`, and does a correct page stay clean?
 *
 *   node scripts/analysis/replay-wrong-state-judge.js --env=prod|staging --out=<dir> [--probe] [--images] [--cap=0.45] <storyId>:<page> ...
 *
 *   --probe   free: print, for each page, the PAGE ELEMENTS block the judge WOULD get; no model call.
 *   --images  free: also write the active page image to <out>/<storyId>_p<N>.jpg for a visual read.
 *   default   paid (gemini-2.5-flash, ~USD 0.002-0.01 a call): one judge call per page, each booked
 *             in <out>/ledger.jsonl; stops before a call once the running total reaches --cap.
 * Nothing is written to the database (no story scope, so eval_calls stays untouched).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n, d = null) => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const has = (n) => args.includes(`--${n}`);
const env = flag('env', 'prod');
const out = flag('out');
const cap = parseFloat(flag('cap', '0.45'));
const specs = args.filter(a => /^[^-].*:-?\d+$/.test(a));
if (!out || specs.length === 0) { console.error('usage: --env= --out= [--probe] [--images] [--cap=] storyId:page ...'); process.exit(2); }
if (env === 'staging') process.env.DATABASE_URL = process.env.STAGING_DATABASE_URL;
fs.mkdirSync(out, { recursive: true });

(async () => {
  require('../../server/services/database').initializePool();
  const { loadPromptTemplates } = require('../../server/services/prompts');
  await loadPromptTemplates();
  const T = require('../../server/lib/testlab');
  const SV = require('../../server/lib/sceneValidator');
  const realJudge = SV.evaluateSemanticFidelity;
  let captured = null;
  // Capture the judge's exact inputs (and its raw answer) without changing the call.
  SV.evaluateSemanticFidelity = async (img, storyText, imagePrompt, sceneHint, tpl, evalContext) => {
    const blocks = SV.semanticDeclaredBlocks({ sceneHint, imagePrompt, visualBible: evalContext.visualBible || null, pageNumber: evalContext.pageNumber ?? null });
    captured = { elementsBlock: blocks.elementsBlock };
    if (has('probe')) return null;
    const r = await realJudge(img, storyText, imagePrompt, sceneHint, tpl, evalContext);
    captured.raw = r;
    return r;
  };
  let total = 0;
  const ledger = path.join(out, 'ledger.jsonl');
  if (fs.existsSync(ledger)) for (const l of fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean)) total += JSON.parse(l).usd || 0;
  for (const spec of specs) {
    const [storyId, pn] = spec.split(':'); const pageNumber = parseInt(pn, 10);
    const row = { storyId, pageNumber, env };
    try {
      if (!has('probe') && total >= cap) { row.skipped = `cap ${cap} reached at ${total.toFixed(4)}`; console.log(JSON.stringify(row)); continue; }
      const ctx = await T.loadSceneContext(storyId, pageNumber);
      ctx.storyId = storyId; ctx.pageNumber = pageNumber;
      captured = null;
      try {
        const res = await T.runSemanticEvalStage(ctx, { experimentId: 'wrong-state-replay' });
        row.score = res.scores.semantic; row.verdict = res.scores.verdict;
        row.issues = (res.semanticIssues || []).map(i => ({ type: i.type, severity: i.severity, element: i.element || null, description: String(i.description || '').slice(0, 220) }));
        const usd = res.usage?.estimatedCost ?? res.usage?.cost ?? 0;
        total += usd; row.usd = usd;
        fs.appendFileSync(ledger, JSON.stringify({ storyId, pageNumber, usd, total }) + '\n');
      } catch (e) { if (!has('probe')) row.error = e.message; }
      row.elementsBlock = captured && captured.elementsBlock;
      if (captured && captured.raw) fs.writeFileSync(path.join(out, `${storyId.slice(-9)}_p${pageNumber}.raw.json`), JSON.stringify(captured.raw, null, 1));
      if (has('images')) {
        const img = await T.loadActivePageImage(storyId, pageNumber);
        fs.writeFileSync(path.join(out, `${storyId.slice(-9)}_p${pageNumber}.jpg`), Buffer.from(String(img).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      }
    } catch (e) { row.error = e.message; }
    console.log(JSON.stringify(row));
  }
  console.log(JSON.stringify({ total_usd: total }));
  process.exit(0);
})();
