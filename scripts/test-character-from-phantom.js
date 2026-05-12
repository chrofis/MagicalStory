#!/usr/bin/env node
/**
 * Character reference sheet using the phantom as a POSE TEMPLATE.
 *
 * Inputs:
 *   - Phantom 2×4 pose grid (the approved mannequin reference sheet)
 *   - Character face photo
 *
 * Output: 2×4 reference sheet of the SAME character, matching the
 * phantom's 8 angles, in the requested art style and costume.
 *
 * Tries Grok and/or Gemini per --backend flag, ONE call each.
 *
 * Usage:
 *   node scripts/test-character-from-phantom.js \
 *     --face=tests/fixtures/demo-photos/berger/Hans.jpg \
 *     --phantom=tests/_outputs/phantom/phantom_grok_watercolor_single_2026-05-11-20-08-16.png \
 *     --costume="pirate costume, white shirt, red sash, dark breeches" \
 *     --style=watercolor \
 *     --backend=both
 */

'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

function arg(name, dflt = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : dflt;
}

const FACE_PATH = arg('face');
const AVATAR_2X2_PATH = arg('avatar2x2');
const PHANTOM_PATH = arg('phantom', 'tests/_outputs/phantom/phantom_grok_watercolor_single_2026-05-11-20-08-16.png');
const COSTUME = arg('costume', 'pirate costume, white shirt, red sash, dark breeches, brown boots');
const STYLE_KEY = arg('style', 'watercolor');
const NAME = arg('name', FACE_PATH ? path.basename(FACE_PATH, path.extname(FACE_PATH)) : 'character');
const BACKEND = arg('backend', 'both'); // grok | gemini | both

if (!FACE_PATH || !fs.existsSync(FACE_PATH)) { console.error('--face missing or not found'); process.exit(1); }
if (!fs.existsSync(PHANTOM_PATH)) { console.error(`--phantom not found: ${PHANTOM_PATH}`); process.exit(1); }
if (AVATAR_2X2_PATH && !fs.existsSync(AVATAR_2X2_PATH)) { console.error(`--avatar2x2 not found: ${AVATAR_2X2_PATH}`); process.exit(1); }

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const XAI_API_KEY = process.env.XAI_API_KEY;

const STYLE_LINE = {
  'watercolor': "soft watercolor children's storybook illustration style — gentle washes, simple outlines",
  'pixar':      "Pixar 3D illustration style — smooth shading, clean rim light",
  'anime':      "anime line-art style — clean lines, flat shading",
}[STYLE_KEY] || "soft watercolor children's storybook style";

function readAsBase64(p) {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { base64: buf.toString('base64'), mime, dataUri: `data:${mime};base64,${buf.toString('base64')}` };
}

const face = readAsBase64(FACE_PATH);
const phantom = readAsBase64(PHANTOM_PATH);
const avatar2x2 = AVATAR_2X2_PATH ? readAsBase64(AVATAR_2X2_PATH) : null;

const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const OUT_DIR = path.resolve(__dirname, '..', 'tests', '_outputs', 'character-from-phantom', `${STAMP}__${NAME}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

// ────────────────────────────────────────────────────────────────────────────
// Shared prompt
// ────────────────────────────────────────────────────────────────────────────
const VARIANT = arg('variant', 'base');

// ────────────────────────────────────────────────────────────────────────────
// Three prompt variants — each describes the SAME 2×4 character sheet but
// frames the task differently. The cell-2 three-quarter view and cell-4
// back-view are the recurring failure points; each variant attacks them
// from a different angle.
// ────────────────────────────────────────────────────────────────────────────
const PROMPTS = {
  // BASE — the prompt we used previously. Reference for comparison.
  base: `You are given THREE reference images:
  Image 1 (POSE TEMPLATE): a 2×4 grid of a wooden mannequin showing 8 viewing angles. Top row = 4 head-only views, bottom row = 4 full-body views. In each row the figure rotates from front → three-quarter → profile → back. COPY THE EXACT ANGLE FROM EACH CELL OF IMAGE 1 into the corresponding cell of your output.
  Image 2 (STYLED 2×2 AVATAR): the existing 2×2 character sheet. Use this image as the authoritative reference for costume colours, costume shape, and the rendered art style of the body row.
  Image 3 (CHARACTER PHOTO): the person's face photo. Authoritative reference for face identity, hair colour, skin tone.

Produce a NEW 2×4 grid that matches Image 1's layout exactly (thin black dividing lines, pure white background, 2 rows × 4 columns).

Top row = head only, cropped at the neck, no shoulders, no clothing visible.
Bottom row = full body head to feet, arms at sides, wearing the costume from Image 2 (${COSTUME}).

Render in ${STYLE_LINE}. Identity from Image 3, costume from Image 2, angles + layout from Image 1. ABSOLUTELY NO TEXT.`,

  // VARIANT A — "paint-by-numbers": treat the phantom as a fillable template.
  // Each mannequin is a placeholder; replace its wood with the character but
  // keep the silhouette/pose untouched.
  a: `Treat Image 1 (POSE TEMPLATE) as a paint-by-numbers template. The wooden mannequin in each of its 8 cells defines a POSE and an ANGLE. Your job is to REPLACE the mannequin in each cell with the character from Images 2 and 3 while keeping the mannequin's exact silhouette, pose, and head/body direction unchanged.

Image 2 (STYLED 2×2 AVATAR) — authoritative reference for the costume worn in the bottom row and the art style of the rendering.
Image 3 (CHARACTER PHOTO) — authoritative reference for the face identity.

Output a 2×4 grid with thin black dividing lines and pure white background, same dimensions and cell layout as Image 1.

Cell-by-cell content:
  Cell 1 (top-left): the character's head and neck only, facing the camera straight on. No shoulders, no clothing.
  Cell 2 (top): head and neck only, in the SAME three-quarter angle as Image 1's cell 2 — both eyes still visible, head clearly rotated. No shoulders, no clothing.
  Cell 3 (top): head and neck only, in the SAME profile angle as Image 1's cell 3 — one eye, sharp side silhouette. No shoulders, no clothing.
  Cell 4 (top-right): BACK OF THE HEAD ONLY — the camera is behind the character. The viewer sees the BACK of the hair, the BACK of the neck, and nothing of the face. NO eye, NO nose, NO mouth, NO hat, NO clothing. Match cell 4 of Image 1.
  Cell 5 (bottom-left): full body from head to feet in the costume — ${COSTUME}. Every costume element from Image 2 (especially headwear if Image 2 shows one) must be present here. Facing the camera straight on.
  Cell 6 (bottom): full body in the SAME costume, in the SAME three-quarter angle as Image 1's cell 6 — leading shoulder forward, both feet visible, chest partly facing the viewer. Same hat and accessories as cell 5.
  Cell 7 (bottom): full body in the SAME costume, in the SAME profile angle as Image 1's cell 7. Same hat and accessories as cell 5.
  Cell 8 (bottom-right): FULL BODY BACK VIEW — camera is behind the character. The viewer sees the BACK of the costume: back of the hat, back of the shirt, sash tied behind, back of the breeches, back of the boots, heels closer to camera than toes. Match cell 8 of Image 1.

Costume continuity is mandatory: cells 5, 6, 7, and 8 must show the SAME costume worn by the character — every accessory (hat, sash, etc.) visible in cell 5 must also appear in cells 6, 7, and 8.

Render in ${STYLE_LINE}. ABSOLUTELY NO TEXT — no numbers, no degree symbols, no labels.`,

  // VARIANT B — strict per-cell description with no row abstraction.
  // Removes the "row" framing in favour of 8 explicit cell specifications,
  // each declaring what the camera sees.
  b: `Render an 8-cell character reference sheet (2 rows × 4 columns, thin black dividing lines, pure white background, 16:9 image).

You have THREE reference images: Image 1 = pose template (2×4 mannequin grid), Image 2 = styled 2×2 character sheet showing the costume and rendered style, Image 3 = the person's face photo.

For each cell below, the WHOLE FIGURE described must appear, framed and angled exactly as written. Same character (face from Image 3) in every cell. Cells 5–8 wear the costume from Image 2: ${COSTUME}.

CELL 1 (top-left): head + neck. Camera sees both eyes equally far from centre, full nose, full mouth, no clothing.
CELL 2 (top, 2nd from left): head + neck. Camera sees three-quarters of the face — both eyes visible but the further eye sits near the cheek edge; the nose points diagonally off-centre, not straight; the far side of the head and the further ear are visible BEHIND the face. NO clothing. Distinctly different from cell 1 (asymmetric face) and from cell 3 (both eyes still visible).
CELL 3 (top, 3rd from left): head + neck. Camera sees the side of the face — only one eye visible, the far eye fully hidden, nose sticking out perpendicular to the camera as a clear silhouette. No clothing.
CELL 4 (top-right): head + neck. CAMERA IS BEHIND THE CHARACTER. The viewer sees only the back of the head — back of the hair, back of the neck. The face is fully hidden. NO eye, NO nose, NO mouth, NO ear in front, NO hat, NO costume. Match the back-of-head pose in cell 4 of Image 1.
CELL 5 (bottom-left): full body, head to feet, facing camera. Wearing the COMPLETE costume from Image 2 — hat, shirt, sash, breeches, boots — every accessory present.
CELL 6 (bottom, 2nd from left): full body, three-quarter view. Same costume as cell 5 with every accessory. Leading shoulder forward, chest still partly facing camera, both feet still visible. Clearly NOT a profile (chest still visible to camera).
CELL 7 (bottom, 3rd from left): full body, profile view. Same costume as cell 5. Only one shoulder visible from the front; both feet point the same direction.
CELL 8 (bottom-right): full body, BACK VIEW. CAMERA IS BEHIND THE CHARACTER. Same costume as cell 5 seen from behind — back of the hat, back of the shirt collar, sash tied behind the body, back of the breeches, back of the boots, heels closer to camera than toes. NO face visible.

Identity from Image 3. Costume + art style from Image 2. Layout + per-cell angles from Image 1. Render in ${STYLE_LINE}. ABSOLUTELY NO TEXT — no numbers, no degree symbols, no labels.`,
};

const PROMPT_BASE_NO_AVATAR = `You are given two reference images:
  Image 1 (POSE TEMPLATE): a 2×4 grid of a wooden mannequin showing 8 distinct viewing angles — top row is 4 head-only views (front, 45° right, profile 90°, back), bottom row is 4 full-body views (same four angles). Use this image ONLY to determine angles and layout — do not copy the mannequin's wood texture or featureless face.
  Image 2 (CHARACTER IDENTITY): a photograph of the person whose face, hair, build, and skin tone must be matched exactly.

Render a NEW reference sheet that follows the EXACT 2×4 grid layout of Image 1 (thin black dividing lines between cells, pure white background). Every cell shows the same person from Image 2 at the angle shown in the corresponding cell of Image 1.

Top row — head only (cropped at the neck, no shoulders, no clothing visible).
  Cell 1: head front. Cell 2: head 45° three-quarter right. Cell 3: head strict profile 90° right. Cell 4: back of head (only hair visible).

Bottom row — full body, head to feet, standing upright, arms relaxed at sides.
  Cell 5: full body front. Cell 6: full body 45° three-quarter right. Cell 7: full body strict profile 90° right. Cell 8: full body back view.

Bottom row clothing: ${COSTUME}.

Render in ${STYLE_LINE}. Identity (face, hair colour, build) must match Image 2 across all 8 cells. Angle must match the corresponding cell of Image 1. ABSOLUTELY NO TEXT in the output — no numbers, no degree symbols, no labels.`;

const PROMPT = avatar2x2 ? (PROMPTS[VARIANT] || PROMPTS.base) : PROMPT_BASE_NO_AVATAR;
console.log(`Variant: ${VARIANT} (${PROMPT.length} chars)`);

// ────────────────────────────────────────────────────────────────────────────
// Gemini
// ────────────────────────────────────────────────────────────────────────────
async function runGemini() {
  if (!GEMINI_API_KEY) { console.error('  - GEMINI_API_KEY missing, skipping'); return null; }
  const SYSTEM = `You are an expert character artist creating a children's book character reference sheet. You will receive two reference images and produce a new 2×4 grid that copies the layout and angles from the first image and the identity/face from the second image. Never write any text into the output image.`;
  const parts = [
    { text: '[Image 1 — POSE TEMPLATE: 2×4 grid showing 8 mannequin angles]' },
    { inline_data: { mime_type: phantom.mime, data: phantom.base64 } },
  ];
  if (avatar2x2) {
    parts.push({ text: '[Image 2 — STYLED 2×2 AVATAR: copy costume colours/shape + body-row art style from here]' });
    parts.push({ inline_data: { mime_type: avatar2x2.mime, data: avatar2x2.base64 } });
    parts.push({ text: '[Image 3 — CHARACTER PHOTO: match this face identity]' });
    parts.push({ inline_data: { mime_type: face.mime, data: face.base64 } });
  } else {
    parts.push({ text: '[Image 2 — CHARACTER IDENTITY: match this face/hair/build]' });
    parts.push({ inline_data: { mime_type: face.mime, data: face.base64 } });
  }
  parts.push({ text: PROMPT });
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.4,
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: { aspectRatio: '16:9' },
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  console.log(`→ Gemini call…`);
  const t0 = Date.now();
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const ms = Date.now() - t0;
  if (!resp.ok) { console.error(`  ✗ Gemini ${resp.status}:`, (await resp.text()).slice(0, 300)); return null; }
  const data = await resp.json();
  const finish = data.candidates?.[0]?.finishReason || 'unknown';
  let imgData = null;
  const textBits = [];
  for (const part of (data.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData?.mimeType?.startsWith('image/')) imgData = part.inlineData;
    else if (part.text) textBits.push(part.text);
  }
  if (!imgData) {
    console.error(`  ✗ Gemini: no image (finish=${finish}, text="${textBits.join(' ').slice(0, 200)}")`);
    return null;
  }
  const outPath = path.join(OUT_DIR, `gemini.png`);
  fs.writeFileSync(outPath, Buffer.from(imgData.data, 'base64'));
  console.log(`  ✓ Gemini in ${ms}ms → ${outPath}`);
  return { path: outPath, ms };
}

// ────────────────────────────────────────────────────────────────────────────
// Grok (edit endpoint — accepts ref images)
// ────────────────────────────────────────────────────────────────────────────
async function runGrok() {
  if (!XAI_API_KEY) { console.error('  - XAI_API_KEY missing, skipping'); return null; }
  // Grok /images/edits — JSON body with images array of { url: dataURI, type: 'image_url' }.
  // Slot 1 = phantom pose template, slot 2 = character face photo.
  const refs = [{ url: phantom.dataUri, type: 'image_url' }];
  if (avatar2x2) refs.push({ url: avatar2x2.dataUri, type: 'image_url' });
  refs.push({ url: face.dataUri, type: 'image_url' });
  const body = {
    model: 'grok-imagine-image',
    prompt: PROMPT,
    response_format: 'b64_json',
    aspect_ratio: '16:9',
    images: refs,
  };
  console.log(`→ Grok call (${refs.length} refs: phantom${avatar2x2 ? ' + 2×2 avatar' : ''} + face)…`);
  const t0 = Date.now();
  const resp = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) { console.error(`  ✗ Grok ${resp.status}:`, (await resp.text()).slice(0, 300)); return null; }
  const data = await resp.json();
  if (!data.data || !data.data[0]?.b64_json) { console.error('  ✗ Grok: no image in response'); return null; }
  const outPath = path.join(OUT_DIR, `grok.png`);
  fs.writeFileSync(outPath, Buffer.from(data.data[0].b64_json, 'base64'));
  console.log(`  ✓ Grok in ${ms}ms → ${outPath}`);
  return { path: outPath, ms };
}

(async () => {
  fs.writeFileSync(path.join(OUT_DIR, 'prompt.txt'), PROMPT);
  fs.writeFileSync(path.join(OUT_DIR, 'inputs.json'), JSON.stringify({
    face: FACE_PATH, phantom: PHANTOM_PATH, costume: COSTUME, style: STYLE_KEY, name: NAME, backend: BACKEND,
  }, null, 2));

  const results = {};
  if (BACKEND === 'grok' || BACKEND === 'both') results.grok = await runGrok();
  if (BACKEND === 'gemini' || BACKEND === 'both') results.gemini = await runGemini();

  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(`\nOutput dir: ${OUT_DIR}`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
