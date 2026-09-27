/**
 * JUDGE REGRESSION FIXTURES — scoring (pure: no DB, no network, no model).
 *
 * A fixture is one stored input a judge is handed (a page image + its brief, a
 * plate, a book, an arc) and the verdict it must return: `flag` (a finding of
 * the named type, at or above a minimum severity) or `pass` (no such finding).
 * The Test Lab stage `judge_fixture` replays the fixture through the CURRENT
 * production judge with production's builders and hands the judge's answer to
 * this module; `scripts/admin/judge-fixtures.js` aggregates the answers into
 * recall and precision per judge. Fixtures live in tests/judge-fixtures/.
 *
 * Why it exists (owner, 2026-09-26): judge recall had never been measured on
 * any judge. The eval-gap analysis of 24 problems found most misses were
 * structural, and a critic-input change could only be argued about. A fixture
 * set turns "the judge now sees X" into a number that moves.
 *
 * WHAT THIS MODULE MAY READ. Scoring a fixture means finding the one finding
 * that answers it, so the selector reads a finding's structured fields (type,
 * severity, character, pages, named boolean fields). `about` additionally
 * matches words in the finding's text. That is a LOCATOR for a measuring stick,
 * never production classification: nothing here feeds a score, a repair or a
 * gate (CLAUDE.md "classification belongs to the PROMPT"). The report prints the
 * matched finding's own words, so every hit is checked by a human reading it.
 */
'use strict';

/** Severity ladder, lowest first. Case-insensitive on read. */
const SEVERITY_ORDER = ['MINOR', 'MODERATE', 'MAJOR', 'CRITICAL', 'CATASTROPHIC'];

/** The judges a fixture can name. The stage dispatches on the same list. */
const JUDGES = Object.freeze([
  'semantic', 'quality', 'lettering', 'plate_qc', 'entity', 'book_audit', 'arc_panel',
]);

function severityRank(sev) {
  if (sev == null) return null;
  const i = SEVERITY_ORDER.indexOf(String(sev).trim().toUpperCase());
  return i < 0 ? null : i;
}

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const lower = (v) => String(v == null ? '' : v).toLowerCase();

/**
 * One finding shape for every judge: {type, severity, text, character, pages, fields}.
 * `fields` keeps the judge's own structured booleans (e.g. landmark_element).
 * Throws on an unknown judge — a fixture naming a judge nobody reads is a typo.
 */
function normalizeFindings(judge, result) {
  const r = result || {};
  const fromIssue = (i, extra = {}) => ({
    type: i?.type ?? null,
    severity: i?.severity ? String(i.severity).toUpperCase() : null,
    text: String(i?.description ?? i?.issue ?? i?.text ?? ''),
    character: i?.character ?? null,
    pages: asArray(i?.pages ?? i?.pagesToFix ?? i?.pageNumber ?? i?.page).map(Number).filter(Number.isFinite),
    fields: {
      ...(i?.landmark_element != null ? { landmark_element: !!i.landmark_element } : {}),
      ...(i?.absent != null ? { absent: !!i.absent } : {}),
      ...(i?.element != null ? { element: i.element } : {}),
      ...(Array.isArray(i?.sources) ? { sources: i.sources } : {}),
    },
    ...extra,
  });
  switch (judge) {
    case 'semantic':
      return asArray(r.semanticIssues).map(i => fromIssue(i));
    case 'quality':
      // Everything evaluateImageQuality hands the pipeline as fixable issues —
      // the quality judge's own findings and the presence derivation it runs on
      // its inventory — except the lettering check, which is its own judge here.
      // Each finding keeps its `sources` in `fields` for the report.
      return asArray(r.fixableIssues)
        .filter(i => i?.source !== 'lettering-check')
        .map(i => fromIssue(i));
    case 'lettering':
      return asArray(r.fixableIssues).filter(i => i?.source === 'lettering-check').map(i => fromIssue(i));
    case 'plate_qc':
      // Plate QC files each issue under a closed check key (plateQc.js); it has
      // no severity, so a fixture on it names a type and no minSeverity.
      return asArray(r.qc?.findings).map(f => ({ type: f?.check ?? null, severity: null, text: String(f?.issue ?? ''), character: null, pages: [], fields: {} }));
    case 'entity': {
      const out = [];
      for (const [name, data] of Object.entries(r.report?.characters || {})) {
        for (const i of asArray(data?.issues)) out.push(fromIssue(i, { character: i?.character ?? name }));
      }
      return out;
    }
    case 'book_audit':
      return [...asArray(r.byRoute?.IMG).map(f => ({ ...f, route: 'IMG' })), ...asArray(r.byRoute?.TEXT).map(f => ({ ...f, route: 'TEXT' }))]
        .map(f => fromIssue({ ...f, description: f.line ?? f.description ?? f.text }, { type: f.type ?? f.route, fields: { route: f.route } }));
    case 'arc_panel': {
      const out = [];
      for (const run of asArray(r.runs)) {
        if (!run?.ok) continue;
        for (const f of asArray(run.findings)) {
          out.push({ type: f?.lens ?? null, severity: f?.severity ? String(f.severity).toUpperCase() : null, text: String(f?.text ?? ''), character: null, pages: [], fields: { panelist: run.model, sentences: f?.sentences || [] } });
        }
      }
      return out;
    }
    default:
      throw new Error(`judgeFixtures: unknown judge "${judge}" (known: ${JUDGES.join(', ')})`);
  }
}

/**
 * Does this finding answer the expectation's selector?
 *   types       — any-of on finding.type (case-insensitive); omitted = any type
 *   minSeverity — finding.severity at or above it; a finding with no severity
 *                 never satisfies a severity bound (it could not be graded)
 *   page        — story-level judges: the finding cites that page
 *   character   — finding.character, case-insensitive
 *   fields      — every named structured field equals the given value
 *   about       — any-of words, case-insensitive, in the finding's text (locator only)
 *   minPanelists— arc_panel: at least N distinct panelists raised a matching finding
 *                 (checked on the set, see matchFindings)
 */
function findingMatches(sel, f) {
  const types = asArray(sel.types ?? sel.type).map(lower);
  if (types.length && !types.includes(lower(f.type))) return false;
  if (sel.minSeverity != null) {
    const want = severityRank(sel.minSeverity);
    if (want == null) throw new Error(`judgeFixtures: unknown minSeverity "${sel.minSeverity}"`);
    const got = severityRank(f.severity);
    if (got == null || got < want) return false;
  }
  if (sel.page != null && !(f.pages || []).includes(Number(sel.page))) return false;
  if (sel.character != null && lower(f.character) !== lower(sel.character)) return false;
  for (const [k, v] of Object.entries(sel.fields || {})) {
    if ((f.fields || {})[k] !== v) return false;
  }
  const about = asArray(sel.about).map(lower).filter(Boolean);
  if (about.length && !about.some(w => lower(f.text).includes(w))) return false;
  return true;
}

function matchFindings(sel, findings) {
  const hits = asArray(findings).filter(f => findingMatches(sel, f));
  if (sel.minPanelists != null) {
    const voices = new Set(hits.map(h => h.fields?.panelist).filter(Boolean));
    if (voices.size < Number(sel.minPanelists)) return [];
  }
  return hits;
}

/**
 * Score one replay against its fixture's expectation.
 * @param {{verdict:'flag'|'pass', types?, minSeverity?, page?, character?, fields?, about?, minPanelists?}} expect
 * @param {Array} findings normalized findings
 * @returns {{expected:'flag'|'pass', flagged:boolean, outcome:'TP'|'FN'|'TN'|'FP', correct:boolean, matched:Array}}
 */
function scoreFixture(expect, findings) {
  if (!expect || (expect.verdict !== 'flag' && expect.verdict !== 'pass')) {
    throw new Error(`judgeFixtures: expect.verdict must be "flag" or "pass", got ${JSON.stringify(expect?.verdict)}`);
  }
  const matched = matchFindings(expect, findings);
  const flagged = matched.length > 0;
  const outcome = expect.verdict === 'flag' ? (flagged ? 'TP' : 'FN') : (flagged ? 'FP' : 'TN');
  return { expected: expect.verdict, flagged, outcome, correct: outcome === 'TP' || outcome === 'TN', matched };
}

const ratio = (a, b) => (b > 0 ? a / b : null);

/**
 * Aggregate replay entries into per-judge numbers.
 * @param {Array<{fixtureId, judge, outcome?: string, error?: string}>} entries — one per replay (N repeats = N entries)
 * @returns {{judges: Object<string, {fixtures, runs, tp, fn, tn, fp, errors, recall, precision, falseAlarmRate, flipped, flipRate, repeated}>, overall: Object}}
 *
 * Every replay counts once (a fixture repeated 3 times adds 3 to the counts), so
 * recall and precision are rates over judge CALLS, which is what the pipeline
 * experiences. A fixture FLIPS when its repeats disagree on the outcome; the flip
 * rate is over fixtures that have at least two scored repeats. Errors are
 * counted apart and never enter recall or precision — a replay that failed says
 * nothing about the judge.
 */
function summarize(entries) {
  const judges = {};
  const byFixture = new Map();
  const blank = () => ({ fixtures: 0, runs: 0, tp: 0, fn: 0, tn: 0, fp: 0, errors: 0, flipped: 0, repeated: 0 });
  for (const e of asArray(entries)) {
    const j = judges[e.judge] || (judges[e.judge] = blank());
    const key = `${e.judge}::${e.fixtureId}`;
    if (!byFixture.has(key)) { byFixture.set(key, []); j.fixtures++; }
    if (e.error || !e.outcome) { j.errors++; continue; }
    j.runs++;
    j[String(e.outcome).toLowerCase()]++;
    byFixture.get(key).push(e.outcome);
  }
  for (const [key, outs] of byFixture) {
    const j = judges[key.split('::')[0]];
    if (outs.length >= 2) {
      j.repeated++;
      if (new Set(outs).size > 1) j.flipped++;
    }
  }
  const finish = (j) => ({
    ...j,
    recall: ratio(j.tp, j.tp + j.fn),
    precision: ratio(j.tp, j.tp + j.fp),
    falseAlarmRate: ratio(j.fp, j.fp + j.tn),
    flipRate: ratio(j.flipped, j.repeated),
  });
  const overall = Object.values(judges).reduce((a, j) => {
    for (const k of Object.keys(a)) a[k] += j[k];
    return a;
  }, blank());
  return {
    judges: Object.fromEntries(Object.entries(judges).map(([k, j]) => [k, finish(j)])),
    overall: finish(overall),
  };
}

/**
 * Validate a fixture file's entries. Returns a list of problems (empty = valid).
 * Run by the unit test over the committed file and by the runner before a sync.
 */
function validateFixtures(fixtures) {
  const problems = [];
  const ids = new Set();
  for (const [i, f] of asArray(fixtures).entries()) {
    const at = `fixture[${i}]${f?.id ? ` ${f.id}` : ''}`;
    if (!f?.id || !/^[a-z0-9][a-z0-9-]*$/.test(f.id)) problems.push(`${at}: id must be kebab-case`);
    if (ids.has(f?.id)) problems.push(`${at}: duplicate id`);
    ids.add(f?.id);
    if (!JUDGES.includes(f?.judge)) problems.push(`${at}: unknown judge "${f?.judge}"`);
    if (!f?.target?.storyId) problems.push(`${at}: target.storyId required`);
    const pageJudge = ['semantic', 'quality', 'lettering', 'plate_qc'].includes(f?.judge);
    if (pageJudge && !Number.isFinite(Number(f?.target?.pageNumber))) problems.push(`${at}: target.pageNumber required for ${f?.judge}`);
    if (['semantic', 'quality', 'lettering', 'plate_qc'].includes(f?.judge) && !/^https:\/\//.test(String(f?.input?.imageUrl || ''))) {
      problems.push(`${at}: input.imageUrl (the judged image, by R2 URL) required for ${f?.judge}`);
    }
    if (f?.judge === 'entity' && !f?.target?.character) problems.push(`${at}: target.character required for entity`);
    if (f?.expect?.verdict !== 'flag' && f?.expect?.verdict !== 'pass') problems.push(`${at}: expect.verdict must be flag|pass`);
    if (f?.expect?.minSeverity != null && severityRank(f.expect.minSeverity) == null) problems.push(`${at}: unknown minSeverity ${f.expect.minSeverity}`);
    if (f?.judge === 'plate_qc' && f?.expect?.minSeverity != null) problems.push(`${at}: plate_qc findings carry no severity — drop minSeverity`);
    if (!String(f?.source || '').trim()) problems.push(`${at}: source note required (story, page, which finding)`);
  }
  return problems;
}

// gemini-2.5-flash list price, USD per 1M tokens (MODEL_PRICING in
// server/config/models.js). Every image judge here runs on it.
const FLASH = { input: 0.30, output: 2.50 };
const priceFlash = (inTok, outTok) => ((inTok || 0) * FLASH.input + (outTok || 0) * FLASH.output) / 1e6;

/**
 * What one replay cost, from the usage the judge returns — and, where a judge
 * returns none, a stated flat estimate. `basis` says which, so a report never
 * passes an estimate off as a measurement.
 * Thinking tokens are billed at the output rate and are NOT inside a Gemini
 * reply's output count (server/lib/providerUsage.js), so every measured branch
 * adds them to output — the entity estimate was ~5-7x low without them.
 *   semantic  — the judge's own usage: input + output + thinking.
 *   quality   — the aggregate the pipeline records (quality + P1 + semantic +
 *               three-stage). The semantic call is inside it whenever it ran
 *               (semantic_input_tokens > 0); only when it did not is the flat
 *               semantic estimate added.
 *   plate_qc  — validateEmptyScene returns no usage: ~4k input tokens (the prompt,
 *               the plate and the landmark photo) + ~300 output.
 *   entity    — the check's report.tokenUsage (input + output + thinking).
 *   book_audit, arc_panel — the stage's own measured cost.
 */
function estimateCostUsd(judge, result) {
  const r = result || {};
  const SEMANTIC_FLAT = priceFlash(14000, 1500);
  switch (judge) {
    case 'semantic': {
      const u = r.usage || {};
      if (!Number(u.input_tokens)) return { usd: SEMANTIC_FLAT, basis: 'flat estimate (no usage returned)' };
      return { usd: priceFlash(u.input_tokens, (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0)), basis: 'measured (input + output + thinking)' };
    }
    case 'quality':
    case 'lettering': {
      const u = r.totalUsage || {};
      const inTok = Number(u.input_tokens) || 0;
      const outTok = (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0);
      if (!inTok) return { usd: priceFlash(30000, 3000) + SEMANTIC_FLAT, basis: 'flat estimate (no usage returned)' };
      if (Number(u.semantic_input_tokens) > 0) return { usd: priceFlash(inTok, outTok), basis: 'measured (quality + P1 + semantic + three-stage, incl. thinking)' };
      return { usd: priceFlash(inTok, outTok) + SEMANTIC_FLAT, basis: 'measured quality+P1 tokens + semantic estimate' };
    }
    case 'plate_qc':
      return { usd: priceFlash(4000, 300), basis: 'flat estimate (validateEmptyScene returns no usage)' };
    case 'entity': {
      const t = r.report?.tokenUsage || {};
      if (!Number(t.inputTokens)) return { usd: priceFlash(12000, 1500), basis: 'flat estimate per character grid call (no usage returned)' };
      return { usd: priceFlash(t.inputTokens, (Number(t.outputTokens) || 0) + (Number(t.thinkingTokens) || 0)), basis: 'measured (input + output + thinking)' };
    }
    case 'book_audit':
      return { usd: Number(r.cost) || 0, basis: 'measured (stage cost)' };
    case 'arc_panel':
      return { usd: Number(r.totalCost) || 0, basis: 'measured (stage cost)' };
    default:
      return { usd: 0, basis: 'unknown judge' };
  }
}

/** Test Lab set name for a judge's fixtures — one stage-typed set per judge. */
const setNameFor = (judge) => `Judge fixtures · ${judge}`;

module.exports = {
  SEVERITY_ORDER,
  JUDGES,
  severityRank,
  normalizeFindings,
  findingMatches,
  matchFindings,
  scoreFixture,
  summarize,
  validateFixtures,
  estimateCostUsd,
  setNameFor,
};
