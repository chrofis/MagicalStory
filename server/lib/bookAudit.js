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

/** Split a data URI (or bare base64) into the shape a Gemini inline_data part wants. */
function inlinePart(imageData) {
  const mime = String(imageData).match(/^data:(image\/[\w+.-]+);base64,/)?.[1] || 'image/jpeg';
  const data = r2Lib.stripDataUriPrefix(imageData);
  if (!data) return null;
  return { inline_data: { mime_type: mime, data } };
}

/** One vision call over one chunk of pages. Returns raw text + usage. */
async function judgeChunk(template, chunk, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');

  const { fillTemplate } = require('../services/prompts');
  const instructions = fillTemplate(template, {
    PAGE_LIST: chunk.map(p => p.pageNumber).join(', '),
  });

  // Instructions FIRST, then the book. The judge must know what it is looking
  // for before it starts looking, and the trailing part is the last thing it
  // read either way.
  const parts = [{ text: instructions }];
  for (const p of chunk) {
    parts.push({ text: `PAGE ${p.pageNumber} TEXT: ${p.text || '(no text on this page)'}` });
    parts.push(p.part);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        // Headroom for the judge's own reasoning. Measured: a 6-page chunk
        // spends ~9k tokens thinking before writing, and a 4000 cap truncated
        // two chunks of three mid-sentence — a truncated audit reads as a clean
        // one, which is the worst failure a measurement can have.
        maxOutputTokens: 16000,
        // Eval judges run at temperature 0, always (docs/SETTLED.md).
        temperature: 0,
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
    log.warn(`⚠️ [BOOK-AUDIT] chunk p${chunk[0].pageNumber}-${chunk[chunk.length - 1].pageNumber} finished as ${finish} — faults may be missing`);
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
    const raws = [];
    for (const chunk of chunks) {
      try {
        const r = await judgeChunk(template, chunk, modelId);
        raws.push(r.text);
        usage.input_tokens += r.usage.input_tokens;
        usage.output_tokens += r.usage.output_tokens;
        usage.thinking_tokens += r.usage.thinking_tokens;
      } catch (err) {
        // One bad chunk must not cost the other chunks' findings.
        log.warn(`⚠️ [BOOK-AUDIT] chunk p${chunk[0].pageNumber}-${chunk[chunk.length - 1].pageNumber} failed: ${err.message}`);
      }
    }
    if (raws.length === 0) throw new Error('every chunk failed');

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
      modelId,
      pagesRead: prepared.map(p => p.pageNumber),
      pagesSkipped: missing.sort((a, b) => a - b),
    };
  } catch (err) {
    log.warn(`⚠️ [BOOK-AUDIT] skipped: ${err.message}`);
    return null;
  }
}

module.exports = { auditStoryBook, shippedVersionIndex, parseRoutes, CHUNK_PAGES };
