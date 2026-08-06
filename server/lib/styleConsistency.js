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

const THUMB_SIZE = 256;        // px per cell
const COLS = 3;                // grid columns
const LABEL_HEIGHT = 24;       // px above each thumbnail for the page label
const CELL_PADDING = 8;        // px of padding around each cell

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

  const cellW = THUMB_SIZE + CELL_PADDING * 2;
  const cellH = THUMB_SIZE + LABEL_HEIGHT + CELL_PADDING * 2;
  const cols = Math.min(COLS, cells.length);
  const rows = Math.ceil(cells.length / cols);
  const gridW = cols * cellW;
  const gridH = rows * cellH;

  // Resize all thumbnails in parallel
  const resized = await Promise.all(cells.map(async (cell) => {
    const base64 = stripDataUriPrefix(cell.imageData || '');
    if (!base64) return null;
    const buf = Buffer.from(base64, 'base64');
    try {
      const thumb = await sharp(buf)
        .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: 'cover' })
        .jpeg({ quality: 82 })
        .toBuffer();
      return { label: cell.label, buffer: thumb };
    } catch (err) {
      log.warn(`[STYLE-CHECK] Failed to resize ${cell.label}: ${err.message}`);
      return null;
    }
  }));

  const composites = [];
  resized.forEach((r, i) => {
    if (!r) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cellLeft = col * cellW;
    const cellTop = row * cellH;

    // Label strip — dark background, white text, escapes XML special chars.
    const labelText = r.label.length > 28 ? r.label.slice(0, 25) + '…' : r.label;
    const safe = labelText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const labelSvg = `<svg width="${THUMB_SIZE + CELL_PADDING * 2}" height="${LABEL_HEIGHT}">
      <rect width="${THUMB_SIZE + CELL_PADDING * 2}" height="${LABEL_HEIGHT}" fill="#222"/>
      <text x="${(THUMB_SIZE + CELL_PADDING * 2) / 2}" y="17" font-family="Arial,sans-serif" font-size="14" fill="white" text-anchor="middle">${safe}</text>
    </svg>`;
    composites.push({ input: Buffer.from(labelSvg), left: cellLeft, top: cellTop });
    composites.push({ input: r.buffer, left: cellLeft + CELL_PADDING, top: cellTop + LABEL_HEIGHT + CELL_PADDING });
  });

  return sharp({
    create: { width: gridW, height: gridH, channels: 3, background: { r: 245, g: 245, b: 245 } },
  })
    .composite(composites)
    .jpeg({ quality: 85 })
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
    cells.push({ label: `Page ${s.pageNumber}`, imageData: s.imageData, page: s.pageNumber });
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

  log.info(`🎨 [STYLE-CHECK] Building grid for ${cells.length} images (${cells.length - coverCount} pages + ${coverCount} cover(s))`);
  const gridBuffer = await buildStyleGrid(cells);
  log.info(`🎨 [STYLE-CHECK] Grid built: ${(gridBuffer.length / 1024).toFixed(0)}KB, sending to ${modelId}...`);

  // Prompt: cluster by style, return strict JSON.
  // pageNumber values: -1 front cover, -2 initial page, -3 back cover,
  // 1+ for pages. The model returns the same numbers so we can act on them.
  const prompt = `You are a visual-style auditor for a children's storybook.

The image you see is a labelled grid of every illustrated page from one storybook (and its front cover, if shown). Each cell has a label like "Page 3" or "Front cover".
${requestedStyle ? `
The book was commissioned in this art style:
"""
${requestedStyle}
"""
` : ''}

Cluster the cells by VISUAL STYLE. Look at:
- Color palette (warm/cool, saturated/muted, dominant hues)
- Brushwork or line quality (soft watercolor edges vs crisp inked lines vs cel-shaded blocks)
- Character rendering (face geometry, eye style, skin shading)
- Lighting tone (flat illustration vs dimensional shading vs cinematic)
- Texture (paper grain, brush stroke visibility, smoothness)

Identify ONE dominant cluster (the majority of cells that share a style). Pick ONE anchor page from that cluster — the cleanest representative of the dominant style. Then list every cell that does NOT belong to the dominant cluster as an outlier.

For each outlier, name 2-4 SPECIFIC differences (not just "different style"). Severity:
- "major"    — clearly a different art style (different rendering technique, very different palette, different character look)
- "moderate" — same family but visibly off (palette shift, line weight different, lighting tone different)
- "minor"    — subtle inconsistency (slight color cast, small edge-style variation)

${requestedStyle ? `Separately from the clustering, classify the dominant cluster's RENDERING MEDIUM against the commissioned art style above:
- "matches" — the same medium as commissioned. Use this even when the execution is imperfect: weaker brushwork, smoother shading, less texture, a missing named-artist mannerism, or any other fidelity shortfall is still "matches".
- "drifted" — recognisably the commissioned medium, but a defining property named in the style is largely absent.
- "wrong_medium" — a different medium altogether. The clearest case: photographic rendering (camera-real skin, fabric and light) when the commissioned style is an illustration style or says it is not photorealistic.
Judge only how it is DRAWN, never whether a scene suits its subject. A majority is not evidence of correctness.

` : ''}Return ONLY this JSON, no prose:
{
  "verdict": "consistent" | "mixed" | "fragmented",
  "dominantCluster": [<page numbers in cluster>],
  "anchorPage": <page number>,
  "outliers": [
    { "page": <number>, "severity": "major"|"moderate"|"minor", "differences": ["...", "..."] }
  ],${requestedStyle ? `
  "dominantStyleVerdict": "matches" | "drifted" | "wrong_medium",
  "requestedStyleDifferences": ["<how the dominant cluster departs from the commissioned medium; empty when it matches>"],` : ''}
  "reasoning": "<2-3 sentences explaining what unifies the dominant cluster and how the outliers diverge>"
}

Use -1 for "Front cover", -2 for "Initial page", -3 for "Back cover" if they appear. Use the page numbers from the labels for everything else.

Verdict rule:
- "consistent" if ≥90% of cells are in the dominant cluster and outliers are all "minor"
- "mixed" if 60-90% in dominant cluster, or any "moderate"+ outliers
- "fragmented" if <60% in any single cluster`;

  // Clustering is a judgment task, and this call was the only one still on
  // Gemini's default temperature — two identical runs over the same 14 pages
  // returned dominant clusters of 7 and 13 pages (7 outliers vs 1), which makes
  // both the outlier list and the style verdict unreproducible and any repair
  // decision built on them a coin flip. Same knob the image evaluator uses.
  const evalTemperature = process.env.EVAL_TEMPERATURE != null ? Number(process.env.EVAL_TEMPERATURE) : 0;
  const model = genAI.getGenerativeModel({
    model: modelId,
    generationConfig: { temperature: evalTemperature },
  });
  const result = await model.generateContent([
    { inlineData: { mimeType: 'image/jpeg', data: gridBuffer.toString('base64') } },
    prompt,
  ]);

  const usage = result.response.usageMetadata || {};
  if (usageTracker && (usage.promptTokenCount || usage.candidatesTokenCount)) {
    usageTracker('gemini', {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
      thinking_tokens: usage.thoughtsTokenCount || 0,
    }, 'style_check', modelId);
  }

  const raw = result.response.text() || '';
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`style-check returned no JSON. Raw: ${raw.slice(0, 200)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
  } catch (err) {
    throw new Error(`style-check JSON parse failed: ${err.message}. Raw: ${raw.slice(jsonStart, jsonStart + 300)}`);
  }

  // Sanity-defaults so callers can rely on the shape.
  const out = {
    verdict: parsed.verdict || 'mixed',
    dominantCluster: Array.isArray(parsed.dominantCluster) ? parsed.dominantCluster : [],
    anchorPage: typeof parsed.anchorPage === 'number' ? parsed.anchorPage : (cells[0]?.page ?? null),
    outliers: Array.isArray(parsed.outliers) ? parsed.outliers : [],
    reasoning: parsed.reasoning || '',
    gridImage: `data:image/jpeg;base64,${gridBuffer.toString('base64')}`,
    // Absolute check. dominantMatches === false means the book as a whole
    // drifted off the commissioned style, so anchorPage is NOT a valid repair
    // target. null when no style was resolvable (check did not run).
    styleMatch: requestedStyle
      ? {
          requestedStyle,
          // Three levels, not a boolean. A boolean read "false" on 4 of 5
          // sampled books — including two the auditor itself called
          // "consistent" — because the model scores style fidelity
          // pedantically ("lacks the named artist's brushwork", "shading is
          // subtly digital rather than strictly flat"). Gating repair on that
          // would have disabled style-repair for almost every story. Only a
          // wholesale medium change blocks.
          verdict: ['matches', 'drifted', 'wrong_medium'].includes(parsed.dominantStyleVerdict)
            ? parsed.dominantStyleVerdict
            : 'matches',
          differences: Array.isArray(parsed.requestedStyleDifferences) ? parsed.requestedStyleDifferences : [],
        }
      : null,
  };

  log.info(`🎨 [STYLE-CHECK] verdict=${out.verdict}, dominant=${out.dominantCluster.length} pages, anchor=Page ${out.anchorPage}, outliers=${out.outliers.length}`);
  if (out.styleMatch && out.styleMatch.verdict !== 'matches') {
    const how = out.styleMatch.verdict === 'wrong_medium' ? 'is a DIFFERENT MEDIUM from' : 'has drifted from';
    log.warn(`🎨 [STYLE-CHECK] the dominant style ${how} the commissioned art style "${storyData.artStyle}": ${out.styleMatch.differences.slice(0, 3).join('; ')}`);
  }
  for (const o of out.outliers) {
    log.info(`🎨 [STYLE-CHECK] outlier Page ${o.page} [${o.severity}]: ${o.differences?.slice(0, 2).join('; ')}`);
  }

  return out;
}

module.exports = {
  checkStoryStyleConsistency,
  buildStyleGrid,
};
