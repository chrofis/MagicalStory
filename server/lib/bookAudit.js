/**
 * Final-book audit — the reader's-eye pass.
 *
 * Every other check in this pipeline looks at ONE artefact: the evaluator sees
 * an image against its brief, the text audit sees prose with a one-line
 * description of what the picture depicts, the style check sees thumbnails with
 * no words at all. Nothing ever read the finished book the way a child receives
 * it — rendered image and page text together, in order. This does.
 *
 * The judge gets, per page, the page TEXT and then the page's SHIPPED IMAGE,
 * interleaved as message parts so "PAGE N TEXT" and the picture that follows it
 * are unambiguously the same page.
 *
 * BALANCE IS NEVER A FAULT (owner's design constraint). The words and the
 * picture tell the story TOGETHER: a page may carry its moment almost entirely
 * in the picture with three words of text, or almost entirely in words over a
 * quiet picture. Both are legitimate picture-book craft. The prompt says so
 * explicitly, and a run that flags pages for being picture-heavy or word-heavy
 * is a failed prompt, not a finding.
 *
 * Faults are ROUTED, not scored: FAULT[IMG] means a different image would fix
 * it, FAULT[TEXT] means different prose would. Nothing here repaints anything.
 */

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');
const r2Lib = require('./r2');
const { assertPromptFilled } = require('../services/prompts');

// Pages per vision call. Six pages = six images + six text parts per request,
// which keeps a chunk well under the inline-data request ceiling and keeps the
// judge's attention on a readable stretch of book. Chunks run sequentially:
// the questions are per-page, so nothing is lost by splitting, and a serial
// walk keeps the rate-limit profile of one cheap Flash call at a time.
const CHUNK_PAGES = 6;

// Every fault line, tagged with its route. LEADING WHITESPACE IS TOLERATED on
// purpose: the judge sometimes nests a fault under the page it was reasoning
// about, and an anchored `^FAULT` silently dropped exactly those — the audit
// reported 3 faults on a replay that had found 5.
// Severity bracket is optional so pre-severity stored reports still parse.
const ROUTED_FAULT_RE = /^[ \t>*-]*FAULT\[(IMG|TEXT)\](?:\[(MINOR|MAJOR|CRITICAL|CATASTROPHIC)\])?:\s*(?:p(-?\d+))?\s*(.*)$/gim;

/**
 * Position of the SHIPPED image inside a scene's imageVersions[].
 *
 * The shipped version is the one whose `source` equals `bestSource` — NOT the
 * highest version index. A page can pick `original` after five repair passes,
 * and reading the last entry hands the audit an image the book never showed.
 *
 * An explicit PIN wins over bestSource when the caller passes one: the version
 * picker writes `stories.image_version_meta`, and a pinned version is what the
 * reader actually sees. Callers with no pin map (the in-flight pipeline, where
 * nothing has been pinned yet) get the bestSource answer.
 */
function shippedVersionIndex(scene, pinned) {
  if (typeof pinned === 'number' && pinned >= 0) return pinned;
  const versions = Array.isArray(scene?.imageVersions) ? scene.imageVersions : [];
  if (versions.length === 0) return 0;
  const idx = versions.findIndex(v => v && v.source === scene.bestSource);
  return idx >= 0 ? idx : 0;
}

/**
 * Resolve the bytes a reader saw on a page, in cost order:
 *   1. `scene.imageData` — the in-flight pipeline and any already-rehydrated
 *      story already hold the active image here.
 *   2. an injected `imageLoader(scene)` — what the tests use.
 *   3. a `story_images` lookup keyed by the shipped version index.
 * Returns a data URI, or null when the page has no image to read.
 */
async function loadShippedImage(scene, { pool, imageLoader, storyId, activeVersions }) {
  if (scene?.imageData && typeof scene.imageData === 'string' && scene.imageData.startsWith('data:')) {
    return scene.imageData;
  }
  if (typeof imageLoader === 'function') {
    const got = await imageLoader(scene);
    return got || null;
  }
  if (scene?.imageData) return scene.imageData;   // a bare URL — fetched below
  if (!pool || !storyId) return null;

  const versionIndex = shippedVersionIndex(scene, activeVersions?.[String(scene.pageNumber)]);
  const rows = await pool.query(
    `SELECT image_data, image_url FROM story_images
      WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = $3
      LIMIT 1`,
    [storyId, scene.pageNumber, versionIndex]
  );
  const row = rows.rows?.[0];
  if (!row) return null;
  if (row.image_data) return row.image_data;
  if (!row.image_url) return null;
  const buf = await r2Lib.fetchImageBytes(row.image_url);
  if (!buf) return null;
  const mime = buf[0] === 0x89 ? 'image/png' : buf[0] === 0x52 ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * THE PAGES THE AUDIT READS — one resolver, used by every caller.
 *
 * The audit is the reader's-eye pass, so it must be handed the book that
 * SHIPS: the FINAL page text and the PICKED image version. Two ways to get
 * that wrong, both of which have happened:
 *   - the picked version: `imageVersions[last]` is not the shipped image when
 *     a page keeps its original after five repair passes (see
 *     shippedVersionIndex). `pickVersion` answers it for the in-flight
 *     pipeline, where nothing is pinned yet.
 *   - the final text: the in-flight pipeline's page objects carried PRE-REFINE
 *     prose until 2026-09-13, because the text-refine join ran after the
 *     repair pipeline. Measured: 97% of pages are rewritten by the refiner.
 *     The join now happens before the pipeline (storyJobPipeline.js,
 *     joinTextRefinement), so `img.text` here is the shipped wording.
 *
 * A page with no resolvable image is dropped — half a page tells the judge
 * nothing about whether words and picture agree.
 *
 * @param {Array} images        page objects carrying pageNumber, text, imageData
 * @param {Function} [pickVersion] (pageNumber) => version — the picked version
 * @returns {Array<{pageNumber:number, text:string, imageData:string}>}
 */
function buildAuditPages(images, pickVersion) {
  const out = [];
  for (const img of images || []) {
    if (!img || typeof img.pageNumber !== 'number') continue;
    const picked = typeof pickVersion === 'function' ? pickVersion(img.pageNumber) : null;
    const imageData = picked?.imageData || img.imageData;
    if (!imageData) continue;
    out.push({ pageNumber: img.pageNumber, text: img.text || '', imageData });
  }
  return out;
}

/** Split a data URI (or bare base64) into the shape a Gemini inline_data part wants. */
function inlinePart(imageData) {
  const mime = String(imageData).match(/^data:(image\/[\w+.-]+);base64,/)?.[1] || 'image/jpeg';
  const data = r2Lib.stripDataUriPrefix(imageData);
  if (!data) return null;
  return { inline_data: { mime_type: mime, data } };
}

/**
 * A model id carrying a vendor prefix (`x-ai/grok-4.6`, `openai/gpt-5.6-sol`)
 * is an OpenRouter id; a bare `gemini-*` id is a native Google one. Production
 * passes no override and lands on the Google path with the body it always sent.
 */
function isOpenRouterId(modelId) {
  return String(modelId || '').includes('/');
}

/**
 * Same chunk, same prompt, same interleaving — sent as OpenAI chat parts with
 * the images as data URIs. Lab-only path: nothing in production reaches it.
 */
async function judgeChunkOpenRouter(parts, modelId, thinkingLevel) {
  assertPromptFilled(parts, 'bookAudit.judgeChunkOpenRouter');
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing');
  const content = parts.map(p => (
    p.inline_data
      ? { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } }
      : { type: 'text', text: p.text }
  ));
  // No max_tokens (owner rule: no output caps). Reasoning effort only when the
  // caller names one — thinking tokens bill as output.
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: modelId,
      temperature: 0,
      messages: [{ role: 'user', content }],
      usage: { include: true },
      ...(thinkingLevel ? { reasoning: { effort: thinkingLevel } } : {}),
    }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    throw new Error(`book audit HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(`book audit openrouter error: ${JSON.stringify(data.error).slice(0, 300)}`);
  const choice = data.choices?.[0];
  if (choice?.finish_reason && !['stop', 'end_turn'].includes(String(choice.finish_reason))) {
    log.warn(`⚠️ [BOOK-AUDIT] chunk finished as ${choice.finish_reason} — faults may be missing`);
  }
  return {
    text: String(choice?.message?.content || '').trim(),
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
      thinking_tokens: data.usage?.completion_tokens_details?.reasoning_tokens || 0,
      cost_usd: data.usage?.cost ?? null,
    },
  };
}

/**
 * The template file holds TWO prompts: the reader's-eye pass, and the
 * cross-page object-scale pass below this marker. They live in one file
 * because they are one stage's prompt work, and they are SPLIT before filling
 * because each pass must never see the other's instructions — a chunk call
 * that also carried "output only LARGER/SMALLER" would stop reporting faults.
 */
const SCALE_SECTION_MARKER = '===OBJECT-SCALE PASS===';

/** @returns {{reading: string, scale: string|null}} */
function splitBookAuditTemplate(template) {
  const text = String(template || '');
  const at = text.indexOf(SCALE_SECTION_MARKER);
  if (at < 0) return { reading: text, scale: null };
  return {
    reading: text.slice(0, at).trimEnd(),
    scale: text.slice(at + SCALE_SECTION_MARKER.length).trim(),
  };
}

/** Dispatch a built part list to whichever vendor the model id names. */
async function judgeParts(parts, modelId, thinkingLevel) {
  if (isOpenRouterId(modelId)) return judgeChunkOpenRouter(parts, modelId, thinkingLevel);
  return judgeGeminiParts(parts, modelId, thinkingLevel);
}

/** One vision call over one chunk of pages. Returns raw text + usage. */
async function judgeChunk(template, chunk, modelId, thinkingLevel = null) {
  const { fillTemplate } = require('../services/prompts');
  const instructions = fillTemplate(splitBookAuditTemplate(template).reading, {
    PAGE_LIST: chunk.map(p => p.pageNumber).join(', '),
    // ONE rule for every template that authors or judges a page against its
    // text (promptBuilders.TEXT_NOT_A_CHECKLIST_RULE, 2026-09-18). This audit
    // is the ONE stage that compares a page's words against its picture, so it
    // is the one that can commit the fault outright — and, reading the whole
    // book in order, the one place the rule's second half can actually fire.
    TEXT_NOT_A_CHECKLIST: require('./promptBuilders').TEXT_NOT_A_CHECKLIST_RULE,
  });

  // Instructions FIRST, then the book. The judge must know what it is looking
  // for before it starts looking, and the trailing part is the last thing it
  // read either way.
  const parts = [{ text: instructions }];
  for (const p of chunk) {
    parts.push({ text: `PAGE ${p.pageNumber} TEXT: ${p.text || '(no text on this page)'}` });
    parts.push(p.part);
  }

  assertPromptFilled(parts, 'bookAudit.judgeChunk');
  return judgeParts(parts, modelId, thinkingLevel);
}

/** The native-Google call. Same body production has always sent. */
async function judgeGeminiParts(parts, modelId, thinkingLevel = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        // No maxOutputTokens (owner rule: no output caps) — Gemini's default is
        // the model's own ceiling. Measured: a 6-page chunk spends ~9k tokens
        // thinking before writing, and a 4000 cap truncated two chunks of three
        // mid-sentence — a truncated audit reads as a clean one, which is the
        // worst failure a measurement can have.
        // Eval judges run at temperature 0, always (docs/SETTLED.md).
        temperature: 0,
        // Gemini 3 models take a thinking LEVEL ('low'|'medium'|'high'), not a
        // budget. Lab-only knob: OMITTED entirely unless a caller asks, so every
        // production audit sends the exact same body it always has and each
        // model keeps its own default. Measured 2026-09-13: an unknown field
        // here is a hard 400, so a typo cannot be silently ignored.
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok) {
    throw new Error(`book audit HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = await response.json();
  // A truncated reply loses the tail of the fault list and reads as a clean
  // audit. Say so out loud rather than under-reporting silently.
  const finish = data.candidates?.[0]?.finishReason;
  if (finish && finish !== 'STOP') {
    log.warn(`⚠️ [BOOK-AUDIT] a call finished as ${finish} — output may be truncated`);
  }
  const text = (data.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought)
    .map(p => p.text || '')
    .join('')
    .trim();
  return {
    text,
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount || 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount || 0,
      thinking_tokens: data.usageMetadata?.thoughtsTokenCount || 0,
    },
  };
}

/**
 * CROSS-PAGE OBJECT SCALE — three shuffled reads, act on the intersection.
 *
 * Every call sees the SAME page images for one prop in a DIFFERENT order,
 * because the order was measured to move the verdict (see objectScaleAudit.js
 * for the full evidence). Only a page every successful call named is reported.
 * Fewer than MIN_ANSWERS usable replies → one retry → the object is recorded
 * as NOT EVALUATED, never as clean and never as a partial list.
 *
 * REPORTED, NOT REPAIRED: the result lands in its own `objectScale` field and
 * is deliberately kept out of `byRoute`, which is what the corrective rounds
 * consume.
 */
async function auditObjectScale(scaleTemplate, prepared, storyData, opts) {
  const scaleLib = require('./objectScaleAudit');
  const { fillTemplate } = require('../services/prompts');
  const { modelId, thinkingLevel = null, usage, notEvaluated } = opts;

  const pages = prepared.map(p => p.pageNumber);
  const { candidates, skipped } = scaleLib.selectScaleObjects(storyData, pages);
  for (const s of skipped) {
    notEvaluated.record('object_scale', s.reason,
      `"${s.label}" (${s.id}) cited on ${s.pages.length} audited page(s): ${s.pages.map(p => `p${p}`).join(', ')}`);
  }
  if (candidates.length === 0) return { objects: [], findings: [] };

  const byPage = new Map(prepared.map(p => [p.pageNumber, p]));
  const objects = [];
  const findings = [];

  for (const obj of candidates) {
    const instructions = fillTemplate(scaleTemplate, { OBJECT_LABEL: obj.label });
    const objPages = obj.pages.map(n => byPage.get(n)).filter(Boolean);

    const lists = [];
    let calls = 0;
    // SCALE_CALLS reads, plus ONE retry round for the truncation case (1 run in
    // 4 returned nothing when this was measured).
    const maxCalls = scaleLib.SCALE_CALLS + scaleLib.MIN_ANSWERS;
    while (lists.length < scaleLib.MIN_ANSWERS && calls < maxCalls) {
      const seed = (obj.id.length * 7919) + (calls * 104729) + objPages.length;
      const order = scaleLib.shuffleWithSeed(objPages, seed);
      const parts = [{ text: instructions }];
      for (const p of order) {
        parts.push({ text: `PAGE ${p.pageNumber}` });
        parts.push(p.part);
      }
      calls += 1;
      try {
        assertPromptFilled(parts, 'bookAudit.auditObjectScale');
        const r = await judgeParts(parts, modelId, thinkingLevel);
        usage.input_tokens += r.usage.input_tokens;
        usage.output_tokens += r.usage.output_tokens;
        usage.thinking_tokens += r.usage.thinking_tokens;
        if (typeof r.usage.cost_usd === 'number') usage.cost_usd = (usage.cost_usd || 0) + r.usage.cost_usd;
        const parsed = scaleLib.parseScaleReply(r.text);
        if (!parsed) {
          log.warn(`⚠️ [BOOK-AUDIT] object-scale read for "${obj.label}" returned no LARGER/SMALLER line — not counted`);
          continue;
        }
        lists.push(parsed);
      } catch (err) {
        log.warn(`⚠️ [BOOK-AUDIT] object-scale read for "${obj.label}" failed: ${err.message}`);
      }
    }

    if (lists.length < scaleLib.MIN_ANSWERS) {
      notEvaluated.record('object_scale', 'insufficient_scale_reads',
        `"${obj.label}" (${obj.id}): ${lists.length} usable read(s) of ${calls} call(s), ${scaleLib.MIN_ANSWERS} needed to intersect`);
      objects.push({ id: obj.id, label: obj.label, pages: obj.pages, reads: lists.length, evaluated: false });
      continue;
    }

    const larger = scaleLib.intersectOutliers(lists.map(l => l.larger));
    const smaller = scaleLib.intersectOutliers(lists.map(l => l.smaller));
    const finding = scaleLib.buildScaleFinding(obj.label, larger, smaller);
    if (finding) findings.push(finding);
    objects.push({ id: obj.id, label: obj.label, pages: obj.pages, reads: lists.length, evaluated: true, larger, smaller });
  }

  return { objects, findings };
}

/** Pull routed fault lines out of the concatenated raw output. */
function parseRoutes(raw) {
  const byRoute = { IMG: [], TEXT: [] };
  for (const m of String(raw || '').matchAll(ROUTED_FAULT_RE)) {
    const route = m[1].toUpperCase();
    const severity = m[2] ? m[2].toUpperCase() : null;
    const page = m[3] != null ? parseInt(m[3], 10) : null;
    byRoute[route].push({
      page,
      severity,
      // The whole line, verbatim — the corrective text round is fed FAULT lines
      // in the same shape the text audit produces, so the refine template reads
      // them without a second format to learn.
      line: m[0].trim(),
      detail: (m[4] || '').replace(/^[—–-]\s*/, '').trim(),
    });
  }
  return byRoute;
}

/**
 * Audit a finished book: every page's text next to the image that shipped with it.
 *
 * NEVER THROWS. A failed audit is a missing measurement, not a failed story —
 * every caller runs this after the expensive work is already paid for.
 *
 * @param {Object} storyData                     story blob (sceneImages[] with text + imageVersions/bestSource)
 * @param {Object} [opts]
 * @param {Object} [opts.pool]                   pg pool for the story_images lookup
 * @param {string} [opts.storyId]                required with `pool` (defaults to storyData.id)
 * @param {Function} [opts.imageLoader]          async (scene) => dataUri — overrides every other source
 * @param {Object} [opts.activeVersions]         { "<page>": version_index } pins that beat bestSource
 * @param {Function} [opts.usageTracker]         (provider, usage, fn, modelId) => void
 * @param {string} [opts.modelId]
 * @returns {Promise<{faults:number, byRoute:{IMG:Array,TEXT:Array}, raw:string, usage:Object, modelId:string, pagesRead:number[]}|null>}
 */
async function auditStoryBook(storyData, opts = {}) {
  const {
    pool = null,
    imageLoader = null,
    activeVersions = null,
    usageTracker = null,
    modelId = MODEL_DEFAULTS.utility || 'gemini-2.5-flash',
    // Lab-only. Absent = today's behaviour, byte-identical.
    thinkingLevel = null,
    // The cross-page object-scale pass. On by default; a caller that only
    // wants the reader's-eye faults (a replay, a Lab arm) turns it off.
    objectScale: objectScaleEnabled = true,
  } = opts;
  const storyId = opts.storyId || storyData?.id || null;

  try {
    const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../services/prompts');
    if (!PROMPT_TEMPLATES.bookAudit) await loadPromptTemplates();
    const template = PROMPT_TEMPLATES.bookAudit;
    if (!template) throw new Error('bookAudit template not loaded');

    const scenes = (storyData?.sceneImages || [])
      .filter(s => s && typeof s.pageNumber === 'number')
      .sort((a, b) => a.pageNumber - b.pageNumber);
    if (scenes.length === 0) throw new Error('no pages to audit');

    // Resolve images in parallel, judge in sequence. A page whose image cannot
    // be resolved is DROPPED rather than sent text-only — half a page tells the
    // judge nothing about whether words and picture agree.
    const prepared = [];
    const missing = [];
    await Promise.all(scenes.map(async (scene) => {
      let part = null;
      try {
        const img = await loadShippedImage(scene, { pool, imageLoader, storyId, activeVersions });
        part = img ? inlinePart(img) : null;
      } catch (err) {
        log.warn(`⚠️ [BOOK-AUDIT] p${scene.pageNumber} image load failed (${err.message})`);
      }
      if (!part) { missing.push(scene.pageNumber); return; }
      prepared.push({ pageNumber: scene.pageNumber, text: String(scene.text || '').trim(), part });
    }));
    prepared.sort((a, b) => a.pageNumber - b.pageNumber);
    if (prepared.length === 0) throw new Error('no page images could be resolved');
    if (missing.length) {
      log.warn(`⚠️ [BOOK-AUDIT] ${missing.length} page(s) skipped — no shipped image: ${missing.sort((a, b) => a - b).join(', ')}`);
    }

    const chunks = [];
    for (let i = 0; i < prepared.length; i += CHUNK_PAGES) chunks.push(prepared.slice(i, i + CHUNK_PAGES));

    const usage = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 };
    // Per-chunk usage, kept so a Lab run can PROVE a thinking level took effect
    // rather than assuming it. Report-only; nothing reads it in production.
    const chunkUsage = [];
    const raws = [];
    for (const chunk of chunks) {
      try {
        const r = await judgeChunk(template, chunk, modelId, thinkingLevel);
        raws.push(r.text);
        chunkUsage.push({
          pages: `${chunk[0].pageNumber}-${chunk[chunk.length - 1].pageNumber}`,
          ...r.usage,
        });
        usage.input_tokens += r.usage.input_tokens;
        usage.output_tokens += r.usage.output_tokens;
        usage.thinking_tokens += r.usage.thinking_tokens;
        // OpenRouter reports the billed dollars per call; Gemini native does not.
        if (typeof r.usage.cost_usd === 'number') usage.cost_usd = (usage.cost_usd || 0) + r.usage.cost_usd;
      } catch (err) {
        // One bad chunk must not cost the other chunks' findings.
        log.warn(`⚠️ [BOOK-AUDIT] chunk p${chunk[0].pageNumber}-${chunk[chunk.length - 1].pageNumber} failed: ${err.message}`);
      }
    }
    if (raws.length === 0) throw new Error('every chunk failed');

    // Cross-page object scale. Reported only — see auditObjectScale. Its
    // absences use the shared notEvaluated vocabulary so an analyst reading
    // stored data sees "could not check" the same way everywhere.
    const notEvaluated = require('./notEvaluated').createNotEvaluatedRecorder({ pageContext: 'book' });
    let objectScale = null;
    const { scale: scaleTemplate } = splitBookAuditTemplate(template);
    if (objectScaleEnabled && scaleTemplate) {
      try {
        const r = await auditObjectScale(scaleTemplate, prepared, storyData, {
          modelId, thinkingLevel, usage, notEvaluated,
        });
        objectScale = { ...r, notEvaluated: notEvaluated.list() };
        for (const f of r.findings) log.info(`📐 [BOOK-AUDIT] ${f}`);
      } catch (err) {
        log.warn(`⚠️ [BOOK-AUDIT] object-scale pass skipped: ${err.message}`);
        notEvaluated.record('object_scale', 'scale_pass_failed', err.message);
        objectScale = { objects: [], findings: [], notEvaluated: notEvaluated.list() };
      }
    }

    const raw = raws.join('\n');
    if (usageTracker && (usage.input_tokens || usage.output_tokens)) {
      usageTracker('gemini_quality', usage, 'book_audit', modelId);
    }

    const byRoute = parseRoutes(raw);
    const faults = byRoute.IMG.length + byRoute.TEXT.length;
    log.info(`📖 [BOOK-AUDIT] ${prepared.length} page(s) in ${chunks.length} call(s): ${faults} fault(s) — ${byRoute.IMG.length} IMG, ${byRoute.TEXT.length} TEXT`);
    return {
      faults,
      byRoute,
      raw,
      usage,
      chunkUsage,
      modelId,
      thinkingLevel,
      objectScale,
      pagesRead: prepared.map(p => p.pageNumber),
      pagesSkipped: missing.sort((a, b) => a - b),
    };
  } catch (err) {
    log.warn(`⚠️ [BOOK-AUDIT] skipped: ${err.message}`);
    return null;
  }
}

module.exports = {
  auditStoryBook,
  buildAuditPages,
  shippedVersionIndex,
  parseRoutes,
  splitBookAuditTemplate,
  SCALE_SECTION_MARKER,
  CHUNK_PAGES,
};
