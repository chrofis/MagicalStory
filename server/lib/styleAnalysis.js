/**
 * Style analysis — four read-only vision calls about how an image LOOKS.
 *
 * Split out of images.js 2026-08-09. This cluster has no inbound calls from
 * generation, evaluation or repair: it is consumed by faceRepair.js,
 * styleRepair.js, testlab.js and the regeneration routes, always through a
 * lazy require.
 *
 * `applyStyleTransfer` deliberately stayed in images.js — it calls
 * generateImageOnly, which makes it a generation function wearing a style name,
 * and moving it here would create a require cycle for no benefit.
 *
 * Every function here talks to the Gemini REST API directly and returns a
 * verdict; none of them writes anything.
 */

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');
// r2 is a leaf module (no require cycle) — `stripDataUriPrefix` is used by every
// vision call below. It was referenced as `r2Lib` without ever being required,
// so checkStyleMatch/analyzeImageStyle threw `r2Lib is not defined` on every
// call and the style-repair gate silently returned "unavailable" in production.
const r2Lib = require('./r2');

const getStoryHelpers = () => require('./storyHelpers');

const fs = require('fs');
const path = require('path');
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');

/**
 * The canonical rendered example of an art style (`server/assets/
 * style-anchor-<id>.jpg`), as a data URI. Null when the style has no asset.
 *
 * Lives here, not in character2x4Sheet.js where it started, because it is a
 * property of the STYLE, and two consumers now need it: pass-2 avatar style
 * transfer (as a reference image) and the commissioned-style repair gate (as
 * the "what the style looks like" side of checkStyleMatch). Two copies of this
 * loader would be two places to forget an asset.
 *
 * Note the anchors depict PEOPLE by design (owner, 2026-08-20) — a swatch of
 * pigment cannot show how a style renders a face. That makes them unsafe to
 * feed a generator as a plain reference (the figures can bleed into the output)
 * but ideal for checkStyleMatch, which judges rendering technique of faces and
 * figures and explicitly ignores content.
 */
function loadStyleAnchor(artStyle) {
  if (!artStyle) return null;
  const id = String(artStyle).toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const ext of ['jpg', 'png']) {
    const file = path.join(ASSETS_DIR, `style-anchor-${id}.${ext}`);
    if (fs.existsSync(file)) {
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    }
  }
  return null;
}

/**
 * Analyze the art style of an image using Gemini vision.
 * Returns a text description of the style that can be used for style transfer.
 */
async function analyzeImageStyle(imageData) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const base64Data = r2Lib.stripDataUriPrefix(imageData);
  const mimeType = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Data } },
          { text: `Analyze the art style of this illustration. Describe it in detail so another AI image generator could reproduce the same style. Include:

1. Medium/technique (watercolor, digital, oil, 3D render, etc.)
2. Line work (bold outlines, soft edges, no outlines, etc.)
3. Color palette (warm/cool, muted/vibrant, specific dominant colors)
4. Shading/lighting style (flat, cel-shaded, volumetric, chiaroscuro, etc.)
5. Level of realism (photorealistic, stylized, cartoon, abstract)
6. Texture (smooth, grainy, brush strokes visible, paper texture, etc.)
7. Overall mood/aesthetic

Output ONLY the style description as a single paragraph (3-5 sentences) that could be used as an art style prompt. No headers, no bullet points, no analysis structure — just the description.` }
        ]
      }],
      generationConfig: { maxOutputTokens: 500, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } }
    }),
    signal: AbortSignal.timeout(45_000)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini style analysis failed: ${error.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('No style analysis returned');

  log.info(`🎨 [STYLE ANALYZE] Result: ${text.substring(0, 150)}...`);
  return { style: text, usage: { input_tokens: data.usageMetadata?.promptTokenCount || 0, output_tokens: data.usageMetadata?.candidatesTokenCount || 0 } };
}

/**
 * Style-repaint gate: of the ORIGINAL and its REPAINT, is the repaint closer to
 * the commissioned style — AND did it change nothing but the rendering?
 *
 * Two questions, one call, because a repaint has to pass BOTH to be worth
 * shipping and each alone has already failed in production:
 *
 * 1. CLOSER? Replaces the old absolute `checkStyleMatch` gate, which measured
 *    each image against the anchor on its own and accepted the repaint only on
 *    a full medium-class match. That threw away every partial fix: prod
 *    job_1787514321173_gvs2ojo4o0n repainted 11 outliers, 6 were discarded —
 *    a fully photographic page among them — and the photograph shipped. The
 *    question is never "is the repaint perfect", only "is it better than what
 *    we already have"; anything else can only ever prefer the original.
 *
 * 2. UNCHANGED? A style repaint that rewrites the costume is a regression even
 *    when the style improves. Staging job_1787514666616_yw9qsv1vf p1: the
 *    repaint replaced the captain's green tricorn with a red headscarf and
 *    dropped the prop at her belt. The repair prompt already forbids this
 *    ("identical hair and clothing, add nothing and remove nothing"); nothing
 *    checked whether it obeyed. Headwear, garments, hair, held items, faces and
 *    the cast are all contract-bearing — clothing comes from the story's
 *    clothingRequirements, so a repaint may not renegotiate it.
 *
 * A colour shift IS a change here, deliberately: this judge is the only thing
 * standing between a wardrobe rewrite and the shipped book.
 *
 * @param {string} beforeImage - data-URI of the original (off-style) image
 * @param {string} afterImage - data-URI of the repaint
 * @param {Object} [opts]
 * @param {string|null} [opts.anchorImage] - data-URI of the commissioned-style anchor
 * @param {string|null} [opts.artStyleDesc] - resolved style descriptor
 * @returns {Promise<{better:'after'|'before'|'same', changed:string[], reason:string}>}
 */
async function compareStyleProximity(beforeImage, afterImage, opts = {}) {
  const { anchorImage = null, artStyleDesc = null } = opts;
  // Identical bytes never reach the judge. Asked to compare an image with
  // itself it answers "after" and invents the evidence ("IMAGE 2 exhibits more
  // visible brushstrokes") — it is told IMAGE 2 is a repaint, so it reasons
  // toward the expected answer. A no-op repaint must never displace a page,
  // and this is the one case that can be settled without a model.
  if (beforeImage && afterImage && beforeImage === afterImage) {
    return { better: 'same', changed: [], reason: 'identical image bytes — the repaint changed nothing' };
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const part = (img) => ({ inline_data: { mime_type: img.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg', data: r2Lib.stripDataUriPrefix(img) } });
  const parts = [];
  if (anchorImage) {
    parts.push({ text: 'TARGET — an illustration in the commissioned style:' }, part(anchorImage));
  }
  parts.push({ text: 'IMAGE 1 (the current illustration):' }, part(beforeImage));
  parts.push({ text: 'IMAGE 2 (a repaint of the same scene, meant to change the ART STYLE ONLY):' }, part(afterImage));
  parts.push({
    text: `Answer two questions about IMAGE 2 compared with IMAGE 1.

1. "better": which is rendered closer to ${anchorImage ? 'the TARGET\'s rendering technique' : 'this style'}${artStyleDesc ? `: ${artStyleDesc}` : ''}? Judge ONLY how people are rendered — faces, skin, hair and fabric. Painted surfaces with visible brushwork are closer; photographic skin, camera-real fabric, optical blur and lens grain are further away. Judge the STRUCTURE, not the surface: in a painted figure the form itself is built from strokes, so edges dissolve and small detail is simplified away. Grain, noise or texture laid OVER photographic structure is not brushwork — if skin pores, individual hairs and sharp specular highlights survive underneath, that figure is still photographic however textured it looks. "after" when IMAGE 2 is closer, "before" when IMAGE 1 is closer, "same" when you cannot separate them. Answering "after" or "before" requires a specific difference you can actually see and name in the reason; the two images are often the SAME image or near enough, and "same" is the correct answer then — do not infer a difference from the fact that a repaint was attempted.

2. "changed": list everything about the PEOPLE that is not the same thing in IMAGE 2 as in IMAGE 1. Only the rendering technique was allowed to change. Report an entry when a garment, hat, headwear, footwear or accessory has become a DIFFERENT item or a different colour; when hair length, style or colour differs; when a held or worn object is gone, added or swapped; when a face reads as a different person, age or expression; or when a person is added or missing. Each entry names the person and the difference, e.g. "the woman's green tricorn hat is now a red headscarf". An item that is merely painted more loosely is NOT a change. Empty list when only the rendering differs.

JSON only: {"better": "after"|"before"|"same", "changed": ["..."], "reason": "one short sentence"}`,
  });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      // Thinking ON: the change list is a careful two-image diff, not a
      // classification — a zero-budget read reports "no changes" on a swapped
      // hat. The budget must cover thinking AND the JSON: at 1200 the model
      // spent it thinking and the reply truncated mid-string, so a correctly
      // DETECTED hat swap ("the dark green tricorn hat is now a red head…")
      // died in the JSON parse and the gate reported itself unavailable.
      generationConfig: { temperature: 0, maxOutputTokens: 4000, responseMimeType: 'application/json' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Gemini style comparison failed: ${(await response.text()).substring(0, 200)}`);
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  const parsed = getStoryHelpers().extractJsonFromText(text);
  if (!parsed || !['after', 'before', 'same'].includes(parsed.better)) {
    throw new Error(`Invalid style comparison response: ${text.slice(0, 120)}`);
  }
  return {
    better: parsed.better,
    changed: Array.isArray(parsed.changed) ? parsed.changed.map(c => String(c).slice(0, 200)) : [],
    reason: String(parsed.reason || '').slice(0, 300),
  };
}

/**
 * Binary style-match check: is image B rendered in the same artistic medium/
 * stylization as image A? Built for repair gating — the numeric
 * compareImageStyles score is too lenient there (a flat-vector repaint of a
 * watercolor crop still scored 85/100 because layout/content matched; the
 * binary classification separates cleanly: watercolor→watercolor true,
 * watercolor→flat-vector false). Returns { sameStyle, styleA, styleB }.
 */
async function checkStyleMatch(imageDataA, imageDataB) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const part = (img) => ({ inline_data: { mime_type: img.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg', data: r2Lib.stripDataUriPrefix(img) } });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: 'Image A (original illustration):' },
        part(imageDataA),
        { text: 'Image B (candidate repaint of the same scene):' },
        part(imageDataB),
        { text: 'Is Image B rendered in the SAME artistic medium and stylization CLASS as Image A? The classes: painterly/watercolor, flat vector cartoon, anime/manga, 3D render, photo. Judge ONLY the rendering technique of faces and figures; content and layout differences are irrelevant. Answer false ONLY when the class differs (e.g. a flat-vector cartoon face in a watercolor scene, an anime face in a photo). Variation WITHIN a class — smoother vs more textured watercolor, more or less visible brushstrokes, softer edges — is the SAME style: answer true. JSON only: {"sameStyle": true/false, "styleA": "...", "styleB": "..."}' },
      ] }],
      generationConfig: { temperature: 0, maxOutputTokens: 300, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`Gemini style match failed: ${(await response.text()).substring(0, 200)}`);
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  const parsed = getStoryHelpers().extractJsonFromText(text);
  if (!parsed || typeof parsed.sameStyle !== 'boolean') throw new Error(`Invalid style match response: ${text.slice(0, 120)}`);
  return parsed;
}

/**
 * Head pose/expression facts for face repair — replaces the blurred pose
 * reference image: blur removes facial detail but PRESERVES silhouette, so
 * the original (possibly wrong) HAIRSTYLE leaked from the pose ref into the
 * repaint (two side pigtails instead of one ponytail). Text carries
 * direction/emotion with zero pixel leakage. The Grok repair prompt states
 * the same rules in words ("match the gaze, a head seen from behind stays
 * seen from behind") but Grok sees the whole scene; the Qwen crop has the
 * face whited out, so the facts are measured here and injected explicitly.
 * Returns { facing, headTilt, gaze, expression, mouth } (short phrases).
 */
async function describeHeadPose(imageDataUri) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: imageDataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg', data: r2Lib.stripDataUriPrefix(imageDataUri) } },
        { text: 'This crop shows one person\'s head (an illustration). Describe the head for a repainting task. All directions FROM THE VIEWER\'S PERSPECTIVE (the person\'s nose pointing toward the left edge of the image = "left"). JSON only: {"facing":"...","headTilt":"...","gaze":"...","expression":"...","mouth":"..."} — each a short phrase, e.g. "three-quarter left", "tilted slightly down", "looking down at the object in their hands", "gentle concerned smile", "closed".' },
      ] }],
      generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Gemini head-pose failed: ${(await response.text()).substring(0, 200)}`);
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  const parsed = getStoryHelpers().extractJsonFromText(text);
  if (!parsed || typeof parsed !== 'object') throw new Error(`Invalid head-pose response: ${text.slice(0, 120)}`);
  return parsed;
}

/**
 * Compare two images for art style similarity.
 * Sends both images to Gemini and returns a similarity score + breakdown.
 */
async function compareImageStyles(imageDataA, imageDataB) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');

  const toBase64 = (img) => r2Lib.stripDataUriPrefix(img);
  const getMime = (img) => img.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility || 'gemini-2.5-flash'}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: 'Image A:' },
          { inline_data: { mime_type: getMime(imageDataA), data: toBase64(imageDataA) } },
          { text: 'Image B:' },
          { inline_data: { mime_type: getMime(imageDataB), data: toBase64(imageDataB) } },
          { text: `Compare the art styles of Image A and Image B. They depict the same scene but were generated by different AI models.

Evaluate their visual style similarity (ignore content differences — focus only on artistic rendering style).

Return a JSON object:
{
  "similarity": <0-100 overall score>,
  "dimensions": {
    "medium": <0-100>,
    "colorPalette": <0-100>,
    "lineWork": <0-100>,
    "shading": <0-100>,
    "texture": <0-100>,
    "aesthetic": <0-100>
  },
  "summary": "<2-3 sentences: what matches, what differs, and specific suggestions to make them more similar>"
}

Return ONLY the JSON, no markdown fences.` }
        ]
      }],
      // thinkingBudget 0: 2.5-flash otherwise spends the small output budget
      // on thinking and returns empty text. responseMimeType enforces JSON.
      generationConfig: { maxOutputTokens: 1024, temperature: 0.2, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }
    }),
    signal: AbortSignal.timeout(45_000)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini style comparison failed: ${error.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('No style comparison returned');

  // Parse JSON from response (handle markdown fences)
  let parsed = getStoryHelpers().extractJsonFromText(text);
  if (!parsed || typeof parsed.similarity !== 'number') {
    // Fallback: try stripping fences manually and parsing
    const stripped = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      log.error(`🎨 [STYLE COMPARE] Failed to parse response (${text.length} chars): ${text.substring(0, 500)}`);
      throw new Error(`Invalid style comparison response — see server logs`);
    }
  }

  log.info(`🎨 [STYLE COMPARE] Similarity: ${parsed.similarity}/100 — ${parsed.summary?.substring(0, 100)}`);
  return parsed;
}


module.exports = {
  analyzeImageStyle,
  loadStyleAnchor,
  checkStyleMatch,
  compareStyleProximity,
  describeHeadPose,
  compareImageStyles,
};
