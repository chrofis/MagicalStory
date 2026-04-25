/**
 * Multi-style bbox dry-run. Pick one story per art style, pull one page image,
 * run the available face detectors, and save everything for inspection.
 *
 * Detectors queried:
 *   1. Gemini 2.5 Flash bbox detection (always — hits Gemini API directly).
 *   2. Cascade face detectors from photo_analyzer.py Flask service on :5000.
 *      If not running, the cascade columns are just omitted — script does NOT
 *      attempt to start the service (memory safety).
 *   3. What the pipeline already stored (read from stories.data.sceneImages).
 *
 * Output: tmp/bbox-multi-style/<artStyle>/
 *   raw.jpg                   — the stored page image
 *   gemini-annotated.jpg      — Gemini's faceBox drawn in GREEN
 *   cascade-anime-annotated.jpg (if Flask was up)
 *   cascade-haar-annotated.jpg  (if Flask was up)
 *   pipeline-annotated.jpg    — what the pipeline actually ended up using (RED)
 *   findings.json             — raw numbers per detector
 *   README.md                 — per-style summary
 *
 * Run: node scripts/analysis/bbox-multi-style.js
 * Reads: DATABASE_URL, GEMINI_API_KEY from .env
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const sharp = require('sharp');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'tmp', 'bbox-multi-style');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Styles to sample. User's DB shows: oil (56), watercolor (55), pixar (17),
// steampunk (11), realistic (10), concept (9), cartoon (5), anime (5).
const STYLES = ['oil', 'watercolor', 'pixar', 'anime', 'steampunk'];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Flask service probe ─────────────────────────────────────────────────────
async function flaskUp() {
  try {
    const r = await fetch('http://localhost:5000/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// ─── Gemini detection — stripped-down version of the pipeline helper ─────────
async function geminiDetectOnce(imageBase64, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const prompt = `Detect human/character figures in this illustration.

For each figure return: name (or "UNKNOWN"), a face bounding box if a face is visible, and a body bounding box.

Respond in JSON: {"figures": [{"name": "...", "face_bbox": [ymin,xmin,ymax,xmax], "body_bbox": [ymin,xmin,ymax,xmax]}]}

All bbox values normalised 0-1000 (Gemini convention — we'll rescale). Tight faces only, chin to top of head, ear to ear — no padding.`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
        { text: prompt }
      ]}],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return { figures: [] };
  try {
    const parsed = JSON.parse(text);
    for (const f of (parsed.figures || [])) {
      for (const key of ['face_bbox', 'body_bbox']) {
        if (Array.isArray(f[key]) && f[key].length === 4) {
          f[key] = f[key].map(v => v / 1000);
        }
      }
    }
    return parsed;
  } catch { return { figures: [] }; }
}

async function geminiDetect(imageBase64) {
  // 60s first try, 90s retry — large JPEGs push Gemini past the original 30s.
  try { return await geminiDetectOnce(imageBase64, 60000); }
  catch (e1) {
    if (!/abort|timeout/i.test(String(e1.message))) throw e1;
    return await geminiDetectOnce(imageBase64, 90000);
  }
}

// ─── Cascade detection via Flask ─────────────────────────────────────────────
async function cascadeDetect(endpoint, imageBase64) {
  const url = `http://localhost:5000/${endpoint}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageBase64 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`${endpoint} HTTP ${resp.status}`);
  return resp.json();
}

// ─── Annotate image with bboxes (SVG overlay via sharp) ──────────────────────
async function annotate(imageBuf, boxes, outPath) {
  const meta = await sharp(imageBuf).metadata();
  const W = meta.width, H = meta.height;
  const rects = boxes.map((b, i) => {
    // b.box = [ymin, xmin, ymax, xmax] normalised 0-1
    const [y1, x1, y2, x2] = b.box;
    const x = Math.round(x1 * W);
    const y = Math.round(y1 * H);
    const w = Math.max(1, Math.round((x2 - x1) * W));
    const h = Math.max(1, Math.round((y2 - y1) * H));
    const color = b.color || '#00ff00';
    const label = b.label || '';
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="4" />
      <rect x="${x}" y="${y - 24}" width="${Math.max(80, label.length * 10)}" height="22" fill="${color}" />
      <text x="${x + 4}" y="${y - 8}" font-family="monospace" font-size="16" fill="black">${label}</text>
    `;
  }).join('');
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  await sharp(imageBuf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toFile(outPath);
}

// ─── Pick one story per art style, most-recent completed ─────────────────────
async function pickStory(artStyle) {
  const { rows } = await pool.query(`
    SELECT id, data->'sceneImages' AS scene_images, data->>'title' AS title
    FROM stories
    WHERE data->>'artStyle' = $1
      AND data ? 'sceneImages'
      AND jsonb_array_length(COALESCE(data->'sceneImages','[]'::jsonb)) > 3
    ORDER BY id DESC
    LIMIT 10
  `, [artStyle]);
  for (const row of rows) {
    const images = row.scene_images || [];
    // Pick a middle page with figures
    const candidate = images.find(img => img?.pageNumber >= 2 && img?.imageVersions?.length && img?.bestSource);
    if (candidate) return { storyId: row.id, title: row.title, page: candidate };
  }
  return null;
}

async function fetchActiveImage(storyId, pageNumber, bestSource) {
  // The `imageVersions` array is per-page in stories.data; but story_images
  // is the canonical binary table. Pick the version_index matching bestSource
  // (same position as the imageVersions[] entry with matching .source).
  const { rows: story } = await pool.query(
    `SELECT data->'sceneImages' AS scene_images FROM stories WHERE id = $1`,
    [storyId]
  );
  const pageEntry = (story[0].scene_images || []).find(s => s.pageNumber === pageNumber);
  if (!pageEntry) return null;
  const vIdx = (pageEntry.imageVersions || []).findIndex(v => v.source === bestSource);
  if (vIdx < 0) return null;
  const { rows: img } = await pool.query(
    `SELECT image_data FROM story_images
     WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = $3
     LIMIT 1`,
    [storyId, pageNumber, vIdx]
  );
  if (!img[0]) return null;
  return img[0].image_data; // may be Buffer or data URL string
}

async function toBuffer(imageData) {
  if (!imageData) return null;
  if (Buffer.isBuffer(imageData)) return imageData;
  if (typeof imageData === 'string') {
    const b64 = imageData.replace(/^data:image\/\w+;base64,/, '');
    return Buffer.from(b64, 'base64');
  }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
(async () => {
  const flaskAlive = await flaskUp();
  console.log(`Flask on :5000 ${flaskAlive ? 'UP — cascade detectors available' : 'DOWN — Gemini + pipeline-stored only'}`);

  for (const style of STYLES) {
    const styleDir = path.join(OUT_DIR, style);
    fs.mkdirSync(styleDir, { recursive: true });
    console.log(`\n── ${style} ──`);

    const pick = await pickStory(style);
    if (!pick) { console.log(`  no story with images found for ${style}`); continue; }
    const pageEntry = pick.page;
    const pageNumber = pageEntry.pageNumber;
    console.log(`  story ${pick.storyId} — "${pick.title}" — page ${pageNumber}`);

    const raw = await fetchActiveImage(pick.storyId, pageNumber, pageEntry.bestSource);
    const imgBuf = await toBuffer(raw);
    if (!imgBuf) { console.log('  no image data'); continue; }
    fs.writeFileSync(path.join(styleDir, 'raw.jpg'), imgBuf);
    const imgBase64 = imgBuf.toString('base64');

    const findings = { style, storyId: pick.storyId, title: pick.title, pageNumber };

    // 1. What the pipeline stored
    const pipelineFigs = [];
    const latestRetry = (pageEntry.retryHistory || []).slice(-1)[0];
    for (const f of (latestRetry?.bboxDetection?.figures || [])) {
      if (f.faceBox) pipelineFigs.push({ label: `PIPE: ${f.name || 'UNK'}`, color: '#ff0000', box: Array.isArray(f.faceBox) ? f.faceBox : [f.faceBox.y, f.faceBox.x, f.faceBox.y + f.faceBox.height, f.faceBox.x + f.faceBox.width] });
    }
    findings.pipelineStored = pipelineFigs;
    if (pipelineFigs.length > 0) await annotate(imgBuf, pipelineFigs, path.join(styleDir, 'pipeline-annotated.jpg'));

    // 2. Fresh Gemini
    try {
      const g = await geminiDetect(imgBase64);
      findings.gemini = g;
      const boxes = (g.figures || []).filter(f => f.face_bbox).map(f => ({
        label: `GEM: ${f.name || 'UNK'}`, color: '#00ff00', box: f.face_bbox
      }));
      if (boxes.length > 0) await annotate(imgBuf, boxes, path.join(styleDir, 'gemini-annotated.jpg'));
      console.log(`  gemini: ${boxes.length} face boxes`);
    } catch (e) { findings.geminiError = e.message; console.log(`  gemini error: ${e.message}`); }

    // 3. Cascade detectors. Schema: each face has `faceBox` (tight) and
    // `paddedBox` (inflated, what the pipeline actually substitutes into
    // Gemini's slot — and the suspected bug). Coordinates are in PIXELS
    // (origin top-left), not 0-1 normalised. Convert to normalised so the
    // annotate helper can scale uniformly.
    if (flaskAlive) {
      const meta = await sharp(imgBuf).metadata();
      const W = meta.width, H = meta.height;
      const toNormBox = (b) => Array.isArray(b)
        ? b
        : [b.y / H, b.x / W, (b.y + b.height) / H, (b.x + b.width) / W];
      for (const endpoint of ['detect-anime-faces', 'detect-illustration-faces', 'detect-all-faces']) {
        try {
          const r = await cascadeDetect(endpoint, imgBase64);
          // Strip cropData (huge base64) before persisting findings.
          const stripped = JSON.parse(JSON.stringify(r, (k, v) => k === 'cropData' ? undefined : v));
          findings[endpoint] = stripped;
          const faces = stripped.faces || stripped.figures || [];
          const tightBoxes = faces.filter(f => f.faceBox || f.face_bbox || f.bbox || f.box).map((f, i) => {
            const raw = f.faceBox || f.face_bbox || f.bbox || f.box;
            return { label: `${endpoint.replace('detect-','').slice(0,5)}T-${i}${f.source ? ':'+f.source : ''}`, color: '#0066ff', box: toNormBox(raw) };
          });
          const paddedBoxes = faces.filter(f => f.paddedBox).map((f, i) => ({
            label: `${endpoint.replace('detect-','').slice(0,5)}P-${i}${f.source ? ':'+f.source : ''}`,
            color: '#9933ff',
            box: toNormBox(f.paddedBox)
          }));
          const allBoxes = [...tightBoxes, ...paddedBoxes];
          if (allBoxes.length > 0) await annotate(imgBuf, allBoxes, path.join(styleDir, `${endpoint}-annotated.jpg`));
          console.log(`  ${endpoint}: ${tightBoxes.length} tight + ${paddedBoxes.length} padded`);
        } catch (e) { findings[`${endpoint}Error`] = e.message; console.log(`  ${endpoint} error: ${e.message}`); }
      }
    }

    fs.writeFileSync(path.join(styleDir, 'findings.json'), JSON.stringify(findings, null, 2));

    // Mini README per style
    const geminiCount = (findings.gemini?.figures || []).filter(f => f.face_bbox).length;
    const pipelineCount = pipelineFigs.length;
    const cascadeCount = (findings['detect-anime-faces']?.faces || []).length
                       + (findings['detect-illustration-faces']?.faces || []).length;
    fs.writeFileSync(path.join(styleDir, 'README.md'), `# ${style}

Story: ${pick.storyId}
Title: ${pick.title}
Page: ${pageNumber}

## Detection counts

- Pipeline stored (red): ${pipelineCount}
- Gemini fresh (green): ${geminiCount}
- Cascade combined (blue): ${cascadeCount}${flaskAlive ? '' : ' — Flask service was down, skipped'}

## Files

- raw.jpg — the original page image
- pipeline-annotated.jpg — red boxes = what the pipeline actually used (merged output)
- gemini-annotated.jpg — green boxes = fresh Gemini 2.5 Flash face detection
- cascade-\\*-annotated.jpg — blue boxes = anime/illustration/Haar cascade detections
- findings.json — raw numbers for every detector

Compare visually: a face-box whose vertical centre is in the lower half of the
image is almost certainly a body/torso misdetection. That's the pattern to
watch for. Gemini should land tight on the actual face.
`);
  }

  // Top-level README
  fs.writeFileSync(path.join(OUT_DIR, 'README.md'), `# Multi-style bbox dry-run

Sampled ${STYLES.length} art styles — one image each — to see which detectors
produce good face boxes on which styles.

Styles: ${STYLES.join(', ')}.
Flask cascade service at startup: ${flaskAlive ? 'UP' : 'DOWN (cascade columns omitted)'}.

Each subfolder has its own README.md with the specific story/page/counts.

## Colour code on annotated images

- RED    — what the pipeline actually stored and used (merged Gemini+cascade)
- GREEN  — fresh Gemini 2.5 Flash detection run today (ignoring cascade)
- BLUE   — cascade detectors (anime, illustration, Haar) run today

If RED differs from GREEN, the merge is changing Gemini's answer — that's the
bug we suspect. If GREEN is also wrong, Gemini itself struggles on that style.
`);

  console.log(`\nDone. Output in ${OUT_DIR}`);
  await pool.end();
})().catch(e => { console.error(e); pool.end(); process.exit(1); });
