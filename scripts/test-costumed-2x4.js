#!/usr/bin/env node
/**
 * Local test for the 2x4 costumed-character sheet (vs. the production 2x2).
 *
 * Generates ONE Gemini image with the new 2x4 layout — top row = 4 face
 * angles (0°/45°/90°/180°), bottom row = 4 full-body angles in the requested
 * art style + costume. Saves the full grid plus 8 per-cell crops so the
 * angles can be inspected individually.
 *
 * Inputs are local files (no DB needed). Use the demo photos in
 * tests/fixtures/demo-photos/<family>/ or any other face/avatar JPG.
 *
 * Usage:
 *   node scripts/test-costumed-2x4.js \
 *     --face=tests/fixtures/demo-photos/berger/Hans.jpg \
 *     [--avatar=path/to/standard-avatar.jpg]       # optional, defaults to --face
 *     [--costume="pirate costume — wide-brimmed brown tricorn hat, ..."] \
 *     [--style=watercolor]                          # art style key
 *     [--name=Hans]                                 # for output dirname
 *     [--also-2x2]                                  # run the legacy 2x2 in parallel
 *
 * Output: tests/_outputs/costumed-2x4/<timestamp>__<name>/
 *   - 2x4.png             — full grid from Gemini
 *   - 2x4_cellN.png       — 8 cropped cells (N=1..8)
 *   - 2x4_prompt.txt      — full prompt text
 *   - 2x4_meta.json       — model id, tokens, duration
 *   - 2x2.png             — legacy grid if --also-2x2 set
 *   - 2x2_cellN.png       — 4 cropped cells
 *   - summary.md          — side-by-side notes
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

function arg(name, dflt = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : dflt;
}
function flag(name) { return process.argv.includes(`--${name}`); }

const FACE_PATH = arg('face');
const AVATAR_PATH = arg('avatar', FACE_PATH);
const COSTUME = arg('costume', 'pirate costume: wide-brimmed brown tricorn hat with a feather, white shirt, red sash at the waist, dark breeches, brown boots');
const STYLE_KEY = arg('style', 'watercolor');
const NAME = arg('name', FACE_PATH ? path.basename(FACE_PATH, path.extname(FACE_PATH)) : 'character');
const ALSO_2x2 = flag('also-2x2');

if (!FACE_PATH) {
  console.error('--face=<path-to-face-photo> is required');
  process.exit(1);
}
if (!fs.existsSync(FACE_PATH)) {
  console.error(`face photo not found: ${FACE_PATH}`);
  process.exit(1);
}
if (AVATAR_PATH !== FACE_PATH && !fs.existsSync(AVATAR_PATH)) {
  console.error(`avatar not found: ${AVATAR_PATH}`);
  process.exit(1);
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY missing in .env');
  process.exit(1);
}

const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const OUT_DIR = path.resolve(__dirname, '..', 'tests', '_outputs', 'costumed-2x4', `${STAMP}__${NAME}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
// Load the prompt templates from disk so the test mirrors the live wiring.
// ────────────────────────────────────────────────────────────────────────────
const TEMPLATE_2x4 = fs.readFileSync(path.resolve(__dirname, '..', 'prompts', 'styled-costumed-avatar-2x4.txt'), 'utf8');
const TEMPLATE_2x2 = fs.readFileSync(path.resolve(__dirname, '..', 'prompts', 'styled-costumed-avatar.txt'), 'utf8');

// ────────────────────────────────────────────────────────────────────────────
// Art-style descriptors (subset of ART_STYLE_PROMPTS from server/lib/styledAvatars.js).
// Pulled by key so the test stays self-contained.
// ────────────────────────────────────────────────────────────────────────────
const ART_STYLE_PROMPTS = {
  'watercolor':         "watercolor children's storybook illustration, soft brushwork, gentle colors, warm friendly mood",
  'pixar':              "Pixar/Disney 3D animation style, polished cel shading, soft rim light, friendly proportions",
  'anime':              "anime/manga line work with soft cel shading and clean line art",
  'oil':                "oil painting style with visible brushwork, rich color blending, painterly texture",
  'cartoon':            "modern flat cartoon, bold outlines, clean shapes, vibrant colors",
};
const artStylePrompt = ART_STYLE_PROMPTS[STYLE_KEY] || ART_STYLE_PROMPTS['watercolor'];

function fillTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), v || '');
  }
  return out;
}

// Best-effort physical traits string. We don't have a character record here,
// so describe whatever we know from the photo and let the model preserve it
// from the reference. Mirroring the shape used by buildPhysicalTraitsString.
const physicalTraits = arg('traits', 'See reference photos — preserve face, hair colour, build, skin tone, glasses, and any visible distinguishing features exactly.');

const COSTUME_TYPE = COSTUME.split(/[:,]/)[0].trim();

const prompt2x4 = fillTemplate(TEMPLATE_2x4, {
  ART_STYLE_PROMPT: artStylePrompt,
  COSTUME_DESCRIPTION: COSTUME,
  COSTUME_TYPE,
  PHYSICAL_TRAITS: physicalTraits,
});
const prompt2x2 = fillTemplate(TEMPLATE_2x2, {
  ART_STYLE_PROMPT: artStylePrompt,
  COSTUME_DESCRIPTION: COSTUME,
  COSTUME_TYPE,
  PHYSICAL_TRAITS: physicalTraits,
});

// ────────────────────────────────────────────────────────────────────────────
// Reference image loading
// ────────────────────────────────────────────────────────────────────────────
function readAsBase64(p) {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { base64: buf.toString('base64'), mime };
}

const face = readAsBase64(FACE_PATH);
const avatar = AVATAR_PATH === FACE_PATH ? face : readAsBase64(AVATAR_PATH);

// ────────────────────────────────────────────────────────────────────────────
// Gemini call
// ────────────────────────────────────────────────────────────────────────────
async function callGemini(prompt, gridLabel, gridShape) {
  const cols = gridShape.cols;
  const rows = gridShape.rows;
  const aspectRatio = arg('aspect', cols >= 4 ? '16:9' : '1:1');
  const modelId = arg('model', 'gemini-2.5-flash-image');
  const systemText = `You are an expert character artist creating reference sheets for children's book illustrations. You are given a face photo for identity reference and an avatar/photo for body and clothing. Follow the user's instructions precisely about grid shape, art style, and costume. The SAME person must appear in every panel.`;

  const imageParts = [
    { text: '[Face photo - identity reference]' },
    { inline_data: { mime_type: face.mime, data: face.base64 } },
    { text: '[Reference avatar - body and clothing]' },
    { inline_data: { mime_type: avatar.mime, data: avatar.base64 } },
  ];

  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ parts: [...imageParts, { text: prompt }] }],
    generationConfig: {
      temperature: 0.5,
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  console.log(`\n→ Calling Gemini for ${gridLabel} (${rows}×${cols}, aspect=${aspectRatio})...`);
  const t0 = Date.now();
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const ms = Date.now() - t0;
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini ${resp.status}: ${err.slice(0, 400)}`);
  }
  const data = await resp.json();
  const tokensIn = data.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 0;
  const block = data.promptFeedback?.blockReason;
  if (block) throw new Error(`Blocked: ${block}`);
  let imageData = null;
  const textBits = [];
  for (const part of (data.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData?.mimeType?.startsWith('image/')) {
      imageData = { mime: part.inlineData.mimeType, base64: part.inlineData.data };
    } else if (part.text) {
      textBits.push(part.text);
    }
  }
  if (!imageData) {
    const finish = data.candidates?.[0]?.finishReason || 'unknown';
    const safety = JSON.stringify(data.candidates?.[0]?.safetyRatings || []);
    throw new Error(`No image in response (finish=${finish}, text="${textBits.join(' ').slice(0, 300)}", safety=${safety.slice(0, 200)})`);
  }
  console.log(`  ✓ ${gridLabel} in ${ms}ms (in=${tokensIn} out=${tokensOut})`);
  return { imageData, ms, tokensIn, tokensOut };
}

async function saveCells(buf, rows, cols, prefix) {
  const meta = await sharp(buf).metadata();
  const W = meta.width, H = meta.height;
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c + 1;
      const left = c * cellW;
      const top = r * cellH;
      const outPath = path.join(OUT_DIR, `${prefix}_cell${idx}.png`);
      await sharp(buf).extract({ left, top, width: cellW, height: cellH }).png().toFile(outPath);
      cells.push({ idx, row: r + 1, col: c + 1, outPath });
    }
  }
  return { width: W, height: H, cellW, cellH, cells };
}

(async () => {
  const summary = {
    runStarted: new Date().toISOString(),
    inputs: { face: FACE_PATH, avatar: AVATAR_PATH, costume: COSTUME, style: STYLE_KEY, name: NAME },
    runs: [],
  };

  // ── 2x4 run ──
  try {
    fs.writeFileSync(path.join(OUT_DIR, '2x4_prompt.txt'), prompt2x4);
    const r = await callGemini(prompt2x4, '2x4', { rows: 2, cols: 4 });
    const buf = Buffer.from(r.imageData.base64, 'base64');
    fs.writeFileSync(path.join(OUT_DIR, '2x4.png'), buf);
    const grid = await saveCells(buf, 2, 4, '2x4');
    fs.writeFileSync(path.join(OUT_DIR, '2x4_meta.json'), JSON.stringify({
      durationMs: r.ms, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ...grid,
    }, null, 2));
    summary.runs.push({ shape: '2x4', durationMs: r.ms, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cells: grid.cells.length });
    console.log(`  ✓ saved ${OUT_DIR}/2x4.png + 8 cell crops`);
  } catch (err) {
    console.error('  ✗ 2x4 failed:', err.message);
    summary.runs.push({ shape: '2x4', error: err.message });
  }

  // ── 2x2 run (optional) ──
  if (ALSO_2x2) {
    try {
      fs.writeFileSync(path.join(OUT_DIR, '2x2_prompt.txt'), prompt2x2);
      const r = await callGemini(prompt2x2, '2x2', { rows: 2, cols: 2 });
      const buf = Buffer.from(r.imageData.base64, 'base64');
      fs.writeFileSync(path.join(OUT_DIR, '2x2.png'), buf);
      const grid = await saveCells(buf, 2, 2, '2x2');
      fs.writeFileSync(path.join(OUT_DIR, '2x2_meta.json'), JSON.stringify({
        durationMs: r.ms, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ...grid,
      }, null, 2));
      summary.runs.push({ shape: '2x2', durationMs: r.ms, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cells: grid.cells.length });
      console.log(`  ✓ saved ${OUT_DIR}/2x2.png + 4 cell crops`);
    } catch (err) {
      console.error('  ✗ 2x2 failed:', err.message);
      summary.runs.push({ shape: '2x2', error: err.message });
    }
  }

  summary.runFinished = new Date().toISOString();
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nOutput: ${OUT_DIR}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
