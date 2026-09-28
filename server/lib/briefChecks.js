/**
 * THE BRIEF CHECKS AND THE ONE RE-ASK (owner, 2026-09-28: "Jev first, then
 * remove the scene review").
 *
 * The page briefs are written by the Art Director with every decided field
 * already fixed (beatsPipeline.runArtDirector, call 2). What is left to verify
 * is what code can verify: the brief checks (sceneBriefCheck), the clothing
 * check's sendable faults (clothingCheck), and the decided fields themselves
 * (jevDecisions.pinBrief). Every page with a finding goes back to the Art
 * Director ONCE, in one batched call that carries the call-2 prompt as its
 * context; each rewritten page is judged by the shared corrective verdict
 * (briefCorrection.correctFindings, `strict`: taken when it resolves at least
 * one finding) and refused when it drops a character its plan line's who
 * column names. Whatever survives ships flagged and logged — never a second
 * round (owner, 2026-09-11: a second review round broke even).
 *
 * This module replaces what the scene review did for the code-found faults;
 * the review's own prose checks are counted in the rung-1 replay before the
 * review is deleted (owner, Q9). Pure except for the one model call; the
 * production run and the Test Lab `beats_scenes` stage call the same
 * `runBriefChecks`.
 *
 * see docs/decisions.md 2026-09-28 "Jev first, then no scene review"
 */

const { log } = require('../utils/logger');
const { carryForwardWornItemsInBrief } = require('./wornItems');

/**
 * A rewritten brief keeps every worn-state row the brief it replaces declared
 * (2026-09-23). A rewrite changes a state by restating the row; an omitted row
 * would resolve to the default `worn` and paint a garment the page took off
 * back on (wornItems.carryForwardWornItems). Loud: the omission is logged.
 */
function keepDeclaredWornRows(pageNumber, rewritten, previous, pass, gl) {
  const carry = carryForwardWornItemsInBrief(rewritten, previous);
  if (!carry) return rewritten;
  const msg = `Page ${pageNumber}: the ${pass} dropped the declared wornItems row(s) ${carry.carried.join(', ')} — carried forward as declared`;
  log.warn(`🎩 [BEATS] ${msg}`);
  if (gl) gl.warn('beats_worn_rows_carried', msg, null, { pageNumber, carried: carry.carried, pass });
  return carry.brief;
}

/**
 * A rewritten brief keeps the declared light (`timeOfDay` / `weather`) of the
 * brief it replaces when it states none (2026-09-24). A rewrite that states a
 * value wins. Without this a rewritten page loses its light, its plate falls
 * back into the vantage's base light, and its page prompt carries no LIGHT
 * line. Loud: the omission is logged.
 */
function keepDeclaredLight(pageNumber, rewritten, previous, pass, gl) {
  const { carryForwardLightInBrief } = require('./sceneLight');
  const carry = carryForwardLightInBrief(rewritten, previous);
  if (!carry) return rewritten;
  const msg = `Page ${pageNumber}: the ${pass} dropped ${carry.carried.join(' and ')} — carried forward as declared`;
  log.warn(`🌗 [BEATS] ${msg}`);
  if (gl) gl.warn('beats_light_carried', msg, null, { pageNumber, carried: carry.carried, pass });
  return carry.brief;
}

/**
 * Finding types a decided field owns on a Jev page (the decision layer wrote
 * the field; a brief rewrite cannot move it): the who column vs the cited
 * figures, a state's page range, the shot against the plan or the plate.
 * Withheld from the re-ask on those pages and returned for the log.
 */
const JEV_OWNED = new Set(['plan_cast_uncited', 'vb_state_contradicted', 'vb_state_no_base', 'shot_off_plate', 'shot_widened']);

/**
 * Clothing findings the re-ask sends beyond clothingCheck.REVIEWABLE (owner,
 * 2026-09-28, Q7): `outfit_missing` — a page whose prose never names a
 * character's outfit, the critic for the "wearing no clothing" kind the scene
 * review caught. Its August measurement (fires on ~1 page in 5, no
 * discriminating power) predates the dressed-prose rules; the 2026-09-28 replay
 * over 251 stored staging briefs found 4 fires, each a real omission
 * (scripts/analysis/replay-jev-first-briefs.js outfit). Sent by this re-ask
 * only: the scene review's check 0 asks for a `wornItems` row, which is not how
 * an omitted outfit is fixed.
 */
const REASK_CLOTHING_EXTRA = new Set(['outfit_missing']);

/** The cast the brief check counts: the commissioned characters and the bible's secondaries, once each. */
function briefCastNames(inputData, visualBible) {
  const secondaryList = Array.isArray(visualBible?.secondaryCharacters)
    ? visualBible.secondaryCharacters
    : Object.values(visualBible?.secondaryCharacters || {});
  const seen = new Set();
  return [...(inputData.characters || []).map(c => c && c.name), ...secondaryList.map(c => c && c.name)]
    .filter(Boolean)
    .filter((n) => {
      const k = String(n).trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * Every code-found fault over the briefs, split into what goes to the re-ask
 * (`findings`) and what a decided field owns (`withheld`). Deterministic and
 * free; the same function makes the before list, each page's recheck and the
 * after list, so the three can never count different things.
 *
 * @param {Array<{pageNumber:number, brief:string}>} expansions
 * @param {{inputData:Object, clothingRequirements:Object|null, visualBible:Object|null, briefBeats:Array}} ctx
 */
function collectBriefFindings(expansions, ctx) {
  const { checkScenes: checkBriefs, REVIEWABLE } = require('./sceneBriefCheck');
  const { checkScenes: checkClothing, REVIEWABLE: CLOTHING_SENDABLE } = require('./clothingCheck');
  const { extractSceneMetadata, splitBrief } = require('./sceneMetadata');
  const { textZoneRulesActive } = require('../config/runtime');
  const { pinBrief } = require('./jevDecisions');
  const beatOf = n => (ctx.briefBeats || []).find(b => b && Number(b.pageNumber) === Number(n)) || {};
  const findings = [];
  const withheld = [];
  const briefRes = checkBriefs(
    expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief, planLine: beatOf(x.pageNumber).planLine || '' })),
    briefCastNames(ctx.inputData, ctx.visualBible),
    ctx.visualBible,
    { textZoneRules: textZoneRulesActive(ctx.inputData) },
  );
  for (const f of briefRes.findings) {
    if (!f || !REVIEWABLE.has(f.type) || f.pageNumber === 0) continue;
    if (beatOf(f.pageNumber).jevFixed && JEV_OWNED.has(f.type)) withheld.push(f);
    else findings.push(f);
  }
  const clothingRes = checkClothing(expansions.map((x) => {
    const m = extractSceneMetadata(x.brief) || {};
    return {
      pageNumber: x.pageNumber,
      prose: splitBrief(x.brief).prose,
      cast: (m.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
      perCharClothing: m.characterClothing || {},
      wornItems: m.wornItems || [],
    };
  }), ctx.clothingRequirements, { artifacts: (ctx.visualBible || {}).artifacts, visualBible: ctx.visualBible });
  for (const f of clothingRes.findings) if (f && (CLOTHING_SENDABLE.has(f.type) || REASK_CLOTHING_EXTRA.has(f.type))) findings.push(f);
  // A decided field the brief cannot hold as written: an outdoor page whose
  // weather is `none` (jevDecisions.pinBrief reports it, never guesses one).
  for (const x of expansions) {
    const fixed = beatOf(x.pageNumber).jevFixed;
    if (!fixed) continue;
    const problem = pinBrief(x.brief, fixed).changes.find(c => c.problem === 'outdoors');
    if (problem) {
      findings.push({
        pageNumber: x.pageNumber,
        type: 'weather_none_outdoors',
        detail: 'The page is outdoors, and `weather` is `none` or missing. Choose the story\'s sky — one of the outdoor values — and write it into the prose.',
      });
    }
  }
  return { findings, withheld };
}

/** The names a brief puts in the picture: its `characters[]` rows and the bible figures it cites. */
function namesInBrief(brief, visualBible) {
  const { extractSceneMetadata } = require('./sceneMetadata');
  const { vbFigureNamesCited } = require('./sceneBriefCheck');
  const m = extractSceneMetadata(brief) || {};
  const rows = (Array.isArray(m.characters) ? m.characters : []).map(c => String(typeof c === 'string' ? c : (c && c.name) || '').trim()).filter(Boolean);
  return [...rows, ...vbFigureNamesCited(m, visualBible)];
}

/**
 * The who-column names a rewrite dropped (owner, 2026-09-28: a rewrite never
 * removes a character the plan line puts in frame). A name counts only when
 * the plan line's who column names it and the brief before the rewrite had it.
 */
function whoColumnDropped(prior, rewritten, planLine, visualBible, commissionedNames = []) {
  const { planSegments, namesIn } = require('./planCounters');
  const { isSameFigureName } = require('./sceneMetadata');
  const who = planSegments(String(planLine || '').replace(/^\s*PLAN:\s*/i, ''))[1] || '';
  if (!who) return [];
  const figures = [];
  for (const key of ['secondaryCharacters', 'animals']) {
    const list = visualBible && (Array.isArray(visualBible[key]) ? visualBible[key] : Object.values(visualBible[key] || {}));
    for (const e of list || []) for (const h of [e && e.name, e && e.label]) if (h) figures.push(String(h).trim());
  }
  const inWho = namesIn(who, [...commissionedNames, ...figures]);
  const before = namesInBrief(prior, visualBible);
  const after = namesInBrief(rewritten, visualBible);
  const has = (list, n) => list.some(x => isSameFigureName(x, n));
  return inWho.filter(n => has(before, n) && !has(after, n));
}

/** One page's findings as the re-ask lists them. */
function renderPageFindings(list) {
  return list.map(f => `- [${f.type}] ${String(f.detail || '').trim()}`).join('\n');
}

/**
 * Run the checks, re-ask the Art Director once for the flagged pages, judge
 * each rewrite, re-check. Mutates `expansions` (a taken rewrite replaces the
 * brief; a page whose worn state is still undeclared gets
 * `wornStateUnresolved`). A failed or cut re-ask ships the briefs as they were,
 * flagged — never a failed story.
 *
 * @returns {Promise<Object>} briefCheckReport
 */
async function runBriefChecks({ inputData, expansions, briefBeats, visualBible, clothingRequirements, contextPrompt, model, gl, stage = async () => {}, onCall = null, labCallOptions = {} }) {
  const t0 = Date.now();
  const textModels = require('./textModels');
  const { parseRefinedText, BRIEF_TRAILING_MARKERS, buildBriefReaskPrompt } = require('./promptBuilders');
  const { correctFindings, partitionFindings } = require('./briefCorrection');
  const { assessSceneBrief, describeSceneBrief } = require('./iterateBriefGuard');
  const { pinBrief } = require('./jevDecisions');
  const ctx = { inputData, clothingRequirements, visualBible, briefBeats };
  const beatOf = n => (briefBeats || []).find(b => b && Number(b.pageNumber) === Number(n)) || {};
  const commissioned = (inputData.characters || []).map(c => c && c.name).filter(Boolean);
  const briefsIn = expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief }));

  const before = collectBriefFindings(expansions, ctx);
  for (const f of before.withheld) {
    gl.warn('beats_jev_field_vs_brief', `Page ${f.pageNumber}: ${f.type} on a page whose field the decision layer owns — ${String(f.detail || '').split('. ')[0]}`, null, { pageNumber: f.pageNumber, finding: f });
  }
  const byPage = new Map();
  for (const f of before.findings) {
    if (!byPage.has(f.pageNumber)) byPage.set(f.pageNumber, []);
    byPage.get(f.pageNumber).push(f);
  }
  const flagged = [...byPage.keys()].sort((a, b) => a - b);
  const report = {
    model, findingsBefore: before.findings, withheld: before.withheld, briefsIn,
    reask: null, verdicts: [], pages: [], findingsAfter: [], introduced: [], survived: [], wornUnresolvedPages: [], durationMs: 0,
  };
  if (flagged.length === 0) {
    log.info('🧩 [BEATS] brief checks: every brief clean — no re-ask');
    gl.info('beats_brief_checks', 'Brief checks: every brief clean — no re-ask', null, { withheld: before.withheld.length });
    report.durationMs = Date.now() - t0;
    return report;
  }

  log.info(`🧩 [BEATS] brief checks: ${before.findings.length} finding(s) on page(s) ${flagged.join(', ')} — one re-ask to the Art Director`);
  gl.info('beats_brief_checks', `Brief checks found ${before.findings.length} fault(s) on page(s) ${flagged.join(', ')}`, null, { findings: before.findings });
  await stage(42, 'Checking the scene briefs...', { next: 51, ms: 60000 });
  const jevBackup = !(briefBeats || []).some(b => b && b.jevFixed);
  const prompt = buildBriefReaskPrompt({
    contextPrompt,
    pages: flagged.map(n => ({ pageNumber: n, brief: expansions.find(x => x.pageNumber === n).brief, findings: renderPageFindings(byPage.get(n)) })),
    jevBackup,
  });
  let res = null;
  let failed = null;
  const t1 = Date.now();
  try {
    res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'beats_brief_reask', ...labCallOptions });
    if (onCall) onCall(res);
    if (!res || !String(res.text || '').trim()) failed = 'the re-ask returned nothing';
    else if (res.truncation?.suspected) failed = `the re-ask reply was ${textModels.describeTruncation(res.truncation)}`;
  } catch (err) {
    failed = `the re-ask call failed: ${err.message}`;
  }
  report.reask = { prompt, model: (res && res.modelId) || model, usage: (res && res.usage) || null, durationMs: Date.now() - t1, pages: flagged, failed, reply: (res && res.text) || '' };
  if (failed) {
    log.error(`❌ [BEATS] ${failed} — the briefs ship as written, flagged`);
    gl.error('beats_brief_reask_failed', `${failed} — page(s) ${flagged.join(', ')} ship with their findings`, null, { pages: flagged });
  } else {
    const parsed = parseRefinedText(res.text || '', flagged, 'SCENES', BRIEF_TRAILING_MARKERS);
    const rewrites = new Map(parsed.pages.map(p => [p.pageNumber, p.text]));
    for (const n of flagged) {
      const x = expansions.find(e => e.pageNumber === n);
      const prior = x.brief;
      const raw = rewrites.get(n);
      if (!raw || !raw.trim()) {
        report.verdicts.push({ pageNumber: n, accepted: false, reason: 'refused: the re-ask returned no brief for this page' });
        continue;
      }
      let candidate = keepDeclaredLight(n, keepDeclaredWornRows(n, raw, prior, 'brief re-ask', gl), prior, 'brief re-ask', gl);
      const fixed = beatOf(n).jevFixed;
      let restored = [];
      if (fixed) {
        const pinned = pinBrief(candidate, fixed);
        restored = [...new Set(pinned.changes.filter(c => !c.problem).map(c => c.field))];
        candidate = pinned.brief;
      }
      const guard = assessSceneBrief(candidate);
      const recheck = (text) => collectBriefFindings(expansions.map(e => (e.pageNumber === n ? { pageNumber: n, brief: text } : e)), ctx)
        .findings.filter(f => f.pageNumber === n);
      const verdict = await correctFindings({
        label: `brief re-ask page ${n}`, priorText: prior, payload: prompt, before: byPage.get(n),
        completed: { text: candidate, usable: guard.usable, reason: guard.usable ? null : describeSceneBrief(guard) },
        recheck, acceptance: 'strict',
      });
      let accepted = verdict.accepted;
      let reason = verdict.reason;
      if (accepted) {
        const dropped = whoColumnDropped(prior, candidate, beatOf(n).planLine, visualBible, commissioned);
        if (dropped.length) {
          accepted = false;
          reason = `refused: the rewrite drops ${dropped.join(', ')}, whom the plan line puts in frame`;
          gl.error('beats_brief_reask_who_dropped', `Page ${n}: the re-ask rewrite dropped ${dropped.join(', ')} from the who column — the page keeps its brief`, null, { pageNumber: n, dropped });
        }
      }
      if (accepted) { x.brief = candidate; report.pages.push({ pageNumber: n, after: candidate }); }
      if (restored.length) gl.warn('beats_jev_field_disobeyed', `Page ${n}: the re-ask rewrite changed decided field(s) ${restored.join(', ')} — code restored them`, null, { pageNumber: n, fields: restored, pass: 'brief re-ask' });
      report.verdicts.push({ pageNumber: n, accepted, reason, resolved: verdict.resolved?.map(f => f.type) || [], survived: verdict.survived?.map(f => f.type) || [], introduced: verdict.introduced?.map(f => f.type) || [], restoredFields: restored });
      gl.info('beats_brief_reask_verdict', `Page ${n}: ${reason}`, null, { pageNumber: n, accepted });
    }
  }

  const after = collectBriefFindings(expansions, ctx);
  const parts = partitionFindings(before.findings, after.findings);
  report.findingsAfter = after.findings;
  report.introduced = parts.introduced;
  report.survived = parts.survived;
  if (parts.survived.length) gl.warn('beats_brief_unfixed', `Brief faults present after the re-ask: ${parts.survived.map(f => `p${f.pageNumber} ${f.type}`).join('; ')}`, null, { findings: parts.survived });
  if (parts.introduced.length) gl.warn('beats_brief_introduced', `The re-ask introduced ${parts.introduced.length} brief fault(s): ${parts.introduced.map(f => `p${f.pageNumber} ${f.type}`).join('; ')}`, null, { findings: parts.introduced });
  // A worn state still undeclared ships flagged and defaults to worn
  // (decisions.md 2026-09-06) — the flag the scene review used to set.
  const wornPages = [...new Set(after.findings.filter(f => f.type === 'removal_unstated').map(f => f.pageNumber))].sort((a, b) => a - b);
  for (const x of expansions) if (wornPages.includes(x.pageNumber)) x.wornStateUnresolved = true;
  if (wornPages.length) gl.warn('beats_worn_state_unresolved', `Worn-item state undeclared after the re-ask on page(s) ${wornPages.join(', ')} — pages ship with wornStateUnresolved and the item defaults to worn`, null, { pages: wornPages });
  report.wornUnresolvedPages = wornPages;
  report.durationMs = Date.now() - t0;
  const taken = report.verdicts.filter(v => v.accepted).map(v => v.pageNumber);
  log.info(`🧩 [BEATS] brief re-ask: ${taken.length}/${flagged.length} page(s) taken${taken.length ? ` (${taken.join(', ')})` : ''}; ${after.findings.length} finding(s) left (${(report.durationMs / 1000).toFixed(1)}s)`);
  gl.info('beats_brief_reask', `Brief re-ask by ${report.reask.model}: ${taken.length}/${flagged.length} page(s) taken, ${after.findings.length} finding(s) left (${(report.durationMs / 1000).toFixed(1)}s)`, null, { taken, flagged, left: after.findings.length });
  return report;
}

module.exports = {
  JEV_OWNED,
  REASK_CLOTHING_EXTRA,
  keepDeclaredWornRows,
  keepDeclaredLight,
  briefCastNames,
  collectBriefFindings,
  namesInBrief,
  whoColumnDropped,
  renderPageFindings,
  runBriefChecks,
};
