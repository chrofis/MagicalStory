/**
 * Shared repair logic — single source of truth for bad-page detection
 * and character repair task selection.
 *
 * Used by:
 *   - server/lib/images.js (unified pipeline)
 *   - server/routes/regeneration.js (repair workflow endpoints)
 *
 * Scoring is delegated to lib/scoring.js. This module just decides which
 * pages need redo based on the canonical finalScore + fixableIssues count.
 */

const { REPAIR_DEFAULTS } = require('../config/models');
const { computeFinalScore, SCORE_THRESHOLDS, findingText } = require('./scoring');
const { log } = require('../utils/logger');

/**
 * Identify pages that need redo. Reads the canonical finalScore via
 * computeFinalScore() — same chain as pickBestVersionIndex / shouldRedo.
 * No more per-site priority chains.
 *
 * @param {Object} evalPages - Map of pageNumber → version-shaped object
 * @param {Object} [options]
 * @param {number} [options.scoreThreshold] - Pages scoring below this need redo
 * @param {number} [options.issueThreshold] - Pages with >= this many fixable issues need redo
 * @returns {number[]} Page numbers needing redo — pages carrying a
 *   CRITICAL/CATASTROPHIC finding first (worst first matters wherever a cap
 *   or budget consumes this list from the front), then the rest by page number
 */
function findBadPages(evalPages, options = {}) {
  const scoreThreshold = options.scoreThreshold ?? REPAIR_DEFAULTS.scoreThreshold ?? SCORE_THRESHOLDS.REDO;
  const issueThreshold = options.issueThreshold ?? REPAIR_DEFAULTS.issueThreshold ?? SCORE_THRESHOLDS.ISSUES;

  const bad = [];
  for (const [pageNumStr, result] of Object.entries(evalPages || {})) {
    const pageNum = parseInt(pageNumStr, 10);
    if (isNaN(pageNum)) continue;

    // Eval failure (timeout, API error, etc.) — treat as bad and redo on the
    // next pass. Without this, a transient Gemini outage means a broken image
    // ships as "completed" because score==null skipped the threshold check.
    if (result?.evaluated === false) {
      log.warn(`[FIND-BAD] page ${pageNum}: eval failed (${result.evalError || 'unknown'}) — marking bad for redo`);
      bad.push({ pageNum, critical: false });
      continue;
    }

    const score = computeFinalScore(result);
    const issueCount = result.fixableIssues?.length ?? 0;
    if (score == null) continue;

    // A CRITICAL/CATASTROPHIC finding makes a page bad REGARDLESS of its
    // score, and ranks it ahead of merely low-scoring pages (owner, item 15,
    // 2026-09-04). piraterun5 shipped CRITICAL fixable findings on four pages
    // whose scores cleared the threshold while the round's work went to a
    // page that was only low-scoring. Severity is read from the evaluators'
    // structured fields only — the prompts own the classification.
    const critical = hasCriticalSeverityFinding(result);
    if (critical && score >= scoreThreshold && issueCount < issueThreshold) {
      log.info(`[FIND-BAD] page ${pageNum}: score ${score} clears threshold ${scoreThreshold} but carries a CRITICAL finding — marking bad for repair`);
    }

    // TYPE RESCUE (owner, 2026-09-09). A page above the floor still gets one
    // round of work when it carries a MAJOR-or-worse finding whose DECLARED type
    // is one local repair reliably fixes — an absent object, a missing prop, a
    // wrong count, a wrong expression. Those are additive, local edits with a
    // known-good route; leaving them because the arithmetic landed at 62 is how
    // job_1788903616404_iqvhj4l8m p3 shipped with three MAJOR findings and zero
    // repair attempts. Declared `type` only — never the description prose.
    const rescue = !critical && score >= scoreThreshold && issueCount < issueThreshold
      ? findSafeRepairableFinding(result) : null;
    if (rescue) {
      log.info(`[FIND-BAD] page ${pageNum}: score ${score} clears threshold ${scoreThreshold} but carries a ${rescue.severity.toUpperCase()} ${rescue.type} finding (${rescue.pool}) — type rescue, marking bad for repair`);
    }

    if (score < scoreThreshold || issueCount >= issueThreshold || critical || rescue) {
      bad.push({ pageNum, critical, score });
    }
  }
  // CRITICAL-carrying pages first (owner ruling 2026-09-04, item 15 — a CRITICAL
  // finding outranks a merely low score), then WORST-FIRST by ascending score
  // within each group, then page number. Ordering matters because the per-round
  // cap below consumes this list from the front.
  bad.sort((a, b) => (b.critical - a.critical)
    || ((a.score ?? 0) - (b.score ?? 0))
    || (a.pageNum - b.pageNum));
  return bad.map(b => b.pageNum);
}

/**
 * The first MAJOR-or-worse finding on this eval whose declared type is in
 * SAFE_REPAIRABLE_TYPES, or null.
 *
 * ENTITY-SOURCED FINDINGS ARE NEVER ADMITTED HERE. The 2026-09-04 owner ruling
 * stands: a MAJOR entity (character) finding gets no automatic repair — not
 * char-fix, not inpaint. This path must not become a back door around it.
 */
function findSafeRepairableFinding(result) {
  const pools = [
    ['quality', result?.fixableIssues],
    ['semantic', result?.semanticResult?.semanticIssues || result?.semanticResult?.issues],
    ['consolidated', result?.consolidatedPlan?.deduped_issues],
  ];
  for (const [pool, list] of pools) {
    if (!Array.isArray(list)) continue;
    for (const i of list) {
      const severity = String(i?.severity || '').toLowerCase();
      if (!/^(major|critical|catastrophic)$/.test(severity)) continue;
      const type = String(i?.type || i?.category || '').toLowerCase();
      if (!SAFE_REPAIRABLE_TYPES.has(type)) continue;
      // Entity-sourced → refused (2026-09-04). Same source read as the
      // clothing-precedence gate in decideRepairMethod.
      const sources = Array.isArray(i?.sources) ? i.sources.map(s => String(s).toLowerCase()) : [];
      if (pool === 'entity' || (sources.length && sources.every(s => s === 'entity'))) continue;
      return { type, severity, pool };
    }
  }
  return null;
}

/**
 * FINAL-BOOK AUDIT → ONE EXTRA REPAIR ROUND (owner, 2026-09-13).
 *
 * Two decisions the round loop needs, kept pure so they can be pinned by tests.
 *
 * 1) `runAudit` — the book audit used to be skipped on the LAST round, so the
 *    book that actually SHIPS was never read by anything. It now runs on every
 *    round the spend guard allows (`bookUnchanged` still suppresses a re-audit
 *    of a byte-identical book).
 * 2) `mayGrantExtraRound` — the final round's audit may buy exactly ONE more
 *    repair round, and only if it has not already done so. Bounded by
 *    construction: no loop, no recursion, one grant per story.
 *
 * @param {Object} o
 * @param {number} o.round             1-based round just finished
 * @param {number} o.roundLimit        current last round
 * @param {boolean} o.bookUnchanged    every repair in this round failed → same book
 * @param {boolean} o.extraRoundUsed   an extra round has already been granted
 * @returns {{ runAudit: boolean, mayGrantExtraRound: boolean }}
 */
function planBookAuditRound({ round, roundLimit, bookUnchanged, extraRoundUsed, finalRound = null, maxPasses = null }) {
  const runAudit = !bookUnchanged;
  // `finalRound` is the CALLER's answer to "is this the book that ships". The
  // round loop also exits early — no bad pages left, or nothing actionable —
  // and on those exits `round >= roundLimit` is false while the book in hand is
  // nevertheless final, so deriving it here could never grant the extra round
  // to a run that converged ahead of its limit. Omitted, the old derivation
  // still applies.
  const isFinal = finalRound === null ? round >= roundLimit : finalRound === true;
  // THE GRANT LIVES INSIDE THE CONFIGURED BUDGET (2026-09-17). `roundLimit` is
  // mutable -- the grant raises it -- so it can never bound the grant. The
  // budget is `maxPasses` (runtime.repairMaxPasses: 3 in production, 1 on
  // staging and locally, the one deliberate environment difference). Without
  // this, staging job_1789584708605_rts4wqupm ran TWO full repair rounds on a
  // one-pass environment: the round-1 audit was final by construction, granted
  // an extra round, and round 2 regressed 5 of 6 pages it touched (p16 -68,
  // p10 -40, p7 -8). A run that converges EARLY still buys its extra round --
  // that is what the grant is for, and round + 1 is then still within budget.
  // `null` keeps the pre-2026-09-17 behaviour for a caller that states no
  // budget (only the tests do).
  const withinBudget = maxPasses == null || round < maxPasses;
  return {
    runAudit,
    mayGrantExtraRound: runAudit && !extraRoundUsed && isFinal && withinBudget,
  };
}

/** Severities that may re-admit a page to repair. Admission ONLY — never a fix. */
const AUDIT_ADMIT_SEVERITIES = new Set(['CRITICAL', 'CATASTROPHIC']);

/**
 * How many audit-admitted pages one round may repair OVER its normal cap
 * (owner, 2026-09-14). The allowance is reserved, not shared: admitted pages
 * are appended after `applyRoundCap` so a low-scoring page cannot displace a
 * page the reader's-eye audit called CATASTROPHIC. Bounded so a noisy audit
 * cannot turn one extra round into a whole-book regeneration.
 */
const AUDIT_ADMIT_MAX = 5;

/**
 * Which pages a final book audit re-admits to repair.
 *
 * Severity is the ONLY thing code reads here, and it decides ONE thing: whether
 * the page re-enters repair. WHAT to fix on that page stays entirely the
 * consolidator's decision from the prompt (the fault lines are handed to it via
 * `readerFindingsByPage`, unread by code). Never pattern-match the fault text.
 *
 * @param {Array<{page:number, severity:string}>} imgFaults
 * @returns {number[]} page numbers, first-seen order
 */
function admitPagesFromAudit(imgFaults) {
  const pages = [];
  for (const f of imgFaults || []) {
    if (!f || f.page == null) continue;
    if (!AUDIT_ADMIT_SEVERITIES.has(String(f.severity || '').trim().toUpperCase())) continue;
    if (!pages.includes(f.page)) pages.push(f.page);
  }
  return pages;
}

/**
 * How many over-cap pages carrying a CRITICAL/CATASTROPHIC finding the LAST
 * repair round may take on top of its cap (2026-09-19). Reserved, not shared —
 * appended after the score-ranked slice — and bounded so a book full of
 * CRITICALs cannot turn the final round into a whole-book regeneration.
 */
const LAST_ROUND_CRITICAL_MAX = 5;

/**
 * PER-ROUND REPAIR CAP (owner, 2026-09-09).
 *
 * Limits how many of a story's pages a single repair round may work on: round 1
 * gets `maxRepairShareRound1` of the page count, later rounds
 * `maxRepairShareLaterRounds` — 20 pages → 10, then 6. A short story still gets
 * `minRepairPagesPerRound` (or all its bad pages, if fewer), so the cap can never
 * stop a small story repairing at all.
 *
 * Pages over the cap are DEFERRED, not dropped: they are still bad next round and
 * findBadPages returns them again. The cap never fails a job — it only bounds the
 * work (and the spend) per round.
 *
 * THERE IS NO "NEXT ROUND" ON THE LAST ROUND (2026-09-19). The deferral above is
 * the cap's whole justification, and it is only true while a later round exists.
 * With `repairMaxPasses` at 1 (staging, local) round 1 IS the last round, so every
 * deferral was a silent DROP — measured on `job_1789759147125_p08djwhbl`: 15 bad
 * pages on an 18-page story, cap 9, and the 6 over the cap were never looked at
 * again. p14 (finalScore 45, `clothing` CRITICAL) and p18 (48, `action_interaction`
 * CRITICAL) shipped with one version and an empty retryHistory, in flat
 * contradiction of the 2026-09-04 ruling that a CRITICAL forces a redo regardless
 * of score. So on the LAST round the cap keeps its slice for the score-ranked
 * pages, and pages carrying a CRITICAL/CATASTROPHIC finding that it would
 * otherwise drop are admitted as a RESERVED allowance on top — the same shape as
 * the book audit's allowance, and bounded by `LAST_ROUND_CRITICAL_MAX` so a
 * many-CRITICAL book cannot turn the final round into a whole-book regeneration.
 * The allowance is severity-driven only; WHAT to fix stays the consolidator's call.
 *
 * @param {number[]} orderedPageNums - Bad pages, WORST FIRST (findBadPages order)
 * @param {Object} opts
 * @param {number} opts.round - 1-based round number
 * @param {number} opts.totalPages - Pages in the story
 * @param {boolean} [opts.lastRound] - No further round will run after this one
 * @param {Iterable<number>} [opts.criticalPageNums] - Pages carrying a
 *   CRITICAL/CATASTROPHIC finding this round (from `hasCriticalSeverityFinding`)
 * @returns {{ admitted: number[], deferred: number[], cap: number, lastRoundCritical: number[] }}
 */
function applyRoundCap(orderedPageNums, opts = {}) {
  const pages = Array.isArray(orderedPageNums) ? orderedPageNums : [];
  const round = opts.round || 1;
  const totalPages = opts.totalPages || pages.length;
  const share = round <= 1
    ? (REPAIR_DEFAULTS.maxRepairShareRound1 ?? 0.5)
    : (REPAIR_DEFAULTS.maxRepairShareLaterRounds ?? 0.3);
  const minPages = REPAIR_DEFAULTS.minRepairPagesPerRound ?? 3;
  const cap = Math.max(Math.round(totalPages * share), Math.min(minPages, pages.length));

  if (pages.length <= cap) return { admitted: pages, deferred: [], cap, lastRoundCritical: [] };

  let admitted = pages.slice(0, cap);
  let deferred = pages.slice(cap);
  let lastRoundCritical = [];

  if (opts.lastRound) {
    const criticals = new Set(opts.criticalPageNums || []);
    lastRoundCritical = deferred.filter(pn => criticals.has(pn)).slice(0, LAST_ROUND_CRITICAL_MAX);
    if (lastRoundCritical.length > 0) {
      const rescued = new Set(lastRoundCritical);
      admitted = [...admitted, ...lastRoundCritical];
      deferred = deferred.filter(pn => !rescued.has(pn));
      const dropped = [...criticals].filter(pn => deferred.includes(pn));
      log.warn(`🚧 [REPAIR-CAP] Round ${round} is the LAST round — ${lastRoundCritical.length} over-cap page(s) carrying a CRITICAL admitted on the reserved allowance: ${lastRoundCritical.join(', ')}${dropped.length ? ` (${dropped.length} more over the ${LAST_ROUND_CRITICAL_MAX}-page allowance, still dropped: ${dropped.join(', ')})` : ''}`);
    }
  }

  log.warn(`🚧 [REPAIR-CAP] Round ${round}: ${pages.length} page(s) eligible for repair on a ${totalPages}-page story — cap is ${cap} (${Math.round(share * 100)}%). Admitting ${admitted.length} worst-first: ${admitted.join(', ')}. ${opts.lastRound ? 'DROPPED (no further round)' : 'DEFERRED to a later round'}: ${deferred.join(', ') || 'none'}`);
  return { admitted, deferred, cap, lastRoundCritical };
}

/**
 * THE SCENE-CAST CONTRACT (2026-09-11). One reader for every site that has to
 * pick between a version's cast and the page's.
 *
 *   an ARRAY — including an EMPTY one — is a DECLARATION: this is the cast.
 *   null / undefined / anything else is UNKNOWN: fall through to the next source.
 *
 * The distinction is load-bearing since `buildExpectedCastBlock` started reading
 * it (D6): a declared empty roster now means "this frame was written with no
 * people in it, every person present is a surplus figure", while an absent one
 * means "no roster supplied, do not judge the figure count". Getting the two
 * confused turns every commissioned child on a page into a CRITICAL
 * `extra_character`.
 *
 * It was expressed as `entry.sceneCharacters || orig.sceneCharacters`, which is
 * the one JS idiom that cannot express it: `[]` is TRUTHY, so an empty array
 * silently won — and `v.sceneCharacters || null` at the version write site does
 * NOT normalise an empty array away either, for the same reason. Nothing writes
 * `[]` today, so the trap was unsprung; it was one careless writer from firing.
 *
 * @param {...any} candidates  most specific first
 * @returns {Array|null} the first declared cast, or null when none was declared
 */
function resolveDeclaredCast(...candidates) {
  for (const c of candidates) if (Array.isArray(c)) return c;
  return null;
}

/**
 * THE EVALUATION CONTRACT FOLLOWS THE LINEAGE (owner, 2026-09-16).
 *
 * Iterate is a SECOND ART DIRECTOR: the first brief asked for a composition the
 * renderer could not deliver, and the rewrite is the new, achievable one. From
 * the moment it exists, THE REWRITE IS THE CONTRACT — for the iterate output
 * itself and for every repair layered on top of it. An inpaint or char-fix edits
 * the pixels of the version it was handed, so it must be judged against THAT
 * version's brief, not the superseded original.
 *
 * Until this, only the iterate branch set `description` / `sceneMetadata` /
 * `sceneCharacters` on its result, so a repair over an iterate output carried
 * none and `buildEvalInputs` fell back to the ORIGINAL page brief while the
 * canvas held the iterate composition. Measured on job_1789506283204_3kxqshifx:
 * p16 v2 scored -205 and p13 v2 -12, both graded against a brief their image was
 * never painted from.
 *
 * The inverse direction is the same rule: a version whose parent is the ORIGINAL
 * inherits the original brief (all three fields stay null and every consumer
 * falls back to the page record), so reverting to an original-lineage version
 * reverts the contract with it. No version is ever discarded — every one is kept
 * for diagnosis, and pick-best simply promotes the winner's own contract.
 *
 * @param {object} target  the round result / version being created (mutated)
 * @param {object|null} parent  the version this one was rendered FROM
 * @returns {object} target
 */
function inheritSceneContract(target, parent) {
  if (!target || !parent) return target;
  // Captured BEFORE the assignment below: whether this version authored its own
  // brief decides what else it is allowed to inherit (see compressedScene).
  const authoredOwnBrief = target.description != null;
  // `== null` on purpose: a version that authored its OWN contract (an iterate
  // rewrite) keeps it; only an absent field is inherited.
  if (target.description == null) target.description = parent.description || null;
  if (target.sceneMetadata == null) target.sceneMetadata = parent.sceneMetadata || null;
  // An ARRAY is a declaration — `[]` is a cast this version deliberately
  // emptied, and `||` cannot say that. Same rule as resolveDeclaredCast.
  if (!Array.isArray(target.sceneCharacters)) {
    target.sceneCharacters = Array.isArray(parent.sceneCharacters) ? parent.sceneCharacters : null;
  }
  // The SENT prose travels with the brief it was cut from. A version that
  // authored its own brief was rendered from a different contract, so it takes
  // the parent's sent prose only when it inherited the parent's brief; a
  // version compressed at its own render always keeps its own.
  if (target.compressedScene == null) {
    target.compressedScene = authoredOwnBrief ? null : (parent.compressedScene || null);
  }
  // Lineage breadcrumb for diagnosis — which version's pixels this one edited.
  if (target.parentSource === undefined) target.parentSource = parent.source || null;
  return target;
}

/**
 * THE POST-SHRINK PROSE A VERSION WAS RENDERED FROM, by lineage.
 *
 * `shrinkPromptForModel` (images.js) rewrites, dedupes or cuts the prompt HEAD
 * whenever the built prompt is over the image model's character cap, and stamps
 * what it actually sent as `compressedScene`. Every judge scores the render
 * against that string rather than the pre-shrink brief
 * (sceneMetadata.resolveEvalSceneDescription), so the wrong one silently grades
 * a picture against prose the model never received.
 *
 * Three cases, and the middle one is why this is not a `||` chain:
 *   - the version was compressed at its own render → its own string wins;
 *   - the version authored its own brief (an iterate rewrite) and was NOT
 *     compressed → nothing sent differed from that brief, so null. Inheriting
 *     the page's here would hand the judge the SUPERSEDED scene's prose;
 *   - the version is original-lineage → the page's sent prose.
 *
 * @param {object|null} version  the version entry being resolved
 * @param {object|null} page     the page record it belongs to
 * @returns {string|null} the prose the model received, or null when nothing was shrunk
 */
function resolveVersionCompressedScene(version, page) {
  const usable = v => (typeof v === 'string' && v.trim() ? v : null);
  return usable(version?.compressedScene)
    || (version?.description ? null : usable(page?.compressedScene));
}

/**
 * THE PROMPT A VERSION WAS RENDERED FROM, by lineage — for the PAGE/COVER ROOT.
 *
 * A version entry's own `prompt` is STRICT: the string that render was handed,
 * or null. It never borrows a neighbour's (repairPipeline's buildVersionEntry
 * stamps `v.prompt || null`, deliberately without a page fallback). Measured on
 * staging job_1789759147125_p08djwhbl `coverImages.initialPage`: all three
 * versions reported the SAME 7,366-char string — the ORIGINAL render's prompt —
 * because the version builder fell back to the page-level field, so a reader of
 * `imageVersions[1].prompt` got a confident wrong answer. That cost three
 * investigation rounds.
 *
 * The page/cover ROOT is a different field with a different job: it names the
 * prompt of the version that SHIPPED. Same DIRECTION as
 * `resolveVersionCompressedScene` — the picked version's own value wins, so the
 * root can never describe an earlier render than its sibling `compressedScene`
 * does — but deliberately WITHOUT that helper's "authored its own brief → null"
 * branch, because the two fields are read by different kinds of consumer:
 *   - `compressedScene` is a JUDGE input, where a stale string silently grades a
 *     picture against prose it was never painted from. Null is strictly better.
 *   - the root `prompt` is a MODEL input on the re-run path — repairPipeline's
 *     non-iterate regen interpolates `${img.prompt}` straight into the string it
 *     hands the image model, unguarded — and `buildEvalInputs` uses it as the
 *     page-level fallback every version record now relies on. A null there ships
 *     the literal "null" to an image model, so the original-lineage fallback
 *     stays. The root is never null when the page rendered at all.
 *
 * @param {object|null} version  the picked version entry
 * @param {object|null} page     the page record it belongs to
 * @returns {string|null} the prompt of the render that shipped
 */
function resolveVersionPrompt(version, page) {
  const usable = v => (typeof v === 'string' && v.trim() ? v : null);
  return usable(version?.prompt) || usable(page?.prompt);
}

/**
 * THE PROMPT A VERSION RECORD MAY CLAIM — its own, or nothing.
 *
 * The counterpart to `resolveVersionPrompt` above, and deliberately a NAMED
 * function rather than the inline `v.prompt || null` it replaces: the bug it
 * closes was one extra `|| img.prompt` on that expression, and an inline chain
 * invites it straight back. There is no page argument here BY CONSTRUCTION — a
 * version cannot borrow what it was not given.
 *
 * Empty and whitespace strings normalise to null: "" is not a prompt anyone
 * sent, and a reader must be able to tell "no prompt recorded" from one.
 *
 * @param {object|null} version  the version entry being stored
 * @returns {string|null} the string THIS render was handed, or null
 */
function resolveOwnRenderPrompt(version) {
  const p = version?.prompt;
  return (typeof p === 'string' && p.trim()) ? p : null;
}

/**
 * The pages that SHIP KNOWN-BROKEN, worst first (D7, 2026-09-11).
 *
 * A page qualifies when the repair budget is spent and it is still below the
 * loop's own `regenThreshold`, or still carries a CRITICAL that repair could
 * not clear. Measured on job_1789147573901_m3uam0nxi: p6 shipped as the ACTIVE
 * version at finalScore 0 (six CRITICAL `action_interaction`) and p9 at 5, and
 * the only trace was a log line — nothing in the stored run, the job status or
 * the story said either page was known-bad.
 *
 * The threshold is passed in rather than re-derived: a second number here could
 * disagree with the one `findBadPages` used, and then this list would describe a
 * different set of pages from the one the loop tried to repair.
 *
 * @param {Array} results   the pipeline's per-page results (finalScore, unrepairedCritical)
 * @param {number} regenThreshold  the score at or above which a page is acceptable
 * @returns {Array<{pageNumber:number, finalScore:number|null, unrepairedCritical:Array}>}
 */
function collectShippedDefective(results, regenThreshold) {
  // `Number(null)` is 0, not NaN — an UNSCORED page would otherwise read as a
  // zero and be reported as the worst page in the book.
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const below = (v) => num(v) !== null && num(v) < Number(regenThreshold);
  return (Array.isArray(results) ? results : [])
    .filter(r => r && (below(r.finalScore) || (r.unrepairedCritical && r.unrepairedCritical.length)))
    .map(r => ({
      pageNumber: r.pageNumber,
      finalScore: num(r.finalScore),
      unrepairedCritical: (r.unrepairedCritical || []).map(f => ({
        type: f.type || 'untyped',
        severity: f.severity || null,
        description: String(f.description || '').slice(0, 300),
      })),
    }))
    // Worst first: an unscored page sorts last rather than pretending to be a 0.
    .sort((a, b) => (a.finalScore ?? Number.POSITIVE_INFINITY) - (b.finalScore ?? Number.POSITIVE_INFINITY));
}

/**
 * THE CRITICALS THAT SURVIVED REPAIR, with the methods that were tried on them
 * (owner, 2026-09-14 — REPORT ONLY, deliberately not a routing change).
 *
 * `collectShippedDefective` is the sibling record and the two OVERLAP but are
 * not the same set. Its qualifying condition is "below the loop's threshold OR
 * carrying a CRITICAL", so a page that ships ABOVE the threshold with a
 * CRITICAL still on it is inside that list — but nothing in the run says which
 * methods were spent on it, and the above-threshold case is exactly the one the
 * threshold reading hides. Measured on job_1789337998754_apslnsq1z p8: a
 * CRITICAL `missing_character` routed to `iterate` (any critical does), the
 * re-roll scored -82, an inpaint round recovered the page to 53, and the page
 * shipped with the CRITICAL still recorded. Iterate is a re-roll and inpaint
 * cannot add an absent person, so nothing about that route was verified.
 *
 * The owner chose to keep the routing and record the evidence instead: the
 * question "is rerouting a surviving CRITICAL worth it" needs per-page
 * method-vs-outcome data across many stories, and that is what this gap was
 * losing. Nothing here decides anything — no method, no severity, no score.
 *
 * Methods come from the round summaries `summarizeRepairRound` already
 * produces (`pages[].method`, e.g. 'iterate-round-1'), never from a second
 * derivation of the same fact.
 *
 * @param {Array} results        per-page pipeline results (pageNumber, finalScore, unrepairedCritical)
 * @param {Array} repairRounds   `summarizeRepairRound` output, one per round
 * @param {number} regenThreshold the SAME score floor the round loop used
 * @returns {{recordedAt:string, pageCount:number, findingCount:number, aboveThresholdCount:number, byType:Object, byMethod:Object, pages:Array}|null}
 *   null when no CRITICAL survived — never an empty husk.
 */
function collectSurvivingCriticals(results, repairRounds, regenThreshold) {
  // Which methods touched which page, in round order, from the round record.
  const methodsByPage = new Map();
  for (const round of (Array.isArray(repairRounds) ? repairRounds : [])) {
    for (const row of (Array.isArray(round?.pages) ? round.pages : [])) {
      if (!row || row.page == null) continue;
      if (!methodsByPage.has(row.page)) methodsByPage.set(row.page, []);
      methodsByPage.get(row.page).push({
        method: row.method || 'unknown',
        outcome: row.outcome ?? null,
        delta: row.delta ?? null,
      });
    }
  }

  // `Number(null)` is 0, not NaN — an UNSCORED page must not read as a zero.
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const floor = num(regenThreshold);

  const pages = [];
  const byType = {};
  const byMethod = {};
  for (const r of (Array.isArray(results) ? results : [])) {
    const findings = Array.isArray(r?.unrepairedCritical) ? r.unrepairedCritical : [];
    if (!findings.length) continue;
    const finalScore = num(r.finalScore);
    const attempts = methodsByPage.get(r.pageNumber) || [];
    for (const f of findings) {
      const t = String(f?.type || 'untyped').toLowerCase();
      byType[t] = (byType[t] || 0) + 1;
    }
    // A page nothing was tried on is its own bucket: "no method reached it" and
    // "every method failed" are different findings.
    const bases = attempts.length ? [...new Set(attempts.map(a => baseRepairMethod(a.method)))] : ['none'];
    for (const b of bases) byMethod[b] = (byMethod[b] || 0) + 1;
    pages.push({
      pageNumber: r.pageNumber ?? null,
      finalScore,
      // The case this record exists for: the score cleared the bar and the page
      // is still known-broken.
      aboveThreshold: floor !== null && finalScore !== null && finalScore >= floor,
      findings: findings.map(f => ({
        type: f?.type || 'untyped',
        severity: f?.severity || null,
        description: String(f?.description || '').slice(0, 300),
      })),
      methodsAttempted: attempts.map(a => a.method),
      attempts,
      roundsAttempted: attempts.length,
    });
  }
  if (!pages.length) return null;
  // Worst first; an unscored page sorts last rather than pretending to be a 0.
  pages.sort((a, b) => (a.finalScore ?? Number.POSITIVE_INFINITY) - (b.finalScore ?? Number.POSITIVE_INFINITY)
    || ((a.pageNumber ?? 0) - (b.pageNumber ?? 0)));
  return {
    recordedAt: new Date().toISOString(),
    pageCount: pages.length,
    findingCount: pages.reduce((n, p) => n + p.findings.length, 0),
    aboveThresholdCount: pages.filter(p => p.aboveThreshold).length,
    byType,
    byMethod,
    pages,
  };
}

/**
 * Does this eval carry any CRITICAL or CATASTROPHIC finding? Reads the
 * structured severity field on the three finding pools (quality fixableIssues,
 * semantic issues, consolidated deduped_issues) — never the prose.
 */
function hasCriticalSeverityFinding(result) {
  return collectCriticalFindings(result).length > 0;
}

/**
 * The CRITICAL/CATASTROPHIC findings on an eval, normalized. Single severity
 * matcher for the whole repair stage — `hasCriticalSeverityFinding` is this
 * function asked whether the list is empty, so a page can never be "critical"
 * for the bad-page gate and "clean" for the end-of-stage report.
 *
 * @returns {Array<{type: string|null, severity: string, description: string, pool: string}>}
 */
function collectCriticalFindings(result) {
  // ONE SOURCE OF TRUTH WITH THE SCORE (2026-09-11). `composeDeductions`
  // (scoring.js) empties the raw quality/semantic/compliance buckets whenever a
  // consolidated plan exists, so a defect three evaluators reported is charged
  // once, at its MERGED severity. This function used to read the raw pools the
  // scorer had just emptied, so the same finding on the same version could be
  // CRITICAL here and MAJOR there: job_1789147573901_m3uam0nxi p13 and p17 each
  // reported an unrepaired CRITICAL `object_presence` and a finalScore of 85.
  // When the page has been consolidated, that merged list is the only list.
  const deduped = result?.consolidatedPlan?.deduped_issues;
  const pools = Array.isArray(deduped) && deduped.length > 0
    ? [['consolidated', deduped]]
    : [
      ['quality', result?.fixableIssues],
      ['semantic', result?.semanticResult?.semanticIssues || result?.semanticResult?.issues],
    ];
  const out = [];
  for (const [pool, list] of pools) {
    if (!Array.isArray(list)) continue;
    for (const i of list) {
      if (!/^(critical|catastrophic)$/i.test(String(i?.severity || ''))) continue;
      out.push({
        type: i.type || i.category || null,
        severity: String(i.severity),
        description: findingText(i),
        pool,
      });
    }
  }
  return out;
}

/**
 * Select character repair tasks from an entity consistency report.
 *
 * Collects CRITICAL issues only (case-insensitive — the entity evaluator emits
 * UPPERCASE severities; owner ruling 2026-09-01: character faults route to
 * character repair "only for critical for now"), deduplicates by
 * page+character, sorts by page score, and applies budget cap.
 *
 * @param {Object} entityReport - Entity consistency report with `.characters`
 * @param {Object} [options]
 * @param {number} [options.maxTasks] - Max repair tasks (defaults to REPAIR_DEFAULTS.maxCharRepairPages)
 * @param {Map|Object} [options.pageScores] - Map or object of pageNumber → score (for sort tiebreaking)
 * @returns {{ tasks: Array<{pageNumber, charName, severity, issueDescription}>, repairs: Array<{character, pages}>, dropped: number }}
 */
function selectCharRepairTasks(entityReport, options = {}) {
  const maxTasks = options.maxTasks ?? REPAIR_DEFAULTS.maxCharRepairPages;

  // Accept Map or plain object for pageScores
  const pageScoresRaw = options.pageScores;
  const getPageScore = (pageNum) => {
    if (!pageScoresRaw) return 100;
    if (pageScoresRaw instanceof Map) return pageScoresRaw.get(pageNum) ?? 100;
    return pageScoresRaw[pageNum] ?? 100;
  };

  const fixTasks = [];
  const seenPairs = new Set();

  for (const [charName, charResult] of Object.entries(entityReport?.characters || {})) {
    // Collect all issues: top-level + byClothing
    const allIssues = [...(charResult.issues || [])];
    if (charResult.byClothing) {
      for (const clothingResult of Object.values(charResult.byClothing)) {
        for (const issue of (clothingResult.issues || [])) {
          if (!allIssues.some(i => i.id === issue.id)) {
            allIssues.push(issue);
          }
        }
      }
    }

    for (const issue of allIssues) {
      // CRITICAL only, case-insensitive — same gate as decideRepairMethod's
      // entity block (owner ruling 2026-09-01). The old lowercase-only
      // major/critical compare never matched the evaluator's UPPERCASE
      // severities, so this selector was dead code too.
      const sev = String(issue.severity || '').toLowerCase();
      if (sev !== 'critical') continue;

      const pagesToFix = issue.pagesToFix || (issue.pageNumber ? [issue.pageNumber] : []);
      for (const pageNum of pagesToFix) {
        const key = `${pageNum}-${charName}`;
        if (seenPairs.has(key)) continue; // one task per page+character
        seenPairs.add(key);
        fixTasks.push({
          pageNumber: pageNum,
          charName,
          severity: sev,
          issueDescription: issue.description || issue.fixInstruction || '',
        });
      }
    }
  }

  // Sort: worst page score (ascending) first, then page number as tiebreaker
  // (every task is critical, so severity no longer orders anything).
  fixTasks.sort((a, b) => {
    const scoreA = getPageScore(a.pageNumber);
    const scoreB = getPageScore(b.pageNumber);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.pageNumber - b.pageNumber;
  });

  // Apply budget cap
  const dropped = Math.max(0, fixTasks.length - maxTasks);
  const selectedTasks = fixTasks.slice(0, maxTasks);

  // Group by character for API calls
  const repairMap = new Map();
  for (const task of selectedTasks) {
    if (!repairMap.has(task.charName)) {
      repairMap.set(task.charName, []);
    }
    repairMap.get(task.charName).push(task.pageNumber);
  }
  const repairs = Array.from(repairMap.entries()).map(([character, pages]) => ({ character, pages }));

  return { tasks: selectedTasks, repairs, dropped };
}

/**
 * Decide ONE repair method for a single page based on its evaluation +
 * the entity consistency report. Single source of truth for the per-page
 * decision; replaces the historical split between `chooseRepairStrategy`
 * (inpaint vs iterate) and `selectCharRepairTasks` (char-fix as a
 * separate post-loop pass).
 *
 * Decision order:
 *   1. Catastrophic visual / semantic break    → iterate (regenerate)
 *   2. Major/critical entity (character) issue → char-fix
 *   3. Has fixable quality / semantic content   → inpaint
 *   4. Otherwise                                → skip
 *
 * Catastrophic outranks entity intentionally: a visually broken image
 * fails entity checks for the wrong reason (the figure isn't recognisable
 * yet). Iterate first; if the next round still has identity issues,
 * char-fix on the iterated result.
 *
 * Char-fix is scene-only (covers don't get char-fix). Cover pages with
 * entity issues — rare — fall through to inpaint/iterate.
 *
 * @param {number} pageNumber - Page number; negative for covers (-1/-2/-3)
 * @param {Object} evaluation - Per-page eval with qualityScore, semanticScore, fixableIssues, etc.
 * @param {Object} entityReport - Story-level entity consistency report
 * @param {Object} [options]
 * @param {Function} [options.chooseRepairStrategy] - Helper to pick inpaint/iterate when entity isn't the answer (DI for testability)
 * @param {Array} [options.characters] - the uploaded roster. Present, the two char-fix
 *        gates decline a figure with no roster entry (charFixReferenceGap) instead of
 *        routing a repaint that has no reference to paint from. Absent, no opinion.
 * @returns {{method: 'skip'|'inpaint'|'iterate'|'char-fix', reason: string, charName?: string, severity?: string, issueDescription?: string}}
 */
function decideRepairMethod(pageNumber, evaluation, entityReport, options = {}) {
  const evaluator = evaluation || {};
  // Canonical reads via scoreBreakdown (post chunk-2 scoring migration). Each
  // evaluator's NATIVE score lives in scoreBreakdown.<evaluator>.score; the
  // combined number lives in evaluator.finalScore. Legacy fallbacks
  // (qualityScore / rawQualityScore / semanticScore on the evaluator object
  // itself) kept for stories that predate the migration. Default of 100 keeps
  // the legacy "no eval data → don't trigger catastrophic gate" behavior.
  const visualRead =
    evaluator.scoreBreakdown?.visual?.score
    ?? evaluator.qualityScore
    ?? evaluator.rawQualityScore
    ?? null;
  const semanticRead =
    evaluator.scoreBreakdown?.semantic?.score
    ?? evaluator.semanticScore
    ?? null;

  // A page that reaches the repair decision with NO readable score is a bug,
  // not a pass. The `?? 100` defaults below keep the historical behaviour
  // (an un-evaluated page must not trip the catastrophic gate on a phantom 0),
  // but the condition is now LOUD: silently treating an unscored page as
  // perfect is exactly how an entire repair stage can go missing without a
  // single line in the logs.
  if (visualRead == null) {
    log.error(`❌ [REPAIR-DECIDE] page ${pageNumber}: no readable visual score (scoreBreakdown.visual.score / qualityScore / rawQualityScore all absent) — defaulting to 100, so the catastrophic-iterate gate CANNOT fire for this page`);
  }
  const visualScore = visualRead ?? 100;
  const semanticScore = semanticRead ?? 100;

  // 0. Spec conflict — the consolidator judged the declared requirements
  // mutually unsatisfiable. No render can fix a broken contract: iterate
  // (scene rewrite) is the only method that can resolve it, and repaint
  // methods must never be chosen for it.
  const specConflicts = evaluator.consolidatedPlan?.spec_conflicts;
  if (Array.isArray(specConflicts) && specConflicts.length > 0) {
    const c = specConflicts[0] || {};
    const why = String(c.why || `${c.a || '?'} vs ${c.b || '?'}`).slice(0, 140);
    return { method: 'iterate', reason: `spec conflict — scene rewrite required: ${why}` };
  }

  // 1. Catastrophic — iterate immediately (figure unrecognisable).
  //
  // Thresholds come from REPAIR_DEFAULTS, not from literals here. They were
  // hardcoded for a month while the config carried DIFFERENT values that nothing
  // read (config 20 vs code 50) — two sources of truth, silently disagreeing.
  // Resolved toward the documented intent (20), which also cuts regenerations:
  // measured on a 14-page story, 13 pages were regenerated and 8 came back
  // WORSE than the original, with pick-best then discarding the work.
  const iterateVisualFloor = REPAIR_DEFAULTS.qualityThresholdForIterate ?? 20;
  const iterateSemanticFloor = REPAIR_DEFAULTS.semanticThresholdForIterate ?? 30;

  // SALVAGE FLOOR. Regenerating is a GAMBLE: the whole image is discarded for a
  // fresh roll, so nothing that was already right carries over. Measured on
  // job_1786287569165 (13 regenerations, outcome known per page):
  //
  //   starting finalScore >= 13  ->  1 improved, 6 WORSE
  //   starting finalScore <  0   ->  4 improved, 2 worse
  //
  // Iterate pays off only when the page is already beyond saving. Above the
  // floor there is something to lose, and local repair (char-fix / inpaint)
  // keeps the composition, likeness and background nobody complained about.
  // Applying the floor to the same story spares p3/p5/p6/p13 — and iterate made
  // ALL FOUR worse. Net: 6 of 8 regressions avoided for 1 of 5 improvements lost.
  //
  // The two NUMERIC gates only. A spec conflict (above) is a broken contract and
  // a CATASTROPHIC finding (below) means the page cannot be published — neither
  // is a gamble worth skipping, and no repaint fixes either.
  //
  // finalScore is deliberately the input rather than `visual`: visual is CLAMPED
  // at 0, so a page with 105 points of deductions and one with 300 both read 0,
  // and the gate cannot tell them apart. finalScore is un-clamped.
  const ITERATE_SALVAGE_FLOOR = REPAIR_DEFAULTS.iterateSalvageFloor ?? 0;
  const pageFinalScore = typeof evaluator.finalScore === 'number'
    ? evaluator.finalScore
    : computeFinalScore(evaluator);
  const worthSalvaging = typeof pageFinalScore === 'number' && pageFinalScore >= ITERATE_SALVAGE_FLOOR;

  if (visualScore < iterateVisualFloor && !worthSalvaging) {
    return { method: 'iterate', reason: `image visually broken (visual=${visualScore} < ${iterateVisualFloor}, finalScore=${pageFinalScore})` };
  }
  if (semanticScore < iterateSemanticFloor && !worthSalvaging) {
    return { method: 'iterate', reason: `wrong scene (semantic=${semanticScore} < ${iterateSemanticFloor}, finalScore=${pageFinalScore})` };
  }
  if ((visualScore < iterateVisualFloor || semanticScore < iterateSemanticFloor) && worthSalvaging) {
    log.info(`🛟 [REPAIR-DECIDE] page ${pageNumber}: numeric gate tripped (visual=${visualScore}, semantic=${semanticScore}) but finalScore=${pageFinalScore} >= ${ITERATE_SALVAGE_FLOOR} — repairing locally instead of regenerating`);
  }
  // Severity-based catastrophic gate: a CATASTROPHIC finding (large wrong
  // text, unrecognisable figure) is beyond what inpaint can recover even when
  // the numeric subscores stay above the floors — the eval rubric reserves
  // this severity for defects only a full regen can fix. Same case-insensitive
  // match the round loop's unresolved-issue surfacing uses (images.js).
  const severityIssues = [
    ...(evaluator.fixableIssues || []),
    ...(evaluator.semanticResult?.semanticIssues || evaluator.semanticResult?.issues || []),
    ...(Array.isArray(evaluator.consolidatedPlan?.deduped_issues) ? evaluator.consolidatedPlan.deduped_issues : []),
  ];
  const catastrophicIssue = severityIssues.find(i => /catastrophic/i.test(String(i?.severity || '')));
  if (catastrophicIssue) {
    const desc = require('./scoring').findingText(catastrophicIssue).slice(0, 80);
    return { method: 'iterate', reason: `CATASTROPHIC issue — ${desc || 'full regen required'}` };
  }

  // 1d. Composition/viewpoint change (camera angle, shot distance, reframing)
  // OR a restage — figures that must be relocated into a different supporting
  // medium/surface than the one painted (on the quay instead of wading in the
  // water, on deck instead of swimming). Inpaint edits bounded regions: it
  // cannot move the camera, and repainting a figure's whole lower staging plus
  // its contact with the medium regenerates part of the frame with no style
  // anchor and drifts the medium (photoreal). The consolidator (rule 7b) owns
  // the classification and sets this flag — code only routes on the boolean,
  // never sniffs prose.
  // ADDITIVE to SETTLED "Grok inpaint handles pose/gaze/body-rotation": those
  // are the FIGURE's orientation inside a fixed frame; camera moves and
  // medium restages are cases that verdict never covered. Overrides the
  // salvage floor deliberately — no local repair can fix framing or restaging,
  // so a decent finalScore is no reason to keep such a page in inpaint.
  if (evaluator.consolidatedPlan?.scene_fix?.requires_regeneration === true) {
    return { method: 'iterate', reason: 'scene fix requires restaging (camera/composition/medium) — full regen' };
  }

  // 2. Entity issue — char-fix wins. Scene-only (covers fall through).
  //
  // CRITICAL ONLY, CASE-INSENSITIVE (owner ruling 2026-09-01, G5/option 2:
  // character faults route to character repair "only for critical for now").
  // Two rules live in this one gate:
  //   - The compare is case-insensitive because the entity evaluator emits
  //     UPPERCASE severities ('MAJOR' x96 / 'CRITICAL' x16 on
  //     job_1788215224103) while this gate matched lowercase only — the
  //     entity→char-fix route was dead code, and every entity fault fell
  //     through to inpaint, which took the raw defect prose as its edit
  //     instruction (p16: "appears visibly older…" painted Lorena into her
  //     60s, and that version shipped).
  //   - MAJOR entity findings get NO automatic repair: not char-fix (this
  //     gate), and not inpaint either — NOT_INPAINTABLE_TYPES keeps character
  //     types out of inpaint instructions regardless of how this gate routes.
  // A figure the story INVENTED has no roster entry, so a char fix has no
  // avatar and no face photo to repaint it from — see charFixReferenceGap. The
  // router declines before the round is spent and says why; the page falls
  // through to the gates below exactly as it would with no entity finding.
  // `options.characters` absent ⇒ no opinion, every name stays routable (the
  // unit tests and any caller that does not carry the roster).
  const charFixImpossible = (name) => {
    if (!Array.isArray(options.characters)) return null;
    const { charFixReferenceGap } = require('./charRepairTarget');
    return charFixReferenceGap({ characters: options.characters, characterName: name });
  };

  if (pageNumber > 0 && entityReport?.characters) {
    let worst = null; // {severity, charName, issue}
    for (const [charName, charResult] of Object.entries(entityReport.characters)) {
      const allIssues = [...(charResult.issues || [])];
      if (charResult.byClothing) {
        for (const cr of Object.values(charResult.byClothing)) {
          for (const i of (cr.issues || [])) {
            if (!allIssues.some(x => x.id === i.id)) allIssues.push(i);
          }
        }
      }
      for (const issue of allIssues) {
        const sev = String(issue.severity || '').toLowerCase();
        if (sev !== 'critical') continue;
        const pages = issue.pagesToFix || (issue.pageNumber ? [issue.pageNumber] : []);
        if (!pages.includes(pageNumber)) continue;
        if (!worst) worst = { severity: sev, charName, issue };
      }
    }
    const entityGap = worst && charFixImpossible(worst.charName);
    if (entityGap) {
      log.warn(`🚫 [REPAIR-DECIDE] page ${pageNumber}: entity ${worst.severity} on ${worst.charName} cannot take a char fix — ${entityGap.message}`);
      worst = null;
    }
    if (worst) {
      const issueDescription = worst.issue.description || worst.issue.fixInstruction || '';
      // repairParams: the 3-axis repair plan for this char-fix, resolved from the
      // issue text by the ONE central rule (resolveRepairAxes). Emitted here so the
      // decision — not a scattered per-caller `useFaceOnly` derivation — owns which
      // axes a char-fix uses. faceOnly here is the INTENT (assumes a face box is
      // available); executeCharFixAction finalises it against the actual bbox.
      const { resolveRepairAxes } = require('./faceRepair');
      // The finding's TYPE decides face vs full-figure (owner, 2026-09-01):
      // an age_shift is a face patch, never a full-figure repaint.
      const issueTypes = [worst.issue.subType || worst.issue.type].filter(Boolean);
      const repairParams = resolveRepairAxes(issueDescription, { hasFaceBbox: true, issueTypes });
      return {
        method: 'char-fix',
        reason: `entity ${worst.severity} on ${worst.charName}`,
        charName: worst.charName,
        severity: worst.severity,
        issueDescription,
        issueTypes,
        repairParams,
      };
    }
  }

  // Set by gate 2b when a CRITICAL non-clothing finding outranks a MAJOR
  // clothing finding; read by step 3 for the decision reason.
  let deferredClothing = null;

  // 2b. Clothing is a FIGURE REDO, never an inpaint patch or a scene rewrite.
  //
  // Owner decision 2026-08-09, after reviewing a full 14-page story: a wrong
  // outfit is a property of the FIGURE, so repainting a masked region around it
  // (inpaint) fights the surrounding pixels, and rewriting the scene (iterate)
  // throws away a composition that was fine. Redrawing the figure is the only
  // method that actually owns the defect.
  //
  // Only reachable when the entity check (step 2) did not already claim the
  // page — entity findings carry cross-page evidence and keep priority.
  // `accessory` is deliberately EXCLUDED: it caps at MODERATE, and a bandana
  // knot is not worth redrawing a person over.
  if (pageNumber > 0) {
    const clothingIssue = severityIssues.find(i =>
      String(i?.type || '').toLowerCase() === 'clothing'
      && /^(major|critical|catastrophic)$/i.test(String(i?.severity || ''))
      && String(i?.character || '').trim());
    // SEVERITY PRECEDENCE (2026-09-06). A char-fix DISCARDS the consolidated
    // plan and repaints the figure from the clothing description alone, so a
    // round spent here executes none of the plan's CRITICAL fixes. When the
    // page's worst inpaintable finding outranks the clothing one, the CRITICAL
    // is executed first and the wardrobe gets its figure redo next round —
    // the 2026-08-09 "clothing is a figure redo" verdict is unchanged, only
    // its turn in the queue is. Declared `type`/`severity` fields only.
    // Evidence: job_1788641639919_mpjwlzkf1 p5 v0 — action_interaction CRITICAL
    // + clothing MAJOR routed to char-fix; the CRITICAL was never acted on and
    // the page went 60 → 40.
    const clothingSev = clothingIssue ? String(clothingIssue.severity).toLowerCase() : null;
    const worseNonClothing = clothingSev === 'major' && severityIssues.find(i => {
      if (!/^critical$/i.test(String(i?.severity || ''))) return false;
      // Types inpaint may not touch (clothing / identity / hair / skin / scale)
      // cannot claim precedence — they are not executable by the fall-through.
      if (NOT_INPAINTABLE_TYPES.has(String(i?.type || '').toLowerCase())) return false;
      // Entity-sourced findings keep the 2026-09-04 routing: MAJOR entity gets
      // no automatic repair, and CRITICAL entity already claimed the page at
      // gate 2. They never override the clothing gate here.
      const sources = Array.isArray(i?.sources) ? i.sources.map(s => String(s).toLowerCase()) : [];
      if (sources.length && sources.every(s => s === 'entity')) return false;
      return true;
    });
    if (clothingIssue && worseNonClothing) {
      deferredClothing = worseNonClothing;
      log.info(`👕 [REPAIR-DECIDE] page ${pageNumber}: clothing MAJOR deferred — a CRITICAL ${worseNonClothing.type || 'finding'} outranks it this round`);
    }
    // Same reference gap as gate 2: a wardrobe redo is still a figure repaint
    // from the roster entry's avatar, so an invented figure cannot take one.
    const clothingGap = clothingIssue && charFixImpossible(String(clothingIssue.character).trim());
    if (clothingGap) {
      log.warn(`🚫 [REPAIR-DECIDE] page ${pageNumber}: clothing ${String(clothingIssue.severity).toLowerCase()} on ${String(clothingIssue.character).trim()} cannot take a figure redo — ${clothingGap.message}`);
    }
    if (clothingIssue && !worseNonClothing && !clothingGap) {
      const charName = String(clothingIssue.character).trim();
      const issueDescription = require('./scoring').findingText(clothingIssue);
      const { resolveRepairAxes } = require('./faceRepair');
      // forceTarget 'body' so this never degrades into a face-only cutout:
      // the whole figure is redrawn, which is the point of the route.
      const repairParams = resolveRepairAxes(issueDescription, { hasFaceBbox: true, forceTarget: 'body' });
      return {
        method: 'char-fix',
        reason: `clothing ${String(clothingIssue.severity).toLowerCase()} on ${charName} — figure redo`,
        charName,
        severity: String(clothingIssue.severity).toLowerCase(),
        issueDescription,
        repairParams,
      };
    }
  }

  // 3. Inpaint when there's something inpaintable.
  // `deferredClothing` is set when gate 2b stood down this round (severity
  // precedence, above); it is carried into the reason so the round log says
  // WHY the page took the inpaint route.
  const precedenceNote = deferredClothing
    ? `CRITICAL ${deferredClothing.type || 'finding'} outranks clothing MAJOR (clothing figure redo deferred to next round)`
    : null;
  const withPrecedence = (d) => (precedenceNote && d && d.method === 'inpaint'
    ? { ...d, reason: `${precedenceNote}; ${d.reason || ''}`.trim() }
    : d);
  if (typeof options.chooseRepairStrategy === 'function') {
    return withPrecedence(mapStrategyToMethod(options.chooseRepairStrategy(evaluator)));
  }
  // Inline fallback when chooseRepairStrategy isn't injected (tests).
  const fixableCount = evaluator.fixableIssues?.length || 0;
  const enrichedCount = evaluator.enrichedFixTargets?.length || 0;
  const fixTargetCount = evaluator.fixTargets?.length || 0;
  const semanticIssueCount = (evaluator.semanticResult?.issues?.length
    || evaluator.semanticResult?.semanticIssues?.length || 0);
  if (fixableCount + enrichedCount + fixTargetCount + semanticIssueCount > 0) {
    const parts = [];
    if (fixableCount) parts.push(`${fixableCount} quality`);
    if (semanticIssueCount) parts.push(`${semanticIssueCount} semantic`);
    if (enrichedCount || fixTargetCount) parts.push(`${enrichedCount + fixTargetCount} targets`);
    return withPrecedence({ method: 'inpaint', reason: parts.join(', ') || 'default' });
  }

  // 4. Nothing actionable.
  return { method: 'skip', reason: 'no repair needed' };
}

/**
 * PER-ROUND, PER-METHOD REPAIR EFFECTIVENESS (owner, 2026-09-13).
 *
 * The pipeline runs up to N rounds and each page picks ONE method (iterate /
 * inpaint / char-fix). Which method actually earned its money was invisible:
 * the data existed on every version (`method`, `score`) and on retryHistory
 * (`round_repair_failed`), but nothing aggregated it, so "round 2 was worth
 * running" could never be answered without hand-querying JSONB.
 *
 * A REGRESSION is the finding this exists to surface: the pipeline keeps the
 * best version per page, so a repair that scored WORSE costs money and changes
 * nothing — invisible in every other report.
 *
 * Pure function, no I/O: `attempts` are what the round tried, `beforeScores`
 * the finalScore findBadPages ranked on, `afterScores` the finalScore stamped
 * on the new version. A page with either score missing is `unknown`, never
 * silently counted as unchanged.
 *
 * @param {{round:number, attempts:Array<{pageNumber:number, method:string|null, ok:boolean, error?:string|null}>, beforeScores:Object<number,number|null>, afterScores:Object<number,number|null>}} args
 */
/**
 * One repair result → one attempt row for summarizeRepairRound.
 *
 * A repair result names its method in `source` ('iterate-round-1',
 * 'inpaint-round-2', 'char-fix-round-1'); only the composite path also sets
 * `method`. Reading `method` alone summarised EVERY page of
 * job_1789337998754_apslnsq1z as "unknown" — the exact blindness 278e408ae was
 * written to end.
 */
function repairAttemptFromResult(r) {
  return {
    pageNumber: r?.pageNumber,
    method: r?.method || r?.source || null,
    ok: !!r?.imageData,
    error: r?.imageData ? null : (r?.error || 'no result'),
  };
}

/**
 * The bucket key is the BARE method.
 *
 * Measured on staging `job_1789348171785_9oxos7dwv`: a SUCCESSFUL result carries
 * the round-suffixed source string (`inpaint-round-1`, `char-fix-round-2`) while
 * a FAILED one carries the bare method (`char-fix`). Bucketing on the raw value
 * split one method's successes from its own failures — `char-fix` read
 * `failed: 1, repaired: 0` beside `char-fix-round-1` reading `repaired: 3` — and
 * split every method per round, so nothing could be compared across the book.
 * That is precisely the number this record exists to produce.
 *
 * The raw value stays on the per-page row, where the round it came from is
 * still readable.
 */
function baseRepairMethod(method) {
  const m = String(method || '').trim();
  if (!m) return 'unknown';
  return m.replace(/-round-\d+$/i, '') || 'unknown';
}

function summarizeRepairRound({ round, attempts = [], beforeScores = {}, afterScores = {} }) {
  const byMethod = {};
  const pages = [];

  for (const a of attempts) {
    if (!a || a.pageNumber == null) continue;
    const method = baseRepairMethod(a.method);
    // The bucket is the bare method; the row keeps what the round actually said.
    const rawMethod = a.method || method;
    const m = byMethod[method] || (byMethod[method] = {
      attempted: 0, repaired: 0, failed: 0,
      improved: 0, unchanged: 0, regressed: 0, unknown: 0,
      totalDelta: 0, scoredPages: 0, avgDelta: null,
    });
    m.attempted++;

    if (!a.ok) {
      m.failed++;
      pages.push({ page: a.pageNumber, method: rawMethod, before: beforeScores[a.pageNumber] ?? null, after: null, delta: null, outcome: 'failed', error: a.error || null });
      continue;
    }

    m.repaired++;
    const before = beforeScores[a.pageNumber];
    const after = afterScores[a.pageNumber];
    let outcome, delta = null;
    if (typeof before !== 'number' || typeof after !== 'number') {
      outcome = 'unknown';
      m.unknown++;
    } else {
      delta = Math.round((after - before) * 10) / 10;
      outcome = delta > 0 ? 'improved' : (delta < 0 ? 'regressed' : 'unchanged');
      m[outcome]++;
      m.totalDelta += delta;
      m.scoredPages++;
    }
    pages.push({ page: a.pageNumber, method: rawMethod, before: before ?? null, after: after ?? null, delta, outcome });
  }

  for (const m of Object.values(byMethod)) {
    m.avgDelta = m.scoredPages > 0 ? Math.round((m.totalDelta / m.scoredPages) * 10) / 10 : null;
    delete m.totalDelta;
    delete m.scoredPages;
  }

  const repaired = pages.filter(p => p.outcome !== 'failed').length;
  return {
    round,
    attempted: pages.length,
    repaired,
    failed: pages.length - repaired,
    improved: pages.filter(p => p.outcome === 'improved').length,
    regressed: pages.filter(p => p.outcome === 'regressed').length,
    byMethod,
    pages,
  };
}

function mapStrategyToMethod(s) {
  if (!s) return { method: 'skip', reason: 'no strategy' };
  return { method: s.strategy || 'skip', reason: s.reason || '' };
}


// WHAT INPAINT MAY NOT BE ASKED TO DO (owner, 2026-08-26).
//
// Inpaint turns a figure, moves it, changes hand pose, gaze or expression, and
// edits objects. It cannot change clothing, hair, or the form of a face: asked
// to, it repaints the figure and the identity drifts. Those defects belong to
// character repair, which is anchored to the character's avatar, or to a page
// redo — both routes already exist.
//
// Measured on job_1787689073034_1v6ew0y1kae: 5 of 11 inpaint calls carried 9
// forbidden directives ("Change the hair color to light blonde", "Add the
// square bib panel and two crossing shoulder straps", "Recolour the shorts",
// "Repaint the hair light blonde and wavy", plus two pasted age findings).
//
// Keyed on the DECLARED type, never on the description prose — classifying by
// reading the text is what docs/SETTLED.md forbids. Same contract as
// ZERO_POINT_TYPES / MAX_SEVERITY_TYPES in scoring.js: the finding is still
// reported in full, only its ROUTE is constrained.
const NOT_INPAINTABLE_TYPES = new Set([
  // identity / face
  'character_identity', 'face_mismatch', 'face_drift', 'age_shift', 'skin_tone',
  // face_destroyed: inpaint repaints the whole figure and the identity drifts;
  // a featureless face must go to character repair, anchored to the avatar.
  'face_destroyed',
  // hair
  'hair', 'hair_change', 'hair_nuance',
  // clothing (garment_colour has its own mechanical recolour path)
  'clothing', 'clothing_inconsistent', 'clothing_detail', 'garment_colour', 'garment_color',
  // body form
  'scale',
  // extra_character: the finding is an identity reconciliation, not a deletion
  // (owner, 2026-09-13). Inpaint was the removal route — a Grok whole-frame
  // edit executing "remove this figure" erased a commissioned child from a
  // cover. The finding stays scored and stays in the shippedDefective report;
  // only its ROUTE is closed, like every other entry here.
  'extra_character',
]);

/**
 * ONE predicate for "may inpaint be asked to do this?", given the DECLARED types
 * of a consolidator fix. Never the instruction prose — classifying by reading
 * text is what docs/SETTLED.md forbids.
 *
 * An entry with no types is left alone: older plans predate the field, and
 * silently dropping their fixes would lose real pose work.
 *
 * It exists because the plan has TWO channels and the gate reached one. The
 * 2026-08-28 fix ("the plan path needed the same gate as the fallback") landed
 * on `per_character_fixes`; `scene_fix` stayed ungated, so a scene fix whose own
 * `types` are all forbidden could still be sent. Measured on staging
 * job_1789853503332_riqncqg1i: the front cover's plan carried
 * `scene_fix.types: ['extra_character']` — the route the owner closed on
 * 2026-09-13 after a removal erased a commissioned child — and nothing stopped
 * it. It reached no model only because the consolidator happened to emit an
 * empty instruction for it.
 */
function typesAreInpaintable(types) {
  const list = Array.isArray(types) ? types.filter(Boolean) : [];
  if (!list.length) return true;
  return !list.every((t) => NOT_INPAINTABLE_TYPES.has(String(t).toLowerCase()));
}

/**
 * Types local repair (inpaint) handles well: additive or local edits to objects,
 * props, counts and expression. Deliberately NARROW — anything in
 * NOT_INPAINTABLE_TYPES is excluded by construction below, and composition /
 * camera / staging defects are absent because no local repair can fix them.
 */
const SAFE_REPAIRABLE_TYPES = new Set([
  'object_presence',
  'missing_element',
  'accessory_missing',
  'object_count',
  'emotion',
  'viewer_address',
].filter(t => !NOT_INPAINTABLE_TYPES.has(t)));

/**
 * THE PRESERVE CHANNEL (2026-09-19). What must STILL BE TRUE after an inpaint
 * edit, as opposed to what the edit DOES.
 *
 * Why it exists: every attempt to shrink an oversized prop stranded the
 * characters' hands — the object retreated and the hands stayed where the
 * larger object had been. Measured on job_1789759147125_p08djwhbl p5, the
 * consolidator DRAFTED the combined instruction ("Redraw the egg at
 * child's-head size and move all four boys' hands with it") and then collapsed
 * it to "Resize the dragon egg to the size of a child's head", logging the
 * dropped half as "a constraint, not an action". That collapse is CORRECT —
 * an instruction full of non-actions makes the model change nothing. The
 * missing piece was a separate channel for the constraint, and
 * `scene_fix.preserve` already was one: produced by the consolidator, seeded
 * with landmark names, sanitized — and never sent to the image model. This is
 * the wire.
 *
 * Deliberately narrow: at most 3 short state clauses, appended as their own
 * sentence AFTER the numbered actions, never merged into one.
 *
 * @param {string[]} preserve
 * @returns {string} '' when there is nothing to preserve.
 */
const PRESERVE_MAX = 3;
function buildPreserveClause(preserve) {
  if (!Array.isArray(preserve)) return '';
  const items = [];
  for (const raw of preserve) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().replace(/[.;,\s]+$/, '');
    if (!t) continue;
    if (items.some(i => i.toLowerCase() === t.toLowerCase())) continue;
    items.push(t);
    if (items.length >= PRESERVE_MAX) break;
  }
  if (!items.length) return '';
  return `\n\nStill true after the edit: ${items.join('; ')}.`;
}

module.exports = {
  repairAttemptFromResult, findBadPages, applyRoundCap, LAST_ROUND_CRITICAL_MAX, planBookAuditRound, admitPagesFromAudit, summarizeRepairRound, baseRepairMethod, AUDIT_ADMIT_MAX, AUDIT_ADMIT_SEVERITIES, collectShippedDefective, collectSurvivingCriticals, resolveDeclaredCast, inheritSceneContract, resolveVersionCompressedScene, resolveVersionPrompt, resolveOwnRenderPrompt, SAFE_REPAIRABLE_TYPES, typesAreInpaintable, findSafeRepairableFinding, selectCharRepairTasks, decideRepairMethod, NOT_INPAINTABLE_TYPES, hasCriticalSeverityFinding, collectCriticalFindings, buildPreserveClause, PRESERVE_MAX };
