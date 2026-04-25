/**
 * Multi-image-per-style bbox grid for visual eyeballing.
 *
 * For each art style we sample 3 different stories (one image each from page 2),
 * and per image render the full detector set:
 *   raw.jpg
 *   gemini-annotated.jpg          (GREEN — production prompt with character names)
 *   pipeline-annotated.jpg        (RED   — what production stored, when available)
 *   detect-anime-faces-annotated.jpg          (BLUE)
 *   detect-illustration-faces-annotated.jpg   (BLUE tight + PURPLE padded)
 *   detect-all-faces-annotated.jpg            (BLUE Haar)
 *
 * Output:
 *   tmp/bbox-multi-style/<style>/img1/...
 *   tmp/bbox-multi-style/<style>/img2/...
 *   tmp/bbox-multi-style/<style>/img3/...
 *
 * The Gemini prompt is the EXACT production prompt (prompts/bounding-box-detection.txt)
 * with the EXPECTED CHARACTERS section filled in from each page's stored
 * sceneCharacters/physicalDescription. That replicates what the pipeline
 * actually calls — without that, Gemini returns everything as UNKNOWN.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { Pool } = require('pg');

const STYLES = ['oil', 'watercolor', 'pixar', 'anime', 'steampunk'];
const IMAGES_PER_STYLE = 3;
const OUT_ROOT = path.resolve(__dirname, '..', '..', 'tmp', 'bbox-multi-style');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Production bbox prompt
const PROMPT_TEMPLATE = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'prompts', 'bounding-box-detection.txt'),
  'utf8'
);

async function annotate(imgBuf, boxes, outPath) {
  if (boxes.length === 0) return;
  const meta = await sharp(imgBuf).metadata();
  const W = meta.width, H = meta.height;
  const rects = boxes.map(b => {
    const [y1, x1, y2, x2] = b.box;
    const x = Math.round(x1 * W);
    const y = Math.round(y1 * H);
    const w = Math.max(1, Math.round((x2 - x1) * W));
    const h = Math.max(1, Math.round((y2 - y1) * H));
    const label = (b.label || '').replace(/[<>&]/g, '');
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${b.color}" stroke-width="4"/><rect x="${x}" y="${y - 22}" width="${Math.max(70, label.length * 9)}" height="20" fill="${b.color}"/><text x="${x + 4}" y="${y - 7}" font-family="monospace" font-size="14" fill="white">${label}</text>`;
  }).join('');
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  await sharp(imgBuf)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 85 })
    .toFile(outPath);
}

async function flaskUp() {
  try {
    const r = await fetch('http://localhost:5000/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function cascade(endpoint, imgB64) {
  const r = await fetch(`http://localhost:5000/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imgB64 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`${endpoint} HTTP ${r.status}`);
  return r.json();
}

async function geminiCall(promptText, imgB64) {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: 'image/jpeg', data: imgB64 } },
        { text: promptText }
      ]}],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    }),
    signal: AbortSignal.timeout(180000),
  });
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text);
}

async function geminiWithRetry(prompt, imgB64) {
  for (let i = 0; i < 3; i++) {
    try { return await geminiCall(prompt, imgB64); }
    catch (e) { if (i === 2) return null; }
  }
  return null;
}

function buildPrompt(expectedChars) {
  const charSection = expectedChars.length > 0
    ? `EXPECTED CHARACTERS (identify by name if found):\n` +
      expectedChars.map((c, i) =>
        `${i + 1}. ${c.name} - ${c.description || c.physicalDescription || 'no description'}${c.position ? `\n   Expected position: ${c.position}` : ''}`
      ).join('\n')
    : '(No expected characters provided - detect all figures as UNKNOWN)';
  return PROMPT_TEMPLATE
    .replace('{{EXPECTED_CHARACTERS}}', charSection)
    .replace('{{EXPECTED_OBJECTS}}', '(No expected objects provided)')
    .replace('{{SCENE_CONTEXT}}', '');
}

async function pickStories(artStyle, n) {
  // Prefer stories with bboxDetection populated for page 2 — gives us a
  // pipeline-stored RED box to compare against. Fall back to any story with
  // images for that style if too few qualify.
  const { rows } = await pool.query(`
    SELECT id, data->'sceneImages' AS s
    FROM stories
    WHERE data->>'artStyle' = $1
      AND jsonb_array_length(COALESCE(data->'sceneImages','[]'::jsonb)) > 3
    ORDER BY id DESC
    LIMIT 25
  `, [artStyle]);
  const out = [];
  for (const row of rows) {
    const p = (row.s || []).find(x => x.pageNumber === 2 && x.bestSource);
    if (!p) continue;
    out.push({ storyId: row.id, page: p });
    if (out.length >= n) break;
  }
  return out;
}

async function fetchActiveImage(storyId, pageNumber, bestSource) {
  const { rows: story } = await pool.query(
    `SELECT data->'sceneImages' AS s FROM stories WHERE id = $1`, [storyId]);
  const pageEntry = (story[0].s || []).find(s => s.pageNumber === pageNumber);
  if (!pageEntry) return null;
  const vIdx = (pageEntry.imageVersions || []).findIndex(v => v.source === bestSource);
  if (vIdx < 0) return null;
  const { rows: img } = await pool.query(
    `SELECT image_data FROM story_images
     WHERE story_id = $1 AND image_type = 'scene' AND page_number = $2 AND version_index = $3
     LIMIT 1`,
    [storyId, pageNumber, vIdx]);
  if (!img[0]) return null;
  const d = img[0].image_data;
  if (Buffer.isBuffer(d)) return d;
  if (typeof d === 'string') return Buffer.from(d.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  return null;
}

async function fetchExpectedCharacters(storyId, pageNumber) {
  // First check retryHistory for the bboxDetection input — that's the canonical
  // expectedCharacters list as it was passed to Gemini in production.
  const { rows } = await pool.query(`
    SELECT s, chars FROM (
      SELECT (data->'sceneImages') AS s, (data->'characters') AS chars
      FROM stories WHERE id = $1
    ) sub
  `, [storyId]);
  const r = rows[0];
  if (!r) return [];
  const pageEntry = (r.s || []).find(p => p.pageNumber === pageNumber);
  for (const h of (pageEntry?.retryHistory || [])) {
    if (h?.bboxDetection?.expectedCharacters?.length > 0) {
      return h.bboxDetection.expectedCharacters;
    }
  }
  // Fallback: try the page's own scene.characters[] cross-referenced against
  // the story's character list.
  const sceneChars = pageEntry?.scene?.characters || pageEntry?.characters || [];
  return sceneChars.map(sc => {
    const fullChar = (r.chars || []).find(c => c.name === (sc.name || sc));
    return {
      name: sc.name || sc,
      position: sc.position || null,
      description: fullChar?.physicalDescription || ''
    };
  });
}

async function processOne(style, idx, storyId, pageEntry) {
  const imgDir = path.join(OUT_ROOT, style, `img${idx}`);
  fs.mkdirSync(imgDir, { recursive: true });
  console.log(`  img${idx}: story ${storyId} p${pageEntry.pageNumber}`);

  const buf = await fetchActiveImage(storyId, pageEntry.pageNumber, pageEntry.bestSource);
  if (!buf) { console.log('     no image data'); return; }
  fs.writeFileSync(path.join(imgDir, 'raw.jpg'), buf);
  const b64 = buf.toString('base64');
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  const toNorm = (b) => Array.isArray(b) ? b : [b.y / H, b.x / W, (b.y + b.height) / H, (b.x + b.width) / W];

  const findings = { style, idx, storyId, pageNumber: pageEntry.pageNumber };

  // Pipeline-stored
  let pipelineFigs = [];
  for (let i = (pageEntry.retryHistory || []).length - 1; i >= 0; i--) {
    const h = pageEntry.retryHistory[i];
    if (h?.bboxDetection?.figures?.length) { pipelineFigs = h.bboxDetection.figures; break; }
  }
  findings.pipelineStored = pipelineFigs.map(f => ({ name: f.name, faceBox: f.faceBox, _geminiFaceBox: f._geminiFaceBox, _cascadeFace: f._cascadeFace }));
  const pipeBoxes = pipelineFigs.filter(f => f.faceBox).map((f, i) => ({
    label: 'PIPE:' + (f.name || 'UNK'+i).slice(0, 8),
    color: '#ff0000',
    box: toNorm(f.faceBox)
  }));
  await annotate(buf, pipeBoxes, path.join(imgDir, 'pipeline-annotated.jpg'));
  console.log(`     pipeline: ${pipeBoxes.length}`);

  // Gemini with production prompt + expected characters
  const expectedChars = await fetchExpectedCharacters(storyId, pageEntry.pageNumber);
  findings.expectedCharacters = expectedChars.map(c => ({ name: c.name, position: c.position }));
  const prompt = buildPrompt(expectedChars);
  const gResult = await geminiWithRetry(prompt, b64);
  if (gResult) {
    findings.gemini = gResult;
    const figs = (gResult.figures || []).filter(f => Array.isArray(f.face_box));
    const boxes = figs.map((f, i) => {
      const [y1, x1, y2, x2] = f.face_box.map(v => v / 1000);
      const label = (f.name && f.name !== 'UNKNOWN' ? f.name : 'UNK'+i) + (f.confidence ? '/'+f.confidence[0] : '');
      return { label: 'GEM:' + label.slice(0, 14), color: '#00ff00', box: [y1, x1, y2, x2] };
    });
    await annotate(buf, boxes, path.join(imgDir, 'gemini-annotated.jpg'));
    console.log(`     gemini: ${boxes.length}`);
  } else {
    findings.geminiError = 'all retries failed';
    console.log('     gemini: failed');
  }

  // Cascade
  for (const endpoint of ['detect-anime-faces', 'detect-illustration-faces', 'detect-all-faces']) {
    try {
      const r = await cascade(endpoint, b64);
      const stripped = JSON.parse(JSON.stringify(r, (k, v) => k === 'cropData' ? undefined : v));
      findings[endpoint] = stripped;
      const faces = stripped.faces || [];
      const tight = faces.map((f, i) => {
        const raw = f.faceBox || f.face_bbox || f.bbox || f.box;
        if (!raw) return null;
        return { label: 'T'+i+(f.source ? ':'+f.source : f.detector ? ':'+f.detector : ''), color: '#0066ff', box: toNorm(raw) };
      }).filter(Boolean);
      const padded = faces.filter(f => f.paddedBox).map((f, i) => ({
        label: 'P'+i+(f.source ? ':'+f.source : ''), color: '#9933ff', box: toNorm(f.paddedBox)
      }));
      const all = [...tight, ...padded];
      if (all.length > 0) await annotate(buf, all, path.join(imgDir, `${endpoint}-annotated.jpg`));
      console.log(`     ${endpoint}: ${tight.length}+${padded.length}`);
    } catch (e) {
      findings[`${endpoint}Error`] = e.message;
      console.log(`     ${endpoint}: err`);
    }
  }

  fs.writeFileSync(path.join(imgDir, 'findings.json'), JSON.stringify(findings, null, 2));
}

(async () => {
  const flask = await flaskUp();
  console.log(`Flask :5000 ${flask ? 'UP' : 'DOWN'}`);
  if (!flask) console.log('  → cascade endpoints will fail; consider starting photo_analyzer.py');

  for (const style of STYLES) {
    console.log(`\n══ ${style} ══`);
    const stories = await pickStories(style, IMAGES_PER_STYLE);
    if (stories.length < IMAGES_PER_STYLE) {
      console.log(`  only ${stories.length} stories qualify (wanted ${IMAGES_PER_STYLE})`);
    }
    for (let i = 0; i < stories.length; i++) {
      try {
        await processOne(style, i + 1, stories[i].storyId, stories[i].page);
      } catch (e) {
        console.log(`  img${i + 1} crashed:`, e.message);
      }
    }
  }

  await pool.end();
  console.log('\nDone. See tmp/bbox-multi-style/<style>/img{1,2,3}/');
})().catch(e => { console.error(e); pool.end(); process.exit(1); });
