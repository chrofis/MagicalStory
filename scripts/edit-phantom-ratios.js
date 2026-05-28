#!/usr/bin/env node
/**
 * Derive age-tier phantom mannequins by EDITING the existing phantom, instead
 * of generating each tier from scratch (the from-scratch route produced
 * inconsistent sheets that were rejected).
 *
 * Input:  server/assets/phantom-watercolor.png  (the trusted 2×4 mannequin grid,
 *         currently ~4 head-heights = toddler/chibi proportions)
 * Method: one Gemini image-edit call per tier — feed the existing grid in and
 *         re-proportion ONLY the bottom-row full-body mannequins to the tier's
 *         head-to-body ratio, keeping the top-row heads, wood look, hair, style,
 *         grid layout and camera angles identical. The original top half (heads)
 *         is composited back over the result as a safety net so heads never drift.
 * Output: drafts/phantoms/phantom_edit_<tier>_<stamp>.png  (+ _meta.json)
 *         toddler tier = a verbatim copy of the source (already toddler ratio).
 *
 * Usage:
 *   node scripts/edit-phantom-ratios.js              # all tiers
 *   node scripts/edit-phantom-ratios.js --age=adult  # one tier
 *
 * These are DRAFTS — review, then promote approved ones to approved/phantoms/
 * and copy into server/assets/phantom-watercolor-<tier>.png.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash-image';
if (!GEMINI_API_KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

const arg = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

const SRC = path.resolve(__dirname, '..', 'server', 'assets', 'phantom-watercolor.png');
const OUT_DIR = path.resolve(__dirname, '..', 'drafts', 'phantoms');
const STAMP = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);

// targetRatio = head-heights (body is ~N heads tall). Source is ~4 (toddler).
const TIERS = {
  toddler: { ratio: 4,   descriptor: 'a 1–3 year old toddler (large head, short rounded limbs)', edit: false },
  child:   { ratio: 5.5, descriptor: 'a 5–9 year old child (medium head, slim balanced torso and limbs)', edit: true },
  teen:    { ratio: 7,   descriptor: 'a 12–16 year old adolescent (smaller head, longer legs, lean build)', edit: true },
  adult:   { ratio: 7.5, descriptor: 'a fully grown adult (small head relative to body, long legs, balanced adult build)', edit: true },
};

function buildEditPrompt(t) {
  // Framing matters: an "edit / keep identical" instruction makes Gemini redraw
  // the same stubby toddler. Instead ask it to GENERATE a fresh grid at the
  // target ratio, using the attached image only as a STYLE reference.
  return `Use the attached image only as a STYLE reference — copy its wooden artist's-mannequin material and colour, dark hair, simple face, soft watercolor storybook look, pure white background, and its 2×4 grid layout (top row = four head-and-shoulders views; bottom row = four full-body views at front, three-quarter, profile, back angles).

Now GENERATE a NEW 2×4 reference grid in that exact style, but with completely different BODY proportions: the four full-body mannequins in the bottom row must be ${t.descriptor}, with a head-to-body ratio of ${t.ratio} (the head fits ${t.ratio} times into the full standing height).

The attached reference is a stubby toddler at only ~4 head-heights. Yours MUST look clearly different and unmistakably ${t.ratio}-heads-tall: a noticeably SMALLER head, a LONGER torso, and much LONGER legs, the whole figure tall and slender and standing at full height filling the cell. Do not copy the reference's short stubby proportions. The mannequin is a non-anatomical jointed wooden drawing dummy — no skin, no anatomy. Never draw any text, number, or label.`;
}

async function geminiEdit(srcB64, prompt) {
  const body = {
    contents: [{ parts: [
      { inlineData: { mimeType: 'image/png', data: srcB64 } },
      { text: prompt },
    ] }],
    generationConfig: {
      temperature: 0.55,
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
  const t0 = Date.now();
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const ms = Date.now() - t0;
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const finish = data.candidates?.[0]?.finishReason || 'unknown';
  let img = null;
  for (const part of (data.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData?.mimeType?.startsWith('image/')) img = part.inlineData;
  }
  if (!img) throw new Error(`no image (finish=${finish})`);
  return { buf: Buffer.from(img.data, 'base64'), ms };
}

(async () => {
  if (!fs.existsSync(SRC)) { console.error(`Source phantom missing at ${SRC}`); process.exit(1); }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const srcMeta = await sharp(SRC).metadata();
  const W = srcMeta.width, H = srcMeta.height;          // 1408 × 768
  const srcBuf = fs.readFileSync(SRC);
  const srcB64 = srcBuf.toString('base64');
  // Original top half (heads) — restored over each edit so heads never drift.
  const topHalf = await sharp(srcBuf).extract({ left: 0, top: 0, width: W, height: Math.floor(H / 2) }).png().toBuffer();

  const only = arg('age', null);
  const tiers = only ? [only] : Object.keys(TIERS);

  for (const tier of tiers) {
    const t = TIERS[tier];
    if (!t) { console.error(`unknown tier ${tier}`); continue; }
    const outPath = path.join(OUT_DIR, `phantom_edit_${tier}_${STAMP}.png`);
    let finalBuf, ms = 0, note;

    if (!t.edit) {
      // Toddler already matches the source ratio — copy verbatim.
      finalBuf = await sharp(srcBuf).resize(W, H, { fit: 'fill' }).png().toBuffer();
      note = 'copy-of-source (already toddler ratio)';
      console.log(`→ ${tier}: ${note}`);
    } else {
      console.log(`→ ${tier}: editing source → ${t.ratio} head-heights…`);
      const r = await geminiEdit(srcB64, buildEditPrompt(t));
      ms = r.ms;
      // Normalise to source dimensions, then restore the original heads row.
      const edited = await sharp(r.buf).resize(W, H, { fit: 'fill' }).png().toBuffer();
      finalBuf = await sharp(edited)
        .composite([{ input: topHalf, left: 0, top: 0 }])
        .png().toBuffer();
      note = `gemini-edit + original-heads restore (${ms}ms)`;
      console.log(`  ✓ ${note}`);
    }

    fs.writeFileSync(outPath, finalBuf);
    fs.writeFileSync(outPath.replace(/\.png$/, '_meta.json'), JSON.stringify({
      method: t.edit ? 'gemini-edit-from-existing' : 'copy-of-source',
      source: 'server/assets/phantom-watercolor.png',
      model: t.edit ? MODEL : null,
      tier, targetRatio: t.ratio, descriptor: t.descriptor, ms, note,
    }, null, 2));
    console.log(`  saved ${outPath}`);
  }
  console.log(`\nDone. Review drafts in ${OUT_DIR} (phantom_edit_*_${STAMP}.png).`);
})().catch(err => { console.error('FATAL:', err); process.exit(1); });
