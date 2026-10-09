#!/usr/bin/env node
/**
 * Replay ONE Art-Director-family text stage of a STORED staging story on a
 * different model and score it with the stage's own downstream checks.
 *
 * Why: four calls ran on gemini-3.1-pro for about USD 0.63 per 18-page book
 * (beats_visual_bible, beats_scene_expansion, beats_brief_reask, text_lector).
 * The owner rule (2026-10-08) is "a cheaper model with the same results wins".
 * Inputs are the EXACT prompts the run sent (stories.data reports), so the
 * only variable is the model. Scoring reuses production code:
 *   vb      extractBibleSections + UnifiedStoryParser.extractVisualBible
 *           + vbLabel.validateLabels (each label fault buys a further model call)
 *   briefs  parseRefinedText + partitionSceneBriefs + assembleBriefs
 *           + briefChecks.collectBriefFindings (the re-ask triggers)
 *   reask   briefChecks.runBriefChecks itself, its model call answered by the
 *           candidate with the STORED prompt (resolved / survived / introduced)
 *   lector  textRefine.parseLectorLines + applyLectorFindings
 *
 * Usage (from the repo root; needs .env with STAGING_DATABASE_URL and
 * OPENROUTER_API_KEY / ANTHROPIC_API_KEY):
 *   node scripts/analysis/ad-stage-model-replay.js --stage baseline --story <id>
 *   node scripts/analysis/ad-stage-model-replay.js --stage vb|briefs|reask|lector --story <id> --model <TEXT_MODELS key> [--effort medium]
 *
 * Paid calls are capped by --cap (USD, default 2.00) over one shared ledger
 * (evals/runs/<run>/ledger.jsonl); the script refuses a call that would start
 * with less than --reserve (default 0.15) of the cap left.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const RUN_DIR = path.join(__dirname, '..', '..', 'evals', 'runs', '2026-10-09_ad-stage-replay');
const LEDGER = path.join(RUN_DIR, 'ledger.jsonl');

function args() {
  const a = {};
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith('--')) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith('--') ? v[++i] : true;
  return a;
}

function spent() {
  if (!fs.existsSync(LEDGER)) return 0;
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).reduce((s, l) => s + (JSON.parse(l).cost || 0), 0);
}

async function loadStory(pool, id) {
  const base = await pool.query(`select data - 'sceneImages' - 'coverImages' - 'styledAvatarGeneration' - 'generationLog' - 'beatsReviewReport' - 'finalChecksReport' - 'arcReviewReport' - 'storyBibleReport' - 'tokenUsage' d,
      data->'tokenUsage'->'byFunction' tok from stories where id = $1`, [id]);
  if (!base.rows[0]) throw new Error(`story ${id} not found`);
  const imgs = await pool.query(`select jsonb_agg(jsonb_build_object('pageNumber', s->'pageNumber', 'jevFixed', s->'jevFixed', 'outlineExtract', s->'outlineExtract')) pages,
      (select jsonb_object_agg(k, jsonb_build_object('jevFixed', v->'jevFixed', 'outlineExtract', v->'outlineExtract')) from stories st, jsonb_each(st.data->'coverImages') e(k, v) where st.id = $1) covers
    from stories st, jsonb_array_elements(st.data->'sceneImages') s where st.id = $1`, [id]);
  return { ...base.rows[0].d, id, tokenByFunction: base.rows[0].tok || {}, sceneImages: imgs.rows[0].pages || [], covers: imgs.rows[0].covers || {} };
}

/** The briefBeats the run held, rebuilt from what the story stored (plan lines, decided fields, cover beats). */
function rebuildBriefBeats(story) {
  const { buildCoverBeats } = require('../../server/lib/coverBeats');
  const planOf = x => ((String(x || '').match(/(?:^|\n)\s*PLAN:\s*([\s\S]*)$/i) || [, ''])[1]).trim();
  const jevMod = require('../../server/lib/jevDecisions');
  const pages = story.sceneImages.filter(s => Number(s.pageNumber) > 0).map((s) => {
    const planLine = planOf(s.outlineExtract);
    const who = String((jevMod.planParts(planLine) || [])[1] || '').split(/,\s*/).map(x => x.trim()).filter(Boolean);
    return { pageNumber: Number(s.pageNumber), planLine, jevFixed: s.jevFixed || undefined, inFrame: who };
  });
  const covers = buildCoverBeats(story, { clothingRequirements: story.clothingRequirements, placeDecided: true });
  for (const cb of covers) {
    const rec = story.covers[cb.coverKey];
    if (rec && rec.jevFixed) cb.jevFixed = rec.jevFixed;
  }
  return [...pages, ...covers];
}

function typeCounts(findings) {
  const c = {};
  for (const f of findings) c[f.type] = (c[f.type] || 0) + 1;
  return c;
}

const PRICE_CHECK = () => require('../../server/config/models');

async function callCandidate({ prompt, model, options, label, story, cap, reserve, call = null }) {
  const left = cap - spent();
  if (left < reserve) throw new Error(`CAP: ${spent().toFixed(4)} of ${cap} USD spent, ${left.toFixed(4)} left < reserve ${reserve} — stopping`);
  const textModels = require('../../server/lib/textModels');
  const { priceUsage, TEXT_MODELS } = PRICE_CHECK();
  if (!TEXT_MODELS[model]) throw new Error(`unknown TEXT_MODELS key ${model}`);
  const t0 = Date.now();
  const res = await (call || textModels.callTextModelStreaming)(prompt, null, null, model, options);
  const cost = res.usage?.direct_cost ?? priceUsage(res.modelId || TEXT_MODELS[model].modelId, res.usage || {});
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), story, label, model, cost, in: res.usage?.input_tokens, out: res.usage?.output_tokens, ms: Date.now() - t0 }) + '\n');
  return { res, cost, ms: Date.now() - t0 };
}

function stored(story, stage) {
  const se = story.sceneExpansionReport || {};
  const bc = story.briefCheckReport || {};
  const lectorRound = ((story.textRefineReport || {}).roundTrace || []).find(r => r.kind === 'lector');
  if (stage === 'vb') return { prompt: se.visualBiblePrompt, text: se.visualBibleReplies?.[0]?.text, cost: story.tokenByFunction.beats_visual_bible?.cost };
  if (stage === 'briefs') return { prompt: se.prompts?.[0]?.prompt, text: se.replies?.[0]?.text, cost: story.tokenByFunction.beats_scene_expansion?.cost };
  if (stage === 'reask') return { prompt: bc.reask?.prompt, text: bc.reask?.reply, cost: bc.reask?.usage?.direct_cost ?? story.tokenByFunction.beats_brief_reask?.cost };
  if (stage === 'lector') return { prompt: lectorRound?.prompt, text: lectorRound?.rawResponse, cost: lectorRound?.cost, round: lectorRound };
  throw new Error(`unknown stage ${stage}`);
}

// ── scoring ──────────────────────────────────────────────────────────────────

function scoreVb(raw) {
  const { extractBibleSections, AD_BIBLE_MARKERS } = require('../../server/lib/beatsPipeline');
  const { UnifiedStoryParser } = require('../../server/lib/outlineParser/unified');
  const { validateLabels } = require('../../server/lib/vbLabel');
  const out = { chars: raw.length, parsed: false };
  const sections = extractBibleSections(raw, AD_BIBLE_MARKERS);
  if (!sections) return { ...out, error: 'no ---VISUAL BIBLE--- section' };
  let vb = null;
  try { vb = new UnifiedStoryParser(sections.body).extractVisualBible(); } catch (e) { return { ...out, error: `vb parse threw: ${e.message}` }; }
  if (!vb) return { ...out, error: 'vb JSON did not parse' };
  out.parsed = true;
  out.entries = {};
  for (const [k, v] of Object.entries(vb)) if (Array.isArray(v)) out.entries[k] = v.length;
  let labelFaults = [];
  try { labelFaults = validateLabels(vb) || []; } catch (e) { out.labelCheckError = e.message; }
  out.labelFaults = labelFaults.length;
  // element budget by page (secondary characters, animals, artifacts, vehicles), the way vbElementBudget counts bible-side
  const perPage = {};
  for (const k of ['secondaryCharacters', 'animals', 'artifacts', 'vehicles']) {
    for (const e of (Array.isArray(vb[k]) ? vb[k] : [])) for (const p of (e.appearsInPages || [])) perPage[p] = (perPage[p] || 0) + 1;
  }
  const { VB_ELEMENT_BUDGET } = require('../../server/lib/vbElementBudget');
  out.pagesOverElementBudget = Object.entries(perPage).filter(([, n]) => n > VB_ELEMENT_BUDGET).map(([p]) => Number(p));
  const ids = [];
  for (const v of Object.values(vb)) if (Array.isArray(v)) for (const e of v) if (e && e.id) ids.push(String(e.id));
  out.duplicateIds = ids.length - new Set(ids).size;
  out.vb = vb;
  return out;
}

function briefCtx(story) {
  const briefBeats = rebuildBriefBeats(story);
  return { inputData: story, clothingRequirements: story.clothingRequirements || null, visualBible: story.visualBible, briefBeats };
}

function scoreBriefs(raw, story) {
  const { parseRefinedText, BRIEF_TRAILING_MARKERS } = require('../../server/lib/promptBuilders');
  const { partitionSceneBriefs } = require('../../server/lib/iterateBriefGuard');
  const { assembleBriefs } = require('../../server/lib/jevBriefFields');
  const { collectBriefFindings } = require('../../server/lib/briefChecks');
  const ctx = briefCtx(story);
  const expected = ctx.briefBeats.map(b => b.pageNumber);
  const parsed = parseRefinedText(raw, expected, 'SCENES', BRIEF_TRAILING_MARKERS);
  const { whole, cut } = partitionSceneBriefs(parsed.pages);
  const expansions = ctx.briefBeats.filter(b => whole.some(p => p.pageNumber === b.pageNumber))
    .map(b => ({ pageNumber: b.pageNumber, brief: whole.find(p => p.pageNumber === b.pageNumber).text }));
  const noop = { info() {}, warn() {}, error() {}, debug() {} };
  assembleBriefs(expansions, ctx.briefBeats, noop, story.visualBible);
  const before = collectBriefFindings(expansions, ctx);
  const reaskable = before.findings.filter(f => f && !require('../../server/lib/briefChecks').COVER_ONLY_TYPES.has(f.type));
  return {
    chars: raw.length, pagesExpected: expected.length, pagesWhole: whole.length, pagesCut: cut.length,
    findings: before.findings.length, reaskable: reaskable.length, withheld: before.withheld.length,
    flaggedPages: [...new Set(reaskable.map(f => f.pageNumber))].sort((a, b) => a - b),
    byType: typeCounts(before.findings), expansions,
  };
}

async function scoreReask(story, model, options, cap, reserve, live = false) {
  const { runBriefChecks } = require('../../server/lib/briefChecks');
  const textModels = require('../../server/lib/textModels');
  const { buildAvailableAvatarsForPrompt } = require('../../server/lib/clothingResolve');
  const { visualBibleJsonOf } = require('../../server/lib/jevBriefFields');
  const ctx = briefCtx(story);
  const expansions = story.briefCheckReport.briefsIn.map(x => ({ pageNumber: x.pageNumber, brief: x.brief }));
  const events = [];
  const rec = level => (event, message) => events.push({ level, event, message });
  const gl = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  let paid = null;
  const orig = textModels.callTextModelStreaming;
  // The re-ask's one model call is answered by the candidate with the STORED prompt.
  // live: the prompt the CURRENT builder makes for the pages the CURRENT checks flag (for stories whose stored findings predate today's checks)
  textModels.callTextModelStreaming = async (builtPrompt) => {
    const { res, cost, ms } = await callCandidate({ prompt: live ? builtPrompt : story.briefCheckReport.reask.prompt, model, options, label: 'reask', story: story.id, cap, reserve, call: orig });
    paid = { cost, ms, usage: res.usage };
    return res;
  };
  let report;
  try {
    report = await runBriefChecks({
      inputData: story, expansions, briefBeats: ctx.briefBeats, visualBible: story.visualBible, clothingRequirements: ctx.clothingRequirements,
      visualBibleJson: visualBibleJsonOf(story.outline), availableAvatars: buildAvailableAvatarsForPrompt(story.characters || [], ctx.clothingRequirements),
      maxCharactersPerScene: 3, model, gl,
    });
  } finally { textModels.callTextModelStreaming = orig; }
  return {
    cost: paid?.cost ?? 0, ms: paid?.ms ?? null, failed: report.reask?.failed || null,
    flagged: report.reask?.pages || [], findingsBefore: report.findingsBefore.length, findingsBeforeByType: typeCounts(report.findingsBefore),
    taken: report.verdicts.filter(v => v.accepted).length, refused: report.verdicts.filter(v => !v.accepted).map(v => ({ p: v.pageNumber, reason: v.reason })),
    findingsAfter: report.findingsAfter.length, survived: report.survived.length, introduced: report.introduced.length,
    introducedTypes: typeCounts(report.introduced), reply: report.reask?.reply || '', pagesAfter: report.pages,
  };
}

function scoreLector(raw, story, round) {
  const { parseLectorLines, applyLectorFindings } = require('../../server/lib/textRefine');
  const { findings, unparsed } = parseLectorLines(raw);
  // The stored round keeps only each page's text AFTER the lector (`before` is projected away): undo the applied corrections.
  const pages = round.pages.map((p) => {
    let text = p.before != null ? p.before : p.after;
    if (p.before == null) for (const f of (story.textRefineReport.lectorApplied || [])) if (Number(f.pageNumber) === Number(p.pageNumber)) text = text.replace(f.correction, f.quote);
    return { pageNumber: p.pageNumber, text };
  });
  const { applied, dropped } = applyLectorFindings(pages, findings);
  return { findings: findings.map(f => ({ pageNumber: f.pageNumber, quote: f.quote, correction: f.correction })), applied: applied.length, dropped: dropped.length, droppedWhy: dropped.map(d => `${d.reason}:${d.quote}`), unparsed: unparsed.length };
}

async function main() {
  const a = args();
  const cap = parseFloat(a.cap || '2.00');
  const reserve = parseFloat(a.reserve || '0.15');
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const out = { story: a.story, stage: a.stage, model: a.model || 'baseline', effort: a.effort || null, at: new Date().toISOString() };
  try {
    const story = await loadStory(pool, a.story);
    await require('../../server/services/prompts').loadPromptTemplates();
    const options = {};
    if (a.effort) options.effort = a.effort; // Anthropic: options.effort
    if (a.reasoning) options.reasoning = { effort: a.reasoning }; // OpenRouter: options.reasoning.effort
    if (a.temperature != null) options.temperature = parseFloat(a.temperature);
    const stage = a.stage;
    if (stage === 'baseline') {
      const ctx = briefCtx(story);
      const { collectBriefFindings } = require('../../server/lib/briefChecks');
      const recomputed = collectBriefFindings(story.briefCheckReport.briefsIn.map(x => ({ pageNumber: x.pageNumber, brief: x.brief })), ctx);
      out.calibration = {
        storedFindingsBefore: story.briefCheckReport.findingsBefore.length, recomputed: recomputed.findings.length,
        storedByType: typeCounts(story.briefCheckReport.findingsBefore), recomputedByType: typeCounts(recomputed.findings),
      };
      const b = scoreBriefs(stored(story, 'briefs').text, story);
      out.briefsBaseline = { ...b, expansions: undefined, storedFindingsBefore: story.briefCheckReport.findingsBefore.length };
      out.vbBaseline = { ...scoreVb(stored(story, 'vb').text), vb: undefined };
      out.cost = { vb: stored(story, 'vb').cost, briefs: stored(story, 'briefs').cost, reask: stored(story, 'reask').cost, lector: stored(story, 'lector').cost };
      const lr = stored(story, 'lector').round;
      if (lr) out.lectorBaseline = scoreLector(lr.rawResponse, story, lr);
    } else if (stage === 'reask') {
      out.baseline = { findingsBefore: story.briefCheckReport.findingsBefore.length, taken: story.briefCheckReport.verdicts.filter(v => v.accepted).length, flagged: story.briefCheckReport.reask.pages, findingsAfter: story.briefCheckReport.findingsAfter.length, survived: story.briefCheckReport.survived.length, introduced: story.briefCheckReport.introduced.length, cost: stored(story, 'reask').cost };
      out.candidate = await scoreReask(story, a.model, { usageLabel: 'beats_brief_reask', ...options }, cap, reserve, a.live === true);
      if (a.live) out.baseline = null; // no stored Pro answer exists for these pages: run Pro live too
    } else {
      const s = stored(story, stage);
      if (!s.prompt || !s.text) throw new Error(`story ${a.story} stores no ${stage} prompt/reply`);
      const usageLabel = { vb: 'beats_visual_bible', briefs: 'beats_scene_expansion', lector: 'text_lector' }[stage];
      const { res, cost, ms } = await callCandidate({ prompt: s.prompt, model: a.model, options: { usageLabel, ...options }, label: stage, story: a.story, cap, reserve });
      const text = String(res.text || '');
      out.candidate = { cost, ms, usage: res.usage, truncation: res.truncation?.suspected ? res.truncation : null, stop: res.stop_reason ?? null, text };
      if (stage === 'vb') { out.candidate.score = scoreVb(text); out.baseline = { ...scoreVb(s.text), cost: s.cost }; }
      if (stage === 'briefs') { out.candidate.score = scoreBriefs(text, story); out.baseline = { ...scoreBriefs(s.text, story), cost: s.cost }; }
      if (stage === 'lector') { out.candidate.score = scoreLector(text, story, s.round); out.baseline = { ...scoreLector(s.text, story, s.round), cost: s.cost }; }
      out.baselineText = s.text;
    }
  } finally { await pool.end(); }
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const file = path.join(RUN_DIR, `${a.story}__${a.stage}__${out.model}${a.effort ? '-' + a.effort : ''}${a.live ? '__live' : ''}.json`);
  const slim = JSON.parse(JSON.stringify(out, (k, v) => (k === 'vb' ? undefined : v)));
  fs.writeFileSync(file, JSON.stringify(slim, null, 1));
  console.log(JSON.stringify(slim, (k, v) => (['text', 'baselineText', 'reply', 'expansions', 'pagesAfter'].includes(k) ? undefined : v), 1));
  console.log(`SPENT SO FAR: ${spent().toFixed(4)} USD (cap ${cap})`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { scoreVb, scoreBriefs, scoreLector, stored, loadStory, rebuildBriefBeats, spent };
