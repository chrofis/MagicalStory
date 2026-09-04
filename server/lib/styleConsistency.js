/**
 * Cross-page style consistency check.
 *
 * Builds a thumbnail grid of all page images (+ the front cover) and asks
 * Gemini to cluster them by visual style. Returns the dominant cluster, an
 * anchor page, and a list of outliers with severity + reasons.
 *
 * The whole point of style consistency is RELATIVE — "is this image
 * consistent with the rest?" not "does this match an abstract style
 * description?". A single multi-image vision call gives the model the
 * context it needs to spot odd-ones-out by comparison.
 *
 * RELATIVE IS NOT ENOUGH ON ITS OWN (2026-08-06). When the MAJORITY of a book
 * collapses away from the requested art style, "consistent with the rest"
 * canonises the collapse: a cyberpunk book rendered mostly photoreal had its
 * two correctly-stylised comic pages flagged as the outliers, and style-repair
 * repainted one of them toward the photorealism. So the relative clustering
 * stays exactly as it was, and an ABSOLUTE check rides alongside it:
 * `styleMatch.verdict` says whether the dominant cluster is actually the
 * requested style. Only `wrong_medium` — a wholesale medium change, e.g.
 * photographic when an illustration style was ordered — means the anchor is
 * untrustworthy and callers must not repair outliers toward it. Fidelity
 * nitpicks are NOT a blocker; see the note on the parsed verdict below.
 *
 * Usage: const result = await checkStoryStyleConsistency(storyData)
 */

const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { log } = require('../utils/logger');
const { stripDataUriPrefix } = require('./r2');
const { resolveArtStyle } = require('./storyHelpers');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const THUMB_SIZE = 448;        // px per cell — big enough for the model to judge medium (photographic vs painted) after it downscales the composite
const COLS = 3;                // grid columns

// ─────────────────────────────────────────────────────────────────────
// VISUAL FLOW — time-of-day and facing, measured on the same grid pass.
//
// A book may span days. "Page 3 is morning and page 13 is evening" is not a
// defect, it is a story, so a rendered time can only ever be wrong against the
// time the page's own brief DECLARED. Everything below therefore compares
// rendered-vs-declared and nothing else; a page whose brief declares no time
// can never produce a mismatch.
//
// The extraction is deliberately dumb and readable: a keyword hit in the brief
// picks a bucket, and the sentence carrying it is handed to the judge verbatim
// as the declaration. Nothing infers a time from the plot, from neighbouring
// pages, or from an assumed single day.
//
// WARN-ONLY, measure-first. Nothing here triggers a repair, changes a score, or
// gates anything — the point of this pass is to find out how often the renders
// contradict their briefs before anyone decides what to do about it.
// ─────────────────────────────────────────────────────────────────────

const TIME_BUCKETS = 'morning|midday|afternoon|evening|night|indoor-unclear';

// Keywords are SPECIFIC on purpose. Bare "light" and bare "dark" are banned:
// every brief opens with hair and clothing descriptions ("light blonde",
// "dark red"), and keying on them classifies a character's hair as the hour.
const TIME_KEYWORDS = [
  ['morning', /\b(morning|early morning|sunrise|dawn|daybreak|morgens?|frühmorgens|morgendlich|sonnenaufgang)\b/i],
  ['midday', /\b(midday|noon|middaylight|high sun|overhead sun|mittag(s|szeit)?)\b/i],
  ['afternoon', /\b(afternoon|nachmittags?)\b/i],
  ['evening', /\b(evening|dusk|sunset|twilight|golden hour|golden light|late day|shadows lengthen|lengthening shadows|long shadows|abends?|abendlich|dämmerung|sonnenuntergang|lange schatten)\b/i],
  ['night', /\b(night|nighttime|midnight|moonlight|moonlit|starlight|starlit|dark sky|nachts?|mitternacht|mondlicht|sternenlicht)\b/i],
];

/**
 * The time-of-day a page's brief DECLARED, plus the sentence that declared it.
 * Returns { token: null, text: <first 200 chars> } when no keyword hits — the
 * judge still sees the opening of the brief, but code can never call it a
 * mismatch.
 */
function extractDeclaredLight(sceneDescription) {
  const brief = String(sceneDescription || '').split(/---\s*METADATA/i)[0].trim();
  if (!brief) return { token: null, text: '' };

  // EARLIEST hit wins, so a brief that sets its hour in the first lighting
  // sentence is not overruled by a stray word further down.
  let best = null;
  for (const [token, re] of TIME_KEYWORDS) {
    const m = brief.match(re);
    if (m && (best === null || m.index < best.index)) best = { token, index: m.index };
  }
  if (!best) return { token: null, text: brief.slice(0, 200) };

  // The sentence carrying the keyword, verbatim — that is the declaration the
  // judge is asked to check the pixels against.
  const sentences = brief.split(/(?<=[.!?])\s+/);
  let cursor = 0;
  let sentence = '';
  for (const s of sentences) {
    const end = cursor + s.length;
    if (best.index >= cursor && best.index <= end) { sentence = s; break; }
    cursor = end + 1;
  }
  return { token: best.token, text: (sentence || brief).trim().slice(0, 200) };
}

/**
 * Build a labelled thumbnail-grid JPEG from a list of page images.
 * Each cell = label strip + 256x256 thumbnail. Layout = COLS columns.
 *
 * @param {Array<{label: string, imageData: string}>} cells
 * @returns {Promise<Buffer>} JPEG buffer
 */
async function buildStyleGrid(cells) {
  if (!cells || cells.length === 0) {
    throw new Error('buildStyleGrid: cells array empty');
  }

  const cols = Math.min(COLS, cells.length);
  const rows = Math.ceil(cells.length / cols);
  const gridW = cols * THUMB_SIZE;
  const gridH = rows * THUMB_SIZE;

  // Cells packed EDGE-TO-EDGE at full THUMB_SIZE — no gaps, no label strip.
  // Those wasted pixels and shrank each cell; the vision model downscales the
  // whole composite, so every pixel of a cell counts for judging watercolour-
  // vs-photographic. Each cell instead carries a small RED code in its top-left
  // corner (the page token the model returns): -1/-2/-3 for the covers, the
  // page number otherwise. A stray failed cell leaves a blank slot (positions
  // are by index) rather than shifting the whole grid.
  const composites = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const base64 = stripDataUriPrefix(cell.imageData || '');
    if (!base64) continue;
    let thumb;
    try {
      thumb = await sharp(Buffer.from(base64, 'base64'))
        .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'cover' })
        .toBuffer();
    } catch (err) {
      log.warn(`[STYLE-CHECK] Failed to resize ${cell.label}: ${err.message}`);
      continue;
    }
    const code = cell.page != null ? String(cell.page) : String(cell.label || '');
    const safe = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const codeSvg = Buffer.from(
      `<svg width="${THUMB_SIZE}" height="${THUMB_SIZE}"><text x="10" y="40" font-family="Arial,sans-serif" font-size="34" font-weight="bold" fill="#ff2020" stroke="#000" stroke-width="1.5" paint-order="stroke">${safe}</text></svg>`
    );
    const labelled = await sharp(thumb).composite([{ input: codeSvg, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
    composites.push({ input: labelled, left: (i % cols) * THUMB_SIZE, top: Math.floor(i / cols) * THUMB_SIZE });
  }

  return sharp({
    create: { width: gridW, height: gridH, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toBuffer();
}

/**
 * Run the style-consistency check. Loads all page images + front cover,
 * builds a labelled grid, sends to Gemini for clustering, returns JSON.
 *
 * @param {Object} storyData - story data blob (must include sceneImages + coverImages)
 * @param {Object} [opts]
 * @param {string} [opts.modelId='gemini-2.5-flash']
 * @param {Function} [opts.usageTracker] - (provider, usage, fn, modelId) => void
 * @returns {Promise<{
 *   verdict: 'consistent'|'mixed'|'fragmented',
 *   dominantCluster: number[],
 *   anchorPage: number,
 *   outliers: Array<{page: number, severity: 'major'|'moderate'|'minor', differences: string[]}>,
 *   reasoning: string,
 *   gridImage: string,  // base64 data URL of the grid sent to Gemini (for UI display)
 *   styleMatch: {requestedStyle: string, verdict: 'matches'|'drifted'|'wrong_medium', differences: string[]}|null
 * }>}
 */
async function checkStoryStyleConsistency(storyData, opts = {}) {
  const { modelId = 'gemini-2.5-flash', usageTracker = null } = opts;

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY missing');
  }

  // Collect all renderable images: covers (negative page convention:
  // frontCover -1, initialPage -2, backCover -3 — same numbers the repair
  // pipeline uses) + every page. Covers are treated the same as normal
  // pages (owner directive 2026-07-31): a style outlier on any of the three
  // covers must be detected exactly like a page outlier.
  const cells = [];
  const COVER_CELLS = [
    ['frontCover', -1, 'Front cover'],
    ['initialPage', -2, 'Initial page'],
    ['backCover', -3, 'Back cover'],
  ];
  for (const [coverKey, page, label] of COVER_CELLS) {
    const img = storyData.coverImages?.[coverKey]?.imageData;
    if (img) cells.push({ label, imageData: img, page });
  }
  const coverCount = cells.length;
  const pages = (storyData.sceneImages || [])
    .filter(s => s.imageData)
    .sort((a, b) => a.pageNumber - b.pageNumber);
  for (const s of pages) {
    cells.push({
      label: `Page ${s.pageNumber}`,
      imageData: s.imageData,
      page: s.pageNumber,
      // Covers declare nothing (they have no brief), so they stay undefined and
      // can never contribute a time mismatch.
      declared: extractDeclaredLight(s.sceneDescription),
    });
  }

  if (cells.length < 2) {
    throw new Error(`style-check needs ≥2 images, got ${cells.length}`);
  }

  // Absolute anchor: what the book was actually commissioned as. Resolved from
  // the story blob so no caller has to thread it through. Null (unknown style
  // id) simply drops the absolute check and leaves the relative audit intact.
  const requestedStyle = resolveArtStyle(storyData.artStyle) || null;
  if (!requestedStyle && storyData.artStyle) {
    log.warn(`🎨 [STYLE-CHECK] art style "${storyData.artStyle}" did not resolve — running relative check only`);
  }

  // Batch into grids of <=9 cells so each thumbnail stays large (less downscale
  // by the model → faces big enough to judge medium). Safe because the judgment
  // is ABSOLUTE per-page — there is no cross-page clustering to lose across
  // batches. ceil(17/9) = 2 cheap Flash calls for a typical book.
  const CHUNK = 9;
  const batches = [];
  for (let i = 0; i < cells.length; i += CHUNK) batches.push(cells.slice(i, i + CHUNK));
  log.info(`🎨 [STYLE-CHECK] ${cells.length} images (${cells.length - coverCount} pages + ${coverCount} cover(s)) → ${batches.length} grid(s) of ≤${CHUNK}`);

  // Prompt: cluster by style, return strict JSON.
  // pageNumber values: -1 front cover, -2 initial page, -3 back cover,
  // 1+ for pages. The model returns the same numbers so we can act on them.
  // PER-CELL VERDICT, CODE-SIDE AGGREGATION (2026-08-17). "Judge each page
  // independently" was already in this prompt and the model still answered for
  // the whole grid at once — one batch declared "every character across all
  // pages is rendered photographically" while a plainly painted page sat in
  // that same grid, inflating the outlier list and charging real page scores
  // for it. A free-form outlier list lets the model summarise; an entry PER
  // CODE does not. The codes in this batch are injected below, the model must
  // return exactly those, and dominantCluster/outliers are derived here from
  // its per-cell answers instead of from its own aggregation.
  const buildPrompt = (batch) => {
    const codes = batch.map(c => c.page);
    // Declarations are handed over verbatim, per cell. The judge is never told
    // what the book's "overall" time is, and never asked to compare cells to
    // each other — a story may legitimately span several days.
    const declaredBlock = batch
      .filter(c => c.declared?.text)
      .map(c => `${c.page}: ${c.declared.text}`)
      .join('\n');
    return `You are a visual-style auditor for a children's storybook.

The image is a grid of pages from one storybook. Each cell has a small RED code in its top-left corner identifying it: -1 = front cover, -2 = initial page, -3 = back cover, and the page number (1, 2, 3, …) for every other page. Return these exact code numbers.

This grid contains exactly ${batch.length} cell(s), with these codes: ${codes.join(', ')}.
${requestedStyle ? `
The book was commissioned in this art style:
"""
${requestedStyle}
"""
` : ''}

Judge EACH cell INDEPENDENTLY against the COMMISSIONED art style above, looking only at that cell's own pixels. Do NOT cluster the cells or compare them to each other — a majority rendered in the wrong style is still wrong, so "consistent with the other pages" is NOT the test. The test is: is THIS cell rendered in the commissioned MEDIUM? Never carry a verdict from one cell to another, and never write a statement about "all pages" or "every character" — each cell gets its own answer, and cells in one grid regularly differ.

Be TOLERANT. Flag a page ONLY when it is CLEARLY and unmistakably in the WRONG art medium — it looks like a real photograph (or a photo with a light filter over it): camera-real skin with visible pores, real fabric and lighting, photographic eyes — when a painted or illustrated style was commissioned. The mismatch must be obvious at a glance.

Do NOT flag anything short of that. A page whose people are merely a bit smooth, refined, or realistic-leaning is still the RIGHT medium — leave it. Slightly-too-clean faces, less brushstroke texture than ideal, or one face a touch sharper than the rest are NOT outliers. When in doubt, do NOT flag. Only a clear, obvious, whole-image wrong-medium failure counts — never a degree-of-looseness difference.

For each flagged page, name 2-4 SPECIFIC differences. Severity:
- "major"    — photographic/photoreal rendering of the people, or a wholly different medium than commissioned
- "moderate" — the commissioned medium, but a defining property named in the style is clearly absent
- "minor"    — subtle inconsistency (slight colour cast, small edge-style variation)

Separately, report two OBSERVATIONS per cell. These are descriptions, not judgments — never let them change a style verdict.
- "renderedTime": the time of day the cell's own light shows, one of: ${TIME_BUCKETS}. Use "indoor-unclear" when the light gives no time.
- "facing": which way the dominant figure faces — "frame-left", "frame-right", or "camera". Use "none" when no figure dominates.
${declaredBlock ? `
Each line below is the sentence a page's own brief used to set its light. Report only what the pixels show; do not let the sentence decide your answer, and do not assume the pages share one day.
"""
${declaredBlock}
"""
` : ''}
${requestedStyle ? `Separately from the per-cell verdicts, classify this grid's RENDERING MEDIUM against the commissioned art style above. Base it on the cells you judged as departing: only call it wrong for the whole grid when MOST cells departed.
- "matches" — the same medium as commissioned. Use this even when the execution is imperfect: weaker brushwork, smoother shading, less texture, a missing named-artist mannerism, or any other fidelity shortfall is still "matches".
- "drifted" — recognisably the commissioned medium, but a defining property named in the style is largely absent.
- "wrong_medium" — a different medium altogether. The clearest case: photographic rendering (camera-real skin, fabric and light) when the commissioned style is an illustration style or says it is not photorealistic.
Judge only how it is DRAWN, never whether a scene suits its subject. A majority is not evidence of correctness.

` : ''}Return ONLY this JSON, no prose. \`cells\` carries ONE entry per code listed above, in that order — never fewer, never merged, never a shared verdict:
{
  "cells": [
    { "page": <code>, "matchesStyle": true|false, "severity": "major"|"moderate"|"minor", "differences": ["<2-4 specifics; omit when matchesStyle is true>"], "renderedTime": "${TIME_BUCKETS}", "facing": "frame-left"|"frame-right"|"camera"|"none" }
  ],${requestedStyle ? `
  "dominantStyleVerdict": "matches" | "drifted" | "wrong_medium",
  "requestedStyleDifferences": ["<how the departing cells depart; empty when they match>"],` : ''}
  "reasoning": "<2-3 sentences naming which of THESE cells depart and how; never a claim about pages you cannot see in this grid>"
}

Use the red corner code as the "page" value: -1 front cover, -2 initial page, -3 back cover, the page number otherwise.`;
  };

  const evalTemperature = process.env.EVAL_TEMPERATURE != null ? Number(process.env.EVAL_TEMPERATURE) : 0;
  const model = genAI.getGenerativeModel({ model: modelId, generationConfig: { temperature: evalTemperature } });

  const judgeBatch = async (batch) => {
    const gridBuffer = await buildStyleGrid(batch);
    const result = await model.generateContent([
      { inlineData: { mimeType: 'image/jpeg', data: gridBuffer.toString('base64') } },
      buildPrompt(batch),
    ]);
    const usage = result.response.usageMetadata || {};
    if (usageTracker && (usage.promptTokenCount || usage.candidatesTokenCount)) {
      // 'gemini_quality', not bare 'gemini': the provider rollup only has
      // gemini_text/gemini_image/gemini_quality buckets — a bare 'gemini' tag
      // kept these eval calls out of every provider aggregate.
      usageTracker('gemini_quality', {
        input_tokens: usage.promptTokenCount || 0,
        output_tokens: usage.candidatesTokenCount || 0,
        thinking_tokens: usage.thoughtsTokenCount || 0,
      }, 'style_check', modelId);
    }
    const raw = result.response.text() || '';
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error(`style-check returned no JSON. Raw: ${raw.slice(0, 200)}`);
    let parsed;
    try {
      parsed = JSON.parse(raw.slice(s, e + 1));
    } catch (err) {
      throw new Error(`style-check JSON parse failed: ${err.message}. Raw: ${raw.slice(s, s + 300)}`);
    }
    // Outliers are DERIVED from the per-cell verdicts — the model states a
    // verdict per code, the aggregation happens here. A cell it forgot to
    // answer counts as matching (never invent an outlier), and a code it
    // invented is dropped (it can only judge what is in this grid).
    const inBatch = new Set(batch.map(c => c.page));
    // Fail-safe: a model that answers in the OLD shape (a bare `outliers` list)
    // must not read as "every cell matched" — map it onto the per-cell shape.
    const cellVerdicts = Array.isArray(parsed.cells) && parsed.cells.length > 0
      ? parsed.cells
      : (Array.isArray(parsed.outliers) ? parsed.outliers.map(o => ({ ...o, matchesStyle: false })) : []);
    const answered = new Set();
    const outliers = [];
    const observations = [];
    const TIME_SET = new Set(TIME_BUCKETS.split('|'));
    const FACING_SET = new Set(['frame-left', 'frame-right', 'camera', 'none']);
    const declaredByPage = new Map(batch.map(c => [c.page, c.declared || null]));
    for (const c of cellVerdicts) {
      if (typeof c?.page !== 'number' || !inBatch.has(c.page) || answered.has(c.page)) continue;
      answered.add(c.page);
      // Observations, not judgments — recorded for every cell, outlier or not.
      // An unrecognised value is dropped rather than coerced: a made-up bucket
      // must not become a mismatch against a real declaration.
      const rendered = TIME_SET.has(c.renderedTime) ? c.renderedTime : null;
      const declared = declaredByPage.get(c.page) || null;
      observations.push({
        page: c.page,
        declared: declared?.token || null,
        declaredText: declared?.text || '',
        rendered,
        // A mismatch needs BOTH a declaration and a readable rendered hour.
        // "indoor-unclear" is not a contradiction of anything — an interior can
        // legitimately look like any hour.
        mismatch: !!(declared?.token && rendered && rendered !== 'indoor-unclear' && rendered !== declared.token),
        facing: FACING_SET.has(c.facing) ? c.facing : null,
      });
      if (c.matchesStyle === false) {
        outliers.push({
          page: c.page,
          severity: ['major', 'moderate', 'minor'].includes(c.severity) ? c.severity : 'moderate',
          differences: Array.isArray(c.differences) ? c.differences : [],
        });
      }
    }
    if (answered.size !== batch.length) {
      log.warn(`🎨 [STYLE-CHECK] batch answered ${answered.size}/${batch.length} cells — unanswered cells counted as on-style`);
    }
    return {
      outliers,
      observations,
      dominantStyleVerdict: ['matches', 'drifted', 'wrong_medium'].includes(parsed.dominantStyleVerdict) ? parsed.dominantStyleVerdict : 'matches',
      requestedStyleDifferences: Array.isArray(parsed.requestedStyleDifferences) ? parsed.requestedStyleDifferences : [],
      reasoning: parsed.reasoning || '',
      gridBuffer,
    };
  };

  // One failed batch (parse/API) shouldn't sink the whole check.
  const settled = await Promise.allSettled(batches.map(judgeBatch));
  const results = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (results.length === 0) throw new Error(settled[0]?.reason?.message || 'all style-check batches failed');

  // Merge per-page outliers (each page is in exactly one batch); keep the
  // highest severity and union the reasons.
  const SEV = { major: 3, moderate: 2, minor: 1 };
  const seen = new Map();
  for (const r of results) {
    for (const o of r.outliers) {
      if (typeof o?.page !== 'number') continue;
      const cand = { page: o.page, severity: SEV[o.severity] ? o.severity : 'moderate', differences: Array.isArray(o.differences) ? o.differences : [] };
      const prev = seen.get(o.page);
      if (!prev || (SEV[cand.severity] || 0) > (SEV[prev.severity] || 0)) seen.set(o.page, cand);
    }
  }
  const outliers = [...seen.values()];
  const outlierPages = new Set(outliers.map(o => o.page));

  // VISUAL FLOW — one row per cell, in page order. Covers (-1/-2/-3) ride along
  // with declared:null so they are never mismatches; `facing` is recorded and
  // never judged (no rule says which way a figure should face).
  const timeFlow = results
    .flatMap(r => r.observations || [])
    .sort((a, b) => a.page - b.page);
  const dominantCluster = cells.map(c => c.page).filter(p => !outlierPages.has(p));
  const anchorPage = dominantCluster.find(p => p >= 1) ?? dominantCluster[0] ?? (cells[0]?.page ?? null);

  const ratio = cells.length ? outliers.length / cells.length : 0;
  const allMinor = outliers.every(o => o.severity === 'minor');
  const verdict = (ratio <= 0.1 && allMinor) ? 'consistent' : (ratio > 0.4 ? 'fragmented' : 'mixed');

  // Book-level medium check = WORST per-batch verdict (a strict batch flagging a
  // wholesale medium change propagates; a lenient batch can't hide it). Only
  // wrong_medium blocks — the repair pipeline reads it to SKIP per-page repair
  // (a whole-book miss is a generation problem, not a per-page fix).
  const RANK = { matches: 0, drifted: 1, wrong_medium: 2 };
  let medium = 'matches';
  let mediumDiffs = [];
  for (const r of results) {
    if ((RANK[r.dominantStyleVerdict] || 0) > (RANK[medium] || 0)) { medium = r.dominantStyleVerdict; mediumDiffs = r.requestedStyleDifferences; }
  }
  // A batch's wholesale verdict only condemns the BOOK when the book's own
  // per-cell verdicts agree. `wrong_medium` makes the repair pipeline skip
  // per-page repair (a whole-book miss is a generation problem), so a single
  // sweeping batch must not trigger that while most pages are on-style —
  // exactly what happened when one grid declared "every character across all
  // pages is photographic" with painted pages sitting in it.
  if (medium === 'wrong_medium' && ratio < 0.5) {
    log.info(`🎨 [STYLE-CHECK] a batch called the medium wrong, but only ${outliers.length}/${cells.length} cells departed — recording 'drifted' and keeping per-page repair enabled`);
    medium = 'drifted';
  }

  const out = {
    verdict,
    dominantCluster,
    anchorPage,
    outliers,
    // ALL batches' reasonings, not just the first — with 2 grids the second
    // batch (pages 7+) was analyzed but its assessment never shown anywhere.
    reasoning: results.map(r => r.reasoning).filter(Boolean).join('\n'),
    gridImage: `data:image/jpeg;base64,${results[0].gridBuffer.toString('base64')}`,
    // EVERY batch's grid, not just the first: a 10-page book + 3 covers spans
    // two grids (covers + p1-6, then p7-10) — showing only results[0] made the
    // UI look like pages 7+ were never checked.
    gridImages: results.map(r => `data:image/jpeg;base64,${r.gridBuffer.toString('base64')}`),
    timeFlow,
    styleMatch: requestedStyle
      ? { requestedStyle, verdict: medium, differences: medium === 'matches' ? [] : mediumDiffs.slice(0, 4) }
      : null,
  };

  log.info(`🎨 [STYLE-CHECK] verdict=${out.verdict}, ${dominantCluster.length}/${cells.length} on-style, outliers=${outliers.length} (${batches.length} batch(es))`);
  if (out.styleMatch && out.styleMatch.verdict !== 'matches') {
    const how = out.styleMatch.verdict === 'wrong_medium' ? 'is a DIFFERENT MEDIUM from' : 'has drifted from';
    log.warn(`🎨 [STYLE-CHECK] the book ${how} the commissioned art style "${storyData.artStyle}": ${out.styleMatch.differences.slice(0, 3).join('; ')}`);
  }
  for (const o of out.outliers) {
    log.info(`🎨 [STYLE-CHECK] outlier Page ${o.page} [${o.severity}]: ${(o.differences || []).slice(0, 2).join('; ')}`);
  }

  // MEASURE-FIRST: a time mismatch is reported and nothing else. It does not
  // enter the outlier list, does not touch a score, and does not trigger a
  // repair — the pass exists to find out how often briefs and renders disagree.
  const timeMismatches = timeFlow.filter(t => t.mismatch);
  const declaredCount = timeFlow.filter(t => t.declared).length;
  log.info(`🕑 [VISUAL-FLOW] ${declaredCount}/${timeFlow.length} cell(s) declared a time; ${timeMismatches.length} rendered against it`);
  for (const t of timeMismatches) {
    log.warn(`🕑 [VISUAL-FLOW] time-of-day mismatch on p${t.page}: declared ${t.declared}, rendered ${t.rendered}`);
  }

  return out;
}

module.exports = {
  checkStoryStyleConsistency,
  buildStyleGrid,
  extractDeclaredLight,
};
