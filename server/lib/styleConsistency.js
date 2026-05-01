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
 * Usage: const result = await checkStoryStyleConsistency(storyData)
 */

const sharp = require('sharp');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { log } = require('../utils/logger');

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
    const base64 = (cell.imageData || '').replace(/^data:image\/\w+;base64,/, '');
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
 *   gridImage: string  // base64 data URL of the grid sent to Gemini (for UI display)
 * }>}
 */
async function checkStoryStyleConsistency(storyData, opts = {}) {
  const { modelId = 'gemini-2.5-flash', usageTracker = null } = opts;

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY missing');
  }

  // Collect all renderable images: front cover (-1 for label) + every page.
  const cells = [];
  const front = storyData.coverImages?.frontCover?.imageData;
  if (front) {
    cells.push({ label: 'Front cover', imageData: front, page: -1 });
  }
  const pages = (storyData.sceneImages || [])
    .filter(s => s.imageData)
    .sort((a, b) => a.pageNumber - b.pageNumber);
  for (const s of pages) {
    cells.push({ label: `Page ${s.pageNumber}`, imageData: s.imageData, page: s.pageNumber });
  }

  if (cells.length < 2) {
    throw new Error(`style-check needs ≥2 images, got ${cells.length}`);
  }

  log.info(`🎨 [STYLE-CHECK] Building grid for ${cells.length} images (${cells.length - (front ? 1 : 0)} pages + ${front ? 'cover' : 'no cover'})`);
  const gridBuffer = await buildStyleGrid(cells);
  log.info(`🎨 [STYLE-CHECK] Grid built: ${(gridBuffer.length / 1024).toFixed(0)}KB, sending to ${modelId}...`);

  // Prompt: cluster by style, return strict JSON.
  // pageNumber values: -1 for front cover, 1+ for pages. The model returns
  // the same numbers so we can act on them.
  const prompt = `You are a visual-style auditor for a children's storybook.

The image you see is a labelled grid of every illustrated page from one storybook (and its front cover, if shown). Each cell has a label like "Page 3" or "Front cover".

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

Return ONLY this JSON, no prose:
{
  "verdict": "consistent" | "mixed" | "fragmented",
  "dominantCluster": [<page numbers in cluster>],
  "anchorPage": <page number>,
  "outliers": [
    { "page": <number>, "severity": "major"|"moderate"|"minor", "differences": ["...", "..."] }
  ],
  "reasoning": "<2-3 sentences explaining what unifies the dominant cluster and how the outliers diverge>"
}

Use -1 for "Front cover" if it appears. Use the page numbers from the labels for everything else.

Verdict rule:
- "consistent" if ≥90% of cells are in the dominant cluster and outliers are all "minor"
- "mixed" if 60-90% in dominant cluster, or any "moderate"+ outliers
- "fragmented" if <60% in any single cluster`;

  const model = genAI.getGenerativeModel({ model: modelId });
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
  };

  log.info(`🎨 [STYLE-CHECK] verdict=${out.verdict}, dominant=${out.dominantCluster.length} pages, anchor=Page ${out.anchorPage}, outliers=${out.outliers.length}`);
  for (const o of out.outliers) {
    log.info(`🎨 [STYLE-CHECK] outlier Page ${o.page} [${o.severity}]: ${o.differences?.slice(0, 2).join('; ')}`);
  }

  return out;
}

module.exports = {
  checkStoryStyleConsistency,
  buildStyleGrid,
};
