/**
 * THE TRIAL PAGE CHECK — two defect classes, one re-render, loud on failure.
 *
 * A trial runs no quality eval and no repair, by design (docs/decisions.md
 * "Trial stories skip the quality-eval + repair pipeline": speed). That left a
 * trial page with no safety net at all, and three staging trials shipped the
 * two defects the full path's judges exist to catch:
 *   - painted lettering nobody asked for (job_1791531511694_j945yhw9a p6 painted
 *     "Rohan / Rüebli / Kirche Rohrdorf"; job_1791496201302_6vgktllu5 p6 painted
 *     "A STORY OF EMMA AND STUPF"), from prompts that said "no lettering";
 *   - a character drawn twice (job_1791531512895_3bofwpxh4 p2: the child once
 *     carried on Mama's arm and once standing), from a prompt naming one child.
 *
 * This module is the MINIMUM that closes exactly those two, and it reuses what
 * the full path already has instead of building a second inventory:
 *   - the blind vision inventory (evalPipeline.runVisualInventory) on the
 *     cheapest model the full path uses for it (MODEL_DEFAULTS.inventoryModel);
 *   - the undeclared-lettering comparison (letteringCheck.checkUndeclaredLettering)
 *     against the page's declared strings (requiredText);
 *   - the roster arithmetic's own cast count (evalPipeline.buildExpectedCastBlock
 *     + castPeopleCount): people drawn against people the page holds.
 * The inventory prompt classifies each string (overlay / fits / misplaced,
 * spelling); code only compares two numbers and maps the pair to a severity.
 * Nothing here reads a finding's prose.
 *
 * ONE call per page, started the moment the page image lands, in parallel with
 * every other page. The caller has already saved the page for progressive
 * display, so the check never delays the first image the user sees. A failed
 * page is re-rendered ONCE with the defect fed back (a generic sentence that
 * never quotes the letters the inventory read: an image model paints what it
 * reads, letteringCheck.redactReadLettering); if the re-render still fails the
 * page ships and the job says so — a runMetrics counter and an error log. A
 * check that cannot run (no inventory answer) is logged and counted too; it is
 * never read as a pass.
 *
 * DUPLICATES are judged only where the brief says the page is `cast_only`: on a
 * populated page (crowd / ambient / sparse) an extra figure is not a defect the
 * brief lets arithmetic name (derivePresenceFinding declines the same pages).
 *
 * Decision record: docs/decisions.md "The trial gets a minimal page check".
 */
'use strict';

const { log } = require('../utils/logger');

// Counter names — one vocabulary, read by the verify entry and the stats page.
const COUNTERS = Object.freeze({
  PASS: 'trial_page_check_pass',
  FAIL_LETTERING: 'trial_page_check_fail_lettering',
  FAIL_DUPLICATE: 'trial_page_check_fail_duplicate',
  UNAVAILABLE: 'trial_page_check_unavailable',
  REDO: 'trial_page_redo',
  REDO_FIXED: 'trial_page_redo_fixed',
  REDO_FAILED_RENDER: 'trial_page_redo_render_failed',
  SHIPPED_DEFECTIVE: 'trial_page_shipped_defective',
  DUP_SKIPPED_POPULATION: 'trial_page_check_duplicate_skipped_population',
});

/** `…background` zones of the inventory's closed vocabulary. */
const isBackgroundZone = (f) => /background$/.test(String(f?.zone || ''));

/**
 * Findings of one page from its inventory. Pure.
 *
 * @param {Object}   a
 * @param {Object}   a.inventory      runVisualInventory() result
 * @param {string[]} a.declared       strings the page declares (requiredText)
 * @param {number|null} a.expectedPeople  people the page's roster holds; null = roster not declared
 * @param {string}   a.population     the brief's population level
 * @returns {{findings: Array<{type, severity, description}>, skippedDuplicate: boolean}}
 */
function trialPageFindings({ inventory, declared = [], expectedPeople = null, population = 'cast_only' } = {}) {
  const { checkUndeclaredLettering } = require('./letteringCheck');
  const findings = [];

  // LETTERING: CRITICAL only (overlay caption, misspelled, misplaced-legible).
  // A MINOR scribble on a surface that carries writing is not worth a re-render.
  for (const f of checkUndeclaredLettering({ lettering: inventory?.lettering, declared })) {
    if (f.severity === 'CRITICAL') findings.push({ type: 'rendered_text', severity: 'CRITICAL', description: f.description });
  }

  // DUPLICATES / EXTRA PEOPLE: people drawn against people the page holds.
  let skippedDuplicate = false;
  if (population !== 'cast_only') {
    skippedDuplicate = true;
  } else if (Number.isFinite(expectedPeople)) {
    const drawn = (Array.isArray(inventory?.figures) ? inventory.figures : []).filter(f => !isBackgroundZone(f)).length;
    if (drawn > expectedPeople) {
      findings.push({
        type: 'extra_character',
        severity: 'CRITICAL',
        description: `${drawn} people are drawn but this page holds ${expectedPeople}: one character is drawn more than once, or a person nobody asked for is in the frame.`,
        drawn,
        expectedPeople,
      });
    }
  }
  return { findings, skippedDuplicate };
}

/**
 * The generic correction appended to the page prompt for the one re-render.
 * States what to do, never what the inventory read (no quoted letters).
 * @param {Array<{type}>} findings
 * @param {{expectedPeople?: number|null}} [ctx]
 * @returns {string} '' when there is nothing to say
 */
function redoCorrection(findings, { expectedPeople = null } = {}) {
  const lines = [];
  if (findings.some(f => f.type === 'rendered_text')) {
    lines.push('The previous render of this page carried painted lettering that nothing asked for. Paint no readable letters, words, names or captions anywhere in the picture: signs, walls, paper, clothing and the sky carry plain marks only, except any REQUIRED TEXT above.');
  }
  if (findings.some(f => f.type === 'extra_character')) {
    lines.push(`The previous render of this page drew a character more than once.${Number.isFinite(expectedPeople) ? ` This page holds exactly ${expectedPeople} ${expectedPeople === 1 ? 'person' : 'people'}.` : ''} Draw every named character exactly once: a character who is carried, held or standing beside another is one figure, never a second copy of themselves.`);
  }
  return lines.length ? `\n\nCORRECTION: ${lines.join(' ')}` : '';
}

/**
 * Run the check on one rendered page: the inventory, then the pure comparison.
 *
 * @param {Object} a
 * @param {string} a.imageData      data URI or base64 of the page
 * @param {string} a.pageContext    log label
 * @param {number} a.pageNumber
 * @param {Object} a.sceneMetadata  the page's parsed scene metadata
 * @param {Array}  a.sceneCharacters the page's cast records (photo-backed characters)
 * @param {Object} a.visualBible
 * @param {Object} a.inputData      the job input (characters, language)
 * @param {Function} [a.usageTracker] (provider, usage, label, model) -> void
 * @returns {Promise<{ok: boolean, findings: Array, available: boolean, expectedPeople: number|null, lettering?: Object, ms: number}>}
 */
async function checkTrialPage({ imageData, pageContext, pageNumber, sceneMetadata, sceneCharacters, visualBible, inputData, usageTracker = null }) {
  const t0 = Date.now();
  const { runVisualInventory, buildExpectedCastBlock, castPeopleCount } = require('./evalPipeline');
  const { MODEL_DEFAULTS } = require('./textModels');
  const { PROMPT_TEMPLATES } = require('../services/prompts');
  const r2Lib = require('./r2');
  const requiredText = require('./requiredText');

  if (!PROMPT_TEMPLATES.imageInventoryUnified || !process.env.GEMINI_API_KEY) {
    // The same two preconditions evaluateImageQuality has for its inventory.
    log.error(`❌ [TRIAL-CHECK] ${pageContext}: inventory prompt or GEMINI_API_KEY missing — page NOT checked`);
    return { ok: false, available: false, findings: [], expectedPeople: null, ms: Date.now() - t0 };
  }
  const b64 = r2Lib.stripDataUriPrefix(imageData);
  const mime = String(imageData).match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';
  const inventory = await runVisualInventory(
    [{ inline_data: { mime_type: mime, data: b64 } }],
    MODEL_DEFAULTS.inventoryModel || MODEL_DEFAULTS.qualityEval || 'gemini-2.5-flash',
    process.env.GEMINI_API_KEY, pageContext, { pageNumber }
  );
  if (!inventory) {
    log.error(`❌ [TRIAL-CHECK] ${pageContext}: the inventory returned nothing — page NOT checked`);
    return { ok: false, available: false, findings: [], expectedPeople: null, ms: Date.now() - t0 };
  }
  if (usageTracker) {
    usageTracker('gemini_quality', {
      input_tokens: inventory.inputTokens || 0, output_tokens: inventory.outputTokens || 0, thinking_tokens: inventory.thinkingTokens || 0,
    }, `${pageContext}_trial_check_inventory`, inventory.servedByModel);
  }

  // Declared lettering and expected cast: the same builders the full eval reads.
  const objectIds = Array.isArray(sceneMetadata?.objects) ? sceneMetadata.objects : [];
  const declared = requiredText.collectImageRequiredTexts({
    objectIds, visualBible: visualBible || null, language: inputData?.language || 'en',
  }).map(r => r.text).filter(Boolean);
  const cast = buildExpectedCastBlock({
    sceneCharacters: sceneCharacters || [],
    sceneMetadata,
    visualBible: visualBible || null,
    pageNumber,
    pageLabel: pageContext,
    storyData: { characters: inputData?.characters || [] },
  });
  const expectedPeople = castPeopleCount(cast);
  const { findings, skippedDuplicate } = trialPageFindings({
    inventory, declared, expectedPeople, population: cast.population,
  });
  return {
    ok: findings.length === 0,
    available: true,
    findings,
    expectedPeople,
    skippedDuplicate,
    population: cast.population,
    figures: (inventory.figures || []).length,
    lettering: (inventory.lettering || []).map(l => ({ text: l?.text, placement: l?.placement, spelling: l?.spelling })),
    ms: Date.now() - t0,
  };
}

/**
 * Check a freshly rendered trial page and, on a failure, re-render it once.
 *
 * @param {Object} a
 * @param {Object}   a.genResult    the render result ({imageData, ...})
 * @param {Function} a.render       async (correctionSentence) => genResult; the page's own render call with the sentence appended to its prompt
 * @param {Object}   a.check        the checkTrialPage() context (everything except imageData)
 * @param {Object}   a.metrics      {count(name)} — runMetrics.forJob(jobId)
 * @param {Function} [a.onRedone]   async (newGenResult) => void, e.g. re-save the progressive-display checkpoint
 * @returns {Promise<{genResult: Object, redone: boolean, checks: Array}>}
 */
async function guardTrialPage({ genResult, render, check, metrics, onRedone = null }) {
  const label = check.pageContext;
  const checks = [];
  if (!genResult?.imageData) return { genResult, redone: false, checks };

  // A fault INSIDE the check is an unavailable check — loud, counted, and never
  // a reason to lose the page it was guarding.
  const run = async (imageData) => {
    try {
      return await checkTrialPage({ ...check, imageData });
    } catch (err) {
      log.error(`❌ [TRIAL-CHECK] ${label}: the check itself threw (${err.message}) — page NOT checked`);
      return { ok: false, available: false, findings: [], expectedPeople: null, ms: 0 };
    }
  };

  const first = await run(genResult.imageData);
  checks.push(first);
  if (!first.available) {
    metrics.count(COUNTERS.UNAVAILABLE);
    return { genResult, redone: false, checks };
  }
  if (first.skippedDuplicate) metrics.count(COUNTERS.DUP_SKIPPED_POPULATION);
  if (first.ok) {
    metrics.count(COUNTERS.PASS);
    log.info(`✅ [TRIAL-CHECK] ${label}: clean (${first.figures} figure(s), ${first.ms} ms)`);
    return { genResult, redone: false, checks };
  }
  for (const f of first.findings) {
    metrics.count(f.type === 'rendered_text' ? COUNTERS.FAIL_LETTERING : COUNTERS.FAIL_DUPLICATE);
    log.warn(`⚠️ [TRIAL-CHECK] ${label}: [${f.severity}] ${f.description}`);
  }

  // ONE re-render, started now, with the defect fed back.
  metrics.count(COUNTERS.REDO);
  let redo;
  try {
    redo = await render(redoCorrection(first.findings, { expectedPeople: first.expectedPeople }));
  } catch (err) {
    metrics.count(COUNTERS.REDO_FAILED_RENDER);
    metrics.count(COUNTERS.SHIPPED_DEFECTIVE);
    log.error(`❌ [TRIAL-CHECK] ${label}: re-render failed (${err.message}) — SHIPPING THE DEFECTIVE PAGE`);
    return { genResult, redone: false, checks };
  }
  if (!redo?.imageData) {
    metrics.count(COUNTERS.REDO_FAILED_RENDER);
    metrics.count(COUNTERS.SHIPPED_DEFECTIVE);
    log.error(`❌ [TRIAL-CHECK] ${label}: re-render returned no image — SHIPPING THE DEFECTIVE PAGE`);
    return { genResult, redone: false, checks };
  }
  const second = await run(redo.imageData);
  checks.push(second);
  if (second.available && second.ok) {
    metrics.count(COUNTERS.REDO_FIXED);
    log.info(`✅ [TRIAL-CHECK] ${label}: re-render is clean`);
  } else {
    // Ship whichever render has fewer findings (tie: the re-render); an
    // unchecked re-render counts as no better than the original.
    metrics.count(COUNTERS.SHIPPED_DEFECTIVE);
    log.error(`❌ [TRIAL-CHECK] ${label}: the re-render ${second.available ? `still fails (${second.findings.length} finding(s))` : 'could not be checked'} — SHIPPING A PAGE THE CHECK DID NOT CLEAR`);
  }
  const secondBetter = second.available && second.findings.length <= first.findings.length;
  const chosen = second.ok || secondBetter ? redo : genResult;
  if (chosen === redo && onRedone) await onRedone(redo);
  return { genResult: chosen, redone: chosen === redo, checks };
}

module.exports = { COUNTERS, trialPageFindings, redoCorrection, checkTrialPage, guardTrialPage };
