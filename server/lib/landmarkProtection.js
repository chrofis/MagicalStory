/**
 * Landmark protection — era-aware guard for pages that carry a real landmark
 * reference photo.
 *
 * WHY (owner ruling 2026-09-05, staging story job_1788614817116_vxnu60yjg p2):
 * page 2 rendered the Uetliberg Fernsehturm and the Uto Kulm spire on the ridge,
 * faithfully from the attached landmark photo ("Oppidum Uetliberg Rampart").
 * The story has NO era anywhere (input_data.era null, VB era null, scene-brief
 * era null) — i.e. present day, and the era guard is empty. The three-stage
 * compliance judge nevertheless invented a historical setting from the words
 * "ancient earthwork" in the prose and emitted
 *   {type: "object_presence", severity: "MAJOR",
 *    description: "Setting includes unrequested modern infrastructure: …",
 *    fix: "Remove transmission towers and replace background with …"}
 * The consolidator's scene_fix.preserve listed six prose items and no landmark,
 * so the instruction reached Grok as an UNMASKED whole-frame edit
 * ("1. Remove red-white transmission tower and grey-red tower from background",
 * targetBbox null). v1 (towers erased) scored 83 against v0's 55 and shipped —
 * the page lost the real geography of the place it depicts.
 *
 * The owner's ruling: a story set in the middle ages SHOULD have modern towers
 * removed; a present-day story MUST keep its landmarks. So the protection is
 * ERA-AWARE, and it is a MECHANICAL RULE computed in code and injected into
 * BOTH the critic (the compliance eval prompt) and the fixer (the consolidator
 * input + its preserve list) — the memory pattern "mechanical rules and
 * fed-back retries".
 *
 * ONE era classifier: `buildEraGuard()` in promptBuilders.js. It returns '' for
 * a missing / "present day" / "contemporary" / "modern day" era and the guard
 * paragraph otherwise. `eraIsHistorical = !!buildEraGuard(era)` — no second
 * classifier is invented here.
 */

const { log } = require('../utils/logger');

/**
 * The era a page was rendered under. Scene metadata is the carrier
 * (sceneMetadata.era, restored 2026-08-11; iterate re-reads it from the saved
 * scene via `fullData.era`) — the same value buildImagePrompt and the iterate
 * path read, so covers/iterate/eval all agree.
 *
 * @param {object|null} sceneMetadata
 * @returns {string|null}
 */
function resolveSceneEra(sceneMetadata) {
  if (!sceneMetadata || typeof sceneMetadata !== 'object') return null;
  return sceneMetadata.era || sceneMetadata.fullData?.era || null;
}

/**
 * Unique landmark names attached to a page, in order.
 * @param {Array<{name?: string}>|null} landmarkPhotos
 * @returns {string[]}
 */
function landmarkNames(landmarkPhotos) {
  if (!Array.isArray(landmarkPhotos)) return [];
  const seen = new Set();
  const out = [];
  for (const lp of landmarkPhotos) {
    const name = String(lp?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Compute the page's landmark protection state.
 *
 * @param {object} args
 * @param {Array|null} args.landmarkPhotos - the photos actually attached to the render
 * @param {string|null} args.era - story/scene era (free text)
 * @returns {{names: string[], landmarkPresent: boolean, eraIsHistorical: boolean,
 *            eraGuard: string, protect: boolean}}
 */
function computeLandmarkProtection({ landmarkPhotos = null, era = null } = {}) {
  const names = landmarkNames(landmarkPhotos);
  // Lazy require: promptBuilders pulls in a large graph and this module is
  // required from evalPipeline/feedbackConsolidator at call time.
  const { buildEraGuard } = require('./promptBuilders');
  const eraGuard = buildEraGuard(era) || '';
  const eraIsHistorical = !!eraGuard;
  return {
    names,
    landmarkPresent: names.length > 0,
    eraIsHistorical,
    eraGuard,
    // Protection applies ONLY when a real landmark is attached AND the story is
    // not historical. A historical story keeps modern infrastructure as a
    // legitimate finding — that is the era guard's whole job.
    protect: names.length > 0 && !eraIsHistorical,
  };
}

/**
 * THE NAME OF THE DECLARED SUBJECT FIELD. One spelling, shared by the prompt
 * contract below and by the code that reads it — so a rename cannot land on one
 * side only.
 */
const LANDMARK_ELEMENT_FIELD = 'landmark_element';

/**
 * The subject contract, appended to every non-empty landmark block.
 *
 * This is what makes the guard trigger on the finding's SUBJECT rather than on
 * its TYPE. The judge — not code — decides whether a finding is about the real
 * place; docs/SETTLED.md gives classification to the prompt and leaves code only
 * what a declared field says.
 *
 * NO ENUMERATED SCENE NOUNS, for the reason recorded below: a list a model is
 * shown is a list a model will echo. The domain is given by relationship ("part
 * of the real place named above"), and the false side by role, never by naming
 * objects a page might contain.
 */
const LANDMARK_SUBJECT_CONTRACT = `SUBJECT FLAG — required on every \`fixable_issues[]\` entry for as long as this block is non-empty:
\`${LANDMARK_ELEMENT_FIELD}\`: true when the thing this finding is about is part of the real place named above — its geography, or any structure or fixture standing on it — and false for everything else, including every character, every garment and every prop the story brought into the scene. Answer it on every entry; never omit it and never leave it null.`;

/**
 * THE landmark block, and the only copy of it. Injected as `{LANDMARK_CONTEXT}`
 * into EVERY judge that can emit a removal-shaped fix — the three-stage
 * compliance judge (image-prompt-compliance.txt), the semantic judge
 * (image-semantic.txt) and the quality judge (image-evaluation.txt).
 *
 * It used to reach the compliance judge alone, which is why the other two kept
 * proposing the removals this module then had to catch: the one production fire
 * on record came from the semantic judge, which had never been told the page
 * carries a real place. A second, third and fourth hand-written copy of this
 * wording is exactly the drift the owner ruled against ("fix the mirror class,
 * not the instance") — so there is one builder and the templates carry one
 * placeholder each.
 *
 * - protected page → the landmark's geography and structures are PRESENT BY
 *   DESIGN and can never be reported as unrequested / modern / a setting
 *   mismatch, at any type.
 * - historical page carrying a landmark → the era guard's own semantics, so
 *   modern infrastructure REMAINS a legitimate finding.
 * - no landmark → empty (unchanged behaviour); the guard cannot run on such a
 *   page, so the subject flag is not asked for either.
 *
 * @param {ReturnType<typeof computeLandmarkProtection>} protection
 * @returns {string}
 */
function buildLandmarkContextBlock(protection) {
  if (!protection || !protection.landmarkPresent) return '';
  const names = protection.names.join(', ');
  if (protection.protect) {
    // NO ENUMERATED WORD LIST. The sibling copy of this wording in
    // feedbackConsolidator.js listed "terrain, skyline, towers, masts,
    // antennas, buildings" and the model copied those six nouns straight into
    // scene_fix.preserve as six standalone entries (staging
    // job_1788641639919_mpjwlzkf1 p8) — a generic list describing nothing this
    // page contains. A list a model is shown is a list a model will echo, so
    // both copies now name the landmark and refer to what belongs to it.
    return `LANDMARK ELEMENTS — PRESENT BY DESIGN: ${names}.
This page was rendered from a reference photo of that real place, and the story is set in the present day. Everything that belongs to that place — its geography and every structure standing on it — is there because the real place has it. Never report any of it as unrequested, unauthorized, extra, added, modern, out of period, anachronistic, or as a setting mismatch, at any severity, on any axis. Never ask for it to be removed or for the background to be replaced. Judge only whether the landmark is rendered well; do not infer a historical period from words in the prose.

${LANDMARK_SUBJECT_CONTRACT}`;
  }
  return `LANDMARK ELEMENTS: ${names}. This page was rendered from a reference photo of that real place, but the story is NOT set in the present day:
${protection.eraGuard}
Modern infrastructure visible on this page remains a legitimate finding.

${LANDMARK_SUBJECT_CONTRACT}`;
}

/**
 * Historical name, kept because it is the name the compliance call site and the
 * existing tests use. Same function — never a second implementation.
 */
const buildLandmarkComplianceBlock = buildLandmarkContextBlock;

/**
 * Removal-shaped fix detector.
 *
 * Deliberately scoped to the `fix` field — the EDIT INSTRUCTION — never to the
 * description prose. docs/SETTLED.md forbids classifying a finding by reading
 * its description; this does not classify anything. The finding's own declared
 * `type` (`object_presence`) does the classifying, and this only asks whether
 * the proposed edit is a destructive removal/replacement, which is exactly the
 * operation the owner ruled must not run unmasked on a landmark page.
 */
// `strip` is the one token here that is also a common NOUN in an illustration
// brief — "a bright strip at the top of the frame", "the sky strip", "a daylight
// strip". Measured over the stored corpus it matched 5 fixes and every one of
// them was the noun: "Adjust the camera angle … so the Kapellbrücke appears as a
// distant, bright strip". Harmless while the trigger was a prop type; with the
// subject trigger those are landmark findings and all five would have been
// dropped. So the verb is required to be doing something to something.
const REMOVAL_FIX = /\b(remove|removing|removal|delete|deleting|erase|erasing|eliminat\w*|strip(?:s|ped|ping)?\s+(?:out|away|off|from|it|the|this|that|all|every|any)\b|paint\s+out|paint\s+over|take\s+out|replace|replacing)\b/i;

function isRemovalShapedFix(issue) {
  // A finding whose `fix` is NOT the judge's own edit instruction carries no
  // edit instruction at all: the compliance/quality parsers stand one in from
  // the description (`fix: i.fix || \`Fix: ${i.description}\``) and stamp
  // `fixAuthored: false` when they do. Running the removal regex over THAT
  // string would be classifying the finding from its description prose, which
  // docs/SETTLED.md forbids — the very thing this detector's header claims it
  // does not do. Latent until now (measured: 0 of 15 fires had a stand-in fix),
  // and closed here rather than left to fire on the first story that hits it.
  if (issue && issue.fixAuthored === false) return false;
  const fix = String(issue?.fix || issue?.suggestion || '').trim();
  if (!fix) return false;
  return REMOVAL_FIX.test(fix);
}

/**
 * THE DECLARED SUBJECT of a finding: is the thing it is about part of the real
 * place this page depicts?
 *
 * THREE states, and the third is not the second. `undeclared` covers every
 * finding stored before the judges were asked the question, plus any judge or
 * Lab template that does not ask it. Collapsing it into `other` is precisely
 * the bug shape the owner has now been bitten by twice in one day — an unknown
 * value defaulting to "safe to act on".
 *
 * Only a real boolean (or its exact JSON-ish string spelling) counts as an
 * answer. `null`, `''`, `'unknown'`, a number and a missing key are all
 * `undeclared`.
 *
 * @param {object} issue
 * @returns {'landmark'|'other'|'undeclared'}
 */
function landmarkSubject(issue) {
  if (!issue || typeof issue !== 'object') return 'undeclared';
  const v = issue[LANDMARK_ELEMENT_FIELD];
  if (v === true || v === 'true') return 'landmark';
  if (v === false || v === 'false') return 'other';
  return 'undeclared';
}

/**
 * THE ONE SPELLING of the suppression reason. Stored on every suppressed
 * finding and read by anything that wants to tell "the guard ate this" from
 * "the judge never said it".
 */
const SUPPRESSED_REASON = 'landmark_protected';

/**
 * Stamp a finding as suppressed WITHOUT mutating the original — the caller
 * still hands the untouched object to the logger, and a shared object that
 * appears in two stored arrays with two meanings is the drift this avoids.
 *
 * `suppressedBy` records WHICH of the guard's two rules fired, so a later
 * reader can separate a judge-declared landmark finding from one the
 * pre-2026-09-18 type fallback caught.
 *
 * @param {object} issue
 * @param {'landmark'|'other'|'undeclared'} subject
 * @returns {object}
 */
function markSuppressed(issue, subject) {
  return {
    ...issue,
    suppressed: SUPPRESSED_REASON,
    suppressedBy: subject === 'landmark' ? `${LANDMARK_ELEMENT_FIELD}=true` : 'type=object_presence (subject undeclared)',
  };
}

/**
 * HARD GUARD. Drop removal-shaped fixes aimed AT the landmark on a protected
 * page.
 *
 * THE TRIGGER IS THE SUBJECT, NOT THE TYPE (2026-09-18). It used to be
 * `type === 'object_presence'`, which is the compliance template's code for a
 * PROP — "present but wrong", a wrong object colour. The findings that actually
 * destroy a landmark arrive as `setting` / `object` / `extra_object` /
 * `background`: measured over 842 stored landmark pages, 53 removal-shaped
 * fixes on protected pages, at least 8 of them unmistakably aimed at the real
 * place, none of which the type trigger could see. On one page
 * (job_1789681157795_wkt20ckod p11) it dropped the harmless finding ("Remove
 * windows from the stone wall") and kept "Replace urban background with natural
 * hillside" — the real Zürich cityscape seen from the Lindenhof.
 *
 * The three subject states map to three actions:
 *   landmark   → DROP. Any type. This is the guard.
 *   other      → KEEP. Any type, `object_presence` included: the judge looked at
 *                the subject and said it is not the real place. This is what
 *                ends the false drops (11 of 15 measured fires on staging were
 *                a prop, a held object or a colour error being suppressed —
 *                twice the story's own plot object, on pages that then stored a
 *                perfect 100 with no findings at all).
 *   undeclared → the OLD rule, unchanged: drop iff `type === 'object_presence'`.
 *                Stored findings predate the field and must keep the outcome
 *                they were scored under; a judge that stops declaring falls back
 *                to the previous guard rather than to no guard. It is never read
 *                as `false`, and every such decision is logged.
 *
 * Fails loudly: every drop logs a WARN naming the page and the landmark. Never
 * silent — a dropped finding that nobody can see in the log is how the original
 * defect went unnoticed for a whole book.
 *
 * @param {Array} issues
 * @param {ReturnType<typeof computeLandmarkProtection>} protection
 * THE DROP SUPPRESSES THE DEDUCTION, IT DOES NOT ERASE THE RECORD (2026-09-19).
 * Until now the removal was total: a dropped finding left no trace anywhere in
 * stored data, so a page that had been judged with 8 findings stored 6 and
 * nothing said the other two ever existed (staging job_1789759147125_p08djwhbl
 * p1, v0 8→6 including a CRITICAL, v1 4→3). The third return value
 * `suppressed` carries those same findings back, each stamped
 * `suppressed: '${SUPPRESSED_REASON}'`, for callers that want to STORE them.
 * It is a recording channel only — exactly like `notEvaluated` — and is never
 * merged into `kept`, so no score, no deduction and no issue count moves.
 *
 * @param {{pageNumber?: number|string|null, label?: string, quiet?: boolean}} [ctx]
 * @returns {{kept: Array, dropped: Array, suppressed: Array}}
 */
function filterProtectedRemovals(issues, protection, ctx = {}) {
  const list = Array.isArray(issues) ? issues : [];
  if (!protection?.protect || list.length === 0) return { kept: list, dropped: [], suppressed: [] };
  const kept = [];
  const dropped = [];
  const undeclared = [];
  for (const iss of list) {
    if (!isRemovalShapedFix(iss)) { kept.push(iss); continue; }
    const subject = landmarkSubject(iss);
    if (subject === 'landmark') { dropped.push({ issue: iss, subject }); continue; }
    if (subject === 'other') { kept.push(iss); continue; }
    // undeclared — the pre-2026-09-18 rule, verbatim.
    undeclared.push(iss);
    if (String(iss?.type || '').toLowerCase() === 'object_presence') dropped.push({ issue: iss, subject });
    else kept.push(iss);
  }
  if (!ctx.quiet) {
    const page = ctx.pageNumber != null ? `P${ctx.pageNumber}` : 'page';
    const where = ctx.label ? `${ctx.label} ` : '';
    for (const d of dropped) {
      const why = d.subject === 'landmark'
        ? `the judge declared its subject part of the landmark (${LANDMARK_ELEMENT_FIELD}=true)`
        : `its subject was NOT declared — falling back to the type rule (object_presence)`;
      log.warn(`🏛️  [LANDMARK-GUARD] ${where}${page}: dropped ${String(d.issue.severity || 'MODERATE').toUpperCase()} ${String(d.issue.type || 'unknown')} removal on a page carrying landmark "${protection.names.join(', ')}" in a present-day story — ${why}; an unmasked whole-frame removal would erase the real place. Finding: ${String(d.issue.description || d.issue.issue || '(no description)').slice(0, 300)}`);
    }
    if (undeclared.length) {
      log.warn(`🏛️  [LANDMARK-GUARD] ${where}${page}: ${undeclared.length} removal-shaped finding(s) carried no \`${LANDMARK_ELEMENT_FIELD}\` — the judge that emitted them is not declaring the subject, so this page fell back to the pre-2026-09-18 type rule. Types: ${[...new Set(undeclared.map(i => String(i?.type || 'unknown')))].join(', ')}`);
    }
  }
  return {
    kept,
    dropped: dropped.map(d => d.issue),
    // The record, not the deduction. Same findings, marked, in drop order.
    suppressed: dropped.map(d => markSuppressed(d.issue, d.subject)),
  };
}

/**
 * Seed the consolidated plan's scene_fix.preserve with the landmark names,
 * unconditionally, on a protected page. The consolidator writes preserve from
 * the scene prose and never named the landmark — so the fixer had nothing
 * telling it the towers on the ridge were the point of the page.
 *
 * @param {object} plan - consolidated plan (mutated)
 * @param {ReturnType<typeof computeLandmarkProtection>} protection
 * @returns {string[]} names added
 */
function seedPreserveWithLandmarks(plan, protection) {
  if (!plan || !protection?.protect) return [];
  if (!plan.scene_fix || typeof plan.scene_fix !== 'object') return [];
  const preserve = Array.isArray(plan.scene_fix.preserve) ? plan.scene_fix.preserve : [];
  const existing = new Set(preserve.map(p => String(p || '').toLowerCase()));
  const added = [];
  for (const name of protection.names) {
    const entry = `${name} — the real landmark this page depicts, including its terrain, skyline and built structures`;
    if (existing.has(entry.toLowerCase()) || preserve.some(p => String(p || '').toLowerCase().includes(name.toLowerCase()))) continue;
    preserve.push(entry);
    added.push(name);
  }
  plan.scene_fix.preserve = preserve;
  return added;
}

module.exports = {
  resolveSceneEra,
  landmarkNames,
  computeLandmarkProtection,
  LANDMARK_ELEMENT_FIELD,
  LANDMARK_SUBJECT_CONTRACT,
  buildLandmarkContextBlock,
  // Same function under its original name — the compliance call site and the
  // existing tests use this one.
  buildLandmarkComplianceBlock,
  landmarkSubject,
  SUPPRESSED_REASON,
  markSuppressed,
  isRemovalShapedFix,
  filterProtectedRemovals,
  seedPreserveWithLandmarks,
};
