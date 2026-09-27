/**
 * Jev text audit — cheap per-passage yes/no checks on story TEXT.
 *
 * Jev (TypeSafe, `typesafe/jev-1.13` on OpenRouter) is a decision model: it
 * reads a text "state" plus questions and returns a probability per question
 * (`noul` = P(yes)) or a choice. It generates nothing. ~$0.00003 per call.
 *
 * WIRED 2026-09-27 (owner: "slop + logic/arc rewrites"), two consumers:
 *   - textRefine.refineStoryText runs `runJevTextSource` in parallel with the
 *     arc-informed and blind audits; its FAULT lines join mergeAuditFindings
 *     and the ONE repair pass rewrites only the pages they name;
 *   - the arc machine's re-tell gate (beatsPipeline + the Lab mirrors) adds
 *     `jevCastBeatVoice`: a commissioned character with no act of their own.
 * Which checks run and at which threshold is JEV_CHECKS, set from the
 * evaluation (docs/decisions.md 2026-09-27 "Jev text audit" and "… wired").
 *
 * Question text lives in prompts/jev-text-audit.txt (versioned), except the
 * slop questions, which live beside the writer rules they judge in
 * proseSlop.js (one source for generator and critic); code only fills
 * placeholders and aggregates.
 *
 * Fails loudly: a non-200, a missing answer, or an oversize state throws.
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
const { SLOP_TYPES } = require('./proseSlop');

const JEV_URL = 'https://openrouter.ai/api/alpha/decisions';
const JEV_MODEL = 'typesafe/jev-1.13';
/** Jev's context is ~32k tokens incl. questions; ~4 chars/token with headroom. */
const MAX_STATE_CHARS = 100000;
const QUESTIONS_FILE = path.join(__dirname, '../../prompts/jev-text-audit.txt');

const LANGUAGE_NAMES = { de: 'German', fr: 'French', en: 'English', it: 'Italian' };

/**
 * Thresholds and on/off per check, set from the 2026-09-27 evaluation
 * (evals/results/results.jsonl, run 2026-09-27_jev-v1). A question is only
 * asked by auditStoryText when its entry is enabled. `flagWhen` says which
 * side of the threshold is a fault ('above' for fault-propositions, 'below'
 * for propositions that are true of a good passage).
 * see DECISIONS: docs/decisions.md 2026-09-27 "Jev text audit"
 */
const slop = (threshold = 0.5, verdict = '✅') => ({ enabled: true, threshold, flagWhen: 'above', unit: 'page', verdict });
const off = verdict => ({ enabled: false, verdict });
const JEV_CHECKS = {
  // GRAMMAR ❌ — synthetic errors separate (paragraph AUC 0.87) but the REAL
  // LLM errors do not (real pages AUC 0.49-0.57, real writer-stage sentences
  // AUC 0.50; «zur Basteltisch» 0.17, «nicht hers» 0.39 vs clean mean ~0.25),
  // at sentence, numbered-sentence, paragraph, page and story granularity.
  GRAM_ANY: off('❌'), GRAM_ARTICLE_CASE: off('❌'), GRAM_AGREEMENT: off('❌'),
  GRAM_FOREIGN_WORD: off('❌'), GRAM_NONWORD: off('❌'), GRAM_TENSE: off('❌'), GRAM_CLEAN: off('❌'),
  // SLOP ✅ at page level, 0.5: real labelled pages recall 11/14, precision
  // 16/18 after adjudication; ~20/23 flags on unlabelled real pages were real.
  SLOP_STOCK_WONDER: slop(0.5, '🟡'), // no real occurrence in 20 stories; injected 9/9
  SLOP_BODY_CLICHE: slop(),
  SLOP_FORESHADOW: slop(),
  SLOP_MORAL_SUMMARY: slop(), // real recall 3/6, no false flag
  SLOP_RULE_OF_THREE: slop(0.5, '🟡'), // real 0/2, injected 8/9
  SLOP_INTENSIFIER: slop(0.5, '🟡'),
  // SLOP_SUDDENLY ❌ (fires 0.6-0.87 on every page) and SLOP_EMOTION_LABEL
  // (contradicts MOTIVE_AT_THE_ACT_RULE's "a feeling named") are not asked:
  // neither is in proseSlop.SLOP_TYPES. "Suddenly" is counted (MECH_SUDDENLY).
  SLOP_REPETITIVE_OPENINGS: slop(0.7, '🟡'),
  SLOP_LESSON_EXPLAIN: slop(),
  SLOP_PURPLE_SIMILE: slop(),
  SLOP_GENERIC_ENDING: slop(),
  SLOP_PARALLEL_NEGATION: slop(),
  // LOGIC — whole story as state with the page marked. Injected, blatant faults
  // separate; the subtle real ones found by reading (5) were all missed.
  LOGIC_APPEAR: off('❌'), // fires on every legitimate introduction (clean neg top 0.9)
  LOGIC_VANISH: { enabled: true, threshold: 0.7, flagWhen: 'above', verdict: '🟡' }, // explicit vanish 4/4; silent absence untested
  LOGIC_ANIMAL: { enabled: true, threshold: 0.5, flagWhen: 'above', verdict: '🟡' }, // 4/4, clean max 0.22
  LOGIC_OBJECT: off('❌'), // real 0/3, injected 6/8
  LOGIC_MOTIVE: { enabled: true, threshold: 0.55, flagWhen: 'above', verdict: '🟡' }, // 3/4, clean max 0.56
  // ARC — page text vs its plan line.
  ARC_PAGE_MATCH: off('❌'), // flags picture-only plan detail on the older plan format (10/18 pages of one story)
  // v2 wording (2026-09-27, picture-only plan detail excluded): subtle 4/7, originals 0/147
  // at 0.8. v1 (0.85: 5/7, 1/147) flagged a plan's 'no figures in the frame' on
  // a page whose prose names the cast — a rewrite toward a picture instruction.
  ARC_PAGE_CONTRADICT: { enabled: true, threshold: 0.8, flagWhen: 'above', verdict: '🟡' },
  ARC_CAST_BEAT: { enabled: true, threshold: 0.35, flagWhen: 'below', verdict: '🟡' }, // cut member 52/57 below; passive members score low too
  // SHOT ❌ — 61% / 58% (two phrasings) vs 60% always-"medium"; the brief's own
  // camera/shot field is counted instead, $0.
  SHOT_TYPE: off('❌'),
};

// ───────────────────────── question file ─────────────────────────

/** Parse `[SECTION]` / `ID: proposition` lines; `#!` maintainer lines are skipped. */
function parseQuestionFile(text) {
  const sections = {};
  let current = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#!')) continue;
    const sec = line.match(/^\[([A-Z_]+)\]$/);
    if (sec) { current = sec[1]; sections[current] = sections[current] || []; continue; }
    const q = line.match(/^([A-Z][A-Z0-9_]+):\s*(.+)$/);
    if (q && current) sections[current].push({ id: q[1], text: q[2] });
  }
  return sections;
}

let cachedQuestions = null;
function loadQuestions(text) {
  if (text != null) return parseQuestionFile(text);
  if (!cachedQuestions) cachedQuestions = parseQuestionFile(fs.readFileSync(QUESTIONS_FILE, 'utf-8'));
  return cachedQuestions;
}

function fill(text, vars = {}) {
  return String(text).replace(/\{([A-Z_]+)\}/g, (m, k) => {
    if (!(k in vars)) throw new Error(`jevAudit: placeholder {${k}} has no value`);
    return String(vars[k]);
  });
}

function languageName(language) {
  const base = String(language || '').toLowerCase().split(/[-_]/)[0];
  const name = LANGUAGE_NAMES[base];
  if (!name) throw new Error(`jevAudit: unsupported language "${language}"`);
  return name;
}

// ───────────────────────── question builders ─────────────────────────

function pick(section, ids, questions) {
  const all = (questions || loadQuestions())[section];
  if (!all) throw new Error(`jevAudit: question file has no [${section}] section`);
  if (!ids) return all;
  return ids.map(id => {
    const q = all.find(x => x.id === id);
    if (!q) throw new Error(`jevAudit: no question ${id} in [${section}]`);
    return q;
  });
}

function asNoul(list, vars) {
  const out = {};
  for (const q of list) out[q.id] = { type: 'noul', instructions: fill(q.text, vars) };
  return out;
}

function buildGrammarQuestions(language, { ids, questions } = {}) {
  return asNoul(pick('GRAMMAR', ids, questions), { LANGUAGE: languageName(language) });
}

/** The slop questions come from proseSlop.SLOP_TYPES, the same entries that write the writer's rules. */
function buildSlopQuestions({ ids } = {}) {
  const list = ids ? ids.map(id => {
    const t = SLOP_TYPES.find(x => x.id === id);
    if (!t) throw new Error(`jevAudit: no slop type ${id} in proseSlop.SLOP_TYPES`);
    return t;
  }) : SLOP_TYPES;
  return asNoul(list.map(t => ({ id: t.id, text: t.question })), {});
}

function buildLogicQuestions(pageNumber, { ids, questions } = {}) {
  return asNoul(pick('LOGIC', ids, questions), { PAGE: pageNumber });
}

function buildArcPageQuestions(planLine, { ids = ['ARC_PAGE_MATCH', 'ARC_PAGE_CONTRADICT'], questions } = {}) {
  return asNoul(pick('ARC', ids, questions), { PLAN: planLine });
}

/** One noul per cast member; ids are ARC_CAST_BEAT__<index> so names never collide with ids. */
function buildCastBeatQuestions(names, { questions } = {}) {
  const [q] = pick('ARC', ['ARC_CAST_BEAT'], questions);
  const out = {};
  names.forEach((name, i) => { out[`ARC_CAST_BEAT__${i}`] = { type: 'noul', instructions: fill(q.text, { NAME: name }) }; });
  return out;
}

const SHOT_CRITERIA = {
  closeup: 'close-up: one face or head and shoulders fills the frame, or a hand and an object seen very near',
  medium: 'medium: one to a few figures seen from about the waist or knees up, the setting only partly visible',
  wide: 'wide: whole figures small or full-length inside a broad setting, the place itself dominant',
};

function buildShotQuestion({ questions } = {}) {
  const [q] = pick('SHOT', ['SHOT_TYPE'], questions);
  return { SHOT_TYPE: { type: 'choice', instructions: q.text, criteria: { ...SHOT_CRITERIA } } };
}

/** Map the brief vocabulary (close-up, over-the-shoulder, ultra-wide, high-angle…) onto the three bins. */
function normalizeShot(label) {
  const s = String(label || '').toLowerCase();
  if (!s) return null;
  if (/close|detail|over-the-shoulder|insert/.test(s)) return 'closeup';
  if (/wide|establish|high-angle|aerial|bird|long/.test(s)) return 'wide';
  if (/medium|mid|two-shot|cowboy/.test(s)) return 'medium';
  return null;
}

// ───────────────────────── state builders ─────────────────────────

function splitParagraphs(text) {
  return String(text || '').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

/** Split into sentences, keeping closing quotes with their sentence. */
function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…][»"“”']?)\s+(?=[«"„A-ZÄÖÜÀ-Ý])/u)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * The whole story as one state, with one page marked for judgement. Pages after
 * the marked one are included only when `includeLater` (a vanish can only be
 * seen against what comes after it; an appearance only against what came before).
 */
function buildMarkedStoryState(pages, pageNumber, { includeLater = true } = {}) {
  const lines = [];
  for (const p of pages) {
    if (!includeLater && p.pageNumber > pageNumber) break;
    const mark = p.pageNumber === pageNumber ? ' (PAGE TO JUDGE)' : '';
    lines.push(`--- Page ${p.pageNumber}${mark} ---\n${p.text}`);
  }
  return lines.join('\n\n');
}

// ───────────────────────── client ─────────────────────────

/**
 * One Jev call. Throws on HTTP error, on a missing answer, on an oversize state.
 * @returns {Promise<{answers:Object, cost:number, model:string, usage:Object}>}
 */
async function callJev({ state, questions, apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = globalThis.fetch, model = JEV_MODEL }) {
  if (!apiKey) throw new Error('jevAudit: OPENROUTER_API_KEY is not set');
  if (!state || typeof state !== 'string') throw new Error('jevAudit: empty state');
  if (state.length > MAX_STATE_CHARS) throw new Error(`jevAudit: state is ${state.length} chars, over ${MAX_STATE_CHARS}`);
  const ids = Object.keys(questions || {});
  if (!ids.length) throw new Error('jevAudit: no questions');
  const res = await fetchImpl(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`jevAudit: HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  let body;
  try { body = JSON.parse(bodyText); } catch (e) { throw new Error(`jevAudit: non-JSON reply: ${bodyText.slice(0, 200)}`); }
  const answers = body.answers || {};
  const missing = ids.filter(id => !answers[id]);
  if (missing.length) throw new Error(`jevAudit: reply lacks answers for ${missing.join(', ')}`);
  return { answers, cost: Number(body.usage?.cost || 0), model: body.model || model, usage: body.usage || {} };
}

/** P(yes) of a noul answer; throws if the answer is not a noul. */
function yesProb(answer) {
  if (!answer || typeof answer.noul !== 'number') throw new Error(`jevAudit: not a noul answer: ${JSON.stringify(answer)}`);
  return answer.noul;
}

// ───────────────────────── mechanical checks ($0) ─────────────────────────

/**
 * Swiss conventions are string facts, not judgements: ß never appears in
 * Swiss German; de-CH and fr-CH dialogue uses «» guillemets.
 * see feedback_swiss_ss_not_eszett / feedback_swiss_guillemets (memory).
 */
const SUDDENLY_WORDS = { de: /\bplötzlich\b/gi, fr: /\bsoudain(?:ement)?\b/gi, en: /\bsuddenly\b/gi, it: /\bimprovvisamente\b/gi };

function mechanicalChecks(text, language) {
  const flags = [];
  const lang = String(language || '').toLowerCase();
  const swiss = /-ch$/.test(lang);
  if (swiss && lang.startsWith('de') && /ß/.test(text)) {
    flags.push({ questionId: 'MECH_ESZETT', evidence: (text.match(/\S*ß\S*/) || [''])[0] });
  }
  if (swiss && /[„“”"]/.test(text)) {
    flags.push({ questionId: 'MECH_QUOTES', evidence: (text.match(/.{0,20}[„“”"].{0,20}/) || [''])[0] });
  }
  // "suddenly" as a crutch is a count, not a judgement — Jev's SLOP_SUDDENLY
  // answered 0.6-0.87 on every page (2026-09-27 eval).
  const sudden = SUDDENLY_WORDS[lang.split('-')[0]];
  const hits = sudden ? (text.match(sudden) || []).length : 0;
  if (hits >= 2) flags.push({ questionId: 'MECH_SUDDENLY', evidence: `${hits}×` });
  return flags;
}

// ───────────────────────── aggregation ─────────────────────────

/**
 * Turn raw probabilities into flags using the check table.
 * @param {Array<{pageNumber:number, paragraphIndex:number|null, check:string, scores:Object<string,number>}>} rows
 * @param {Object} checks  JEV_CHECKS-shaped table
 */
function aggregateFlags(rows, checks = JEV_CHECKS) {
  const flags = [];
  for (const row of rows) {
    for (const [qid, p] of Object.entries(row.scores || {})) {
      const baseId = qid.split('__')[0];
      const cfg = checks[baseId];
      if (!cfg || !cfg.enabled) continue;
      const fires = cfg.flagWhen === 'below' ? p < cfg.threshold : p >= cfg.threshold;
      if (!fires) continue;
      flags.push({
        pageNumber: row.pageNumber,
        paragraphIndex: row.paragraphIndex ?? null,
        check: row.check,
        questionId: baseId,
        subject: row.subjects?.[qid] || null,
        text: row.texts?.[qid] || null,
        p,
      });
    }
  }
  // Deterministic order: the audit's calls finish in any order.
  flags.sort((a, b) => ((a.pageNumber ?? 0) - (b.pageNumber ?? 0))
    || ((a.paragraphIndex ?? -1) - (b.paragraphIndex ?? -1))
    || String(a.check).localeCompare(String(b.check))
    || String(a.questionId).localeCompare(String(b.questionId))
    || String(a.subject || '').localeCompare(String(b.subject || '')));
  return flags;
}

/** Per-page summary: which pages to rewrite and why. */
function pagesToRewrite(flags) {
  const byPage = new Map();
  for (const f of flags) {
    if (f.pageNumber == null) continue;
    if (!byPage.has(f.pageNumber)) byPage.set(f.pageNumber, new Set());
    byPage.get(f.pageNumber).add(f.questionId);
  }
  return [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([pageNumber, ids]) => ({ pageNumber, questionIds: [...ids].sort() }));
}

/**
 * Render flags as the FAULT lines textRefine.parseFaultLines reads, so a later
 * wiring feeds mergeAuditFindings without a new format. That parser's category
 * tag is letters only (`\[([A-Z]+)\]`), so the tag is the CHECK (GRAMMAR,
 * SLOP, LOGIC, ARC) and the question id that fired leads the text.
 */
function toFaultLines(flags) {
  return flags.map(f => {
    const tag = String(f.check || 'JEV').replace(/[^A-Za-z]/g, '').toUpperCase();
    const page = f.pageNumber != null ? `p${f.pageNumber} — ` : '';
    const where = f.paragraphIndex != null ? ` paragraph ${f.paragraphIndex + 1}:` : '';
    // f.text is the question as asked (placeholders filled, the cast name in it)
    return `FAULT[${tag}]: ${page}[${f.questionId}]${where} ${f.text || ''}`.trimEnd();
  });
}

function shotDistribution(labels) {
  const dist = { closeup: 0, medium: 0, wide: 0 };
  for (const l of labels) if (l && l in dist) dist[l]++;
  return dist;
}

/**
 * A beats plan line is "<shot> — <cast> — <what happens> — <outcome>" (the
 * outlineExtract PLAN: line). Jev was measured on the part after the shot, so
 * a leading shot token is dropped. Empty in, empty out.
 */
function planLineForJev(line) {
  const parts = String(line || '').trim().split(/\s+—\s+/);
  if (parts.length > 1 && normalizeShot(parts[0]) && parts[0].split(/\s+/).length <= 3) parts.shift();
  return parts.join(' — ').trim();
}

// ───────────────────────── the audit ─────────────────────────

/**
 * Audit a story's text. Asks only the questions enabled in `checks`.
 * @param {Object} input
 * @param {Array<{pageNumber:number,text:string}>} input.pages
 * @param {string} input.language              e.g. 'de-ch'
 * @param {string} [input.arc]                 arc text (numbered lines)
 * @param {Array<{pageNumber:number,line:string}>} [input.planLines]
 * @param {Array<{name:string}>} [input.cast]   people AND animals
 * @param {Array<{pageNumber:number,camera?:string,text?:string}>} [input.briefs]
 * @returns {Promise<{flags:Array, pages:Array, faultLines:string[], mechanical:Array, shots:Object, cost:number, calls:number}>}
 */
async function auditStoryText(input, { checks = JEV_CHECKS, callImpl = callJev, questions } = {}) {
  const { pages = [], language, arc, planLines = [], cast = [], briefs = [] } = input;
  if (!pages.length) throw new Error('jevAudit: no pages');
  const Q = questions || loadQuestions();
  const enabledIn = section => (section === 'SLOP' ? SLOP_TYPES : (Q[section] || [])).map(q => q.id).filter(id => checks[id]?.enabled);
  const concurrency = Math.max(1, Number(input.concurrency) || 6);
  const rows = [];
  let cost = 0;
  let calls = 0;
  const ask = async (state, qs) => {
    const r = await callImpl({ state, questions: qs });
    cost += r.cost; calls++;
    const scores = {};
    const texts = {};
    for (const id of Object.keys(qs)) {
      texts[id] = qs[id].instructions;
      if (qs[id].type === 'noul') scores[id] = yesProb(r.answers[id]);
    }
    return { scores, texts, answers: r.answers };
  };

  const mechanical = [];
  const gramIds = enabledIn('GRAMMAR');
  const slopIds = enabledIn('SLOP');
  const logicIds = enabledIn('LOGIC');
  // Every call is independent: queue them all, run a small pool. Sequential,
  // an 18-page story took ~15 s (55 calls). Any call that throws fails the
  // whole audit; there is no partial result.
  const tasks = [];
  const task = (state, qs, row) => tasks.push(async () => {
    const { scores, texts } = await ask(state, qs);
    rows.push({ ...row, scores, texts });
  });
  for (const page of pages) {
    const paras = splitParagraphs(page.text);
    for (const m of mechanicalChecks(page.text, language)) mechanical.push({ pageNumber: page.pageNumber, ...m });
    if (gramIds.length) {
      const unit = checks[gramIds[0]].unit || 'page';
      const units = unit === 'paragraph' ? paras.map((t, i) => [t, i]) : [[page.text, null]];
      for (const [t, i] of units) {
        task(t, buildGrammarQuestions(language, { ids: gramIds, questions: Q }), { pageNumber: page.pageNumber, paragraphIndex: i, check: 'grammar' });
      }
    }
    if (slopIds.length) {
      task(page.text, buildSlopQuestions({ ids: slopIds }), { pageNumber: page.pageNumber, paragraphIndex: null, check: 'slop' });
    }
    if (logicIds.length) {
      task(buildMarkedStoryState(pages, page.pageNumber), buildLogicQuestions(page.pageNumber, { ids: logicIds, questions: Q }), { pageNumber: page.pageNumber, paragraphIndex: null, check: 'logic' });
    }
  }
  if (checks.ARC_PAGE_MATCH?.enabled || checks.ARC_PAGE_CONTRADICT?.enabled) {
    const ids = ['ARC_PAGE_MATCH', 'ARC_PAGE_CONTRADICT'].filter(id => checks[id]?.enabled);
    for (const pl of planLines) {
      const page = pages.find(p => p.pageNumber === pl.pageNumber);
      const line = planLineForJev(pl.line);
      if (!page || !line) continue;
      task(page.text, buildArcPageQuestions(line, { ids, questions: Q }), { pageNumber: pl.pageNumber, paragraphIndex: null, check: 'arc' });
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  }));
  if (checks.ARC_CAST_BEAT?.enabled && arc && cast.length) {
    const names = cast.map(c => c.name).filter(Boolean);
    const qs = buildCastBeatQuestions(names, { questions: Q });
    const { scores, texts } = await ask(arc, qs);
    const subjects = Object.fromEntries(names.map((n, i) => [`ARC_CAST_BEAT__${i}`, n]));
    rows.push({ pageNumber: null, paragraphIndex: null, check: 'arc_cast', scores, texts, subjects });
  }

  let shots = null;
  if (briefs.length) {
    const labels = [];
    for (const b of briefs) {
      const own = normalizeShot(b.camera);
      if (own) { labels.push(own); continue; }
      if (!checks.SHOT_TYPE?.enabled || !b.text) { labels.push(null); continue; }
      const { answers } = await ask(b.text, buildShotQuestion({ questions: Q }));
      labels.push(answers.SHOT_TYPE.choice);
    }
    shots = shotDistribution(labels);
  }

  const flags = aggregateFlags(rows, checks);
  return {
    flags,
    pages: pagesToRewrite(flags),
    faultLines: toFaultLines(flags),
    mechanical,
    shots,
    rows,
    cost,
    calls,
  };
}

// ───────────────────────── consumer 1: the text chain ─────────────────────────

/** Languages the 2026-09-27 evaluation covered. Any other language: the source does not run, and says so. */
const JEV_TEXT_LANGUAGES = new Set(['de', 'fr', 'en']);

const MECH_TEXT = {
  MECH_ESZETT: e => `Swiss German never writes ß: «${e}» takes ss.`,
  MECH_QUOTES: e => `Swiss dialogue uses «» guillemets, not ${e.trim()}.`,
  MECH_SUDDENLY: e => `"Suddenly" (or its equivalent) appears ${e} on this page; at most once.`,
};

/** The $0 string checks as FAULT lines, one per page and check. */
function mechanicalFaultLines(mechanical = []) {
  return mechanical.map(m => `FAULT[MECH]: p${m.pageNumber} — [${m.questionId}] ${MECH_TEXT[m.questionId] ? MECH_TEXT[m.questionId](m.evidence || '') : m.questionId}`);
}

/**
 * The Jev source for textRefine.refineStoryText: slop, logic (vanish, animal,
 * motive) and arc contradiction per page, plus the $0 string checks, as FAULT
 * lines for mergeAuditFindings. The cast-beat check is not asked here — it
 * judges the ARC and runs in the arc machine (jevCastBeatVoice).
 *
 * NEVER THROWS, and NEVER DEGRADES QUIETLY: on any Jev error the whole source
 * is reported failed (`ok: false`, logged as an error) and contributes no
 * finding, exactly like a failed arc-informed or blind audit. The $0 string
 * checks are part of this source and are dropped with it, so a Jev outage
 * cannot ship a half-audited story that looks fully audited.
 *
 * @param {{ language: string }} storyData
 * @param {Array<{pageNumber:number, text:string, planLine?:string}>} pages
 * @returns {Promise<{source:'jev', ok:boolean, raw?:string, error?:string, skipped?:string,
 *   flags?:Array, mechanical?:Array, cost?:number, calls?:number, elapsedMs:number}>}
 */
async function runJevTextSource(storyData, pages, { checks = JEV_CHECKS, callImpl = callJev, concurrency } = {}) {
  const t0 = Date.now();
  const language = String(storyData?.language || '').toLowerCase();
  if (!JEV_TEXT_LANGUAGES.has(language.split(/[-_]/)[0])) {
    const skipped = `language "${language || '(none)'}" was not in the 2026-09-27 evaluation (de, fr, en)`;
    log.info(`ℹ️ [TEXT-AUDIT/jev] not run: ${skipped}`);
    return { source: 'jev', ok: false, skipped, elapsedMs: 0 };
  }
  const textChecks = { ...checks, ARC_CAST_BEAT: { ...(checks.ARC_CAST_BEAT || {}), enabled: false } };
  try {
    const r = await auditStoryText({
      pages: pages.map(p => ({ pageNumber: p.pageNumber, text: p.text })),
      language,
      planLines: pages.filter(p => String(p.planLine || '').trim()).map(p => ({ pageNumber: p.pageNumber, line: p.planLine })),
      concurrency,
    }, { checks: textChecks, callImpl });
    const lines = [...r.faultLines, ...mechanicalFaultLines(r.mechanical)];
    const elapsedMs = Date.now() - t0;
    log.info(`🔎 [TEXT-AUDIT/jev] ${lines.length} fault(s) on ${new Set([...r.flags, ...r.mechanical].map(f => f.pageNumber)).size} page(s), ${r.calls} calls, $${r.cost.toFixed(5)}, ${(elapsedMs / 1000).toFixed(1)}s`);
    return { source: 'jev', ok: true, raw: lines.join('\n'), flags: r.flags, mechanical: r.mechanical, cost: r.cost, calls: r.calls, elapsedMs };
  } catch (e) {
    log.error(`❌ [TEXT-AUDIT/jev] FAILED — the Jev source contributes NO findings to this story (slop, logic, arc contradiction and the ß/«»/suddenly checks are all missing): ${e.message}`);
    return { source: 'jev', ok: false, error: e.message, elapsedMs: Date.now() - t0 };
  }
}

// ───────────────────────── consumer 2: the arc re-tell gate ─────────────────────────

/** The numbered sentences of an arc block ("STORY LOGIC: … ARC: 1. … 2. …"), from the ARC heading on. */
function arcSentencesText(arcBlock) {
  const lines = String(arcBlock || '').split('\n');
  const at = lines.findIndex(l => /^\s*(?:\*\*|#+\s*)?(?:FINAL\s+)?ARC(?:\s*\*\*)?\s*:?\s*(?:\*\*)?\s*$/i.test(l));
  return (at >= 0 ? lines.slice(at + 1) : lines).join('\n').trim();
}

/**
 * The cast-beat check as one more voice for promptBuilders.arcRepairFindings:
 * every child on the character list whose Jev "does something that changes
 * what happens" answer falls below the threshold becomes one MAJOR issue in
 * the CAST lens. The generator side is EVERY_CHILD_ACTS_RULE, which the arc
 * create and re-tell already carry; the arc critics had no lens for it.
 *
 * The issue cites every arc sentence (the fault is an absence, there is no one
 * sentence to quote) and carries no quote — it is built here, never parsed
 * from model text, so the quote guard of parseArcIssues does not apply.
 *
 * Never throws: on a Jev error it logs an error and returns no voice.
 *
 * @param {string} arcBlock  the committed block's story logic + arc (splitCommittedBlock().arcBlock)
 * @param {string[]} childNames  the commissioned children (the character list, adults excluded)
 * @returns {Promise<{letter:'J', findings:Array, ok:boolean, error?:string, scores?:Object, cost?:number}|null>}
 */
async function jevCastBeatVoice(arcBlock, childNames, { checks = JEV_CHECKS, callImpl = callJev } = {}) {
  const cfg = checks.ARC_CAST_BEAT;
  const names = [...new Set((childNames || []).map(n => String(n || '').trim()).filter(Boolean))];
  if (!cfg?.enabled || !names.length) return null;
  const arcText = arcSentencesText(arcBlock);
  if (!arcText) return null;
  const sentenceCount = (arcText.match(/^\s*\d+[.)]/gm) || []).length;
  try {
    const qs = buildCastBeatQuestions(names);
    const r = await callImpl({ state: arcText, questions: qs });
    const scores = Object.fromEntries(names.map((n, i) => [n, yesProb(r.answers[`ARC_CAST_BEAT__${i}`])]));
    const weak = names.filter(n => scores[n] < cfg.threshold);
    const cite = sentenceCount > 1 ? `s1-s${sentenceCount}` : 's1';
    const findings = weak.map((n, i) => ({
      text: `${i + 1}. [MAJOR] (${cite}) CAST: ${n} is on the character list and does nothing of their own in the arc that changes what happens (automatic cast check). Smallest change: give ${n} one act of their own that matters to the plot, inside an event the arc already has.`,
      severity: 'MAJOR', rank: i + 1, lens: 'CAST',
      // No sentence list: arcRepairFindings dedupes on lens + cited sentences, and
      // two cast findings citing the whole arc would fold into one.
      sentences: [],
      quotes: [], verified: [], unverified: [],
    }));
    if (weak.length) log.info(`🧮 [ARC/jev] cast-beat: ${weak.map(n => `${n} ${scores[n]}`).join(', ')} below ${cfg.threshold}`);
    return { letter: 'J', ok: true, findings, scores, cost: r.cost };
  } catch (e) {
    log.error(`❌ [ARC/jev] cast-beat check FAILED — no automatic cast finding for this round: ${e.message}`);
    return { letter: 'J', ok: false, findings: [], error: e.message };
  }
}

/**
 * THE re-tell gate with the Jev cast check as one more voice — the ONE entry
 * point production (beatsPipeline round loop) and the Lab mirrors (testlab.js
 * arc_effort, arc_panel_replay) all call (sibling set arc-retell-gate). The
 * voice joins only the gate; the panel list the callers report is unchanged.
 *
 * @param {{critique:string, reviewedArc:string, panel:Array, castNames:string[]}} args
 * @returns {Promise<{gate:Object, jevCast:Object|null}>} gate = arcRepairFindings(); jevCast = what the check said, for the report
 */
async function arcRepairFindingsWithCastCheck({ critique, reviewedArc, panel = [], castNames = [] }, opts = {}) {
  const { arcRepairFindings } = require('./promptBuilders');
  const voice = await jevCastBeatVoice(reviewedArc, castNames, opts);
  const voices = voice && voice.findings.length ? [...panel, voice] : panel;
  const gate = arcRepairFindings({ critique, reviewedArc, panel: voices });
  const jevCast = voice && { ok: voice.ok, scores: voice.scores || null, findings: voice.findings.map(f => f.text), error: voice.error || null, cost: voice.cost ?? null };
  return { gate, jevCast };
}

module.exports = {
  arcRepairFindingsWithCastCheck,
  JEV_TEXT_LANGUAGES,
  planLineForJev,
  mechanicalFaultLines,
  runJevTextSource,
  arcSentencesText,
  jevCastBeatVoice,
  JEV_URL,
  JEV_MODEL,
  JEV_CHECKS,
  MAX_STATE_CHARS,
  SHOT_CRITERIA,
  parseQuestionFile,
  loadQuestions,
  fill,
  languageName,
  buildGrammarQuestions,
  buildSlopQuestions,
  buildLogicQuestions,
  buildArcPageQuestions,
  buildCastBeatQuestions,
  buildShotQuestion,
  normalizeShot,
  splitParagraphs,
  splitSentences,
  buildMarkedStoryState,
  callJev,
  yesProb,
  mechanicalChecks,
  aggregateFlags,
  pagesToRewrite,
  toFaultLines,
  shotDistribution,
  auditStoryText,
};
