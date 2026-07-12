/**
 * Feedback Consolidator
 *
 * Takes all evaluator feedback (quality, semantic, entity, final checks) plus
 * bbox detection and the current image, and asks Claude Haiku to:
 * 1. Dedupe and classify issues (per-character vs scene)
 * 2. Translate character names to visual identifiers Grok can understand
 *    (e.g. "Roger" → "the tall man in the center holding a book")
 * 3. Produce a clean repair plan: per-character fixes (each needs avatar)
 *    + a single scene instruction (avatars optional).
 *
 * Called by the inpaint/repair wrapper before building the edit instruction.
 */

const { callTextModel } = require('./textModels');
const { PROMPT_TEMPLATES } = require('../services/prompts');
const { extractJsonFromText, buildCharacterPhysicalDescription } = require('./storyHelpers');
const { log } = require('../utils/logger');

/**
 * Build the Haiku input text from all feedback sources.
 */
function buildFeedbackInput({
  sceneDescription,
  fixableIssues = [],
  semanticIssues = [],
  complianceIssues = [],
  entityIssues = [],
  finalCheckIssues = [],
  bboxFigures = [],
  characterDescriptions = {},
}) {
  const parts = [];

  parts.push('## Intended scene description');
  parts.push(sceneDescription || '(not provided)');
  parts.push('');

  parts.push('## Characters (name → physical description)');
  const charEntries = Object.entries(characterDescriptions);
  if (charEntries.length === 0) {
    parts.push('(none provided)');
  } else {
    for (const [name, desc] of charEntries) {
      parts.push(`- **${name}**: ${desc}`);
    }
  }
  parts.push('');

  parts.push('## Detected figures in the image (from bbox detector)');
  if (bboxFigures.length === 0) {
    parts.push('(no figures detected)');
  } else {
    for (const fig of bboxFigures) {
      const name = fig.name || fig.label || '(unknown)';
      const bbox = fig.bodyBox ? `bbox=[${fig.bodyBox.map(v => v?.toFixed?.(3) ?? v).join(', ')}]` : '(no bbox)';
      const pos = fig.position ? `position=${fig.position}` : '';
      parts.push(`- ${name} — ${bbox} ${pos}`);
    }
  }
  parts.push('');

  parts.push('## Quality evaluation issues');
  if (fixableIssues.length === 0) {
    parts.push('(none)');
  } else {
    for (const iss of fixableIssues) {
      const sev = iss.severity || 'MODERATE';
      const type = iss.type || 'general';
      const desc = iss.description || iss.issue || '(no description)';
      const fix = iss.fix ? ` — suggested: ${iss.fix}` : '';
      parts.push(`- [${sev}] (${type}) ${desc}${fix}`);
    }
  }
  parts.push('');

  parts.push('## Semantic evaluation issues');
  if (semanticIssues.length === 0) {
    parts.push('(none)');
  } else {
    for (const iss of semanticIssues) {
      const sev = iss.severity || 'MAJOR';
      const type = iss.type || 'general';
      const item = iss.item ? ` [${iss.item}]` : '';
      const problem = iss.problem || iss.description || '(no description)';
      const expected = iss.expected ? ` — expected: ${iss.expected}` : '';
      const observed = iss.observed ? ` — observed: ${iss.observed}` : '';
      parts.push(`- [${sev}] (${type})${item} ${problem}${expected}${observed}`);
    }
  }
  parts.push('');

  parts.push('## Compliance evaluation issues (prompt-compliance evaluator)');
  if (complianceIssues.length === 0) {
    parts.push('(none)');
  } else {
    for (const iss of complianceIssues) {
      const sev = iss.severity || 'MODERATE';
      const type = iss.type || 'general';
      const desc = iss.description || iss.issue || '(no description)';
      const fix = iss.fix ? ` — suggested: ${iss.fix}` : '';
      parts.push(`- [${sev}] (${type}) ${desc}${fix}`);
    }
  }
  parts.push('');

  parts.push('## Entity consistency issues (per-character appearance drift)');
  if (entityIssues.length === 0) {
    parts.push('(none)');
  } else {
    for (const iss of entityIssues) {
      parts.push(`- [${iss.severity || '?'}] ${iss.characterName}: ${iss.description}`);
    }
  }
  parts.push('');

  if (finalCheckIssues.length > 0) {
    parts.push('## Final checks issues');
    for (const iss of finalCheckIssues) {
      parts.push(`- [${iss.severity || '?'}] ${iss.description || iss.issue}`);
    }
    parts.push('');
  }

  parts.push('---');
  parts.push('Produce the JSON repair plan per the system instructions. Output ONLY the JSON object.');

  return parts.join('\n');
}

/**
 * Flatten entity report characters[name].issues[] into a flat list.
 *
 * Read only from the TOP-LEVEL char.issues array — entityConsistency.js stores
 * every issue in two places (byClothing[cat].issues AND top-level .issues),
 * but only the top-level version gets pageNumbers stamped on it. Reading both
 * causes: (1) "duplicated x2" drops in the consolidator, and (2) worse — the
 * byClothing copies have no pageNumbers, so the per-page filter downstream
 * lets them through on every page, not just the ones where the character
 * actually appears. That's how Werner's "bald/glasses" findings from page 4
 * leaked into every other page's repair plan.
 */
function flattenEntityIssues(entityReport) {
  const out = [];
  if (!entityReport?.characters) return out;
  for (const [charName, charData] of Object.entries(entityReport.characters)) {
    for (const iss of charData.issues || []) {
      out.push({
        characterName: charName,
        description: iss.description || iss.issue || '',
        severity: iss.severity || 'MODERATE',
        pageNumbers: iss.pageNumbers,
      });
    }
  }
  return out;
}

/**
 * Consolidate all feedback for a page into a clean repair plan.
 *
 * Text-only: the consolidator dedupes / sorts / trims evaluator findings,
 * it does NOT see the page image. Removing the vision pass eliminates the
 * "Sonnet invents a fix that no evaluator flagged" failure mode (e.g. cover
 * inpaint asking Grok to "Replace the face" / "Remove the beard" because
 * Sonnet's own image observation disagreed with the character profile, even
 * though the quality / semantic / entity evaluators raised neither issue).
 *
 * @param {object} args
 * @param {string} args.sceneDescription - intended scene description
 * @param {object} args.evaluation - quality evaluation { fixableIssues, semanticResult, bboxDetection }
 * @param {object} [args.entityReport] - entity consistency report (whole story) — only entries for this page are used
 * @param {number} [args.pageNumber] - page number (for filtering entity report)
 * @param {Array} [args.characters] - story characters [{ name, physicalDescription }]
 * @returns {Promise<{plan: object|null, usage: object|null, error: string|null}>}
 */
async function consolidateFeedback({
  sceneDescription,
  evaluation = {},
  entityReport = null,
  // Pre-flattened per-page entity issues ({ characterName|name, severity,
  // description }). When provided, used directly instead of flattening +
  // page-filtering entityReport — the eval-consolidation path already has
  // the per-page issues from getEntityPenaltyAndIssues.
  entityIssues: entityIssuesInput = null,
  pageNumber = null,
  characters = [],
  // Per-scene clothing text keyed by character name. Overrides each
  // character's default (modern) clothing so fix instructions don't tell
  // Grok to redress a medieval scene in hoodies.
  sceneClothing = null,
  // Optional audit trail — callers pass storyId + round so every consolidator
  // invocation persists its exact input + output to the DB. This lets us
  // inspect any past call later without reconstructing from partial state.
  storyId = null,
  round = null,
  // Model override — defaults to the configured eval model (resolveEvalModel,
  // key-guarded). The A/B replay passes an explicit model to compare.
  modelOverride = null,
}) {
  try {
    const template = PROMPT_TEMPLATES.feedbackConsolidator;
    if (!template) {
      return { plan: null, usage: null, error: 'feedbackConsolidator prompt template not loaded' };
    }

    // evaluateImageQuality merges the compliance (three-stage) findings into
    // fixableIssues tagged `source: 'three-stage'` — split them back out so
    // each evaluator's findings appear under its own section (and the
    // consolidator's `sources` attribution is accurate). threeStageResult is
    // the single source for compliance; the tagged copies are display-only.
    const rawFixable = evaluation.fixableIssues || [];
    const fixableIssues = rawFixable.filter(i => i?.source !== 'three-stage');
    const complianceIssues =
      evaluation.threeStageResult?.fixableIssues ||
      evaluation.threeStageResult?.issues ||
      rawFixable.filter(i => i?.source === 'three-stage');
    const semanticIssues =
      evaluation.semanticResult?.semanticIssues ||
      evaluation.semanticResult?.issues ||
      [];
    const bboxFigures = evaluation.bboxDetection?.figures || evaluation.bboxDetection?.detectionHistory?.figures || [];

    // Entity issues: pre-flattened list wins; else flatten the report and
    // filter to this page if we have pageNumber.
    let entityIssues;
    if (Array.isArray(entityIssuesInput)) {
      entityIssues = entityIssuesInput.map(e => ({
        characterName: e.characterName || e.name || '(unknown)',
        description: e.description || e.issue || '',
        severity: e.severity || 'MODERATE',
      }));
    } else {
      entityIssues = flattenEntityIssues(entityReport);
      if (pageNumber != null) {
        entityIssues = entityIssues.filter(e => !e.pageNumbers || e.pageNumbers.includes(pageNumber));
      }
    }

    // Build character descriptions from the character profile (source of truth).
    // Fall back to a pre-built description if provided. The character profile
    // overrides stale scene descriptions — e.g. Roger HAS glasses per his profile,
    // even if an older scene description omitted them.
    // Look up the per-scene clothing text for this character (if provided).
    // Falls back to the character's default clothing when the scene doesn't
    // override. The override matters for costumed scenes — without it, the
    // description reads the default modern outfit and fix instructions
    // redress medieval characters in hoodies.
    const clothingLookup = (name) => {
      if (!sceneClothing || !name) return null;
      const lower = String(name).toLowerCase();
      for (const [k, v] of Object.entries(sceneClothing)) {
        if (k.toLowerCase() === lower) return v || null;
      }
      return null;
    };

    const characterDescriptions = {};
    for (const c of characters) {
      if (!c?.name) continue;
      const override = clothingLookup(c.name);
      let desc = c.physicalDescription || c.description || '';
      if (!desc || override) {
        // Rebuild when an override exists so the scene clothing wins over the
        // stored prose (which is usually the modern default).
        try {
          desc = buildCharacterPhysicalDescription(c, override) || desc || '';
        } catch {
          desc = desc || '';
        }
      }
      if (desc) characterDescriptions[c.name] = desc;
    }

    const userInput = buildFeedbackInput({
      sceneDescription,
      fixableIssues,
      semanticIssues,
      complianceIssues,
      entityIssues,
      bboxFigures,
      characterDescriptions,
    });

    // Text-only — no image passed. The consolidator's job is to dedupe / sort /
    // trim what evaluators already flagged, not to run its own vision pass.
    // Sonnet — Haiku padded fix instructions with adjectives and negations
    // ("show effort", "rather than X") that Grok cannot execute, and was
    // soft on the "drop trivial flags" rules. Sonnet follows the policy.
    // The `template` (rules/instructions) is identical across every
    // consolidation call in a story, so cache it — the per-page userInput is
    // the only variable part.
    const { resolveEvalModel } = require('../config/models');
    const evalModel = modelOverride || resolveEvalModel();
    // cachePrefix caches the stable template — Anthropic-only; harmless (ignored)
    // for OpenRouter models, which don't take the cache_control block.
    // 6000 out (was 3000): busy pages with many issues + per-fix critiques
    // overran 3000 and truncated the JSON, which failed the parse and dropped
    // the whole page to the legacy raw-issue fallback. Extra headroom only
    // costs more when the output is genuinely longer (the failing case).
    const result = await callTextModel(userInput, 6000, evalModel, {
      usageLabel: 'eval_consolidation',
      cachePrefix: `${template}\n\n---\n\n`
    });
    if (!result?.text) {
      return { plan: null, usage: result?.usage || null, error: 'no text in consolidator response' };
    }

    const plan = extractJsonFromText(result.text);
    if (!plan) {
      return { plan: null, usage: result.usage || null, error: 'failed to parse JSON from consolidator response' };
    }

    // Normalize shape
    if (!Array.isArray(plan.per_character_fixes)) plan.per_character_fixes = [];
    if (!plan.scene_fix || typeof plan.scene_fix !== 'object') {
      plan.scene_fix = { severity: 'NONE', instruction: '', preserve: [] };
    }
    if (!Array.isArray(plan.dropped_issues)) plan.dropped_issues = [];

    // Final score (0-100) — the consolidator's deduplicated, tolerant judgment.
    // Authoritative for redo decisions; replaces the old practice of summing
    // raw evaluator penalties (which double-counted the same physical issue
    // when quality + semantic + entity all flagged it). Coerce to integer in
    // [0, 100] and default to a passing score when the LLM omits the field
    // (defensive — the prompt requires it, but old replays may not have it).
    if (typeof plan.final_score === 'number' && Number.isFinite(plan.final_score)) {
      plan.final_score = Math.max(0, Math.min(100, Math.round(plan.final_score)));
    } else {
      plan.final_score = null;
    }
    if (typeof plan.final_score_reason !== 'string') plan.final_score_reason = '';

    // Full deduplicated issue list — what the UI displays. Not capped at 3.
    // Falls back to an empty array when the consolidator omits it (older replays).
    if (!Array.isArray(plan.deduped_issues)) {
      plan.deduped_issues = [];
    } else {
      plan.deduped_issues = plan.deduped_issues
        .filter(i => i && typeof i === 'object' && (i.description || i.problem || i.issue))
        .map(i => ({
          description: String(i.description || i.problem || i.issue || '').trim(),
          severity: String(i.severity || 'MODERATE').toUpperCase(),
          sources: Array.isArray(i.sources) ? i.sources.filter(s => typeof s === 'string') : [],
        }));
    }

    // Enforce the 3-fix cap even if the consolidator slipped past the prompt.
    // When Grok is handed more than 3 fixes, it usually executes none of them —
    // empirically a 6-fix inpaint often changes nothing. Cap severity-first and
    // move the overflow into dropped_issues so the next round picks them up.
    const SEVERITY_RANK = { CATASTROPHIC: 5, CRITICAL: 4, MAJOR: 3, MODERATE: 2, MINOR: 1, NONE: 0 };
    const rank = (s) => SEVERITY_RANK[String(s || 'MODERATE').toUpperCase()] ?? 2;
    const sceneSev = plan.scene_fix.instruction ? rank(plan.scene_fix.severity) : 0;
    // Sort per-char fixes by severity (highest first) so the cap preserves the
    // worst issues.
    plan.per_character_fixes.sort((a, b) => rank(b.severity) - rank(a.severity));
    const MAX_TOTAL_FIXES = 3;
    const sceneCount = sceneSev > 0 ? 1 : 0;
    const perCharBudget = Math.max(0, MAX_TOTAL_FIXES - sceneCount);
    if (plan.per_character_fixes.length > perCharBudget) {
      const keep = plan.per_character_fixes.slice(0, perCharBudget);
      const drop = plan.per_character_fixes.slice(perCharBudget);
      plan.per_character_fixes = keep;
      for (const d of drop) {
        plan.dropped_issues.push({
          issue: `${d.characterName || 'character'}: ${(d.issues || []).join('; ') || d.fix_instruction || ''}`,
          severity: d.severity,
          reason: 'capped at 3, defer to next round',
        });
      }
      log.warn(`[FEEDBACK-CONSOLIDATOR] page ${pageNumber}: capped per-char fixes ${drop.length + keep.length} → ${keep.length} (scene=${sceneCount})`);
    }

    log.info(
      `🧠 [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: ${plan.per_character_fixes.length} per-char fixes, scene=${plan.scene_fix.severity || 'NONE'}, dropped=${plan.dropped_issues.length}`
    );

    // Persist the call to the story's data blob for later analysis.
    // Fire-and-forget: any DB failure must not break the repair pipeline.
    // Full prompt (input) + raw Haiku response + parsed plan are captured
    // so `scripts/analysis/inspect-consolidator-call.js` can replay without
    // re-invoking Haiku. The cache refactor split the prompt into template
    // (cachePrefix) + userInput and dropped the fullPrompt binding; rebuild it
    // here (referencing it undefined threw and discarded the whole plan).
    const fullPrompt = `${template}\n\n---\n\n${userInput}`;
    if (storyId && pageNumber != null) {
      persistConsolidatorCall({
        storyId,
        pageNumber,
        round,
        fullPrompt,
        rawResponse: result.text,
        plan,
        usage: result.usage || null,
      }).catch(err => log.debug(`[FEEDBACK-CONSOLIDATOR] Persist failed (non-fatal): ${err.message}`));
    }

    return { plan, usage: result.usage || null, error: null };
  } catch (err) {
    log.warn(`⚠️ [FEEDBACK-CONSOLIDATOR] failed: ${err.message}`);
    return { plan: null, usage: null, error: err.message };
  }
}

/**
 * Persist one consolidator call to the consolidator_calls table.
 * Uses a dedicated table (not stories.data) because upsertStory overwrites
 * the stories.data blob with the in-memory copy at the end of generation,
 * which would stomp any field written mid-flight via jsonb_set.
 */
async function persistConsolidatorCall({ storyId, pageNumber, round, fullPrompt, rawResponse, plan, usage }) {
  const { dbQuery } = require('../services/database');
  await dbQuery(
    `INSERT INTO consolidator_calls (story_id, page_number, round, full_prompt, raw_response, plan, usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      storyId,
      pageNumber ?? null,
      round ?? null,
      fullPrompt || null,
      rawResponse || null,
      plan ? JSON.stringify(plan) : null,
      usage ? JSON.stringify(usage) : null,
    ]
  );
}

/**
 * Consolidate one full evaluation into a deduped issue list for SCORING.
 *
 * The single dedupe step for every evaluation (owner decision Jul 2026:
 * "3-4 different evals, then ONE prompt to summarize"): quality, semantic,
 * compliance, and entity evaluators overlap heavily — the same defect gets
 * flagged by several of them, and summing raw findings deducts it once per
 * evaluator. This wrapper runs the consolidator on the combined outputs and
 * returns `plan.deduped_issues`, which applyScore (scoring.js) uses as the
 * deductions source instead of the raw lists.
 *
 * Zero-issue evaluations skip the LLM call entirely — nothing to dedupe —
 * and return a synthetic empty plan (finalScore math on [] yields 100, same
 * as the raw path).
 *
 * @param {object} args
 * @param {object} args.evalResult    evaluateImageQuality output (fixableIssues, semanticResult, threeStageResult, bboxDetection)
 * @param {Array}  [args.entityIssues] per-page entity issues from getEntityPenaltyAndIssues ({ name, severity, description })
 * @param {string} [args.sceneDescription]
 * @param {Array}  [args.characters]
 * @param {object} [args.sceneClothing]
 * @param {string} [args.storyId]
 * @param {number} [args.pageNumber]
 * @param {number|string} [args.round]
 * @returns {Promise<{plan: object|null, dedupedIssues: Array|null, usage: object|null, error: string|null, skipped: boolean}>}
 */
async function consolidateEvaluation({
  evalResult,
  entityIssues = [],
  sceneDescription = '',
  characters = [],
  sceneClothing = null,
  storyId = null,
  pageNumber = null,
  round = null,
} = {}) {
  if (!evalResult || typeof evalResult !== 'object') {
    return { plan: null, dedupedIssues: null, usage: null, error: 'no evalResult', skipped: true };
  }

  const rawFixable = evalResult.fixableIssues || [];
  const qualityCount = rawFixable.filter(i => i?.source !== 'three-stage').length;
  const complianceCount = (evalResult.threeStageResult?.fixableIssues
    || evalResult.threeStageResult?.issues
    || rawFixable.filter(i => i?.source === 'three-stage')).length;
  const semanticCount = (evalResult.semanticResult?.semanticIssues
    || evalResult.semanticResult?.issues || []).length;
  const entityCount = Array.isArray(entityIssues) ? entityIssues.length : 0;

  if (qualityCount + complianceCount + semanticCount + entityCount === 0) {
    const plan = {
      per_character_fixes: [],
      scene_fix: { severity: 'NONE', instruction: '', preserve: [] },
      dropped_issues: [],
      final_score: 100,
      final_score_reason: 'no evaluator issues',
      deduped_issues: [],
      skipped: true,
    };
    return { plan, dedupedIssues: [], usage: null, error: null, skipped: true };
  }

  const { plan, usage, error } = await consolidateFeedback({
    sceneDescription,
    evaluation: evalResult,
    entityIssues: Array.isArray(entityIssues) ? entityIssues : [],
    pageNumber,
    characters,
    sceneClothing,
    storyId,
    round,
  });
  if (!plan) {
    return { plan: null, dedupedIssues: null, usage, error: error || 'consolidation failed', skipped: false };
  }
  return { plan, dedupedIssues: plan.deduped_issues, usage, error: null, skipped: false };
}

module.exports = {
  consolidateFeedback,
  consolidateEvaluation,
  buildFeedbackInput, // exported for testing
  flattenEntityIssues, // exported for testing
};
