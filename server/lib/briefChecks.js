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

/**
 * Finding types that concern only a cover page (owner, 2026-09-30): each of
 * these fires exclusively on `isCoverPage` pages (sceneBriefCheck's cover
 * checks). A cover-only finding ships flagged rather than triggering the
 * re-ask — the 2026-09-28 Jev-first replay (job_1790618717512_n9wrh5u0j) sent
 * a `cover_location_repeated` finding to the re-ask and the rewrite it
 * produced was refused as "resolves nothing", at the call's full cost.
 *
 * CORRECTED 2026-10-04: the reason first given here — "a cover's location is a
 * decided field the re-ask cannot move" — was false when written. Nothing
 * decided a cover's place then: the Art Director picked it (the Visual Bible
 * call put every cover on one vantage, the briefs copied it), and no pin would
 * have undone a re-ask move. The refusals came from the recheck, which reads
 * each rewritten page against the OTHER covers' original briefs, so a repeat
 * between two covers cannot clear by moving one at a time
 * (staging job_1791040103540_atbttop6w: −2 taken, −3 refused).
 *
 * Since 2026-10-04 (jevBriefFields.decideCoverPlaces):
 *   - Jev path: each cover's location IS decided (Jev ranks the wide vantages,
 *     code makes them distinct) and pinned — after the page-brief call, after
 *     this re-ask, after an iterate rewrite. `cover_location_repeated` does not
 *     compare a decided cover, so it never fires there. The re-ask may rewrite
 *     a cover only for its non-cover findings, and code restores the location.
 *   - Backup path (Jev outage, or no candidate vantage): the Art Director picks
 *     the place under COVER_OWN_PLACE; `cover_location_repeated` fires and the
 *     finding ships flagged, never re-asked, for the recheck reason above.
 * A page with both cover and non-cover findings still sends its non-cover
 * findings (only covers are pages -1/-2/-3, so this never collides with a
 * story page).
 */
const COVER_ONLY_TYPES = new Set(['cover_cast_dropped', 'cover_location_repeated', 'cover_gaze_not_viewer', 'cover_text_zone_mismatch']);

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
  const {
    checkScenes: checkBriefs, REVIEWABLE,
    checkNegationNamed, checkElementUncited, checkCharacterFields, checkCastNotInPlan, checkRequiredTextUndeclared,
  } = require('./sceneBriefCheck');
  const { checkScenes: checkClothing, REVIEWABLE: CLOTHING_SENDABLE, checkClothingIncomplete } = require('./clothingCheck');
  const { extractSceneMetadata, splitBrief } = require('./sceneMetadata');
  const { textZoneRulesActive } = require('../config/runtime');
  const { pinBrief } = require('./jevDecisions');
  const beatOf = n => (ctx.briefBeats || []).find(b => b && Number(b.pageNumber) === Number(n)) || {};
  const findings = [];
  const withheld = [];
  const briefRes = checkBriefs(
    expansions.map(x => ({ pageNumber: x.pageNumber, brief: x.brief, planLine: beatOf(x.pageNumber).planLine || '', placeDecided: !!(beatOf(x.pageNumber).jevFixed && beatOf(x.pageNumber).jevFixed.coverPlace) })),
    briefCastNames(ctx.inputData, ctx.visualBible),
    ctx.visualBible,
    { textZoneRules: textZoneRulesActive(ctx.inputData) },
  );
  for (const f of briefRes.findings) {
    if (!f || !REVIEWABLE.has(f.type) || f.pageNumber === 0) continue;
    // A cover's jevFixed holds its place alone (coverPlace): the story-page fields JEV_OWNED names are not decided there.
    const fx = beatOf(f.pageNumber).jevFixed;
    if (fx && !fx.coverPlace && JEV_OWNED.has(f.type)) withheld.push(f);
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
  // The scene review's rules kept as code checks (owner, 2026-09-28, Q9), plus
  // the required-text check. Each page reads its beat's head count (`inFrame`)
  // and the decision layer's READ answer (`jevFixed.readsText`).
  const commissioned = (ctx.inputData.characters || []).map(c => c && c.name).filter(Boolean);
  for (const x of expansions) {
    const meta = extractSceneMetadata(x.brief) || {};
    const full = meta.fullData || meta;
    const b = beatOf(x.pageNumber);
    const page = { pageNumber: x.pageNumber, brief: x.brief, planLine: b.planLine || '', inFrame: b.inFrame, readsText: !!(b.jevFixed && b.jevFixed.readsText) };
    findings.push(
      ...checkNegationNamed(page, meta),
      ...checkElementUncited(page, full, ctx.visualBible, commissioned),
      ...checkCharacterFields(page, full),
      ...checkCastNotInPlan(page, full, commissioned),
      ...checkRequiredTextUndeclared(page, full, ctx.visualBible),
      ...checkClothingIncomplete({
        pageNumber: x.pageNumber, prose: splitBrief(x.brief).prose, shot: full.shot, perCharClothing: meta.characterClothing || {},
        cast: (full.characters || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean),
      }, ctx.clothingRequirements),
    );
  }
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

/**
 * The re-ask's text lane (required_text_undeclared): the ---VISUAL BIBLE---
 * block after the pages, `{"text": [{id, text}]}`. Taken only for an id one of
 * the `allowed` findings cites (the page's own cited elements) and only as a
 * non-empty string; written onto the bible entry. Everything else in the block
 * is reported as rejected — the lane declares lettering, nothing more.
 *
 * @returns {{applied: Array<{id, oldText, newText}>, rejected: Array<{id, reason}>}}
 */
function applyBibleTextLane(raw, visualBible, allowedIds) {
  const out = { applied: [], rejected: [] };
  const text = String(raw || '');
  const marker = text.match(/---\s*VISUAL BIBLE\s*---/i);
  if (!marker || !visualBible) return out;
  const body = text.slice(marker.index + marker[0].length);
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = (fenced ? fenced[1] : body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)).trim();
  let json;
  try { json = JSON.parse(jsonText); } catch (err) {
    out.rejected.push({ id: '(section)', reason: `unparseable JSON (${err.message})` });
    return out;
  }
  const rows = json && Array.isArray(json.text) ? json.text : [];
  if (!rows.length) out.rejected.push({ id: '(section)', reason: 'no `text` rows' });
  const allowed = new Set([...allowedIds].map(id => String(id).toUpperCase()));
  for (const row of rows) {
    const id = String((row && row.id) || '').trim().toUpperCase().split('.')[0];
    const value = row && typeof row.text === 'string' ? row.text.trim() : '';
    if (!id || !value) { out.rejected.push({ id: id || '(none)', reason: 'row has no id or no text' }); continue; }
    if (!allowed.has(id)) { out.rejected.push({ id, reason: 'not an element a page with required_text_undeclared cites' }); continue; }
    let entry = null;
    for (const key of ['artifacts', 'vehicles', 'locations', 'animals', 'secondaryCharacters']) {
      const list = Array.isArray(visualBible[key]) ? visualBible[key] : Object.values(visualBible[key] || {});
      entry = entry || list.find(e => e && String(e.id || '').toUpperCase().split('.')[0] === id) || null;
    }
    if (!entry) { out.rejected.push({ id, reason: 'no bible entry has that id' }); continue; }
    out.applied.push({ id, oldText: typeof entry.text === 'string' ? entry.text : null, newText: value });
    entry.text = value;
  }
  return out;
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
async function runBriefChecks({ inputData, expansions, briefBeats, visualBible, visualBibleJson, clothingRequirements, availableAvatars, maxCharactersPerScene, model, gl, stage = async () => {}, onCall = null, labCallOptions = {} }) {
  const t0 = Date.now();
  const textModels = require('./textModels');
  const { parseRefinedText, BRIEF_TRAILING_MARKERS, buildBriefReaskPrompt, buildBriefReaskContext } = require('./promptBuilders');
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
  // Cover-only findings ship flagged — they never reach the re-ask (see
  // COVER_ONLY_TYPES). A page with both kinds still sends its non-cover ones.
  const coverOnly = before.findings.filter(f => f && COVER_ONLY_TYPES.has(f.type));
  for (const f of coverOnly) {
    gl.info('beats_brief_cover_only_shipped', `Page ${f.pageNumber}: ${f.type} ships flagged — cover-only findings never trigger the re-ask`, null, { pageNumber: f.pageNumber, finding: f });
  }
  const reaskable = before.findings.filter(f => !(f && COVER_ONLY_TYPES.has(f.type)));
  const byPage = new Map();
  for (const f of reaskable) {
    if (!byPage.has(f.pageNumber)) byPage.set(f.pageNumber, []);
    byPage.get(f.pageNumber).push(f);
  }
  const flagged = [...byPage.keys()].sort((a, b) => a - b);
  const report = {
    model, findingsBefore: before.findings, withheld: before.withheld, coverOnlyShipped: coverOnly, briefsIn,
    reask: null, bibleText: null, verdicts: [], pages: [], findingsAfter: [], introduced: [], survived: [], wornUnresolvedPages: [], durationMs: 0,
  };
  if (flagged.length === 0) {
    log.info('🧩 [BEATS] brief checks: every brief clean — no re-ask');
    gl.info('beats_brief_checks', 'Brief checks: every brief clean — no re-ask', null, { withheld: before.withheld.length, coverOnlyShipped: coverOnly.length });
    report.durationMs = Date.now() - t0;
    return report;
  }

  log.info(`🧩 [BEATS] brief checks: ${reaskable.length} finding(s) on page(s) ${flagged.join(', ')} — one re-ask to the Art Director`);
  gl.info('beats_brief_checks', `Brief checks found ${reaskable.length} fault(s) on page(s) ${flagged.join(', ')}`, null, { findings: reaskable });
  await stage(42, 'Checking the scene briefs...', { next: 51, ms: 60000 });
  const jevBackup = !(briefBeats || []).some(b => b && b.jevFixed);
  // THE SLIM CONTEXT (owner, 2026-09-30): the call-2 template's own rules and
  // output contract, the Visual Bible, and only the FLAGGED pages' plan lines
  // and FIXED blocks — never the whole book. See buildBriefReaskContext.
  const adContext = buildBriefReaskContext(inputData, briefBeats, flagged, {
    jevBackup, availableAvatars, maxCharactersPerScene, visualBible: visualBibleJson,
  }) || '';
  const prompt = buildBriefReaskPrompt({
    contextPrompt: adContext,
    pages: flagged.map(n => ({ pageNumber: n, brief: expansions.find(x => x.pageNumber === n).brief, findings: renderPageFindings(byPage.get(n)) })),
    jevBackup,
  });
  let res = null;
  let failed = null;
  const t1 = Date.now();
  try {
    // Reasoning lowered one step from the model's default (owner, 2026-09-30):
    // the lector A/B on the same model found "medium" ✅ / "low" ❌ — see
    // docs/decisions.md. labCallOptions (Test Lab) may still override it.
    res = await textModels.callTextModelStreaming(prompt, null, null, model, { usageLabel: 'beats_brief_reask', reasoning: { effort: 'medium' }, ...labCallOptions });
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
    // The text lane first, so each page's recheck reads the declared lettering.
    const textFindings = before.findings.filter(f => f.type === 'required_text_undeclared');
    if (textFindings.length) {
      const lane = applyBibleTextLane(res.text, visualBible, textFindings.flatMap(f => f.cited || []));
      report.bibleText = lane;
      for (const a of lane.applied) gl.info('beats_brief_reask_text', `${a.id}: the re-ask declared text "${a.newText}"${a.oldText ? ` (was "${a.oldText}")` : ''}`, null, a);
      for (const r of lane.rejected) gl.warn('beats_brief_reask_text_rejected', `${r.id}: ${r.reason}`, null, r);
    }
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
      // A contract violation (the payload does not carry the brief it corrects)
      // stops this page's correction, loudly — never the story.
      let verdict;
      try {
        verdict = await correctFindings({
          label: `brief re-ask page ${n}`, priorText: prior, payload: prompt, before: byPage.get(n),
          completed: { text: candidate, usable: guard.usable, reason: guard.usable ? null : describeSceneBrief(guard) },
          recheck, acceptance: 'strict',
        });
      } catch (err) {
        gl.error('beats_brief_reask_contract', `Page ${n}: ${err.message} — the page keeps its brief`, null, { pageNumber: n });
        report.verdicts.push({ pageNumber: n, accepted: false, reason: `refused: ${err.message}` });
        continue;
      }
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
  COVER_ONLY_TYPES,
  keepDeclaredWornRows,
  keepDeclaredLight,
  briefCastNames,
  collectBriefFindings,
  applyBibleTextLane,
  namesInBrief,
  whoColumnDropped,
  renderPageFindings,
  runBriefChecks,
};
