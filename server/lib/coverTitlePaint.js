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

const PLATE_PROMPT = (styleTxt, strictEmptyPage = true, _bandPct = 30) => `The image is a book title on a plain flat white background. Repaint each letter IN PLACE - same position, same size, same words, same line breaks - so the lettering looks hand-painted: visible brush texture in every stroke, pigment pooling darker at the stroke edges, slightly irregular hand-made contours. You may change the lettering colour and refine the letterforms and weight; never move, rescale or re-arrange the letters, and never re-set the title in a layout of your own.${strictEmptyPage ? '\nThe output is the same flat white background and the repainted lettering, nothing more: no paper sheet, no paper edges, no surface, no shadow, no photograph, no people, no scenery, no border, no frame, no second copy of the title.' : ''}
The second image is a colour and style reference only - take the palette and the lettering medium from it; the outlined rectangle on it marks where this lettering sits on the cover. Do not copy, include or reproduce any part of the second image in the output.${styleTxt ? ` Paint the lettering in the medium of: ${styleTxt}` : ''}`;


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

  // 3. SEND ONLY THE TITLE BAND (owner-picked fix, 2026-08-09). A mostly-empty
  //    page is a generative invitation: the full-page plate page-filled on three
  //    different covers across three prompt wordings (children drawn in, the
  //    whole illustration reproduced, the title duplicated large), while the
  //    strip runs never page-filled once - letters occupy most of a strip, so
  //    there is nothing to fill. The strip is cut at FULL COVER WIDTH and pasted
  //    back at its known y-offset, so both directions stay 1:1 - no scaling, no
  //    re-fitting, no offsets we did not choose. Padding to a Grok preset grows
  //    the canvas around the strip and is removed again on return.
  const bandPad = Math.round(H * 0.03);
  // BAND FROM THE TYPOGRAPHY SPEC, not the pixel diff (owner, 2026-08-15,
  // second iteration). The diff bbox inflates with compression noise — one
  // cover's "strip" reached the 45% cap, so the model got a half-empty plate
  // and recomposed the lockup into its centre (coverage 0.00). spec.rect is
  // where the lockup was RENDERED — exact by construction, ~20% of the page —
  // and a tight strip padded to 16:9 holds the letters centered, so the
  // model's recentring tendency lands them where they already are. The diff
  // mask stays as the glyph mask; the noisy rows outside the band are simply
  // never part of the strip.
  const specY0 = spec?.rect?.y0 != null ? Math.floor(spec.rect.y0 * H) : miny;
  const specY1 = spec?.rect?.y1 != null ? Math.ceil(spec.rect.y1 * H) : maxy;
  // HARD BAND CAP kept as the backstop for a spec-less legacy path.
  const BAND_CAP = Math.round(H * 0.45);
  if (Math.min(maxy, specY1) > BAND_CAP) log.warn(`🅰️ [TITLE PAINT] band reached y=${(Math.min(maxy, specY1) / H * 100).toFixed(0)}% — clamped to the 45% title band`);
  const bandY0 = Math.max(0, specY0 - bandPad);
  const bandY1 = Math.min(H - 1, Math.min(specY1, BAND_CAP) + bandPad);
  const stripH = bandY1 - bandY0 + 1;
  const bandPct = Math.max(10, Math.min(60, Math.round((bandY1 + 1) / H * 100)));

  // Letters over white at their true coordinates, band rows only.
  const composedRgb = await sharp(composedBuf).removeAlpha().raw().toBuffer();
  const stripRgba = Buffer.alloc(W * stripH * 4);
  for (let y = 0; y < stripH; y++) {
    for (let x = 0; x < W; x++) {
      const src = (y + bandY0) * W + x, j = src * 3, m = (y * W + x) * 4;
      stripRgba[m] = composedRgb[j]; stripRgba[m + 1] = composedRgb[j + 1];
      stripRgba[m + 2] = composedRgb[j + 2];
      stripRgba[m + 3] = maskRaw[src] > 8 ? 255 : 0;
    }
  }
  const stripPng = await sharp(stripRgba, { raw: { width: W, height: stripH, channels: 4 } }).png().toBuffer();

  // Landscape presets ONLY (owner, 2026-08-15): a title strip is wide by
  // construction, and a square or portrait plate hands the model empty page to
  // fill below the letters — the page-fill failure mode. The plate can never
  // be taller than 3:4-of-width again. 2:1 and 20:9 are documented and
  // verified accepted (docs.x.ai aspect_ratio enum) — a ~3.4-ratio title strip
  // now pads to 20:9 instead of 16:9, cutting the vertical slack around the
  // letters roughly in half.
  const PRESETS = [['4:3', 4 / 3], ['3:2', 3 / 2], ['16:9', 16 / 9], ['2:1', 2], ['20:9', 20 / 9]];
  const stripRatio = W / stripH;
  const [presetName, presetRatio] = PRESETS.reduce((best, p2) =>
    Math.abs(p2[1] - stripRatio) < Math.abs(best[1] - stripRatio) ? p2 : best);
  // Grow (never shrink) to the preset so no letter pixel is cut.
  const cw = Math.max(W, Math.round(stripH * presetRatio));
  const chh = Math.max(stripH, Math.round(cw / presetRatio));
  const offX = Math.round((cw - W) / 2), offY = Math.round((chh - stripH) / 2);
  const plateBuf = await sharp({ create: { width: cw, height: chh, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: stripPng, left: offX, top: offY }]).jpeg({ quality: 96 }).toBuffer();
  // The cover reference carries the BAND BOX (owner, 2026-08-15): a drawn
  // rectangle marking where the strip sits, so the model sees the title's real
  // footprint on the page instead of inferring free space to fill.
  const sceneBuf = await (async () => {
    const meta = await sharp(artBuffer).metadata();
    const sw = meta.width, sh = meta.height;
    const y0 = Math.round(bandY0 / H * sh), y1 = Math.round((bandY1 + 1) / H * sh);
    const svg = `<svg width="${sw}" height="${sh}"><rect x="3" y="${y0}" width="${sw - 6}" height="${Math.max(4, y1 - y0)}" fill="none" stroke="#ffffff" stroke-width="6"/><rect x="3" y="${y0}" width="${sw - 6}" height="${Math.max(4, y1 - y0)}" fill="none" stroke="#d92222" stroke-width="2"/></svg>`;
    // Composite FIRST, then resize in a second pipeline: sharp applies
    // composite after resize within one chain, so a native-size overlay on a
    // shrunk canvas throws "must have same dimensions or smaller".
    const boxed = await sharp(artBuffer).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
    return sharp(boxed).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
  })();
  // Evidence is attached to EVERY exit from here on. It used to ride only on the
  // success and eval-rejection paths, so a page-fill rejection — the case you
  // most want to look at — saved no plate and no model output at all.
  const dbg = { plate: `data:image/jpeg;base64,${plateBuf.toString('base64')}`, raw: null };

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
    result = await editWithGrok(PLATE_PROMPT(styleTxt, opts.strictEmptyPage !== false, bandPct), refs,
      { model: IMAGE_MODELS[opts.model || 'grok-imagine']?.modelId, aspectRatio: presetName, resolution: '1k' });
  } else {
    const { loadPromptTemplates } = require('../services/prompts');
    await loadPromptTemplates();
    result = await editImageWithPrompt(
      `data:image/jpeg;base64,${plateBuf.toString('base64')}`, PLATE_PROMPT(styleTxt, opts.strictEmptyPage !== false, bandPct),
      opts.model || 'gemini-2.5-flash-image',
      [`data:image/jpeg;base64,${sceneBuf.toString('base64')}`], opts.artStyle);
  }
  if (!result?.imageData) return { ...flat, debug: dbg, reason: `${backend} returned no image` };
  dbg.raw = result.imageData;
  const debugOut = dbg;

  // 5. read the padded canvas back at its own size, then key on INKINESS
  //    (dark OR saturated) so any paper texture the model invents drops out.
  const outPad = await sharp(Buffer.from(result.imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64'))
    .resize(cw, chh, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const pw = W, ph = stripH;
  // Glyph mask restricted to the band, for the shape diagnostics below.
  const bandMask = Buffer.alloc(pw * ph);
  for (let y = 0; y < ph; y++) bandMask.set(maskRaw.subarray((y + bandY0) * W, (y + bandY0) * W + W), y * W);

  // PADDING GATE. Ink in the padding has no home on the cover - the strip is
  // everything we paste back. A little bleed past the strip edge is harmless
  // (and discarded), but a re-flowed title or an invented composition puts a
  // large share of its ink there, and pasting only the strip would then ship a
  // partial title. Reject the whole attempt instead - never clip letters.
  {
    let inStrip = 0, inPad = 0;
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 3;
        const mx = Math.max(outPad[i], outPad[i + 1], outPad[i + 2]);
        const mn = Math.min(outPad[i], outPad[i + 1], outPad[i + 2]);
        if (Math.max(255 - mx, mx - mn) <= 40) continue;
        if (x >= offX && x < offX + W && y >= offY && y < offY + ph) inStrip++; else inPad++;
      }
    }
    const padShare = (inStrip + inPad) ? inPad / (inStrip + inPad) : 0;
    if (padShare > (opts.maxOutOfBand ?? 0.15)) {
      log.warn(`\u{1F170}\uFE0F [TITLE PAINT] ${Math.round(padShare * 100)}% of the ink landed in the padding outside the title strip - keeping the flat title`);
      return { ...flat, outOfBand: +padShare.toFixed(2), debug: dbg, reason: `page-fill: ${Math.round(padShare * 100)}% of ink outside the title strip` };
    }
  }

  const rgba = Buffer.alloc(pw * ph * 4);
  let letterPx = 0;
  // NEVER clip ink at the band edge (owner 2026-08-08: "if you remove pixels we
  // lose letters"). Cropping at a boundary is the same mistake as the old fixed
  // rectangle that sliced DER THUR into RTHUR — descenders, flourishes and any
  // letter sitting a few px lower get destroyed. Every ink pixel is kept; a
  // model that paints the page is REJECTED WHOLESALE below instead.
  for (let q = 0, m = 0; q < pw * ph; q++, m += 4) {
    const x = q % pw, y = (q / pw) | 0;
    const j = ((y + offY) * cw + (x + offX)) * 3;
    const r = outPad[j], g = outPad[j + 1], b = outPad[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const inkiness = Math.max(255 - mx, mx - mn);
    const a = inkiness <= 26 ? 0 : inkiness >= 70 ? 1 : (inkiness - 26) / 44;
    rgba[m] = r; rgba[m + 1] = g; rgba[m + 2] = b; rgba[m + 3] = Math.round(a * 255);
    if (a > 0.5) letterPx++;
  }
  if (letterPx < 200) return { ...flat, debug: dbg, reason: 'keyed layer is empty' };

  // EDGE FEATHER. The model paints a faint paper-texture tint right up to the
  // plate edge; those rows key as barely-inky and pasted back as a full-width
  // hairline across the cover at the strip boundary. Real letters never sit in
  // the outermost band rows (the strip carries 3% padding), so fade weak alpha
  // out over the last few rows and keep only strong ink there.
  {
    const FEATHER = Math.max(3, Math.round(ph * 0.03));
    for (let y = 0; y < ph; y++) {
      const dEdge = Math.min(y, ph - 1 - y);
      if (dEdge >= FEATHER) continue;
      const keep = dEdge / FEATHER;
      for (let x = 0; x < pw; x++) {
        const m = (y * pw + x) * 4 + 3;
        if (rgba[m] < 230) rgba[m] = Math.round(rgba[m] * keep);
      }
    }
  }

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
  const painted = await sharp(base).composite([{ input: layer, left: 0, top: bandY0 }]).jpeg({ quality: 92 }).toBuffer();

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
  const glyphN = (() => { let n = 0; for (let q = 0; q < pw * ph; q++) if (bandMask[q] > 8) n++; return n; })();
  // Tolerate the letters growing: strokes legitimately thicken and pool.
  const grow = await sharp(bandMask, { raw: { width: pw, height: ph, channels: 1 } })
    .blur(Math.max(3, Math.round(Math.min(pw, ph) * 0.02))).threshold(8).toColourspace('b-w').raw().toBuffer();
  let hit = 0, out = 0, inkN = 0;
  for (let q = 0, m = 3; q < pw * ph; q++, m += 4) {
    const inked = rgba[m] > 128;
    if (!inked) continue;
    inkN++;
    if (bandMask[q] > 8) hit++;
    if (grow[q] <= 8) out++;
  }
  // After a re-fit these compare the model's re-housed ink against the ORIGINAL
  // glyph shape — two different geometries — so they always read 0.00/1.00 and
  // mean nothing. Report null rather than a misleading number; the eval decides.
  const coverage = glyphN ? hit / glyphN : 0;
  const spill = inkN ? out / inkN : 0;
  // SHAPE GATE — the wholesale rejection the keyed-layer comment promises.
  // The final eval below only verifies the WORDS, so a model that re-laid the
  // title out — five giant lines across the figures instead of the rendered
  // lockup — passed with coverage 0.29 / spill 0.66 (measured, shipped cover).
  // Metrics against the rendered mask are exact: low coverage = the lockup was
  // abandoned, high spill = ink far outside any glyph. Reject wholesale; the
  // flat title is always correct.
  // Thresholds widened 2026-08-15 against two MEASURED cases:
  //   rejected (bad, kept):  coverage 0.29 / spill 0.66 — title re-laid out
  //                          across the figures, ink far from any glyph.
  //   rejected (good, was a false positive): coverage 0.37 / spill 0.37 — a
  //                          3-line title repainted in the painter's own
  //                          lettering: same words, same band, same line
  //                          breaks, just a different face than the flat
  //                          lockup it is measured against (staging
  //                          job_1786823576638 — the painted result was
  //                          correct and better-looking than the flat title).
  // Spill is the discriminating signal (0.66 vs 0.37); coverage punishes any
  // restyle. The model eval below still verifies the WORDS, so this gate only
  // has to catch wholesale re-layouts.
  if (coverage < 0.30 || spill > 0.45) {
    log.warn(`🅰️ [TITLE PAINT] shape gate rejected the repaint (coverage ${coverage.toFixed(2)}, spill ${spill.toFixed(2)}) — keeping the flat title`);
    return { ...flat, coverage, spill, debug: debugOut, reason: `shape: coverage ${coverage.toFixed(2)}, spill ${spill.toFixed(2)}` };
  }
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
    return { ...flat, coverage, spill, debug: dbg, reason: `eval-error: ${e.message}` };
  }
}

module.exports = { paintCoverTitle, PLATE_PROMPT };
