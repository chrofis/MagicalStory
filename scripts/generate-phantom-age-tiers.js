#!/usr/bin/env node
/**
 * Generate age-tiered phantom reference sheets (2 rows × 4 columns).
 *
 * Same as scripts/test-phantom-generate.js --mode=split, but the BODY
 * prompts include explicit head:body ratio instructions per age tier so
 * the downstream Grok edit fusion inherits the right proportions
 * (existing phantom-watercolor.png is ~1:4.2, i.e. toddler chibi, which
 * leaks into every character regardless of declared age).
 *
 * Usage:
 *   node scripts/generate-phantom-age-tiers.js --age=toddler
 *   node scripts/generate-phantom-age-tiers.js --age=child
 *   node scripts/generate-phantom-age-tiers.js --age=teen
 *   node scripts/generate-phantom-age-tiers.js --age=adult
 *
 * Output: drafts/phantoms/phantom_watercolor_split_<age>_<stamp>.png
 * (Does NOT touch server/assets/phantom-watercolor.png — drafts only,
 * per feedback_drafts_approved_folders.md.)
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

const AGE = arg('age', 'adult');
const STYLE_KEY = arg('style', 'watercolor');
const MODEL = arg('model', 'gemini-2.5-flash-image');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY missing'); process.exit(1); }

const AGE_CONFIG = {
  toddler: {
    ratio: 4,
    descriptor: 'toddler-proportioned',
    ratioInstruction: 'PROPORTIONS: head height is approximately 1/4 of total figure height (head fits ~4 times into the figure\'s total height). Large head, short limbs, rounded body, short legs — like a 1–3 year old child mannequin.',
  },
  child: {
    ratio: 5.5,
    descriptor: 'child-proportioned',
    ratioInstruction: 'PROPORTIONS: head height is approximately 1/5.5 of total figure height (head fits ~5.5 times into the figure\'s total height). Medium-sized head, slim torso, balanced arms and legs — like a school-age child mannequin (5–9 years).',
  },
  teen: {
    ratio: 7,
    descriptor: 'teen-proportioned',
    ratioInstruction: 'PROPORTIONS: head height is approximately 1/7 of total figure height (head fits ~7 times into the figure\'s total height). Smaller head relative to body, longer legs, lean adolescent build — like a 12–16 year old mannequin.',
  },
  adult: {
    ratio: 7.5,
    descriptor: 'adult-proportioned',
    ratioInstruction: 'PROPORTIONS: head height is approximately 1/7.5 of total figure height (head fits ~7.5 times into the figure\'s total height). Long legs, balanced torso, fully developed adult mannequin proportions.',
  },
};

const CFG = AGE_CONFIG[AGE];
if (!CFG) {
  console.error(`Unknown age "${AGE}". Use one of: ${Object.keys(AGE_CONFIG).join(', ')}`);
  process.exit(1);
}

const STYLE_LINE = {
  'watercolor': "soft watercolor children's storybook illustration style — gentle washes, simple outlines",
  'pixar':      "Pixar 3D illustration style — smooth shading, clean rim light",
  'anime':      "anime line-art style — clean lines, flat shading",
  'sketch':     "simple pencil sketch, light grey lines, minimal shading",
}[STYLE_KEY] || "soft watercolor children's storybook style";

// HEAD prompts: unchanged from the parent script — these are headshots
// so head:body ratio doesn't apply. Keep neutral adult descriptors so the
// face-fusion downstream still works identically.
const HEAD_PROMPTS = {
  '0':   `Head and neck ONLY of a generic genderless person — short neutral brown hair, simple eyes, a simple mouth, neutral skin tone. NO shoulders, NO body, NO clothing. Facing the camera STRAIGHT FRONT (0°): both eyes equally visible, nose centred, mouth horizontal.`,
  '45':  `Head and neck ONLY of a generic genderless person — short neutral brown hair, simple eyes, a simple mouth, neutral skin tone. NO shoulders, NO body, NO clothing. THREE-QUARTER view, head ROTATED 45° to the camera's right: the nose clearly points OFF to the right but is not in pure profile, BOTH EYES are visible but the right eye sits at the cheek edge; the left eye is more centred. Think of a Renaissance portrait three-quarter pose — not front, not profile, but halfway between.`,
  '90':  `Head and neck ONLY of a generic genderless person — short neutral brown hair, simple eyes, a simple mouth, neutral skin tone. NO shoulders, NO body, NO clothing. Strict SIDE PROFILE, head turned 90° to the camera's right: only ONE eye visible, the nose points perpendicular to the camera, the silhouette of the nose, lips, and chin is clearly defined against the white background.`,
  '180': `BACK of the head only — short neutral brown hair seen from behind. NO face, NO eyes, NO nose, NO mouth, NO shoulders, NO body, NO clothing. The viewer sees the rear of the hair, ears either symmetrically visible at the sides or hidden by hair.`,
};

// BODY prompts: per-age ratio instruction injected at the start.
// Framed as a wooden artist's mannequin / posing dummy (no anatomy, no skin)
// so Gemini safety doesn't flag it as nudity. This matches the existing
// phantom-watercolor.png framing and works through IMAGE_SAFETY filters.
const MANNEQUIN_BASE = `a SMOOTH WOODEN ARTIST'S POSING MANNEQUIN — light beige varnished wood, jointed wooden body like a drawing-reference dummy used by art students, NO anatomical details, NO skin texture, NO genitalia, NO nipples, NO navel — just a smooth featureless wooden form. Short neutral brown hair painted on the head, two small dots for eyes, a small line for a mouth. The mannequin is ${CFG.descriptor} (size and segment lengths match the proportion rule below).`;
const BODY_PROMPTS = {
  '0':   `Full body of ${MANNEQUIN_BASE} Standing upright, head to feet, arms relaxed at sides, feet roughly hip-width apart. Facing the camera STRAIGHT FRONT (0°): symmetric stance, both feet point at the camera, both arms equally visible. ${CFG.ratioInstruction} The ENTIRE mannequin from the top of the head to the soles of the feet must fit within the frame, with small margins of pure white above the head and below the feet.`,
  '45':  `Full body of ${MANNEQUIN_BASE} Standing upright, head to feet, arms relaxed at sides. THREE-QUARTER view, body ROTATED 45° to the camera's right: the right shoulder is closer to the camera and the left shoulder is partly behind it; both feet are visible but the right foot points more toward the camera than the left. Clearly NOT a pure side profile — the front of the torso is still partly facing the viewer at an angle. ${CFG.ratioInstruction} The ENTIRE mannequin from the top of the head to the soles of the feet must fit within the frame, with small margins of pure white above the head and below the feet.`,
  '90':  `Full body of ${MANNEQUIN_BASE} Standing upright, head to feet, arms relaxed at sides. Strict SIDE PROFILE, body turned 90° to the camera's right: only one shoulder visible at the front, the other directly behind it; both feet point fully to the right. ${CFG.ratioInstruction} The ENTIRE mannequin from the top of the head to the soles of the feet must fit within the frame, with small margins of pure white above the head and below the feet.`,
  '180': `Full body of ${MANNEQUIN_BASE} Seen from BEHIND, head to feet. NO face visible. Standing upright, arms relaxed at sides, heels closer to the camera than toes, the back of the head and back of the body fully visible. ${CFG.ratioInstruction} The ENTIRE mannequin from the top of the head to the soles of the feet must fit within the frame, with small margins of pure white above the head and below the feet.`,
};

const COMMON_RULES = ` Render in ${STYLE_LINE}. Pure white background (#FFFFFF). ABSOLUTELY NO TEXT, NO numbers, NO degree symbols, NO labels of any kind anywhere in the image.`;

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

const OUT_DIR = path.resolve(__dirname, '..', 'drafts', 'phantoms');
fs.mkdirSync(OUT_DIR, { recursive: true });
const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

(async () => {
  console.log(`\n=== Generating phantom for age tier: ${AGE} (target ratio 1:${CFG.ratio}) ===\n`);

  const SYSTEM = `You are rendering a single pose-reference figure for an art-class drawing-reference template. For top-row HEAD prompts, render a simple genderless human head and shoulders. For bottom-row BODY prompts, render a wooden artist's posing mannequin — a non-anatomical drawing dummy used in art schools, with no skin, no anatomy, no genitalia, no nipples — just smooth jointed wood. The mannequin's proportions represent a ${CFG.descriptor} body so artists can reference correct head-to-body ratios. Pure white background. NEVER write any text, number, or label into the image.`;

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
    cells.push({ ...c, buf: r.buf, ms: r.ms });
    console.log(`  ✓ ${r.ms}ms`);
  }

  // Tile into 2 rows × 4 cols. Same dimensions as parent script (CELL=512, W=2048, H=1024)
  // but we'll match the existing phantom's 1408×768 by resizing the final grid.
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

  // Resize to match existing phantom-watercolor.png dimensions (1408×768) so
  // downstream code that hard-codes phantom size keeps working when a draft
  // is promoted to server/assets/.
  const final = await sharp(grid).resize(1408, 768, { fit: 'fill' }).png().toBuffer();

  const outPath = path.join(OUT_DIR, `phantom_${STYLE_KEY}_split_${AGE}_${STAMP}.png`);
  fs.writeFileSync(outPath, final);
  fs.writeFileSync(outPath.replace(/\.png$/, '_meta.json'), JSON.stringify({
    mode: 'split', model: MODEL, style: STYLE_KEY, age: AGE,
    targetRatio: CFG.ratio, ratioInstruction: CFG.ratioInstruction,
    totalMs, totalTokensIn: totalIn, totalTokensOut: totalOut,
    cells: cells.map(({ buf, ...rest }) => rest),
  }, null, 2));
  console.log(`\n✓ ${outPath}`);
  console.log(`  total: ${totalMs}ms across 8 Gemini calls (in=${totalIn}, out=${totalOut})`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
