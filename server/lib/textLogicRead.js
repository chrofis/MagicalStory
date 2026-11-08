'use strict';

/**
 * THE LOGIC READ of the finished text (2026-11-08, docs/decisions.md "Logic read of the finished text").
 *
 * Runs once, as the LAST step of the text chain (textRefine.refineStoryText, after the lector):
 *   1. ONE text-only call (MODEL_DEFAULTS.textLogicReadModel, no page images) reads the text that ships and
 *      answers prompts/story-text-logic-read.txt. The reply is JSON; parseLogicRead types it.
 *   2. Findings typed MAJOR go through ONE fix round: the EXISTING scoped rewrite (textRefine.runPostAuditTextRound,
 *      the same round the book audit's TEXT route uses: whole-page rewrite, only the pages a finding names, the
 *      30% edit cap). There is no second rewrite implementation here.
 *   MINOR findings are stored and never rewritten.
 *
 * CODE NEVER READS THE PROSE. Which findings are fixed is decided by the typed `severity` field alone. The only
 * string check is the lector's own hallucination guard: a non-empty quote must be on a page the finding names.
 *
 * Trial stories never reach this (the trial skips the whole refine chain, see the decision entry).
 * Like the lector, the step never throws: a failure is a round with ok:false, logged at error level, and the text
 * stays as the lector left it.
 */

const { log } = require('../utils/logger');

/** The closed question vocabulary. Upper-case letters only: the ids double as FAULT-line categories. */
const LOGIC_QUESTIONS = Object.freeze([
  'OBSTACLE', 'STAKES', 'KNOWLEDGE', 'PLACE', 'CONTRADICTION', 'FRIEND', 'NOPROGRESS', 'CAUSE', 'VERSE',
]);
const LOGIC_SEVERITIES = Object.freeze(['MAJOR', 'MINOR']);

/**
 * Same role as POST_AUDIT_SCOPE_NOTE for the logic read's fix round: the reader read the TEXT, and the pictures
 * are drawn from the locked plan lines, so a fault is fixed inside the page it names, in words.
 */
const LOGIC_FIX_SCOPE_NOTE = [
  'These findings come from a reader of the FINISHED text of the whole book, who judged story logic only.',
  'The illustrations are drawn from the locked plan lines and do not change, so every fault below is fixed in the words.',
  'Rewrite only the pages these findings name, and change as little as the fault needs. Never move a passage from one page to another, and never change what happens in the story: fix each fault inside the page it names, or say in the ledger why it stands.',
].join('\n');

/**
 * Type the model's JSON reply. Pure.
 *
 * @param {string} raw
 * @param {Array<{pageNumber:number,text:string}>} pages the pages the model was shown
 * @returns {{ok:boolean, error?:string, resolution:object|null, findings:Array, dropped:Array}}
 *   findings: {pages:number[], question, severity, quote, fix}
 *   dropped:  {reason, finding} for every entry that was not usable (never silent)
 */
function parseLogicRead(raw, pages = []) {
  const { extractJsonFromText } = require('./sceneMetadata');
  const { locateQuote } = require('./textRefine');
  const doc = extractJsonFromText(String(raw || ''));
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.findings)) {
    return { ok: false, error: 'the reply holds no JSON object with a findings array', resolution: null, findings: [], dropped: [] };
  }
  const byPage = new Map(pages.map(p => [p.pageNumber, String(p.text || '')]));
  const findings = [];
  const dropped = [];
  for (const f of doc.findings) {
    const question = String(f?.question || '').toUpperCase();
    const severity = String(f?.severity || '').toUpperCase();
    if (!LOGIC_QUESTIONS.includes(question)) { dropped.push({ reason: 'unknown-question', finding: f }); continue; }
    if (!LOGIC_SEVERITIES.includes(severity)) { dropped.push({ reason: 'unknown-severity', finding: f }); continue; }
    const named = (Array.isArray(f.pages) ? f.pages : [f.pages])
      .map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && byPage.has(n));
    const pageNumbers = [...new Set(named)];
    if (pageNumbers.length === 0) { dropped.push({ reason: 'no-such-page', finding: f }); continue; }
    const fix = String(f.fix || '').trim();
    if (!fix) { dropped.push({ reason: 'no-fix', finding: f }); continue; }
    const quote = String(f.quote || '').trim();
    // The lector's hallucination guard: words the model quotes must be on a page it names.
    if (quote && !pageNumbers.some(n => locateQuote(byPage.get(n), quote))) {
      dropped.push({ reason: 'quote-absent', finding: f });
      continue;
    }
    findings.push({ pages: pageNumbers, question, severity, quote, fix });
  }
  const r = doc.resolution && typeof doc.resolution === 'object' ? doc.resolution : null;
  return { ok: true, resolution: r, findings, dropped };
}

/** The findings that get the fix round: typed MAJOR, nothing else. Pure. */
function selectMajorFindings(findings = []) {
  return findings.filter(f => f.severity === 'MAJOR');
}

/**
 * FAULT lines for the existing scoped rewrite (textRefine.parseFaultLines reads `FAULT[CATEGORY]: p<N> — text`).
 * One line per page a finding names, so the rewrite is scoped to every page the fault touches. The text is
 * assembled from the typed fields only (quote, fix). Pure.
 */
function toFaultLines(findings = []) {
  const lines = [];
  for (const f of findings) {
    const span = f.pages.length > 1 ? ` (the fault runs over pages ${f.pages.join(', ')})` : '';
    const text = `${f.quote ? `"${f.quote}" — ` : ''}${f.fix}${span}`.replace(/\s*\n\s*/g, ' ');
    for (const n of f.pages) lines.push({ line: `FAULT[${f.question}]: p${n} — ${text}` });
  }
  return lines;
}

/**
 * Read, then fix once. Never throws.
 *
 * @param {Object} storyData story record fields
 * @param {Array<{pageNumber:number,text:string}>} pages the text as the lector left it
 * @param {Object} [opts] arc, arcHints, storyLogic (passed to the fix round), model, effort, firstRound (round number to use)
 * @returns {Promise<{pages:Array, rounds:Array, logicRead:object}>}
 *   logicRead is the stored record: model, ok, findings (all, typed), dropped, majorCount, fixed, error, cost.
 */
async function runLogicReadStep(storyData, pages, opts = {}) {
  const { buildTextLogicReadPrompt } = require('./storyHelpers');
  const { callTextModelStreaming, describeTruncation } = require('./textModels');
  const { TEXT_MODELS, MODEL_DEFAULTS, priceUsage } = require('../config/models');
  const { runPostAuditTextRound } = require('./textRefine');

  const modelKey = opts.model || MODEL_DEFAULTS.textLogicReadModel;
  const effort = opts.effort || MODEL_DEFAULTS.textLogicReadEffort;
  const rounds = [];
  const nextRound = () => (opts.firstRound || 1) + rounds.length;
  const record = {
    ran: false, ok: false, modelKey, findings: [], dropped: [], resolution: null,
    majorCount: 0, fixedPages: [], fix: null, error: null, cost: 0,
  };
  const out = () => ({ pages, rounds, logicRead: record });

  const prompt = buildTextLogicReadPrompt(storyData, pages);
  if (!prompt || !TEXT_MODELS[modelKey]) {
    record.error = prompt ? `unknown model "${modelKey}"` : 'template unavailable';
    log.error(`❌ [LOGIC-READ] not run: ${record.error} — the finished text is unread for story logic`);
    return out();
  }

  record.ran = true;
  let t0 = Date.now();
  let raw = '';
  try {
    let r = await callTextModelStreaming(prompt, null, null, modelKey, { usageLabel: 'text_logic_read', effort });
    if (!String(r.text || '').trim()) {
      log.warn(`⚠️ [LOGIC-READ] ${modelKey} returned empty output — retrying once`);
      r = await callTextModelStreaming(prompt, null, null, modelKey, { usageLabel: 'text_logic_read', effort });
    }
    if (r.truncation?.suspected) throw new Error(`reply ${describeTruncation(r.truncation)} — findings unusable`);
    raw = String(r.text || '').trim();
    const parsed = parseLogicRead(raw, pages);
    const cost = priceUsage(r.modelId || TEXT_MODELS[modelKey].modelId, r.usage || {});
    record.cost = cost;
    const entry = {
      round: nextRound(), kind: 'logic_read', ok: parsed.ok, modelKey,
      modelId: r.modelId || TEXT_MODELS[modelKey].modelId,
      elapsedMs: Date.now() - t0,
      usage: { input_tokens: r.usage?.input_tokens || 0, output_tokens: r.usage?.output_tokens || 0 },
      cost, prompt, rawResponse: raw.slice(0, 40000), changedPages: [], error: parsed.ok ? null : parsed.error,
    };
    rounds.push(entry);
    if (!parsed.ok) throw new Error(parsed.error);
    record.ok = true;
    record.findings = parsed.findings;
    record.dropped = parsed.dropped.map(d => ({ reason: d.reason, finding: d.finding }));
    record.resolution = parsed.resolution;
    for (const d of parsed.dropped) {
      log.warn(`⚠️ [LOGIC-READ] dropped a finding (${d.reason}): ${JSON.stringify(d.finding).slice(0, 200)}`);
    }
    const major = selectMajorFindings(parsed.findings);
    record.majorCount = major.length;
    log.info(`🧭 [LOGIC-READ] ${modelKey}: ${parsed.findings.length} finding(s), ${major.length} MAJOR, ${parsed.dropped.length} dropped, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    if (major.length === 0) return out();

    // ONE fix round, through the existing scoped rewrite.
    t0 = Date.now();
    const fix = await runPostAuditTextRound(storyData, pages, toFaultLines(major), {
      arc: opts.arc, arcHints: opts.arcHints, storyLogic: opts.storyLogic,
      scopeNote: LOGIC_FIX_SCOPE_NOTE, usageLabel: 'text_logic_fix',
    });
    if (fix) {
      const e = { ...fix.entry, round: nextRound(), kind: 'logic_fix' };
      rounds.push(e);
      record.fix = {
        ok: !!e.ok, error: e.error || null, changedPages: e.changedPages || [], unresolvedCount: e.unresolvedCount ?? null,
        findingOutcomes: (e.findingOutcomes || []).map(f => ({ pageNumber: f.pageNumber, category: f.category, text: f.text, outcome: f.outcome, reason: f.reason || null })),
        cost: e.cost || 0,
      };
      record.fixedPages = e.changedPages || [];
      record.cost += e.cost || 0;
      if (e.ok) pages = fix.pages;
      else log.error(`❌ [LOGIC-READ] the fix round failed (${e.error}) — ${major.length} MAJOR finding(s) ship unanswered`);
    }
    return out();
  } catch (err) {
    record.error = err.message;
    log.error(`❌ [LOGIC-READ] failed (${err.message}) — the text stays as the lector left it`);
    if (!rounds.some(x => x.kind === 'logic_read')) {
      rounds.push({ round: nextRound(), kind: 'logic_read', ok: false, modelKey, error: err.message, prompt, rawResponse: raw, changedPages: [] });
    }
    return out();
  }
}

module.exports = {
  LOGIC_QUESTIONS,
  LOGIC_SEVERITIES,
  LOGIC_FIX_SCOPE_NOTE,
  parseLogicRead,
  selectMajorFindings,
  toFaultLines,
  runLogicReadStep,
};
