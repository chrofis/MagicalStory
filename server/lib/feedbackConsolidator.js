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
const { buildCastIndex, lookupByName } = require('./castResolver');
const { PROMPT_TEMPLATES } = require('../services/prompts');
const { extractJsonFromText, buildCharacterPhysicalDescription } = require('./storyHelpers');
const { log } = require('../utils/logger');
const { getCurrentLogger } = require('./generationLogger');
const { FINDING_SOURCES, sourcesOf, mergeSources } = require('./findingSources');

/**
 * The severity each section of the consolidator input SHOWS for a finding —
 * the finding's own, or the section's default when it carries none. One
 * function for the renderer and for the vote clamp below, so the ceiling a
 * vote is clamped to is exactly the value the model was shown.
 */
const SECTION_DEFAULT_SEVERITY = Object.freeze({
  [FINDING_SOURCES.QUALITY]: 'MODERATE',
  [FINDING_SOURCES.SEMANTIC]: 'MAJOR',
  [FINDING_SOURCES.COMPLIANCE]: 'MODERATE',
  // Pre-severity book-audit fault lines are MAJOR.
  [FINDING_SOURCES.READER]: 'MAJOR',
  [FINDING_SOURCES.ENTITY]: '?',
  [FINDING_SOURCES.FINAL_CHECKS]: '?',
});
function shownSeverity(source, finding) {
  return String(finding?.severity || SECTION_DEFAULT_SEVERITY[source] || '?').toUpperCase();
}

/**
 * Build the Haiku input text from all feedback sources.
 */
function buildFeedbackInput({
  sceneDescription,
  fixableIssues = [],
  semanticIssues = [],
  complianceIssues = [],
  // Did the blind prompt-compliance judge RUN on this page? An empty
  // `complianceIssues` has meant "it ran and cleared the page" for as long as
  // this section has existed, and since the judge became gateable
  // (MODEL_DEFAULTS.promptComplianceJudge, default off) it also means "it never
  // looked". Telling a model that authors the repair plan "(none)" for a judge
  // that did not run is the false-clean this codebase keeps paying for, so the
  // two states are rendered differently. Default true = unchanged for every
  // caller that has an opinion to report.
  complianceEvaluated = true,
  entityIssues = [],
  finalCheckIssues = [],
  // Page-scoped IMG faults from the mid-loop book audit ({ severity, line }).
  // Rendered verbatim — the consolidator decides what becomes a fix target;
  // no code here reads the fault text.
  readerFindings = [],
  bboxFigures = [],
  characterDescriptions = {},
  // Era-aware landmark protection for this page (computeLandmarkProtection).
  landmarkProtection = null,
  // THE VB-ID LEAK CLOSES HERE (2026-09-06). Every earlier fix for raw Visual
  // Bible ids reaching a model added `sanitizeVbIdsInPrompt` to one more
  // GENERATION prompt (page prompts, covers, reference sheets, empty scenes,
  // the inpaint edit instruction). This input is neither -- it is what a text
  // model READS -- and it was never sanitised, so the whole thing leaked:
  // `sceneDescription` still carries the Art Director's `---METADATA---` block
  // with `"objects": ["LOC006","ART001","ART007","LOC005.1"]` verbatim, and the
  // evaluator findings rendered below quote ids back in their own prose.
  // Measured on staging job_1788641639919_mpjwlzkf1 p8 round 1: the consolidator
  // copied that exact array into `scene_fix.preserve`, and its instruction
  // fields are the text that reaches Grok.
  visualBible = null,
  // The lettering this image is REQUIRED to show — the same items the judges
  // got in their TEXT RULES (requiredText.js; evaluateImageQuality returns
  // them as `requiredTexts`). A cover's painted title is one. The scene
  // description carries none of it: on staging job_1790100385959_1nitlympp the
  // consolidator, told only the scene, turned a false "unrequested text"
  // finding into "Remove the text '<title>'" and the repair erased the title.
  requiredTexts = [],
}) {
  const parts = [];
  // Every finding below is shown with its id (indexFindings) — the handle the
  // model cites in deduped_issues[].ids and dropped_issues[].ids.
  const findingIndex = indexFindings({
    fixableIssues, semanticIssues, complianceIssues, entityIssues, readerFindings, finalCheckIssues,
  });
  const idOf = new Map([...findingIndex.values()].map(e => [e.finding, e.id]));

  parts.push('## Intended scene description');
  parts.push(sceneDescription || '(not provided)');
  parts.push('');

  const requiredTextLines = (Array.isArray(requiredTexts) ? requiredTexts : [])
    .filter(t => t && typeof t.text === 'string' && t.text.trim())
    .map(t => `- on the ${t.label || 'image'}: "${t.text}"`);
  if (requiredTextLines.length > 0) {
    parts.push('## Required lettering — PRESENT BY DESIGN (never remove)');
    parts.push(...requiredTextLines);
    parts.push('Each string above must appear exactly as written. It is never unrequested text: never write a fix that removes, covers or paints over it. A finding that it is missing, misspelled or out of order is fixed by repainting it to read exactly as written.');
    parts.push('');
  }

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

  if (landmarkProtection?.protect) {
    parts.push('## Landmark elements — PRESENT BY DESIGN (never remove)');
    // NO WORD LIST HERE. The previous wording enumerated "terrain, skyline,
    // towers, masts, antennas, buildings" and the model copied those six nouns
    // verbatim into scene_fix.preserve as six separate entries (staging
    // job_1788641639919_mpjwlzkf1 p8) — a generic list naming nothing this page
    // actually contains. Name the landmark and refer to what belongs to it;
    // seedPreserveWithLandmarks already writes the authoritative entry.
    parts.push(`This page was rendered from a reference photo of ${landmarkProtection.names.join(', ')}, and the story is set in the present day. Everything that belongs to that real place is on this page because the real place has it. Never write a fix that removes any of it, replaces the background, or "restores" a historical look — name the landmark itself under scene_fix.preserve instead.`);
    parts.push('');
  }

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
      const sev = shownSeverity(FINDING_SOURCES.QUALITY, iss);
      const type = iss.type || 'general';
      const desc = iss.description || iss.issue || '(no description)';
      const fix = iss.fix ? ` — suggested: ${iss.fix}` : '';
      parts.push(`- ${idOf.get(iss)} [${sev}] (${type}) ${desc}${fix}`);
    }
  }
  parts.push('');

  parts.push('## Semantic evaluation issues');
  if (semanticIssues.length === 0) {
    parts.push('(none)');
  } else {
    for (const iss of semanticIssues) {
      const sev = shownSeverity(FINDING_SOURCES.SEMANTIC, iss);
      const type = iss.type || 'general';
      const item = iss.item ? ` [${iss.item}]` : '';
      const problem = require('./scoring').findingText(iss) || '(no description)';
      const expected = iss.expected ? ` — expected: ${iss.expected}` : '';
      const observed = iss.observed ? ` — observed: ${iss.observed}` : '';
      parts.push(`- ${idOf.get(iss)} [${sev}] (${type})${item} ${problem}${expected}${observed}`);
    }
  }
  parts.push('');

  parts.push('## Compliance evaluation issues (prompt-compliance evaluator)');
  if (!complianceEvaluated) {
    // NOT "(none)". This evaluator has no opinion on this page at all; saying
    // it found nothing would hand the consolidator a clean bill it never issued.
    parts.push('(this evaluator did not run on this page — it has no opinion, clean or otherwise)');
  } else if (complianceIssues.length === 0) {
    parts.push('(none)');
  } else {
    for (const iss of complianceIssues) {
      const sev = shownSeverity(FINDING_SOURCES.COMPLIANCE, iss);
      const type = iss.type || 'general';
      const desc = iss.description || iss.issue || '(no description)';
      const fix = iss.fix ? ` — suggested: ${iss.fix}` : '';
      parts.push(`- ${idOf.get(iss)} [${sev}] (${type}) ${desc}${fix}`);
    }
  }
  parts.push('');

  parts.push('## Entity consistency issues (per-character appearance drift)');
  if (entityIssues.length === 0) {
    parts.push('(none)');
  } else {
    for (const iss of entityIssues) {
      parts.push(`- ${idOf.get(iss)} [${shownSeverity(FINDING_SOURCES.ENTITY, iss)}] ${iss.characterName}: ${iss.description}`);
    }
  }
  parts.push('');

  // Only rendered when this page HAS reader findings — an empty "(none)"
  // section on every other page would teach the consolidator to expect one.
  if (readerFindings.length > 0) {
    parts.push('## READER FINDINGS — a judge who read the finished page (words + picture together) found:');
    for (const f of readerFindings) {
      // Severity is already the shared vocabulary (MINOR/MAJOR/CRITICAL/
      // CATASTROPHIC); MAJOR is the default for pre-severity fault lines.
      const sev = shownSeverity(FINDING_SOURCES.READER, f);
      const line = readerLine(f);
      // The reader's own type (bookAudit, closed list) — rendered the way every
      // evaluator section renders its type, so it is carried over, not invented.
      const type = typeof f?.type === 'string' && f.type.trim() ? ` (${f.type.trim()})` : '';
      if (line) parts.push(`- ${idOf.get(f)} [${sev}]${type} ${line}`);
    }
    parts.push('');
  }

  if (finalCheckIssues.length > 0) {
    parts.push('## Final checks issues');
    for (const iss of finalCheckIssues) {
      parts.push(`- ${idOf.get(iss)} [${shownSeverity(FINDING_SOURCES.FINAL_CHECKS, iss)}] ${iss.description || iss.issue}`);
    }
    parts.push('');
  }

  parts.push('---');
  parts.push('Produce the JSON repair plan per the system instructions. Output ONLY the JSON object.');

  // ONE sanitise, at the point of assembly, over the WHOLE input -- not per
  // section. A per-section pass is the shape that keeps failing: the next
  // section someone adds (readerFindings was the last one) misses it silently.
  const assembled = parts.join('\n');
  if (!visualBible) return assembled;
  const { sanitizeVbIdsInPrompt } = require('./promptBuilders');
  return sanitizeVbIdsInPrompt(assembled, visualBible, null);
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
function flattenEntityIssues(entityReport, pageNumber = null) {
  const out = [];
  if (!entityReport?.characters) return out;
  // With a page: the report's ONE page reader (scoring.entityFindingsForPage)
  // — a finding on several pages reaches each, and one the page's declared
  // wardrobe state voids (off by design) reaches none.
  const { entityFindingsForPage, entityFindingPages } = require('./scoring');
  const rows = pageNumber != null
    ? entityFindingsForPage(pageNumber, entityReport).filter(f => f.source === 'character' && !f.offByDesign)
    : Object.entries(entityReport.characters).flatMap(([name, d]) => (d.issues || []).map(issue => ({ name, issue })));
  for (const { name: charName, issue: iss } of rows) {
    out.push({
      characterName: charName,
      description: iss.description || iss.issue || '',
      // The entity prompt already emits a type (face_mismatch, hair_change,
      // age_shift, clothing_inconsistent, ...) and it was being dropped here,
      // so 100% of entity findings reached scoring with no category and routed
      // to a full regenerate. evalBuckets.normalizeType maps these.
      // The entity report stores its own vocabulary in subType (type is the
      // constant string "consistency", which routes nowhere), so prefer it.
      type: iss.subType || iss.type || iss.category || null,
      severity: iss.severity || 'MODERATE',
      pageNumbers: entityFindingPages(iss),
      // PROVENANCE. This whitelist is a drop site: anything not named here is
      // gone. Carried, never re-derived — an entity finding that arrives
      // without one is stamped, because THIS is the entity pool.
      sources: mergeSources(sourcesOf(iss), [FINDING_SOURCES.ENTITY]),
    });
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
 * @param {object} args.evaluation - quality evaluation { fixableIssues, semanticResult, bboxDetection, judgedPrompt }
 * @param {object} [args.entityReport] - entity consistency report (whole story) — only entries for this page are used
 * @param {number} [args.pageNumber] - page number (for filtering entity report)
 * @param {Array} [args.characters] - story characters [{ name, physicalDescription }]
 * @returns {Promise<{plan: object|null, usage: object|null, error: string|null}>}
 */
/**
 * Severity from the evaluators' own votes, computed here rather than asked for.
 *
 * The consolidator RECORDS reliably and DERIVES unreliably. Measured: `type`,
 * `sources` and `severities` all come back at 100%, but three attempts to make
 * it choose the severity from those votes failed — the 2026-08-06 consensus cap
 * (ignored by qwen-plus, qwen3-max AND claude-sonnet alike), and an explicit
 * median rule with worked examples, which scored WORSE (81% -> 75% agreement)
 * and contradicted its own single-vote records: it wrote {"quality":"MINOR"}
 * and then set MAJOR. It reverts to "take the highest" every time.
 *
 * This is not the pipeline inventing a policy or overwriting an evaluator — it
 * combines votes the evaluators themselves reported, which is what a
 * consolidator is for. The model's own pick is kept as `severityChosen` so the
 * gap stays auditable.
 *
 * Rule: one vote → that vote. Two → the lower. Three or more → the middle,
 * lower-middle on an even count. Since 2026-10-04 the votes are read off the
 * input findings the entry's ids name (resolveDedupedIssues), never off the
 * model's transcription.
 *
 * EXCEPT A CRITICAL VOTE, WHICH WINS (owner, 2026-09-11 — an explicit reversal
 * of the 2026-07-30 "pure median for all severities, no lone escalation"
 * ruling, which accepted a rare real miss in exchange for fewer false alarms).
 * Measured on job_1789147573901_m3uam0nxi p13 and p17: quality rated an
 * `object_presence` defect CRITICAL and semantic rated it MAJOR, the median
 * took MAJOR, the page scored 85 — and the defect was real, a whole phantom
 * dragon drawn where the story's central prop should have been (the same pages
 * the D1 assignment trim broke). A page that one witness says cannot be
 * published does not become publishable because a second witness was milder.
 * Below CRITICAL the median still stands: that is where the false alarms the
 * old ruling was protecting against actually live.
 */
const SEVERITY_RANK = ['MINOR', 'MODERATE', 'MAJOR', 'CRITICAL', 'CATASTROPHIC'];
const ESCALATING_VOTE = new Set(['CRITICAL', 'CATASTROPHIC']);
function medianSeverity(severities) {
  if (!severities || typeof severities !== 'object') return null;
  const votes = Object.values(severities)
    .map(v => String(v || '').toUpperCase())
    .filter(v => SEVERITY_RANK.includes(v))
    .sort((a, b) => SEVERITY_RANK.indexOf(a) - SEVERITY_RANK.indexOf(b));
  if (!votes.length) return null;
  // Any witness at CRITICAL or above → the highest vote, never the middle.
  if (votes.some(v => ESCALATING_VOTE.has(v))) return votes[votes.length - 1];
  return votes[Math.floor((votes.length - 1) / 2)];
}

/**
 * EVERY INPUT FINDING HAS AN ID; CODE READS THE VOTES OFF THE IDS (owner,
 * 2026-10-04 — replaces the 2026-09-24 vote clamp and the 2026-09-23
 * type+character drop match; docs/decisions.md).
 *
 * The consolidator used to TRANSCRIBE each evaluator's vote into `sources` /
 * `severities`, and code had to second-guess the copy. Both repairs of that
 * copy failed in the stored data:
 *   - the 2026-09-24 clamp held each vote to what its CLAIMED source showed, so
 *     a vote credited to the wrong judge was cut to that judge's ceiling
 *     (staging job_1791040103540_atbttop6w p12: a semantic MAJOR "jacket worn
 *     that the brief takes off" was credited to quality, whose page maximum
 *     was MINOR, and billed MINOR);
 *   - the 2026-09-23 not-a-defect guard removed every deduped entry sharing a
 *     dropped finding's type+character, so one dropped reader finding deleted
 *     a semantic MAJOR nobody dropped (same page) — on the last 8 staging
 *     stories ~10 such deletions, 4 of them CRITICAL.
 *
 * Now each finding the model is shown carries an id (Q1, S2, C1, E3, R1, F1 —
 * `indexFindings`, rendered by buildFeedbackInput). A deduped entry and a
 * rule-2/2a drop name the ids they cover. Code derives `sources` and
 * `severities` from the INPUT findings those ids point at — each source's vote
 * is the highest severity it showed among the entry's ids — and removes a drop
 * by its ids only. An entry or drop naming an unknown id, or none, is logged as
 * an error and not applied. There is no second matching path.
 */
const ID_PREFIX = Object.freeze({
  [FINDING_SOURCES.QUALITY]: 'Q',
  [FINDING_SOURCES.SEMANTIC]: 'S',
  [FINDING_SOURCES.COMPLIANCE]: 'C',
  [FINDING_SOURCES.ENTITY]: 'E',
  [FINDING_SOURCES.READER]: 'R',
  [FINDING_SOURCES.FINAL_CHECKS]: 'F',
});

/** The text a reader finding is rendered with; a finding without one is not shown. */
function readerLine(f) {
  return String(f?.line || f?.detail || '').trim();
}

/**
 * The findings the consolidator is shown, each with its id, source and shown
 * severity. The ONE numbering: buildFeedbackInput renders these ids and
 * resolveDedupedIssues reads them, so the two can never disagree.
 * @returns {Map<string, {id:string, source:string, severity:string, finding:object}>}
 */
function indexFindings({
  fixableIssues = [], semanticIssues = [], complianceIssues = [],
  entityIssues = [], readerFindings = [], finalCheckIssues = [],
} = {}) {
  const sections = [
    [FINDING_SOURCES.QUALITY, fixableIssues],
    [FINDING_SOURCES.SEMANTIC, semanticIssues],
    [FINDING_SOURCES.COMPLIANCE, complianceIssues],
    [FINDING_SOURCES.ENTITY, entityIssues],
    [FINDING_SOURCES.READER, (Array.isArray(readerFindings) ? readerFindings : []).filter(f => readerLine(f))],
    [FINDING_SOURCES.FINAL_CHECKS, finalCheckIssues],
  ];
  const index = new Map();
  for (const [source, list] of sections) {
    (Array.isArray(list) ? list : []).filter(Boolean).forEach((finding, i) => {
      const id = `${ID_PREFIX[source]}${i + 1}`;
      index.set(id, { id, source, severity: shownSeverity(source, finding), finding });
    });
  }
  return index;
}

/** The ids a plan row names, normalised; null when it names none. */
function rowIds(row) {
  if (!Array.isArray(row?.ids)) return null;
  const ids = row.ids.map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
  return ids.length ? [...new Set(ids)] : null;
}

/**
 * The votes behind a set of input ids: per source, the highest severity that
 * source showed among them. A finding shown without a readable severity casts
 * no vote.
 */
function votesFromIds(ids, index) {
  const severities = {};
  const sources = [];
  for (const id of ids) {
    const e = index.get(id);
    if (!sources.includes(e.source)) sources.push(e.source);
    if (SEVERITY_RANK.indexOf(e.severity) < 0) continue;
    const prev = severities[e.source];
    if (!prev || SEVERITY_RANK.indexOf(e.severity) > SEVERITY_RANK.indexOf(prev)) severities[e.source] = e.severity;
  }
  return { sources, severities };
}

/**
 * A DROP THAT SAYS "NOT A DEFECT" LEAVES THE SCORING LIST TOO (2026-09-23,
 * matched by id since 2026-10-04). `dropped_issues` holds plan-only drops
 * (capped at 3, needs a char-fix — the defect is real and stays scored) and
 * drops that say the finding is FALSE (rule 2 `profile_says_trait_is_correct`,
 * rule 2a `finding_contradicts_brief`). The reason code is the consolidator's
 * own closed vocabulary.
 */
const NOT_A_DEFECT_DROPS = ['profile_says_trait_is_correct', 'finding_contradicts_brief'];

function isNotADefectDrop(d) {
  const reason = String(d?.reason || '').replace(/^["'`\s]+/, '').toLowerCase();
  return NOT_A_DEFECT_DROPS.some(code => reason.startsWith(code));
}

/**
 * The input finding ids the plan's not-a-defect drops remove. A drop naming no
 * id or an unknown id removes nothing; `fail` (optional) is told why.
 */
function notADefectDroppedIds(plan, index, fail = () => {}) {
  const dropped = new Set();
  for (const d of (Array.isArray(plan?.dropped_issues) ? plan.dropped_issues : [])) {
    if (!isNotADefectDrop(d)) continue;
    const ids = rowIds(d);
    if (!ids) { fail(`a "${String(d.reason).split(/[\s—-]/)[0]}" drop names no finding id — not applied`); continue; }
    const unknown = ids.filter(id => !index.has(id));
    if (unknown.length) { fail(`a "${String(d.reason).split(/[\s—-]/)[0]}" drop names unknown id(s) ${unknown.join(', ')} — not applied`); continue; }
    ids.forEach(id => dropped.add(id));
  }
  return dropped;
}

/**
 * Turn the model's deduped_issues into the scoring list, by id.
 *
 * 1. Every not-a-defect drop removes exactly the input findings it names. A drop
 *    naming no id or an unknown id is an error and removes nothing.
 * 2. Every deduped entry must name at least one id and only known ids, or it is
 *    an error and not applied. Its ids minus the dropped ones decide its
 *    `sources`, `severities` and `severity` (medianSeverity); an entry whose ids
 *    were all dropped leaves the list.
 * The model's type, character and description are carried as written —
 * classification is the prompt's.
 *
 * @returns {{deduped: Array, errors: string[], removedByDrops: number}}
 */
function resolveDedupedIssues(plan, index, pageNumber = null) {
  const errors = [];
  const fail = (msg) => {
    errors.push(msg);
    log.error(`❌ [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: ${msg}`);
  };
  const dropped = notADefectDroppedIds(plan, index, fail);

  const deduped = [];
  let removedByDrops = 0;
  const covered = new Set(dropped);
  for (const i of (Array.isArray(plan?.deduped_issues) ? plan.deduped_issues : [])) {
    if (!i || typeof i !== 'object' || !(i.description || i.problem || i.issue)) continue;
    const description = require('./scoring').findingText(i);
    const ids = rowIds(i);
    if (!ids) { fail(`deduped entry "${description.slice(0, 80)}" names no finding id — not applied`); continue; }
    const unknown = ids.filter(id => !index.has(id));
    if (unknown.length) { fail(`deduped entry "${description.slice(0, 80)}" names unknown id(s) ${unknown.join(', ')} — not applied`); continue; }
    ids.forEach(id => covered.add(id));
    const live = ids.filter(id => !dropped.has(id));
    if (live.length === 0) { removedByDrops++; continue; }
    const { sources, severities } = votesFromIds(live, index);
    const severity = medianSeverity(severities);
    if (!severity) { fail(`deduped entry "${description.slice(0, 80)}" (${live.join(', ')}) has no readable severity — not applied`); continue; }
    deduped.push({
      description,
      severity,
      // The consolidated list IS the scoring source, so dropping `type` here
      // meant every scored deduction was uncategorised (measured: 73/73 with
      // no type, 1201 points) and routed to `other`/regen.
      type: i.type || i.category || null,
      // The subject the deduction bills against (scoring.js deductionClassKey:
      // `category|subject`). Carried through, never inferred from the text.
      character: (typeof i.character === 'string' && i.character.trim()) ? i.character.trim() : null,
      ids: live,
      sources,
      severities,
    });
  }
  if (removedByDrops) log.info(`🧠 [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: ${removedByDrops} deduped issue(s) removed — every finding in them was dropped as not a defect`);
  const unaccounted = [...index.keys()].filter(id => !covered.has(id));
  if (unaccounted.length) {
    // Not an error: rule 2b, spec conflicts and trivial MODERATE/MINOR drops
    // may legitimately leave a finding out of the score. Logged so a silently
    // omitted finding is visible.
    log.info(`🧠 [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: finding(s) ${unaccounted.join(', ')} are in no deduped entry and no not-a-defect drop`);
  }
  return { deduped, errors, removedByDrops };
}

/**
 * A REPAIR FIX MUST REST ON A SCORED FINDING (2026-10-04). Staging
 * job_1791040103540_atbttop6w p17 (consolidator_calls 2971): the only finding
 * was dropped as `finding_contradicts_brief` (so it left the scoring list) while
 * the plan still carried a CRITICAL scene_fix for it. The page scored 100 and
 * the fix never ran. Each CRITICAL/MAJOR fix names the finding ids it fixes;
 * when none of them is in a kept deduped entry, that is logged at ERROR to the
 * generation log and recorded on the plan (`fix_errors`). CHECK ONLY: nothing is
 * reclassified, no severity is invented, the score stays what the kept list says.
 *
 * @returns {string[]} the errors, also logged
 */
function checkFixesRestOnKeptFindings(plan, index, pageNumber = null) {
  const errors = [];
  const keptIds = new Set();
  for (const d of (Array.isArray(plan?.deduped_issues) ? plan.deduped_issues : [])) {
    for (const id of (Array.isArray(d?.ids) ? d.ids : [])) keptIds.add(id);
  }
  const dropped = notADefectDroppedIds(plan, index);
  const fixes = [];
  const sf = plan?.scene_fix;
  if (sf && typeof sf === 'object' && sf.instruction) fixes.push({ label: 'scene_fix', fix: sf, text: sf.instruction });
  for (const p of (Array.isArray(plan?.per_character_fixes) ? plan.per_character_fixes : [])) {
    if (p && typeof p === 'object' && p.fix_instruction) fixes.push({ label: `per_character_fix (${p.characterName || 'unnamed'})`, fix: p, text: p.fix_instruction });
  }
  for (const { label, fix, text } of fixes) {
    const severity = String(fix.severity || '').toUpperCase();
    if (severity !== 'CRITICAL' && severity !== 'MAJOR') continue;
    const ids = rowIds(fix);
    let why = null;
    if (!ids) why = 'names no finding id';
    else if (ids.some(id => !index.has(id))) why = `names unknown id(s) ${ids.filter(id => !index.has(id)).join(', ')}`;
    else if (!ids.some(id => keptIds.has(id))) {
      why = ids.every(id => dropped.has(id))
        ? `rests only on finding(s) ${ids.join(', ')}, all dropped as not a defect`
        : `rests only on finding(s) ${ids.join(', ')}, none in a scored entry`;
    }
    if (!why) continue;
    const msg = `${label} ${severity} "${String(text).slice(0, 80)}" ${why} — no scored finding behind it, the page score does not count it`;
    errors.push(msg);
    log.error(`❌ [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: ${msg}`);
    const genLog = getCurrentLogger();
    if (genLog) genLog.error('consolidator_fix_unbacked', `P${pageNumber}: ${msg}`, null, { pageNumber, fix: label, severity, ids: ids || [] });
  }
  return errors;
}

/**
 * A crop artefact takes no repair route (repairLogic.isCropArtifact) — and the
 * plan is where a route is written. Drop every per-character fix whose declared
 * types are ALL crop artefacts: `cutout_artifact`, or a type that only the entity
 * check reported for that character (the deduped issue with `sources:
 * ['entity']`). Matched on declared type and character, never on prose. The
 * finding stays in deduped_issues (logged, costing 0); the fix moves to
 * dropped_issues with the reason. Runs before the 3-fix cap so a crop artefact
 * never takes a real fix's slot.
 */
function dropCropArtifactFixes(plan, pageNumber = null) {
  if (!plan || !Array.isArray(plan.per_character_fixes)) return 0;
  const { isCropArtifact, CROP_ARTIFACT_TYPES } = require('./repairLogic');
  const key = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const cropKeys = new Set((Array.isArray(plan.deduped_issues) ? plan.deduped_issues : [])
    .filter(i => isCropArtifact(i))
    .map(i => `${key(i.character)}|${key(i.type)}`));
  if (!Array.isArray(plan.dropped_issues)) plan.dropped_issues = [];
  let removed = 0;
  plan.per_character_fixes = plan.per_character_fixes.filter(pcf => {
    const types = Array.isArray(pcf?.types) ? pcf.types.map(key).filter(Boolean) : [];
    if (types.length === 0) return true;
    const who = key(pcf.characterName);
    if (!types.every(t => CROP_ARTIFACT_TYPES.has(t) || cropKeys.has(`${who}|${t}`))) return true;
    plan.dropped_issues.push({
      issue: `${pcf.characterName || 'character'}: ${(pcf.issues || []).join('; ')}`,
      type: types.join('/'),
      character: pcf.characterName || null,
      severity: pcf.severity,
      reason: 'crop artefact — reported by the entity crop only, logged, not repaired',
    });
    removed++;
    return false;
  });
  if (removed) log.info(`🧠 [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: ${removed} per-char fix(es) dropped — crop artefact, logged only`);
  return removed;
}

/**
 * AN IDENTITY SWAP IS NOT THE CONSOLIDATOR'S TO DROP (owner, 2026-09-27).
 *
 * `identity_swap` is the entity judge's finding that a figure's hair AND face
 * both differ from the reference: it reads as another person. The judge saw the
 * reference picture beside the cell; the consolidator sees neither, only the
 * character's written profile. On staging job_1790446348343_z3fw660ie's initial
 * page it dropped such a finding (then filed as a MAJOR hair_change) with
 * `profile_says_trait_is_correct` because the profile's hair words matched the
 * judge's description of the REFERENCE, and the page scored 96 unrepaired.
 *
 * So the swap never enters the model's input. It is appended to
 * `deduped_issues` — the scoring source — exactly as the judge filed it, and its
 * repair is routed from the entity report (repairLogic gate 2, char-fix). Scoped
 * to this one type by its declared `type`; every other entity finding goes
 * through the model as before (the owner did not approve a general change to the
 * consolidator's drop rules).
 */
const IDENTITY_SWAP_TYPE = 'identity_swap';

/**
 * The id a held-out finding carries in `ids` — the model's input numbering
 * (ID_PREFIX) never includes it, so it cannot collide. A deduped row names the
 * findings it rests on; without this the code-appended swaps were the only rows
 * of a stored plan with no `ids` (staging job_1791222889407_ypl33vk8u, p14 and
 * the initial page), indistinguishable from a row an error left unattributed.
 * There is nothing to drop or cite by it: the model never sees the finding, so
 * no fix and no not-a-defect drop can name it.
 */
const HELD_OUT_ID_PREFIX = 'H';

function isIdentitySwap(e) {
  return String(e?.type || '').trim().toLowerCase() === IDENTITY_SWAP_TYPE;
}

/** The deduped_issues rows the page's identity swaps are charged as. */
function identitySwapEntries(swaps) {
  return (Array.isArray(swaps) ? swaps : []).filter(isIdentitySwap).map((e, i) => {
    const severity = String(e.severity || 'CRITICAL').toUpperCase();
    return {
      description: e.description || '',
      severity,
      severityChosen: severity,
      type: IDENTITY_SWAP_TYPE,
      character: e.characterName || e.name || null,
      sources: mergeSources(sourcesOf(e), [FINDING_SOURCES.ENTITY]),
      severities: { [FINDING_SOURCES.ENTITY]: severity },
      ids: [`${HELD_OUT_ID_PREFIX}${i + 1}`],
    };
  });
}

/** Append the swaps the model never saw; one row per character. Returns the count added. */
function appendIdentitySwaps(plan, swaps, pageNumber = null) {
  if (!plan) return 0;
  if (!Array.isArray(plan.deduped_issues)) plan.deduped_issues = [];
  const key = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  let added = 0;
  for (const row of identitySwapEntries(swaps)) {
    if (plan.deduped_issues.some(i => key(i?.type) === IDENTITY_SWAP_TYPE && key(i?.character) === key(row.character))) continue;
    // One numbering per plan: the next free H<n>, whatever the swaps' own order.
    const taken = plan.deduped_issues.filter(i => Array.isArray(i?.ids) && i.ids.some(id => String(id).startsWith(HELD_OUT_ID_PREFIX))).length;
    row.ids = [`${HELD_OUT_ID_PREFIX}${taken + 1}`];
    plan.deduped_issues.push(row);
    added++;
  }
  if (added) log.info(`🧑‍🤝‍🧑 [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: ${added} identity_swap finding(s) charged as filed — never the consolidator's to drop`);
  return added;
}

/**
 * scene_fix.instruction as the image model may read it: no cast or bible-figure
 * name, each figure named by sight (age, garment, place) through the one repair
 * name map. An empty instruction is left alone.
 */
function nameSceneFixInstruction(instruction, repairNames) {
  if (typeof instruction !== 'string' || !instruction.trim()) return instruction;
  return require('./repairLogic').nameRepairText(instruction, repairNames);
}

async function consolidateFeedback({
  evaluation = {},
  entityReport = null,
  // Pre-flattened per-page entity issues ({ characterName|name, severity,
  // description }). When provided, used directly instead of flattening +
  // page-filtering entityReport — the eval-consolidation path already has
  // the per-page issues from getEntityPenaltyAndIssues.
  entityIssues: entityIssuesInput = null,
  // Mid-loop book-audit IMG faults for THIS page ({ severity, line }).
  readerFindings = [],
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
  // Era-aware landmark protection inputs (2026-09-05). When this page was
  // rendered from a real landmark photo AND the story is not historical, the
  // landmark's structures are protected: removal findings are dropped and the
  // names are seeded into scene_fix.preserve. See server/lib/landmarkProtection.js.
  landmarkPhotos = null,
  era = null,
  // Visual Bible — resolves raw VB ids out of the input and out of the plan's
  // instruction fields (which reach Grok). Null degrades to the old behaviour
  // and the runtime guard in callTextModel WARNs, so a caller that forgets to
  // pass it surfaces in the logs instead of leaking silently.
  visualBible = null,
  // The page's repair name map (repairLogic.buildPageRepairNameMap): every cast
  // and bible-figure name -> the descriptor the image model can resolve (age,
  // garment, place). When given, scene_fix.instruction leaves here name-free.
  // Rules 3 and 8b of the template ask the model for exactly that and it does
  // not always comply (staging job_1791222889407_ypl33vk8u p4: a grouped face
  // fix written "Emma: remove ...; Noah: ..."), so the plan is made name-free
  // in code, where it is produced — the Test Lab and the iterate leg read these
  // fields directly. inpaintPage still strips at send time, for plans stored
  // before this. Only callers that hold the story can build the map; the repair
  // pipeline's consolidationInputs does.
  repairNames = null,
  // Model override — defaults to the configured eval model (resolveEvalModel,
  // key-guarded). The A/B replay passes an explicit model to compare.
  modelOverride = null,
  // Template override — Test Lab only. The consolidator authors most of a
  // page's deductions, so its rules (severity policy, dedupe, MINOR
  // definition) are the highest-leverage thing to A/B. Null = shipped template.
  promptOverride = null,
}) {
  try {
    const template = promptOverride || PROMPT_TEMPLATES.feedbackConsolidator;
    if (!template) {
      return { plan: null, usage: null, error: 'feedbackConsolidator prompt template not loaded' };
    }
    // THE SCENE THE JUDGES SCORED (owner, 2026-09-26: "The eval should judge
    // the same thing as image generation"). The consolidator reads the exact
    // string the quality and semantic judges were given, which
    // evaluateImageQuality stamps on its result as `judgedPrompt` — the prompt
    // the image model received (or, on the batch eval, its scene block). It used
    // to read the page's whole brief, a second contract beside the judges'.
    // No judged prompt on the evaluation = nothing to consolidate against:
    // fail, never fall back to another string.
    const judgedPrompt = typeof evaluation.judgedPrompt === 'string' && evaluation.judgedPrompt.trim()
      ? evaluation.judgedPrompt : null;
    if (!judgedPrompt) {
      log.error(`❌ [FEEDBACK-CONSOLIDATOR] page ${pageNumber}: the evaluation carries no judgedPrompt — the scene the judges scored is unknown, not consolidating`);
      return { plan: null, usage: null, error: 'evaluation carries no judgedPrompt' };
    }

    // evaluateImageQuality merges the compliance (three-stage) findings into
    // fixableIssues tagged `source: 'three-stage'` — split them back out so
    // each evaluator's findings appear under its own section (and the
    // consolidator's `sources` attribution is accurate). threeStageResult is
    // the single source for compliance; the tagged copies are display-only.
    const {
      computeLandmarkProtection, filterProtectedRemovals, seedPreserveWithLandmarks,
    } = require('./landmarkProtection');
    const landmarkProtection = computeLandmarkProtection({ landmarkPhotos, era });
    const guard = (list, label) => filterProtectedRemovals(list, landmarkProtection, { pageNumber, label }).kept;

    const rawFixable = evaluation.fixableIssues || [];
    const fixableIssues = guard(rawFixable.filter(i => i?.source !== 'three-stage'), '[CONSOLIDATOR quality]');
    const complianceIssues = guard(
      evaluation.threeStageResult?.fixableIssues ||
      evaluation.threeStageResult?.issues ||
      rawFixable.filter(i => i?.source === 'three-stage'), '[CONSOLIDATOR compliance]');
    const semanticIssues = guard(
      require('./repairLogic').semanticFindings(evaluation.semanticResult), '[CONSOLIDATOR semantic]');
    const bboxFigures = evaluation.bboxDetection?.figures || evaluation.bboxDetection?.detectionHistory?.figures || [];

    // Entity issues: pre-flattened list wins; else flatten the report and
    // filter to this page if we have pageNumber.
    let entityIssues;
    if (Array.isArray(entityIssuesInput)) {
      entityIssues = entityIssuesInput.map(e => ({
        characterName: e.characterName || e.name || '(unknown)',
        description: e.description || e.issue || '',
        // The declared type, as flattenEntityIssues carries it — read only to
        // hold identity swaps out of the model's input (below).
        type: e.subType || e.type || null,
        severity: e.severity || 'MODERATE',
        // Same drop site as flattenEntityIssues, same rule (2026-09-14).
        sources: mergeSources(sourcesOf(e), [FINDING_SOURCES.ENTITY]),
      }));
    } else {
      entityIssues = flattenEntityIssues(entityReport, pageNumber);
    }
    const identitySwaps = entityIssues.filter(isIdentitySwap);
    entityIssues = entityIssues.filter(e => !isIdentitySwap(e));

    // Build character descriptions from the character profile (source of truth).
    // Fall back to a pre-built description if provided. The character profile
    // overrides stale scene descriptions — e.g. Roger HAS glasses per his profile,
    // even if an older scene description omitted them.
    // Look up the per-scene clothing text for this character (if provided).
    // Falls back to the character's default clothing when the scene doesn't
    // override. The override matters for costumed scenes — without it, the
    // description reads the default modern outfit and fix instructions
    // redress medieval characters in hoodies.
    // RESOLVE: the scene keys this map with whatever spelling the brief used
    // ("Rossa" for "Kapitänin Rossa"); one resolver decides who that is.
    const castIdx = buildCastIndex({ characters }, visualBible);
    const clothingLookup = (name) => {
      const hit = lookupByName(sceneClothing, name, castIdx);
      return hit ? (hit.value || null) : null;
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

    // The ids the model is shown — the same numbering buildFeedbackInput
    // renders (indexFindings is pure over these lists).
    const findingIndex = indexFindings({
      fixableIssues, semanticIssues, complianceIssues, entityIssues,
      readerFindings: Array.isArray(readerFindings) ? readerFindings : [],
    });

    const userInput = buildFeedbackInput({
      sceneDescription: judgedPrompt,
      fixableIssues,
      semanticIssues,
      complianceIssues,
      // The house null-contract: `threeStageResult` is an object when the
      // compliance judge produced a verdict and null when it never ran (gated
      // off, or it failed). Same test images.js / repairPipeline.js / testlab.js
      // already apply to that field — no new signal invented here.
      complianceEvaluated: !!evaluation.threeStageResult,
      entityIssues,
      readerFindings: Array.isArray(readerFindings) ? readerFindings : [],
      bboxFigures,
      characterDescriptions,
      landmarkProtection,
      visualBible,
      requiredTexts: evaluation.requiredTexts || [],
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
    // null = the model's own ceiling (owner rule: no output caps). 3000 and
    // then 6000 both truncated busy pages' JSON, which failed the parse and
    // dropped the page to the legacy raw-issue fallback.
    const result = await callTextModel(userInput, null, evalModel, {
      // Judging, not writing — pinned so a rules/model A/B is reproducible.
      temperature: require('../config/models').EVAL_TEMPERATURE,
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
      plan.scene_fix = { severity: 'NONE', instruction: '', requires_regeneration: false, preserve: [] };
    }
    // Routing flag (rule 7b): a camera/viewpoint/framing change inpaint cannot
    // honor. Coerce to a strict boolean so decideRepairMethod can gate on it
    // without truthiness surprises from a stray string.
    plan.scene_fix.requires_regeneration = plan.scene_fix.requires_regeneration === true;
    // Rule 7c: the declared types of the deduped issues the scene_fix merges.
    // Normalised to lowercase strings, the same shape images.js reads off
    // per_character_fixes[].types. Dropped when it is not an array — the rule 7
    // guard then skips rather than guessing a type from the prose.
    if (plan.scene_fix.types !== undefined) {
      plan.scene_fix.types = Array.isArray(plan.scene_fix.types)
        ? plan.scene_fix.types.map(t => String(t || '').trim().toLowerCase()).filter(Boolean)
        : [];
    }
    // Seed the preserve list with the landmark names, unconditionally, on a
    // protected page. The consolidator writes preserve from the scene prose and
    // never names the landmark (job_1788614817116 p2: six prose items, no
    // landmark), so the fixer had nothing telling it the towers on the ridge
    // were the point of the page.
    const seeded = seedPreserveWithLandmarks(plan, landmarkProtection);
    if (seeded.length) {
      log.info(`🏛️  [LANDMARK-GUARD] ${pageNumber != null ? `P${pageNumber}` : 'page'}: seeded scene_fix.preserve with ${seeded.join(', ')}`);
    }
    if (!Array.isArray(plan.dropped_issues)) plan.dropped_issues = [];

    // OUTPUT SIDE. Sanitising the input stops the model being SHOWN an id; it
    // does not stop it echoing one it invented or read from a stale field, and
    // every field below is text that reaches Grok -- images.js merges
    // scene_fix.instruction and each per_character_fixes[].fix_instruction into
    // the edit instruction. The inpaint leg sanitises that merged string, but
    // the iterate/redo leg and the Test Lab replays read these fields directly,
    // so they are cleaned once, here, where the plan is produced. `preserve` is
    // cleaned too: nothing reads it back today, and an id sitting in a stored
    // plan is the seed of the next leak.
    if (visualBible) {
      const { sanitizeVbIdsInPrompt } = require('./promptBuilders');
      const clean = (s) => (typeof s === 'string' && s
        ? sanitizeVbIdsInPrompt(s, visualBible, pageNumber)
        : s);
      for (const field of ['instruction', 'fix_draft', 'fix_critique']) {
        plan.scene_fix[field] = clean(plan.scene_fix[field]);
      }
      if (Array.isArray(plan.scene_fix.preserve)) {
        plan.scene_fix.preserve = plan.scene_fix.preserve.map(clean);
      }
      for (const pcf of plan.per_character_fixes) {
        if (!pcf || typeof pcf !== 'object') continue;
        for (const field of ['fix_instruction', 'fix_draft', 'fix_critique', 'visual_identifier']) {
          pcf[field] = clean(pcf[field]);
        }
        if (Array.isArray(pcf.issues)) pcf.issues = pcf.issues.map(clean);
      }
      for (const d of (Array.isArray(plan.deduped_issues) ? plan.deduped_issues : [])) {
        if (d && typeof d === 'object') d.description = clean(d.description);
      }
    }

    if (repairNames) plan.scene_fix.instruction = nameSceneFixInstruction(plan.scene_fix.instruction, repairNames);

    // Full deduplicated issue list — the scoring source. Not capped at 3.
    // Sources, votes and severity come from the input findings each entry's
    // ids name; not-a-defect drops remove exactly their ids (resolveDedupedIssues).
    const resolved = resolveDedupedIssues(plan, findingIndex, pageNumber);
    plan.deduped_issues = resolved.deduped;
    if (resolved.errors.length) plan.id_errors = resolved.errors;

    applyRule7SceneFixGuard(plan, pageNumber);
    dropCropArtifactFixes(plan, pageNumber);
    appendIdentitySwaps(plan, identitySwaps, pageNumber);
    const fixErrors = checkFixesRestOnKeptFindings(plan, findingIndex, pageNumber);
    if (fixErrors.length) plan.fix_errors = fixErrors;

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
 * Prompt rule 7 guard: a scene_fix whose declared types are all types inpaint
 * may not execute (clothing / identity / hair / skin / scale) is a character
 * repair, not a scene fix. Move it to dropped_issues and clear scene_fix.
 * Declared `types` only — never the prose (docs/SETTLED.md).
 */
function applyRule7SceneFixGuard(plan, pageNumber) {
  if (!plan || !plan.scene_fix) return plan;
  if (!Array.isArray(plan.dropped_issues)) plan.dropped_issues = [];
  // PROMPT RULE 7 GUARD (2026-09-06). A scene_fix whose declared types are
  // ALL types inpaint may not execute (clothing / identity / hair / skin /
  // scale) is not a scene fix at all — it is a character repair wearing a
  // scene_fix's clothes, and the inpaint executor would hand Grok a garment
  // swap. Observed on job_1788641639919_mpjwlzkf1 p5: scene_fix.instruction
  // was "Replace the blue duffle coat with a blue hooded anorak…".
  // Routes on the DECLARED `types` array only (SETTLED: classification is
  // the prompt's job) — a scene_fix with no declared types is left alone.
  const { NOT_INPAINTABLE_TYPES, ITERATE_ROUTED_TYPES } = require('./repairLogic');
  const sceneTypes = Array.isArray(plan.scene_fix.types)
    ? plan.scene_fix.types.map(t => String(t || '').toLowerCase()).filter(Boolean)
    : [];
  if (plan.scene_fix.instruction && sceneTypes.length
      && sceneTypes.every(t => NOT_INPAINTABLE_TYPES.has(t))) {
    // A creature drawn below its size is a page redo, not a character
    // repair (repairLogic ITERATE_ROUTED_TYPES) — the reason says which.
    const redo = sceneTypes.every(t => ITERATE_ROUTED_TYPES.has(t));
    plan.dropped_issues.push({
      issue: plan.scene_fix.instruction,
      severity: plan.scene_fix.severity || null,
      reason: redo ? 'requires_iterate_not_inpaint' : 'requires_char_fix_not_inpaint',
    });
    log.warn(`[FEEDBACK-CONSOLIDATOR] page ${pageNumber}: scene_fix typed ${sceneTypes.join('/')} is ${redo ? 'a page redo' : 'a character repair'}, not an inpaint — dropped (rule 7)`);
    plan.scene_fix.instruction = '';
    plan.scene_fix.severity = 'NONE';
  }
  return plan;
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
/**
 * Deterministic spec-conflict detection on the DECLARED interactions of a
 * scene description. Flags pairs where a body part is committed in one
 * interaction while another interaction targets that same character's part
 * (held or reached-for). Pure code — no model judgment, no dependence on
 * eval wording.
 */
const SPEC_BODY_PARTS = ['hand', 'hands', 'arm', 'arms', 'shoulder', 'shoulders', 'head', 'foot', 'feet', 'leg', 'legs', 'finger', 'fingers', 'knee', 'knees'];
function detectDeclaredSpecConflicts(sceneDescription) {
  const { extractSceneMetadata } = require('./storyHelpers');
  const interactions = extractSceneMetadata(sceneDescription || '')?.interactions;
  if (!Array.isArray(interactions) || interactions.length < 2) return [];
  const out = [];
  for (let i = 0; i < interactions.length; i++) {
    for (let j = 0; j < interactions.length; j++) {
      if (i === j) continue;
      const A = interactions[i] || {};
      const B = interactions[j] || {};
      const aName = String(A.character || '').trim();
      if (!aName) continue;
      const bText = `${B.where || ''} ${B.object || ''}`;
      // B targets A ("Emma's hand" / object === "Emma")
      const bTargetsA = String(B.object || '').trim() === aName
        || new RegExp(`${aName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[’']s`, 'i').test(bText);
      if (!bTargetsA) continue;
      const part = SPEC_BODY_PARTS.find(p => new RegExp(`\\b${p}\\b`, 'i').test(bText));
      if (!part) continue;
      const partRoot = part.replace(/s$/, '');
      // A commits that same body part in its own interaction
      if (!new RegExp(`\\b${partRoot}s?\\b`, 'i').test(String(A.where || ''))) continue;
      // Dedupe mirrored pairs — the loop visits (i,j) and (j,i); the same
      // physical conflict must be listed once, not twice.
      const key = [i, j].sort((x, y) => x - y).join('-');
      if (out.some(o => o._pair === key)) continue;
      out.push({
        a: `${A.character}: ${A.where}`,
        b: `${B.character}: ${B.where}`,
        why: `${aName}'s ${partRoot} is committed in one interaction and targeted in the other`,
        source: 'declared-spec-check',
        _pair: key,
      });
    }
  }
  return out.map(({ _pair, ...rest }) => rest);
}

async function consolidateEvaluation({
  evalResult,
  entityIssues = [],
  // Page-scoped IMG faults from the previous round's book audit.
  readerFindings = [],
  // The page's DECLARED brief, read only for its `interactions` list by the
  // deterministic spec-conflict check below. The scene the consolidator is
  // shown is the one the judges scored (`evalResult.judgedPrompt`).
  sceneDescription = '',
  characters = [],
  sceneClothing = null,
  storyId = null,
  pageNumber = null,
  round = null,
  // Era-aware landmark protection — forwarded to consolidateFeedback.
  landmarkPhotos = null,
  era = null,
  // Visual Bible — forwarded so the consolidator's INPUT and its instruction
  // OUTPUT are free of raw VB ids. Every caller that has one must pass it.
  visualBible = null,
  // Forwarded: the page's repair name map (see consolidateFeedback).
  repairNames = null,
  // Forwarded to consolidateFeedback so the Test Lab can A/B the consolidator's
  // model and rules without touching the shipped pipeline.
  modelOverride = null,
  promptOverride = null,
} = {}) {
  if (!evalResult || typeof evalResult !== 'object') {
    return { plan: null, dedupedIssues: null, usage: null, error: 'no evalResult', skipped: true };
  }

  // Count what SURVIVES the landmark guard — otherwise a page whose only
  // finding is a protected landmark removal still pays for a consolidator call
  // that can only produce an empty plan.
  const { computeLandmarkProtection, filterProtectedRemovals } = require('./landmarkProtection');
  const countProtection = computeLandmarkProtection({ landmarkPhotos, era });
  const surviving = (list) => filterProtectedRemovals(list, countProtection, { pageNumber, quiet: true }).kept.length;

  const rawFixable = evalResult.fixableIssues || [];
  const qualityCount = surviving(rawFixable.filter(i => i?.source !== 'three-stage'));
  const complianceCount = surviving(evalResult.threeStageResult?.fixableIssues
    || evalResult.threeStageResult?.issues
    || rawFixable.filter(i => i?.source === 'three-stage'));
  const semanticCount = surviving(require('./repairLogic').semanticFindings(evalResult.semanticResult));
  // An identity swap never reaches the model (appendIdentitySwaps), so it does
  // not by itself justify the call; a page whose only finding is one is charged
  // it on the skip path below.
  const entityList = Array.isArray(entityIssues) ? entityIssues : [];
  const swapInputs = entityList.filter(e => isIdentitySwap({ type: e?.subType || e?.type }))
    .map(e => ({ ...e, type: IDENTITY_SWAP_TYPE, characterName: e.characterName || e.name }));
  const entityCount = entityList.length - swapInputs.length;
  // A page the evaluators like but the READER flagged must still reach the
  // model — skipping on the evaluator counts alone would discard the audit.
  const readerCount = Array.isArray(readerFindings) ? readerFindings.length : 0;

  if (qualityCount + complianceCount + semanticCount + entityCount + readerCount === 0) {
    const plan = {
      per_character_fixes: [],
      scene_fix: { severity: 'NONE', instruction: '', preserve: [] },
      dropped_issues: [],
      deduped_issues: identitySwapEntries(swapInputs),
      skipped: true,
    };
    return { plan, dedupedIssues: plan.deduped_issues, usage: null, error: null, skipped: true };
  }

  const { plan, usage, error } = await consolidateFeedback({
    evaluation: evalResult,
    entityIssues: Array.isArray(entityIssues) ? entityIssues : [],
    readerFindings: Array.isArray(readerFindings) ? readerFindings : [],
    pageNumber,
    characters,
    sceneClothing,
    storyId,
    round,
    landmarkPhotos,
    era,
    visualBible,
    repairNames,
    modelOverride,
    promptOverride,
  });
  if (!plan) {
    return { plan: null, dedupedIssues: null, usage, error: error || 'consolidation failed', skipped: false };
  }
  // Deterministic spec-conflict check on the DECLARED interactions (user
  // decision 2026-07-18): detection must work from the original spec alone,
  // independent of how the eval happened to word its issues. A body part
  // committed in one interaction while another interaction targets that same
  // character's part (held or reached-for) is flagged in code — the model's
  // own spec_conflicts (which key off eval wording) are merged in on top.
  try {
    const codeConflicts = detectDeclaredSpecConflicts(sceneDescription);
    if (codeConflicts.length > 0) {
      const existing = Array.isArray(plan.spec_conflicts) ? plan.spec_conflicts : [];
      const merged = [...existing];
      for (const c of codeConflicts) {
        if (!merged.some(m => m.a === c.a && m.b === c.b)) merged.push(c);
      }
      plan.spec_conflicts = merged;
    }
  } catch (specErr) {
    log.debug(`[FEEDBACK-CONSOLIDATOR] declared spec-conflict check skipped: ${specErr.message}`);
  }
  return { plan, dedupedIssues: plan.deduped_issues, usage, error: null, skipped: false };
}

module.exports = {
  applyRule7SceneFixGuard,
  indexFindings, // exported for testing
  resolveDedupedIssues, // exported for testing
  checkFixesRestOnKeptFindings, // exported for testing
  appendIdentitySwaps, // exported for testing
  identitySwapEntries, // exported for testing
  dropCropArtifactFixes, // exported for testing
  consolidateFeedback,
  medianSeverity, // exported for testing
  consolidateEvaluation,
  buildFeedbackInput, // exported for testing
  flattenEntityIssues, // exported for testing
  detectDeclaredSpecConflicts, // exported for testing
};
