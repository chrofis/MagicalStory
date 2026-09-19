/**
 * Finding provenance — WHO said this.
 *
 * ONE field, `sources: string[]`, on every finding, in every collection, from
 * the emitter through consolidation and scoring into the stored run. It answers
 * the first question anyone asks of a finding: which evaluator produced it.
 *
 * WHY THIS EXISTS (2026-09-14). Four diagnoses in one day turned on working the
 * emitter out after the fact: a false clothing CRITICAL that came from one judge
 * grading one character against another's outfit and commissioned two repair
 * rounds that destroyed a story's central prop; a `missing_character` CRITICAL
 * that came from the book-audit READER pass rather than the brief checker, which
 * flipped it from a bug into by-design; a state contradiction charged to the
 * wrong element; and a contract warning whose age half was a false positive.
 * Lab #1263 shows the symptom directly — half the findings render as `[?]` and
 * the rest as `three-stage`.
 *
 * WHY `sources` AND NOT A NEW FIELD. It already exists and is already the
 * closest thing to an authority:
 *   - `prompts/feedback-consolidator.txt:104` already defines the closed
 *     vocabulary below and makes the consolidator emit it on every deduped
 *     issue;
 *   - `repairLogic.js:114` / `:768` ROUTE on it (`sources.every(s => s ===
 *     'entity')` refuses automatic repair for entity findings, owner 2026-09-04);
 *   - `scoring.js:357` already passes it through into the stored deductions;
 *   - `textRefine.js:91` already stamps it on every parsed book-audit finding.
 * Adding a second field would have created a parallel truth next to a field that
 * routing already reads. Instead the gap is filled: the emitters that carried
 * nothing now stamp the same field with the same vocabulary.
 *
 * NOT TO BE CONFUSED WITH the singular `source`, which is overloaded and is NOT
 * provenance: on an entity finding it is the detection channel (grid / ref-face)
 * and the Lab renders it as the finding's TYPE; on a three-stage compliance
 * finding it is a display tag; inside `scoring.normalizeIssues` it is the
 * deduction BUCKET. All three are left exactly as they are — this module does
 * not read or write any of them.
 *
 * RULES
 *  - Provenance is STAMPED BY THE EMITTER, never derived downstream, and never
 *    inferred by reading a finding's description prose (docs/SETTLED.md:28).
 *  - Additive only: a finding that lacks `sources` must still flow and still
 *    score exactly as before. Every reader here tolerates absence.
 *  - Never overwrite. A finding that already names its source keeps it, so a
 *    consolidator-merged finding that lists three evaluators is not flattened
 *    back to one by a late stamp.
 */

/**
 * The closed vocabulary. Must stay in step with the `sources` enum in
 * `prompts/feedback-consolidator.txt` — that prompt and this constant are the
 * same list, one for the model and one for the code.
 */
const FINDING_SOURCES = Object.freeze({
  /** image-evaluation.txt — the Gemini vision quality judge. */
  QUALITY: 'quality',
  /** image-semantic.txt — image-vs-brief fidelity. */
  SEMANTIC: 'semantic',
  /** image-vision-inventory + image-prompt-compliance.txt — the three-stage judge. */
  COMPLIANCE: 'compliance',
  /** entityConsistency.js — cross-page character appearance drift. */
  ENTITY: 'entity',
  /** bookAudit.js — the judge that read the finished page, words and picture together. */
  READER: 'reader',
  /** The mechanical end-of-page checks (text overlay, borders, contract). */
  FINAL_CHECKS: 'final_checks',
});

const KNOWN_SOURCES = new Set(Object.values(FINDING_SOURCES));

/**
 * Read a finding's provenance. Always an array of lower-cased names; empty when
 * the finding carries none (legacy rows, and anything this sweep could not
 * reach). Callers must treat empty as "unknown", never as a value.
 *
 * @param {any} finding
 * @returns {string[]}
 */
function sourcesOf(finding) {
  const raw = finding && finding.sources;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(s => typeof s === 'string' && s.trim())
    .map(s => s.trim().toLowerCase());
}

/**
 * Union two provenance lists, order-stable and de-duplicated. Used where a
 * merge brings two records of the same finding together; a merge must never
 * narrow provenance, because a narrowed `sources` is what routing reads.
 *
 * @param {...(string[]|undefined)} lists
 * @returns {string[]}
 */
function mergeSources(...lists) {
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (typeof s !== 'string' || !s.trim()) continue;
      const v = s.trim().toLowerCase();
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

/**
 * Stamp `source` onto every finding in `list` that does not already name one.
 *
 * Returns a NEW array of new objects — the emitters this is called from build
 * their findings in a `.map()`, so copying keeps them free of shared-reference
 * surprises. Non-object entries pass through untouched.
 *
 * ROUTING SAFETY. This only ever ADDS the field where it was absent, and each
 * call site passes its own emitter's name. A quality/semantic/compliance/reader
 * finding therefore goes from no `sources` to a one-entry list that is not
 * `['entity']`, and both entity guards in `repairLogic.js` test
 * `sources.length && sources.every(s => s === 'entity')` — false before (length
 * 0) and false after. Entity findings are stamped `['entity']`, which is what
 * the consolidator already produced for them and what the raw path already
 * bucketed them as. Routing is unchanged in both directions; pinned by
 * `tests/unit/finding-provenance.test.ts`.
 *
 * @param {Array<any>} list
 * @param {string} source one of FINDING_SOURCES
 * @returns {Array<any>}
 */
function stampFindingSource(list, source) {
  if (!Array.isArray(list)) return list;
  const name = String(source || '').trim().toLowerCase();
  if (!KNOWN_SOURCES.has(name)) {
    throw new Error(`stampFindingSource: unknown source "${source}" — add it to FINDING_SOURCES and to prompts/feedback-consolidator.txt`);
  }
  return list.map(f => {
    if (!f || typeof f !== 'object') return f;
    if (sourcesOf(f).length > 0) return f;  // already named — never overwrite
    return { ...f, sources: [name] };
  });
}

module.exports = {
  FINDING_SOURCES,
  KNOWN_SOURCES,
  sourcesOf,
  mergeSources,
  stampFindingSource,
};
