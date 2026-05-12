#!/usr/bin/env node
/**
 * Generate the phantom reference sheet — 2 rows × 4 columns showing a
 * generic figure (neutral hair, basic face features, no clothing) at 8
 * angles. Pure white background.
 *
 * Two modes:
 *   --mode=single   ONE Gemini call that produces the whole 2×4 grid.
 *                   Faster (~7s) but the 45° three-quarter view often
 *                   collapses into the 90° profile.
 *   --mode=split    Eight focused Gemini calls (one per angle) tiled into
 *                   a 2×4 grid with sharp. Slower (~50s), guarantees each
 *                   angle is rendered separately.
 *
 * Usage:
 *   node scripts/test-phantom-generate.js --mode=split [--style=watercolor]
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

const STYLE_KEY = arg('style', 'watercolor');
const BACKEND = arg('backend', 'gemini'); // gemini | grok
const MODEL = arg('model', BACKEND === 'grok' ? 'grok-imagine-image' : 'gemini-2.5-flash-image');
const MODE = arg('mode', 'single');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;
if (BACKEND === 'gemini' && !GEMINI_API_KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1); }
if (BACKEND === 'grok' && !XAI_API_KEY) { console.error('XAI_API_KEY missing'); process.exit(1); }

const STYLE_LINE = {
  'watercolor': "soft watercolor children's storybook illustration style — gentle washes, simple outlines",
  'pixar':      "Pixar 3D illustration style — smooth shading, clean rim light",
  'anime':      "anime line-art style — clean lines, flat shading",
  'sketch':     "simple pencil sketch, light grey lines, minimal shading",
}[STYLE_KEY] || "soft watercolor children's storybook style";

// ────────────────────────────────────────────────────────────────────────────
// Per-cell descriptions for split mode. Each prompt produces ONE square
// figure centred on pure white. Tile 8 of them into 2×4 with sharp.
// ────────────────────────────────────────────────────────────────────────────
const HEAD_PROMPTS = {
  '0':   `Head and neck ONLY of a generic genderless adult — short neutral brown hair, simple eyes, a simple mouth, neutral skin tone. NO shoulders, NO body, NO clothing. Facing the camera STRAIGHT FRONT (0°): both eyes equally visible, nose centred, mouth horizontal.`,
  '45':  `Head and neck ONLY of a generic genderless adult — short neutral brown hair, simple eyes, a simple mouth, neutral skin tone. NO shoulders, NO body, NO clothing. THREE-QUARTER view, head ROTATED 45° to the camera's right: the nose clearly points OFF to the right but is not in pure profile, BOTH EYES are visible but the right eye sits at the cheek edge; the left eye is more centred. Think of a Renaissance portrait three-quarter pose — not front, not profile, but halfway between.`,
  '90':  `Head and neck ONLY of a generic genderless adult — short neutral brown hair, simple eyes, a simple mouth, neutral skin tone. NO shoulders, NO body, NO clothing. Strict SIDE PROFILE, head turned 90° to the camera's right: only ONE eye visible, the nose points perpendicular to the camera, the silhouette of the nose, lips, and chin is clearly defined against the white background.`,
  '180': `BACK of the head only — short neutral brown hair seen from behind. NO face, NO eyes, NO nose, NO mouth, NO shoulders, NO body, NO clothing. The viewer sees the rear of the hair, ears either symmetrically visible at the sides or hidden by hair.`,
};

const BODY_PROMPTS = {
  '0':   `Full body of a generic genderless adult standing upright, head to feet, arms relaxed at sides, feet roughly hip-width apart. Short neutral brown hair, simple face features. Smooth beige body — NO clothing, NO accessories. Facing the camera STRAIGHT FRONT (0°): symmetric stance, both feet point at the camera, both arms equally visible.`,
  '45':  `Full body of a generic genderless adult standing upright, head to feet, arms relaxed at sides. Short neutral brown hair, simple face features. Smooth beige body, NO clothing. THREE-QUARTER view, body ROTATED 45° to the camera's right: the right shoulder is closer to the camera and the left shoulder is partly behind it; both feet are visible but the right foot points more toward the camera than the left. Clearly NOT a pure side profile — viewer can still see the front of the chest and stomach at an angle.`,
  '90':  `Full body of a generic genderless adult standing upright, head to feet, arms relaxed at sides. Short neutral brown hair, simple face features. Smooth beige body, NO clothing. Strict SIDE PROFILE, body turned 90° to the camera's right: only one shoulder visible at the front, the other directly behind it; both feet point fully to the right.`,
  '180': `Full body of a generic genderless adult seen from BEHIND, head to feet. Short neutral brown hair seen from behind, NO face visible. Smooth beige body — NO clothing. Standing upright, arms relaxed at sides, heels closer to the camera than toes, the back of the head and back of the body fully visible.`,
};

const COMMON_RULES = ` Render in ${STYLE_LINE}. Pure white background (#FFFFFF). ABSOLUTELY NO TEXT, NO numbers, NO degree symbols, NO labels of any kind anywhere in the image.`;

// ────────────────────────────────────────────────────────────────────────────
// Grok call (text-to-image, /images/generations endpoint)
// ────────────────────────────────────────────────────────────────────────────
async function callGrok(systemText, userPrompt, aspectRatio = '16:9') {
  const prompt = `${systemText}\n\n${userPrompt}`.trim();
  const body = {
    model: MODEL,
    prompt,
    n: 1,
    response_format: 'b64_json',
    aspect_ratio: aspectRatio,
    resolution: '1k',
  };
  const t0 = Date.now();
  const resp = await fetch('https://api.x.ai/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) throw new Error(`Grok ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  if (!data.data || !data.data[0]?.b64_json) throw new Error('No image in Grok response');
  return { buf: Buffer.from(data.data[0].b64_json, 'base64'), ms, tokensIn: 0, tokensOut: 0 };
}

// ────────────────────────────────────────────────────────────────────────────
// Backend-aware caller
// ────────────────────────────────────────────────────────────────────────────
async function callBackend(systemText, userPrompt, aspectRatio) {
  if (BACKEND === 'grok') return callGrok(systemText, userPrompt, aspectRatio);
  return callGemini(systemText, userPrompt, aspectRatio);
}

// ────────────────────────────────────────────────────────────────────────────
// Gemini call
// ────────────────────────────────────────────────────────────────────────────
async function callGemini(systemText, userPrompt, aspectRatio = '1:1') {
  const body = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.4,
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
  const t0 = Date.now();
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const ms = Date.now() - t0;
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const finish = data.candidates?.[0]?.finishReason || 'unknown';
  const tokensIn = data.usageMetadata?.promptTokenCount ?? 0;
  const tokensOut = data.usageMetadata?.candidatesTokenCount ?? 0;
  let imageData = null;
  for (const part of (data.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData?.mimeType?.startsWith('image/')) imageData = part.inlineData;
  }
  if (!imageData) throw new Error(`no image (finish=${finish})`);
  return { buf: Buffer.from(imageData.data, 'base64'), ms, tokensIn, tokensOut };
}

const OUT_DIR = path.resolve(__dirname, '..', 'tests', '_outputs', 'phantom');
fs.mkdirSync(OUT_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

(async () => {
  if (MODE === 'single') {
    const SYSTEM = `You are creating a pose-reference template for a children's book character pipeline. The image contains exactly 8 figures of a wooden artist's mannequin arranged 2 rows × 4 columns showing 8 distinct viewing angles. Never write any text, number, panel label, or degree symbol into the image. Background is pure white. The mannequin has no face features and no clothing — it is a smooth wooden form whose only purpose is to show angle.`;
    const PROMPT = `A wide reference image divided into 2 rows × 4 columns of equal cells separated by thin black grid lines, on PURE WHITE (#FFFFFF) background.

Every cell contains the same SMOOTH WOODEN ARTIST'S MANNEQUIN: light beige jointed wooden body, NO clothing, NO anatomy details. SHORT BLACK HAIR painted on the head, TWO SMALL BLACK DOTS as eyes, small nose-stub on the head. Nothing else on the face — no mouth, no ears.

The 4 cells in each row show the mannequin ROTATING IN PLACE through one full half-turn, photographed from a single fixed camera. With each cell, the mannequin has rotated A QUARTER FURTHER, so by cell 4 it has its back to the camera. Imagine the mannequin standing on a turntable that clicks 45° between each photo:

  Cell 1: FRONT view — face fully towards camera, you see 100% of the face, both eyes, full nose, the back of the head is hidden.
  Cell 2: THREE-QUARTER view — you see about 75% of the face. The mannequin's chin is angled towards one side of the cell. The far side of the head and one ear are clearly visible BEHIND the face — that's the proof that the head has rotated. Both eyes are visible but offset to one side of the face. The nose-stub points DIAGONALLY, not straight at the camera and not perpendicular. This must look CLEARLY DIFFERENT from Cell 1 (Cell 1's face is symmetric, Cell 2's face is not) and CLEARLY DIFFERENT from Cell 3 (Cell 3 has only one eye visible, Cell 2 has both).
  Cell 3: PROFILE view — you see 50% of the face (one side only). Only ONE eye visible. Nose-stub sticks out perpendicular to the camera. Sharp silhouette of nose and chin.
  Cell 4: BACK view — you see 0% of the face. Only the back of the black hair is visible.

Cells 1 → 2 → 3 → 4 form a smooth progression — the difference between consecutive cells must be obvious. Cell 2 is HALFWAY between Cell 1 and Cell 3 and must look distinct from both.

TOP ROW (4 cells): HEAD ONLY, cropped at the neck, no shoulders, no body. Same 4 angles as described above.

BOTTOM ROW (4 cells): FULL BODY head to feet, arms relaxed at sides, feet hip-width apart. Same 4 angles. In the three-quarter cell, the leading shoulder is closer to the camera, both feet are still visible, and the chest is still partly facing the viewer.

EIGHT figures total. Render in ${STYLE_LINE}. ABSOLUTELY NO TEXT — no numbers, no degree symbols, no captions.`;
    console.log(`→ single-call phantom (${BACKEND}/${MODEL}, style=${STYLE_KEY}, aspect=16:9)…`);
    const r = await callBackend(SYSTEM, PROMPT, '16:9');
    const out = path.join(OUT_DIR, `phantom_${BACKEND}_${STYLE_KEY}_single_${STAMP}.png`);
    fs.writeFileSync(out, r.buf);
    console.log(`✓ ${out} (${r.ms}ms${r.tokensIn ? `, in=${r.tokensIn} out=${r.tokensOut}` : ''})`);
    return;
  }

  // split mode — 8 cells, one Gemini call each, tile with sharp
  const SYSTEM = `You are rendering a single pose-reference figure for a children's book character pipeline. Pure white background. The figure has neutral hair and basic face features so face direction is readable. No clothing, no accessories, no distinctive identity. NEVER write any text, number, or label into the image.`;

  const cells = [];
  let totalMs = 0, totalIn = 0, totalOut = 0;
  const order = [
    { id: 1, kind: 'head', angle: '0' },
    { id: 2, kind: 'head', angle: '45' },
    { id: 3, kind: 'head', angle: '90' },
    { id: 4, kind: 'head', angle: '180' },
    { id: 5, kind: 'body', angle: '0' },
    { id: 6, kind: 'body', angle: '45' },
    { id: 7, kind: 'body', angle: '90' },
    { id: 8, kind: 'body', angle: '180' },
  ];
  for (const c of order) {
    const userPrompt = (c.kind === 'head' ? HEAD_PROMPTS[c.angle] : BODY_PROMPTS[c.angle]) + COMMON_RULES;
    console.log(`→ cell ${c.id} (${c.kind} ${c.angle}°)…`);
    const r = await callGemini(SYSTEM, userPrompt, '1:1');
    totalMs += r.ms; totalIn += r.tokensIn; totalOut += r.tokensOut;
    const cellPath = path.join(OUT_DIR, `phantom_split_${STAMP}_cell${c.id}_${c.kind}_${c.angle}.png`);
    fs.writeFileSync(cellPath, r.buf);
    cells.push({ ...c, buf: r.buf, ms: r.ms });
    console.log(`  ✓ ${cellPath} (${r.ms}ms)`);
  }

  // Tile into 2 rows × 4 cols. Resize each cell to a uniform size.
  const CELL = 512;
  const W = CELL * 4, H = CELL * 2;
  const composites = [];
  for (const c of cells) {
    const resized = await sharp(c.buf).resize(CELL, CELL, { fit: 'cover' }).png().toBuffer();
    const idx = c.id - 1;
    const col = idx % 4, row = Math.floor(idx / 4);
    composites.push({ input: resized, left: col * CELL, top: row * CELL });
  }
  const grid = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(composites).png().toBuffer();
  const outPath = path.join(OUT_DIR, `phantom_${STYLE_KEY}_split_${STAMP}.png`);
  fs.writeFileSync(outPath, grid);
  fs.writeFileSync(outPath.replace(/\.png$/, '_meta.json'), JSON.stringify({
    mode: 'split', model: MODEL, style: STYLE_KEY, totalMs, totalTokensIn: totalIn, totalTokensOut: totalOut,
    cells: cells.map(({ buf, ...rest }) => rest),
  }, null, 2));
  console.log(`\n✓ tiled grid: ${outPath} (total ${totalMs}ms across 8 calls)`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
