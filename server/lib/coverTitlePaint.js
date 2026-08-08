// Painted cover title — the title is repainted by an image model so it looks
// hand-made in the artwork's medium, instead of reading as a flat graphic.
//
// ARCHITECTURE (settled after Test Lab exps #311-#359; docs/cover-text-rendering-research.md):
// the model NEVER sees the cover it is editing. It is given the artwork only as a
// style reference and the title alone on a plain WHITE SQUARE canvas, and paints
// the lettering there. Extraction is then a key on "inkiness", not a detection
// problem, and the cover artwork is never re-rendered — faces and background are
// untouched pixels by construction.
//
// Everything else was tried and failed: restyling on the cover and cutting the
// letters out (diff masks, solved alpha, SAM, colour selection, connected
// components) always traded a missed letter pixel for an admitted background
// pixel, because on a re-rendered frame "letter or artwork" has no clean answer
// when pigment and scene share a palette.
//
// Spelling is safe by construction: the glyphs come from a real font via
// composeCover; the model only restyles them. One FINAL EVAL then verifies the
// result — given the expected text AND the image, it answers whether they match
// (a comparison, which a VLM does well) rather than transcribing stylised
// lettering cold (which it did worse than the thing it was checking). Shape
// coverage/spill are computed alongside as diagnostics. Any failure falls back to
// the flat composite, which is always correct and legible.

const sharp = require('sharp');
const { log } = require('../utils/logger');

const PLATE_PROMPT = (styleTxt, strictEmptyPage = true) => `The image is a book title on a plain white page.${strictEmptyPage ? ' Nothing else is on the page and nothing else may be added.' : ''} Repaint the LETTERING so it looks hand-painted in the medium of the reference artwork: visible brush and paper texture inside every stroke, pigment pooling darker at the stroke edges, slightly irregular hand-made contours. You may change the lettering colour to one that suits the artwork.
Keep the same words, letters, letterforms, size and positions. Keep EXACTLY the same number of lines and the same line breaks — do not re-wrap the title, do not move words to another line, do not resize it to fill the canvas.
${strictEmptyPage
  ? 'The rest of the page stays PURE WHITE and completely empty: no people, no objects, no scenery, no illustration, no background wash, no border or frame. Only the letters may be painted.'
  : 'Put the lettering back on a plain white background — do not paint any scenery, do not draw the illustration, do not add a border or a frame.'}${styleTxt ? ` Medium of the artwork: ${styleTxt}` : ''}`;


/**
 * FINAL EVAL — verification, not transcription. The model is given the expected
 * title AND the painted image and asked whether they match. That is a comparison
 * task, which a VLM does reliably; the previous gate asked it to READ stylised
 * lettering cold, which it did worse than the thing it was checking (it misread
 * correct titles as wrong and suppressed good repaints).
 * Returns { matches, problem }. Throws only on transport/parse failure.
 */
async function verifyTitleRender(imageDataUri, expectedTitle) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const { MODEL_DEFAULTS } = require('../config/models');
  const r2 = require('./r2');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_DEFAULTS.utility}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: imageDataUri.match(/^data:(image\/\w+);base64,/)?.[1] || 'image/jpeg', data: r2.stripDataUriPrefix(imageDataUri) } },
          { text: `This is a children's book cover. The title is supposed to read exactly:

"${expectedTitle}"

Look at the title lettering in the image and answer:
1. Does it show exactly these words, in this order, with no missing, extra, doubled or altered letters?
2. Is every letter fully drawn and legible (not cut off, smeared or replaced by a shape)?
Decorative styling, texture, colour, letter case and hand-painted irregularity are FINE and must not count as problems. Accents and umlauts must be present where the expected title has them.
The lettering sits ON TOP of the illustration, so artwork visible behind or beside a letter can never obscure it — never report a letter as hidden, covered or obscured by the picture. Judge ONLY whether the words and letters themselves are there and legible. Normal spacing between words is not a spelling error.
Return JSON: {"matches": true|false, "problem": "<short description, or empty if it matches>"}` },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  if (!res.ok) throw new Error(`verify failed: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
  const parsed = require('./storyHelpers').extractJsonFromText(raw);
  if (!parsed || typeof parsed.matches !== 'boolean') throw new Error(`invalid verify response: ${raw.slice(0, 100)}`);
  return { matches: parsed.matches, problem: String(parsed.problem || '') };
}

/**
 * Paint the title of one cover.
 *
 * @param {Buffer} artBuffer      TEXTLESS cover plate (the `${coverKey}Art` row)
 * @param {string} title
 * @param {Object} opts           { figures, seed, artStyle, style, backend, model }
 * @returns {Promise<{imageData, spec, ok, coverage, spill, reason, cost}>}
 *          ok=false ⇒ imageData is the FLAT composite (safe fallback, never garbled)
 */
async function paintCoverTitle(artBuffer, title, opts = {}) {
  const { composeCover } = require('./coverTypography');
  const { editImageWithPrompt } = require('./images');
  const figures = opts.figures || [];

  // 1. deterministic lockup — glyphs from a real font, correct by construction
  const { buffer: composedBuf, spec } = await composeCover({
    artBuffer, kind: 'front', title, seed: opts.seed || title, figures, style: opts.style,
  });
  const flat = { imageData: `data:image/jpeg;base64,${composedBuf.toString('base64')}`, spec, ok: false, cost: 0 };
  if (spec?.skipped) return { ...flat, reason: `typography skipped (${spec.skipped})` };

  // 2. glyph mask = composed − art (exact: we rendered those glyphs)
  const meta = await sharp(composedBuf).metadata();
  const W = meta.width, H = meta.height;
  const rawArt = await sharp(artBuffer).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const rawComposed = await sharp(composedBuf).removeAlpha().raw().toBuffer();
  const ink = Buffer.alloc(W * H);
  let minx = W, miny = H, maxx = -1, maxy = -1;
  for (let p = 0, i = 0; p < W * H; p++, i += 3) {
    const d = Math.max(Math.abs(rawComposed[i] - rawArt[i]),
      Math.abs(rawComposed[i + 1] - rawArt[i + 1]), Math.abs(rawComposed[i + 2] - rawArt[i + 2]));
    if (d > 12) {
      ink[p] = 255;
      const x = p % W, y = (p / W) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  if (maxx < 0) return { ...flat, reason: 'no typography ink found' };
  // toColourspace('b-w') is load-bearing: sharp emits sRGB even from 1-channel raw
  // input, and a 3-channel mask read as 1 channel produces a squeezed, row-wrapped
  // alpha (comb artefacts across the whole frame).
  const maskRaw = await sharp(ink, { raw: { width: W, height: H, channels: 1 } })
    .toColourspace('b-w').raw().toBuffer();
  if (maskRaw.length !== W * H) throw new Error(`glyph mask not single-channel (${maskRaw.length} for ${W}x${H})`);

  // 3. THE PLATE IS THE SAME SHAPE AS THE COVER (owner directive 2026-08-08:
  //    "stop scaling them — take the result from Grok and put it on the image;
  //    just make sure the format we send is the same as the image").
  //    White canvas at the cover's exact W×H, letters drawn where they belong.
  //    Grok only accepts preset ratios, so the canvas is PADDED with white to
  //    the nearest one — padding, never cropping — and the padding is removed
  //    from the output again. The lettering is therefore never scaled, never
  //    re-fitted and never offset: what comes back overlays the cover at 1:1.
  const PRESETS = [['9:16', 9 / 16], ['2:3', 2 / 3], ['3:4', 3 / 4], ['4:5', 4 / 5],
    ['1:1', 1], ['5:4', 5 / 4], ['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9]];
  const coverRatio = W / H;
  const [presetName, presetRatio] = PRESETS.reduce((best, p2) =>
    Math.abs(p2[1] - coverRatio) < Math.abs(best[1] - coverRatio) ? p2 : best);
  // Grow (never shrink) to the preset so no pixel of the cover is cut.
  const cw = Math.max(W, Math.round(H * presetRatio));
  const chh = Math.max(H, Math.round(cw / presetRatio));
  const offX = Math.round((cw - W) / 2), offY = Math.round((chh - H) / 2);

  // Letters over white, at their true cover coordinates.
  const composedRgb = await sharp(composedBuf).removeAlpha().raw().toBuffer();
  const lettersOnWhite = Buffer.alloc(W * H * 4);
  for (let q = 0, j = 0, m = 0; q < W * H; q++, j += 3, m += 4) {
    lettersOnWhite[m] = composedRgb[j]; lettersOnWhite[m + 1] = composedRgb[j + 1];
    lettersOnWhite[m + 2] = composedRgb[j + 2];
    lettersOnWhite[m + 3] = maskRaw[q] > 8 ? 255 : 0;
  }
  const lettersPng = await sharp(lettersOnWhite, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const plateBuf = await sharp({ create: { width: cw, height: chh, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: lettersPng, left: offX, top: offY }]).jpeg({ quality: 96 }).toBuffer();
  const sceneBuf = await sharp(artBuffer).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();

  // 4. repaint
  const styleTxt = (() => {
    try {
      const { ART_STYLES } = require('./storyHelpers');
      const raw = ART_STYLES[opts.artStyle];
      return (typeof raw === 'string' ? raw : (raw && raw.default) || '') || '';
    } catch { return ''; }
  })();
  const backend = opts.backend || 'grok';
  let result = null;
  if (backend === 'grok') {
    const { editWithGrok } = require('./grok');
    const { IMAGE_MODELS } = require('../config/models');
    // The artwork reference is ON by default and should stay on: it is what gives
    // the lettering the cover's colour and style (owner, 2026-08-08). The written
    // style description is not a substitute. opts.sceneRef === false is for
    // isolating its effect in the Lab, not for production use.
    const refs = [`data:image/jpeg;base64,${plateBuf.toString('base64')}`];
    if (opts.sceneRef !== false) refs.push(`data:image/jpeg;base64,${sceneBuf.toString('base64')}`);
    result = await editWithGrok(PLATE_PROMPT(styleTxt, opts.strictEmptyPage !== false), refs,
      { model: IMAGE_MODELS[opts.model || 'grok-imagine']?.modelId, aspectRatio: presetName, resolution: '1k' });
  } else {
    const { loadPromptTemplates } = require('../services/prompts');
    await loadPromptTemplates();
    result = await editImageWithPrompt(
      `data:image/jpeg;base64,${plateBuf.toString('base64')}`, PLATE_PROMPT(styleTxt, opts.strictEmptyPage !== false),
      opts.model || 'gemini-2.5-flash-image',
      [`data:image/jpeg;base64,${sceneBuf.toString('base64')}`], opts.artStyle);
  }
  if (!result?.imageData) return { ...flat, reason: `${backend} returned no image` };
  const debugOut = opts.debug ? { plate: `data:image/jpeg;base64,${plateBuf.toString('base64')}`, raw: result.imageData } : undefined;

  // 5. strip the padding back off, then key on INKINESS (dark OR saturated) so
  //    any paper texture the model invents drops out. Straight 1:1 overlay.
  const outRaw = await sharp(Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    .resize(cw, chh, { fit: 'fill' })
    .extract({ left: offX, top: offY, width: W, height: H })
    .removeAlpha().raw().toBuffer();
  const pw = W, ph = H;
  const rgba = Buffer.alloc(W * H * 4);
  let letterPx = 0;
  for (let q = 0, j = 0, m = 0; q < W * H; q++, j += 3, m += 4) {
    const r = outRaw[j], g = outRaw[j + 1], b = outRaw[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const inkiness = Math.max(255 - mx, mx - mn);
    const a = inkiness <= 26 ? 0 : inkiness >= 70 ? 1 : (inkiness - 26) / 44;
    rgba[m] = r; rgba[m + 1] = g; rgba[m + 2] = b; rgba[m + 3] = Math.round(a * 255);
    if (a > 0.5) letterPx++;
  }
  if (letterPx < 200) return { ...flat, reason: 'keyed layer is empty' };

  // FILL SPECK HOLES. Light paper texture inside a stroke falls under the
  // inkiness threshold and becomes transparent, so the cover artwork shows
  // through the lettering as white specks (measured: 54 blobs / 1437px on one
  // watercolour title). Fill transparent regions that are ENCLOSED by ink — but
  // only SMALL ones: the counters of o, e, a, d are enclosed by design and must
  // stay open, and they are orders of magnitude larger than a speck.
  {
    const reach = Buffer.alloc(pw * ph);   // transparency connected to the border
    const st = [];
    const push = q => { if (!reach[q] && rgba[q * 4 + 3] < 128) { reach[q] = 1; st.push(q); } };
    for (let x = 0; x < pw; x++) { push(x); push((ph - 1) * pw + x); }
    for (let y = 0; y < ph; y++) { push(y * pw); push(y * pw + pw - 1); }
    while (st.length) {
      const q = st.pop(), x = q % pw, y = (q / pw) | 0;
      if (x > 0) push(q - 1); if (x < pw - 1) push(q + 1);
      if (y > 0) push(q - pw); if (y < ph - 1) push(q + pw);
    }
    const MAX_HOLE = Math.max(60, Math.round(pw * ph * 0.0004));
    const seen = Buffer.alloc(pw * ph);
    let filled = 0;
    for (let q0 = 0; q0 < pw * ph; q0++) {
      if (reach[q0] || seen[q0] || rgba[q0 * 4 + 3] >= 128) continue;
      const comp = [q0]; seen[q0] = 1; const list = [];
      while (comp.length) {
        const q = comp.pop(); list.push(q);
        const x = q % pw, y = (q / pw) | 0;
        for (const r of [x > 0 ? q - 1 : -1, x < pw - 1 ? q + 1 : -1, y > 0 ? q - pw : -1, y < ph - 1 ? q + pw : -1]) {
          if (r >= 0 && !seen[r] && !reach[r] && rgba[r * 4 + 3] < 128) { seen[r] = 1; comp.push(r); }
        }
      }
      if (list.length > MAX_HOLE) continue;   // a counter, not a speck — leave it
      for (const q of list) {
        // opaque, and take the colour from the nearest inked neighbour so the
        // fill carries pigment rather than a flat patch
        rgba[q * 4 + 3] = 255;
        const x = q % pw, y = (q / pw) | 0;
        for (const r of [x > 0 ? q - 1 : -1, x < pw - 1 ? q + 1 : -1, y > 0 ? q - pw : -1, y < ph - 1 ? q + pw : -1]) {
          if (r >= 0 && rgba[r * 4 + 3] > 200) { rgba[q * 4] = rgba[r * 4]; rgba[q * 4 + 1] = rgba[r * 4 + 1]; rgba[q * 4 + 2] = rgba[r * 4 + 2]; break; }
        }
        filled++;
      }
    }
    if (filled) log.debug(`🅰️ [TITLE PAINT] filled ${filled}px of speck holes inside the lettering`);
  }
  const layer = await sharp(rgba, { raw: { width: pw, height: ph, channels: 4 } }).png().toBuffer();

  const base = await sharp(artBuffer).resize(W, H, { fit: 'fill' }).jpeg({ quality: 95 }).toBuffer();
  const painted = await sharp(base).composite([{ input: layer, left: 0, top: 0 }]).jpeg({ quality: 92 }).toBuffer();

  // 6. SHAPE GATE (deterministic — replaced a Gemini OCR gate on 2026-08-06).
  // Reading stylised lettering with a VLM introduced a reader less reliable than
  // the thing it checked: it repeatedly misread a correct title ("der" as "den")
  // and the cover silently kept its flat lockup for no reason. We already know
  // exactly what the letters should look like — we rendered them — so compare
  // the painted layer against that mask instead. Free, instant, no false reads.
  //   coverage : share of the drawn glyphs that came back inked. A dropped or
  //              mangled word collapses this.
  //   spill    : ink landing far outside any glyph — a model that invented
  //              decoration or drew scenery.
  const glyphN = (() => { let n = 0; for (let q = 0; q < W * H; q++) if (maskRaw[q] > 8) n++; return n; })();
  // Tolerate the letters growing: strokes legitimately thicken and pool.
  const grow = await sharp(maskRaw, { raw: { width: W, height: H, channels: 1 } })
    .blur(Math.max(3, Math.round(Math.min(pw, ph) * 0.02))).threshold(8).toColourspace('b-w').raw().toBuffer();
  let hit = 0, out = 0, inkN = 0;
  for (let q = 0, m = 3; q < pw * ph; q++, m += 4) {
    const inked = rgba[m] > 128;
    if (!inked) continue;
    inkN++;
    if (maskRaw[q] > 8) hit++;
    if (grow[q] <= 8) out++;
  }
  // After a re-fit these compare the model's re-housed ink against the ORIGINAL
  // glyph shape — two different geometries — so they always read 0.00/1.00 and
  // mean nothing. Report null rather than a misleading number; the eval decides.
  const coverage = glyphN ? hit / glyphN : 0;
  const spill = inkN ? out / inkN : 0;
  // Shape metrics are DIAGNOSTIC only — the final eval below is the gate. They
  // stay because they explain a failure ("letters missing" vs "ink spill") and
  // cost nothing.
  const paintedUri = `data:image/jpeg;base64,${painted.toString('base64')}`;

  // FINAL EVAL: the expected text AND the painted cover, one call.
  try {
    const bandPad = Math.round(Math.min(W, H) * 0.03);
    const bx = Math.max(0, minx - bandPad), by = Math.max(0, miny - bandPad);
    const crop = await sharp(painted).extract({
      left: bx, top: by,
      width: Math.min(W, maxx + 1 + bandPad) - bx,
      height: Math.min(H, maxy + 1 + bandPad) - by,
    }).jpeg({ quality: 95 }).toBuffer();
    const verdict = await verifyTitleRender(`data:image/jpeg;base64,${crop.toString('base64')}`, title);
    if (!verdict.matches) {
      const m = coverage == null ? 're-fitted' : `coverage ${coverage.toFixed(2)}, spill ${spill.toFixed(2)}`;
      log.warn(`🅰️ [TITLE PAINT] final eval rejected the repaint: ${verdict.problem} (${m}) — keeping the flat title`);
      return { ...flat, coverage, spill, debug: debugOut, reason: `eval: ${verdict.problem || 'title does not match'}` };
    }
    return { imageData: paintedUri, spec, ok: true, coverage, spill, debug: debugOut, cost: result.cost ?? null };
  } catch (e) {
    // The eval itself failing is not evidence the repaint is bad, but we do not
    // ship an unverified title either — fall back, and say why.
    log.warn(`🅰️ [TITLE PAINT] final eval error (${e.message}) — keeping the flat title`);
    return { ...flat, coverage, spill, reason: `eval-error: ${e.message}` };
  }
}

module.exports = { paintCoverTitle, PLATE_PROMPT };
