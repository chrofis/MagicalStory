/**
 * COMPOSITE render method for cover images.
 *
 * One of two render methods available. The other is the DIRECT method
 * (single-pass prompt → image via generateImageWithQualityRetry), defined
 * in server/lib/images.js. Routing between methods happens in
 * server/lib/coverIterate.js based on MODEL_DEFAULTS.compositeCovers and
 * per-call options.
 *
 * Composite advantages:
 *  - Character faces / costumes are GUARANTEED to come from the stored
 *    styled-costumed avatars (no model re-imagining of a character's look).
 *  - Landmark architecture is GUARANTEED to be pixel-faithful (the photo
 *    is the input image; pass-2 only restyles, never redraws).
 *  - Pose, action, and prop placement are model-controlled but constrained
 *    by per-character structured action lines from coverHint.characterDetails
 *    — no prose round-trip.
 *
 * Composite disadvantages:
 *  - Two Grok edit calls per cover instead of one (~$0.04 vs $0.02).
 *  - Pass 1 + Pass 2 + cutout step = ~15s total vs ~4s for direct.
 *  - Requires real-landmark photo bytes for pass 2 (no photo → pass-2
 *    skipped, output is figures-on-white).
 *
 * Pipeline steps:
 *   1. Pull the costumed styled-avatar for each story character.
 *   2. Remove background via the Python rembg service (chroma-key fallback).
 *   3. Compute left-to-right placement using:
 *        - explicit positions from coverHint.characters when provided
 *        - else: gender-alternated centre-out arrangement (main → child → adult)
 *   4. Composite figures + prop onto a WHITE canvas (pass 1 input).
 *   5. Pass 1 → Grok edit, prompt = strict pose-redraw only,
 *      action lines from coverHint.characterDetails (holds + gazesAt + priority).
 *      VB grid attached as a second image so artifact references are visible.
 *   6. Cut figures from pass 1 result via rembg.
 *   7. Composite cutout onto the landmark photo (pass 2 input).
 *   8. Pass 2 → Grok edit, prompt = watercolor unification + ground repaint
 *      + title rendering. Landmark architecture preserved. Atmosphere from
 *      coverHint.mood + scene prose (legacy) or synthesized from characterDetails.
 *
 * Returns the same { imageData, modelId, prompt, totalAttempts, debug } shape
 * that iterateCover expects, so callers don't care which render method ran.
 */

const sharp = require('sharp');
const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');

const PHOTO_ANALYZER_URL = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
const XAI_API_URL = 'https://api.x.ai/v1';

// ─── Real-world heights by age (cm) — for figure scale ─────────────────
const TARGET_TALLEST_PX = 920; // tallest adult on a 1024×1365 canvas
function heightCm(age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n)) return 175;
  if (n <= 1) return 75;
  if (n <= 3) return 95;
  if (n <= 5) return 110;
  if (n <= 7) return 122;
  if (n <= 10) return 140;
  if (n <= 12) return 150;
  if (n <= 14) return 162;
  if (n <= 17) return 172;
  if (n <= 60) return 175;
  return 168;
}

// ─── Importance + arrangement ──────────────────────────────────────────
function sortByImportance(chars) {
  return chars.slice().sort((a, b) => {
    const score = (c) => {
      if (c.isMain || c.isMainCharacter === true) return 0;
      const age = parseInt(c.age, 10);
      if (Number.isFinite(age) && age <= 12) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
}

const flipGender = (g) => g === 'male' ? 'female' : g === 'female' ? 'male' : null;
const genderOf = (c) => String(c?.gender || '').toLowerCase();

/**
 * Centre-out arrangement with gender alternation, supporting any number of
 * mains. All mains occupy the central block; non-mains fill outward with
 * alternating gender from each block edge.
 */
function arrangeCenterOut(sorted) {
  const n = sorted.length;
  if (n === 0) return [];
  const out = new Array(n);
  const mains = sorted.filter(c => c.isMain || c.isMainCharacter === true);
  const nonMains = sorted.filter(c => !(c.isMain || c.isMainCharacter === true));

  const K = Math.max(1, mains.length);
  const blockStart = Math.floor((n - K) / 2);
  const blockEnd = blockStart + K;

  if (mains.length === 0) {
    let male = 0, female = 0;
    for (const c of nonMains) {
      const g = genderOf(c);
      if (g === 'male') male++; else if (g === 'female') female++;
    }
    let pickIdx = 0;
    if (male !== female) {
      const target = male > female ? 'male' : 'female';
      const idx = nonMains.findIndex(c => genderOf(c) === target);
      if (idx >= 0) pickIdx = idx;
    }
    out[blockStart] = nonMains[pickIdx];
    nonMains.splice(pickIdx, 1);
  } else {
    const inner = new Array(K);
    const innerCentre = Math.floor((K - 1) / 2);
    inner[innerCentre] = mains[0];
    const usedMain = new Set([0]);
    const innerCentreGender = genderOf(mains[0]);
    const innerOffsets = [];
    for (let d = 1; d <= Math.max(innerCentre, K - 1 - innerCentre); d++) {
      if (innerCentre + d < K) innerOffsets.push(d);
      if (innerCentre - d >= 0) innerOffsets.push(-d);
    }
    for (const off of innerOffsets) {
      const want = (Math.abs(off) % 2 === 0) ? innerCentreGender : flipGender(innerCentreGender);
      let pick = -1;
      if (want) {
        for (let i = 0; i < mains.length; i++) {
          if (usedMain.has(i)) continue;
          if (genderOf(mains[i]) === want) { pick = i; break; }
        }
      }
      if (pick === -1) {
        for (let i = 0; i < mains.length; i++) { if (!usedMain.has(i)) { pick = i; break; } }
      }
      inner[innerCentre + off] = mains[pick];
      usedMain.add(pick);
    }
    for (let k = 0; k < K; k++) out[blockStart + k] = inner[k];
  }

  const pickByGender = (want) => {
    if (want) {
      for (let i = 0; i < nonMains.length; i++) {
        if (genderOf(nonMains[i]) === want) return i;
      }
    }
    return nonMains.length > 0 ? 0 : -1;
  };

  let nextWant = flipGender(genderOf(out[blockEnd - 1]));
  for (let pos = blockEnd; pos < n; pos++) {
    const idx = pickByGender(nextWant);
    if (idx === -1) break;
    out[pos] = nonMains[idx];
    nonMains.splice(idx, 1);
    nextWant = flipGender(genderOf(out[pos]));
  }
  nextWant = flipGender(genderOf(out[blockStart]));
  for (let pos = blockStart - 1; pos >= 0; pos--) {
    const idx = pickByGender(nextWant);
    if (idx === -1) break;
    out[pos] = nonMains[idx];
    nonMains.splice(idx, 1);
    nextWant = flipGender(genderOf(out[pos]));
  }

  return out;
}

/**
 * Try to honor an explicit character sequence from the cover hint.
 *   coverHint.characters can be ["Noah (left foreground)", "Emma (right foreground)", ...]
 * If positions are present (parenthesised), parse them and return the
 * corresponding character objects in left→right order. Otherwise return null
 * so callers fall back to arrangeCenterOut().
 */
function parseExplicitSequence(coverHint, characters) {
  if (!Array.isArray(coverHint?.characters)) return null;
  const parsed = coverHint.characters.map(entry => {
    if (typeof entry !== 'string') return null;
    const match = entry.match(/^([^(]+?)\s*\(([^)]+)\)\s*$/);
    if (match) return { name: match[1].trim(), pos: match[2].trim().toLowerCase() };
    return { name: entry.trim(), pos: null };
  }).filter(Boolean);
  const anyPos = parsed.some(p => p.pos);
  if (!anyPos || parsed.length < 2) return null;

  const score = (p) => {
    const pos = p.pos || '';
    if (pos.includes('far left')) return 0;
    if (pos.includes('left foreground')) return 1;
    if (pos.includes('left midground')) return 2;
    if (pos.includes('left')) return 3;
    if (pos.includes('center') || pos.includes('centre')) return 4;
    if (pos.includes('right foreground')) return 5;
    if (pos.includes('right midground')) return 6;
    if (pos.includes('far right')) return 8;
    if (pos.includes('right')) return 7;
    return 9;
  };
  parsed.sort((a, b) => score(a) - score(b));

  const result = [];
  for (const p of parsed) {
    const ch = characters.find(c => c.name?.toLowerCase() === p.name.toLowerCase());
    if (ch) result.push(ch);
  }
  return result.length >= 2 ? result : null;
}

// ─── Avatar sheet-cell extraction ──────────────────────────────────────
//
// The styled avatar layout depends on the generator:
//   • Modern (2026-05-14+): 2×4 sheet — 4 columns × 2 rows at 16:9.
//       Top row    cells 1-4: face — front / three-quarter / profile / back
//       Bottom row cells 5-8: body — front / three-quarter / profile / back
//       body-front = cell 5 (col 0, row 1). body-profile = cell 7 (col 2, row 1).
//   • Legacy 2×2 Gemini fallback: 2 columns × 2 rows, portrait aspect.
//       TL=face-front, TR=face-profile, BL=body-front, BR=body-profile.
//   • Single image: portrait, no grid — return as-is.
//
// Branch on aspect h/w: ≲0.8 → 2×4 sheet; 1.3–2.2 → legacy 2×2 (variance
// scan locates the separators); otherwise → single cell.
async function extractQuadrant(buffer, which = 'body-front') {
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) return null;
  const aspect = meta.height / meta.width;

  // 2×4 sheet (4 cols × 2 rows, 16:9 → aspect ≈ 0.56).
  if (aspect < 0.8) {
    const cellW = Math.floor(meta.width / 4);
    const cellH = Math.floor(meta.height / 2);
    const col = which === 'body-profile' ? 2 : 0;
    const row = 1;
    return sharp(buffer)
      .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
      .png()
      .toBuffer();
  }

  // Legacy 2×2 portrait grid: locate separators by min variance.
  if (aspect >= 1.3 && aspect <= 2.2) {
    const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    let minHVar = Infinity, sepY = Math.floor(height / 2);
    for (let y = Math.floor(height * 0.25); y < Math.floor(height * 0.75); y++) {
      let s = 0, sq = 0;
      for (let x = 0; x < width; x++) { const v = data[y * width + x]; s += v; sq += v * v; }
      const mean = s / width;
      const variance = sq / width - mean * mean;
      if (variance < minHVar) { minHVar = variance; sepY = y; }
    }
    let minVVar = Infinity, sepX = Math.floor(width / 2);
    for (let x = Math.floor(width * 0.3); x < Math.floor(width * 0.7); x++) {
      let s = 0, sq = 0;
      for (let y = 0; y < height; y++) { const v = data[y * width + x]; s += v; sq += v * v; }
      const mean = s / height;
      const variance = sq / height - mean * mean;
      if (variance < minVVar) { minVVar = variance; sepX = x; }
    }
    if (which === 'body-profile') {
      return sharp(buffer).extract({ left: sepX, top: sepY, width: width - sepX, height: height - sepY }).toBuffer();
    }
    return sharp(buffer).extract({ left: 0, top: sepY, width: sepX, height: height - sepY }).toBuffer();
  }

  // Single image (no grid).
  return buffer;
}

// ─── Background removal (rembg via Python service, chroma-key fallback) ──
async function removeBackground(buf) {
  // Try Python rembg first
  try {
    const dataUrl = `data:image/png;base64,${buf.toString('base64')}`;
    const r = await fetch(`${PHOTO_ANALYZER_URL}/remove-bg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, max_size: 1024 }),
      signal: AbortSignal.timeout(60000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j.success && j.image) {
        return Buffer.from(j.image.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      }
    }
  } catch (e) {
    log.warn(`[COVER-COMPOSITE] rembg failed: ${e.message}`);
  }
  // Fallback: edge-flood chroma-key
  return chromaKeyBg(buf, 45);
}

async function chromaKeyBg(buf, threshold = 45) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const CH = 4;
  const sample = (x0, y0, w = 8, h = 8) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + h && y < height; y++) {
      for (let x = x0; x < x0 + w && x < width; x++) {
        const i = (y * width + x) * CH;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return n > 0 ? [r / n, g / n, b / n] : null;
  };
  const samples = [
    sample(0, 0), sample(width - 8, 0), sample(0, height - 8), sample(width - 8, height - 8),
  ].filter(Boolean);
  const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  const bgR = med(samples.map(s => s[0]));
  const bgG = med(samples.map(s => s[1]));
  const bgB = med(samples.map(s => s[2]));
  const T_HARD = threshold * threshold;
  const T_SOFT = (threshold * 1.5) * (threshold * 1.5);
  const distSq = (i) => {
    const dr = data[i] - bgR, dg = data[i + 1] - bgG, db = data[i + 2] - bgB;
    return dr * dr + dg * dg + db * db;
  };
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let qHead = 0, qTail = 0;
  const enqueue = (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = y * width + x;
    if (visited[idx]) return;
    if (distSq(idx * CH) > T_SOFT) { visited[idx] = 1; return; }
    visited[idx] = 1;
    queue[qTail++] = idx;
  };
  for (let x = 0; x < width; x++) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 0; y < height; y++) { enqueue(0, y); enqueue(width - 1, y); }
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = Math.floor(idx / width);
    const pix = idx * CH;
    const d2 = distSq(pix);
    if (d2 < T_HARD) data[pix + 3] = 0;
    else if (d2 < T_SOFT) data[pix + 3] = Math.round(255 * (Math.sqrt(d2) - threshold) / (threshold * 0.5));
    else continue;
    enqueue(x + 1, y); enqueue(x - 1, y); enqueue(x, y + 1); enqueue(x, y - 1);
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

// ─── Visual identifiers for the prompt (no character names sent to Grok) ──
function visualIdentifier(idx, n, age) {
  const centerIdx = Math.floor(n / 2);
  let pos;
  if (n === 1) pos = 'the figure';
  else if (idx === 0) pos = 'the leftmost figure';
  else if (idx === n - 1) pos = 'the rightmost figure';
  else if (idx === centerIdx) pos = 'the centre figure';
  else if (idx < centerIdx) pos = `the ${idx === 1 ? 'second-from-left' : `${idx + 1}th-from-left`} figure`;
  else pos = `the ${(n - idx) === 2 ? 'second-from-right' : `${n - idx}th-from-right`} figure`;

  const a = parseInt(age, 10);
  let ageWord = 'figure';
  if (Number.isFinite(a)) {
    if (a <= 6) ageWord = 'small child';
    else if (a <= 12) ageWord = 'older child';
    else if (a <= 17) ageWord = 'teenager';
    else if (a <= 60) ageWord = 'adult';
    else ageWord = 'elderly figure';
  }
  return `${pos} (the ${ageWord})`;
}

// ─── Grok edit call ────────────────────────────────────────────────────
// Accepts a single buffer OR an array of buffers (up to 3 — Grok's hard cap
// on multi-image edits for the standard model). When more than one buffer is
// passed, the request uses `images[]` instead of `image` so all slots reach
// the model. The Grok API treats the first image as the primary edit target
// and subsequent images as visual references.
async function callGrokEdit(promptOrImgs, imgBuf, { aspectRatio = '3:4', model = 'grok-imagine-image' } = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not set');
  const prompt = promptOrImgs;
  const buffers = Array.isArray(imgBuf) ? imgBuf.filter(Boolean).slice(0, 3) : [imgBuf];
  if (buffers.length === 0) throw new Error('callGrokEdit requires at least one input image');
  const t0 = Date.now();
  const body = {
    model, prompt,
    response_format: 'b64_json',
    aspect_ratio: aspectRatio,
  };
  if (buffers.length === 1) {
    body.image = { url: `data:image/jpeg;base64,${buffers[0].toString('base64')}`, type: 'image_url' };
  } else {
    body.images = buffers.map(b => ({ url: `data:image/jpeg;base64,${b.toString('base64')}`, type: 'image_url' }));
  }
  const resp = await fetch(`${XAI_API_URL}/images/edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Grok edit ${resp.status}: ${err.slice(0, 200)}`);
  }
  const data = await resp.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('Grok edit returned no image');
  return { imageData: Buffer.from(b64, 'base64'), elapsedMs: Date.now() - t0, modelId: model };
}

// ─── Resolve the styled costumed avatar for a character ────────────────
function getCostumedAvatarSrc(c, artStyle) {
  const styled = c.avatars?.styledAvatars?.[artStyle];
  if (!styled) return null;
  const costumedObj = styled.costumed;
  if (costumedObj && typeof costumedObj === 'object') {
    // costumed is keyed by costume description: { "medieval swiss huntsman": "data:..." }
    const first = Object.values(costumedObj)[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') return first.imageUrl || first.imageData;
  } else if (typeof costumedObj === 'string') {
    return costumedObj;
  }
  // Fall back to standard in the same art style
  {
    const v = styled.standard;
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return v.imageUrl || v.imageData;
  }
  // Last resort: avatars.standardUrl
  return c.avatars?.standardUrl || c.avatars?.standard || null;
}

async function loadImageAny(src) {
  if (!src) return null;
  if (typeof src === 'object') return loadImageAny(src.imageUrl || src.imageData);
  if (typeof src !== 'string') return null;
  if (src.startsWith('data:')) return Buffer.from(src.replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }
  try { return Buffer.from(src, 'base64'); } catch { return null; }
}

/**
 * Main entry point.
 *
 * @param {Object} args
 * @param {string} args.coverKey               'frontCover' | 'initialPage' | 'backCover'
 * @param {Object[]} args.characters           Story characters with avatars + age + gender + isMainCharacter
 * @param {Object} args.coverHint              storyData.coverHints[hintKey]
 * @param {Buffer|null} args.landmarkBuf       Landmark photo buffer (optional — pass 2 skipped if null)
 * @param {string} args.artStyle               e.g. 'watercolor'
 * @param {string} args.title                  Story title for cover text rendering
 * @param {string} args.styleHint              Verbose art-style description used in pass 2 prompt
 * @param {string} [args.sceneDescription]     Full scene prose (Emma holds X / Noah gazes at Y) — when provided, embedded into pass-1 and pass-2 prompts so the model knows the story-specific action instead of inventing generic poses.
 * @param {Buffer} [args.vbGrid]               Visual Bible grid image (multi-cell composite of artifacts / animals / secondary characters referenced by the cover hint). Passed as a second image slot to pass-1 so Grok knows the actual visual of each prop the figures should hold or interact with.
 * @param {Function} [args.usageTracker]       (provider, usage, fn, modelId) callback for cost tracking
 * @returns {Promise<{ imageData: string, modelId: string, prompt: string, totalAttempts: number, debug: object }>}
 */
async function generateCoverViaComposite({
  coverKey,
  characters,
  coverHint,
  landmarkBuf,
  artStyle = 'watercolor',
  title = '',
  styleHint = "watercolor children's storybook illustration, soft brushwork, gentle storybook colors",
  sceneDescription = '',
  vbGrid = null,
  usageTracker = null,
}) {
  const W = 1024;
  const H = 1365;
  const label = coverKey === 'frontCover' ? 'FRONT COVER' : coverKey === 'initialPage' ? 'INITIAL PAGE' : 'BACK COVER';
  log.info(`🎨 [COVER-COMPOSITE] ${label}: starting composite-cover generation`);

  // 1. Determine character sequence (explicit > alternation)
  let sequence = parseExplicitSequence(coverHint, characters);
  if (sequence) {
    log.info(`🎨 [COVER-COMPOSITE] ${label}: using explicit sequence from coverHint`);
  } else {
    const importance = sortByImportance(characters);
    sequence = arrangeCenterOut(importance);
    log.info(`🎨 [COVER-COMPOSITE] ${label}: using gender-alternated centre-out sequence`);
  }
  log.info(`🎨 [COVER-COMPOSITE] order: ${sequence.map(c => `${c.name}(${(c.gender || '?')[0]?.toUpperCase()})`).join(' → ')}`);

  // 2. Load each character's costumed avatar, extract body-front, bg-remove
  const figures = [];
  const tallestCm = Math.max(...sequence.map(c => heightCm(c.age)));
  const sceneScale = 0.62; // village/cover scale
  const pxPerCm = (TARGET_TALLEST_PX * sceneScale) / tallestCm;
  for (const c of sequence) {
    const src = getCostumedAvatarSrc(c, artStyle);
    if (!src) {
      log.warn(`[COVER-COMPOSITE] ${c.name}: no styled avatar found in style=${artStyle}`);
      continue;
    }
    const buf = await loadImageAny(src);
    if (!buf) { log.warn(`[COVER-COMPOSITE] ${c.name}: avatar load failed`); continue; }
    const body = await extractQuadrant(buf, 'body-front');
    const cleanRaw = await removeBackground(body);
    const trimmed = await sharp(cleanRaw).trim({ threshold: 1 }).toBuffer().catch(() => cleanRaw);
    const targetH = Math.max(40, Math.round(heightCm(c.age) * pxPerCm * 1.2));
    let resized = await sharp(trimmed).resize({ height: targetH }).png().toBuffer();
    let m = await sharp(resized).metadata();
    // Cap to the white-bg canvas. Resizing by height can produce a width > W
    // for very tall narrow figures, or a height > H if targetH itself exceeds
    // the canvas. Sharp's composite() throws "Image to composite must have
    // same dimensions or smaller" in either case, taking down the whole
    // composite-cover path. Scale down once more so the layer fits.
    if (m.width > W || m.height > H) {
      resized = await sharp(resized).resize({ width: W, height: H, fit: 'inside' }).png().toBuffer();
      m = await sharp(resized).metadata();
    }
    figures.push({ name: c.name, age: parseInt(c.age, 10), gender: c.gender, buffer: resized, width: m.width, height: m.height });
  }
  if (figures.length === 0) throw new Error('No figures could be assembled for composite cover');

  // 3. Pull and bg-remove the cover prop (first ART* in coverHint.objects)
  const propIds = (coverHint?.objects || []).filter(id => /^ART\d+/.test(String(id)));
  let propBuf = null;
  if (propIds.length > 0) {
    // Caller must supply propUrl/propData via coverHint.artifacts (passed in by the wrapper)
    // For now, the artifacts must be loaded by the caller and attached to coverHint as `_artifactImages`
    const artImg = coverHint._artifactImages?.[propIds[0]];
    if (artImg) {
      const raw = await loadImageAny(artImg);
      if (raw) {
        const cleaned = await removeBackground(raw);
        const trimmed = await sharp(cleaned).trim({ threshold: 1 }).toBuffer().catch(() => cleaned);
        propBuf = trimmed;
      }
    }
  }

  // 4. Composite figures + prop on WHITE bg (pass 1 input)
  const whiteBg = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } }).jpeg({ quality: 92 }).toBuffer();
  const margin = 24;
  const usableW = W - margin * 2;
  const overlap = 0.20;
  const groundY = Math.round(H * 0.96);
  const centres = new Array(figures.length);
  centres[0] = 0;
  for (let i = 1; i < figures.length; i++) {
    const step = (figures[i - 1].width + figures[i].width) / 2 * (1 - overlap);
    centres[i] = centres[i - 1] + step;
  }
  const span = centres[figures.length - 1] || 0;
  const startCentre = (W - span) / 2;
  for (let i = 0; i < figures.length; i++) centres[i] += startCentre;

  const layers = [];
  for (let i = 0; i < figures.length; i++) {
    const f = figures[i];
    const left = Math.max(0, Math.min(W - f.width, Math.round(centres[i] - f.width / 2)));
    const top = Math.max(0, groundY - f.height);
    layers.push({ input: f.buffer, left, top });
  }
  if (propBuf) {
    const propTargetH = Math.round(H * 0.25);
    let propResized = await sharp(propBuf).resize({ height: propTargetH }).png().toBuffer();
    let pm = await sharp(propResized).metadata();
    if (pm.width > W || pm.height > H) {
      propResized = await sharp(propResized).resize({ width: W, height: H, fit: 'inside' }).png().toBuffer();
      pm = await sharp(propResized).metadata();
    }
    const left = Math.max(0, Math.round((W - pm.width) / 2));
    const top = Math.max(0, H - 8 - pm.height);
    layers.push({ input: propResized, left, top });
  }
  const pass1Input = await sharp(whiteBg).composite(layers).jpeg({ quality: 92 }).toBuffer();

  // 5. Build pass 1 prompt (pose redraw only, no landmark, no style)
  const n = figures.length;
  const centerIdx = Math.floor(n / 2);
  const propName = propIds[0] ? (coverHint._artifactNames?.[propIds[0]] || 'central prop') : null;
  const POSES = [];
  for (let i = 0; i < n; i++) {
    const me = visualIdentifier(i, n, figures[i].age);
    let pose;
    if (i === centerIdx) {
      pose = propName
        ? `BOTH HANDS rest on the ${propName} on the ground in front. Body leans slightly forward. Head looks down at the prop and up at the viewer. NOT arms-at-sides.`
        : `Holding hands with the figure to the immediate right. Body squared to camera. NOT arms-at-sides.`;
    } else if (i < centerIdx) {
      pose = `RIGHT ARM raised and around ${visualIdentifier(i + 1, n, figures[i + 1].age)}'s shoulders, pulling that figure close. Body angled slightly to the right. NOT arms-at-sides.`;
    } else {
      pose = `LEFT HAND placed on ${visualIdentifier(i - 1, n, figures[i - 1].age)}'s shoulder, fingers visible. Body angled slightly to the left. NOT arms-at-sides.`;
    }
    POSES.push(`- ${me}: REDRAW the pose. New pose: ${pose}`);
  }
  // Pass-1 must stay WHITE-BACKGROUND only. We can't dump the full scene
  // prose here — the prose names the landmark explicitly and Grok would paint
  // that landscape into pass-1's white background, defeating the cutout step.
  //
  // PRIMARY SOURCE: coverHint.characterDetails — the structured per-character
  // data the outline parser populates from the cover hint. Each entry carries
  // { position, clothing, holds (ART###), gazesAt, priority }. This is one
  // step from Sonnet's outline, no Haiku scene-expansion intermediary, no
  // prose lossy round-trip.
  //
  // FALLBACK: scene-metadata interactions[]. Only used when characterDetails
  // is missing (legacy stories from before the structured schema landed).
  const PRIO_RANK = { essential: 0, normal: 1, low: 2 };
  const interactionLines = [];
  const details = (coverHint && coverHint.characterDetails) || {};
  const artNames = (coverHint && coverHint._artifactNames) || {};
  const detailEntries = Object.values(details)
    .filter(d => d && d.name)
    .sort((a, b) => (PRIO_RANK[a.priority] ?? 1) - (PRIO_RANK[b.priority] ?? 1));
  for (const d of detailEntries) {
    const holds = String(d.holds || '').trim();
    const gaze = String(d.gazesAt || '').trim();
    const prio = String(d.priority || 'normal').toLowerCase();
    if ((!holds || holds.toLowerCase() === 'nothing') && !gaze) continue;
    // Resolve ART### references to the artifact's name when known.
    let holdsPhrase = '';
    if (holds && holds.toLowerCase() !== 'nothing') {
      const artMatch = holds.match(/^(ART\d+)/i);
      if (artMatch && artNames[artMatch[1].toUpperCase()]) {
        holdsPhrase = `holds the ${artNames[artMatch[1].toUpperCase()]}, both hands visibly gripping it`;
      } else {
        holdsPhrase = `holds ${holds}`;
      }
    }
    let gazePhrase = '';
    if (gaze) {
      const gazeArtMatch = gaze.match(/^(ART\d+)/i);
      if (gazeArtMatch && artNames[gazeArtMatch[1].toUpperCase()]) {
        gazePhrase = `eyes fixed on the ${artNames[gazeArtMatch[1].toUpperCase()]}`;
      } else if (/^the viewer$/i.test(gaze)) {
        gazePhrase = `eyes on the viewer`;
      } else if (/^the distance$/i.test(gaze)) {
        gazePhrase = `eyes looking off into the distance`;
      } else {
        gazePhrase = `eyes on ${gaze}`;
      }
    }
    const action = [holdsPhrase, gazePhrase].filter(Boolean).join(', ');
    const prioTag = prio === 'essential' ? ' [ESSENTIAL]' : prio === 'low' ? ' [low]' : '';
    interactionLines.push(`- ${d.name}${prioTag}: ${action}`);
  }
  // Legacy fallback: parse scene-metadata interactions[] when no structured
  // details came through.
  if (interactionLines.length === 0) {
    try {
      const metaMatch = String(sceneDescription || '').match(/---\s*METADATA\s*---([\s\S]*?)(?:\n---|$)/i)
        || String(sceneDescription || '').match(/```json([\s\S]*?)```/i);
      if (metaMatch) {
        const meta = JSON.parse(metaMatch[1].trim().replace(/^json\s*/i, ''));
        const ints = meta.interactions || meta.fullData?.interactions || [];
        for (const ix of ints) {
          if (!ix?.character || !ix?.where) continue;
          const splitChars = String(ix.character).split(/\s*(?:\+|&|\band\b|,)\s*/i).map(s => s.trim()).filter(Boolean);
          const targets = splitChars.length > 1 ? splitChars : [String(ix.character).trim()];
          for (const t of targets) {
            interactionLines.push(`- ${t}: ${ix.where}`);
          }
        }
      }
    } catch { /* metadata not parseable — fall back to positional templates only */ }
  }
  const actionSection = interactionLines.length > 0
    ? `\n═══ STORY ACTION (essential first — these poses are mandatory; environmental detail forbidden) ═══\n${interactionLines.join('\n')}\n**Essential lines override the POSE REDRAW templates below when the same character appears in both.**\n`
    : '';

  // VB grid handling: when present, send as a second image slot. Normalise
  // input format — buildVisualBibleGrid returns a Buffer; coverIterate may
  // also pass a data: URI or base64 string depending on path. Accept all.
  let vbGridBuf = null;
  if (vbGrid) {
    if (Buffer.isBuffer(vbGrid)) {
      vbGridBuf = vbGrid;
    } else if (typeof vbGrid === 'string') {
      const stripped = vbGrid.replace(/^data:image\/\w+;base64,/, '');
      try { vbGridBuf = Buffer.from(stripped, 'base64'); } catch { vbGridBuf = null; }
    }
  }
  const vbGridSection = vbGridBuf
    ? `\n═══ VISUAL BIBLE GRID (second image attached) ═══\nThe SECOND image shows a labeled grid of every artifact, animal, and secondary character referenced in this scene. When the STORY ACTION above names an object (map, chest, key, sword, lantern, etc.), use the matching grid cell as the visual reference for that object — that's exactly what the rendered prop must look like. Do NOT copy the grid cell layout or background into the output; the grid is reference only. The first image (figures on white) remains the primary edit target.\n`
    : '';

  const pass1Prompt = `PASS 1: REPOSE FIGURES ONLY.

The first input image shows ${n} character cutouts on a plain white background${propBuf ? ', plus a prop in the foreground' : ''}. The figures are pasted with ARMS AT THEIR SIDES — this is wrong, and your only job is to redraw their poses per the lines below. Keep the white background. Keep every face/hair/skin/clothing exactly. Just change the poses.
${actionSection}${vbGridSection}
═══ POSE REDRAW (mandatory — do every line) ═══
${POSES.join('\n')}

PRESERVE: every face, hair colour, skin tone, clothing detail, every prop, white background, relative left-to-right positions.

DO NOT add or remove characters. DO NOT add a landscape, sky, ground, buildings, or any background. The background MUST stay pure white. NO TEXT, no signage, no letters anywhere.

If any figure still has arms at their sides, the task has failed. If the background is anything other than white, the task has failed.`;

  // 6. Call Grok pass 1 — figures-on-white as primary edit target, VB grid as
  // a second reference image when available so the model knows exactly what
  // each named artifact / animal / secondary character looks like.
  log.info(`🎨 [COVER-COMPOSITE] ${label}: pass 1 (repose) — Grok edit${vbGridBuf ? ' + VB grid ref' : ''}`);
  const pass1Inputs = vbGridBuf ? [pass1Input, vbGridBuf] : pass1Input;
  const pass1 = await callGrokEdit(pass1Prompt, pass1Inputs);
  if (usageTracker) usageTracker('grok', { cost: 0.02, direct_cost: 0.02, inferenceTime: pass1.elapsedMs }, 'cover_composite_pass1', pass1.modelId);

  // If no landmark, return pass 1 result
  if (!landmarkBuf) {
    return {
      imageData: `data:image/jpeg;base64,${pass1.imageData.toString('base64')}`,
      modelId: pass1.modelId,
      prompt: pass1Prompt,
      totalAttempts: 1,
      debug: {
        pass1Input,
        pass1VbGrid: vbGridBuf || null,
        pass1Output: pass1.imageData,
        pass1Prompt,
        pass1ModelId: pass1.modelId,
        pass1ElapsedMs: pass1.elapsedMs,
      },
    };
  }

  // 7. Cut figures from pass 1 result
  let cutout = await removeBackground(pass1.imageData);
  // 8. Composite cutout onto landmark
  const landmarkResized = await sharp(landmarkBuf).resize(W, H, { fit: 'cover', position: 'centre' }).jpeg({ quality: 92 }).toBuffer();
  const cutoutResized = await sharp(cutout).resize(W, H, { fit: 'inside' }).png().toBuffer();
  const cm = await sharp(cutoutResized).metadata();
  const offX = Math.round((W - cm.width) / 2);
  const offY = Math.round((H - cm.height) / 2);
  const pass2Input = await sharp(landmarkResized).composite([{ input: cutoutResized, left: offX, top: offY }]).jpeg({ quality: 92 }).toBuffer();

  // 9. Build pass 2 prompt
  // Text instruction depends on cover type:
  //   • frontCover / initialPage → render the story title in the upper third
  //   • backCover                → render only the "magicalstory.ch" footer
  //     (back covers must NOT carry the story title per prompts/back-cover.txt;
  //     the template is bypassed entirely on the composite path so the
  //     equivalent rule has to live here instead).
  let textLine = '';
  if (coverKey === 'backCover') {
    textLine = `\nFOOTER TEXT: render exactly the text "magicalstory.ch" inset from the bottom-left corner (roughly 5% in from both the left edge and the bottom edge, sitting clearly inside the frame, not flush against the border). Hand-painted watercolor letterforms — NOT a system font. Do NOT render the story title. Do NOT add any other text, names, or labels — only "magicalstory.ch".`;
  } else if (title) {
    textLine = `\nTITLE TEXT: render this exact title across the upper third of the canvas: "${title}". Hand-painted watercolor letterforms — NOT a system font, not flat digital text. Looks brushed by an illustrator. Letters have depth, integrated with the watercolor scene above the figures. Title goes in the sky / upper background area, never on faces. This is the only text in the image.`;
  }
  // Pass 2: scene prose (legacy stories) is fine because the landmark is
  // already painted into the input — atmosphere matching, no risk of
  // Grok adding a wrong landscape. New stories carry only the structured
  // coverHint, so we build a deterministic atmosphere paragraph instead:
  // mood + per-character action + gaze. Either way, no Haiku round-trip.
  let proseForPass2 = String(sceneDescription || '')
    .split(/\n*---\s*METADATA\s*---/i)[0]
    .replace(/```json[\s\S]*?```/gi, '')
    .replace(/\s+\n/g, '\n')
    .trim();
  // When no prose (structured-only outline), synthesize a short atmospheric
  // paragraph from coverHint so pass-2 still has gaze + mood reinforcement.
  if (!proseForPass2 && (coverHint?.mood || detailEntries.length > 0)) {
    const moodLine = coverHint?.mood ? `Mood: ${coverHint.mood}.` : '';
    const actionPhrases = detailEntries.map(d => {
      const holds = String(d.holds || '').trim();
      const gaze = String(d.gazesAt || '').trim();
      let phrase = d.name;
      if (holds && holds.toLowerCase() !== 'nothing') {
        const m = holds.match(/^(ART\d+)/i);
        const name = m && artNames[m[1].toUpperCase()] ? artNames[m[1].toUpperCase()] : holds;
        phrase += ` holds the ${name}`;
      }
      if (gaze) {
        const m = gaze.match(/^(ART\d+)/i);
        const target = m && artNames[m[1].toUpperCase()]
          ? `the ${artNames[m[1].toUpperCase()]}`
          : (/^the (viewer|distance)$/i.test(gaze) ? gaze : gaze);
        phrase += `, eyes on ${target}`;
      }
      return phrase + '.';
    });
    proseForPass2 = [moodLine, ...actionPhrases].filter(Boolean).join(' ');
  }
  proseForPass2 = proseForPass2.slice(0, 5000);
  const sceneSectionPass2 = proseForPass2
    ? `\n\nSTORY SCENE CONTEXT (do not change poses; this is for atmosphere matching only):\n${proseForPass2}`
    : '';

  const pass2Prompt = `LANDMARK PROTECTION (CRITICAL — read first):
The background of this image is a real photograph of a specific landmark. DO NOT redraw it. DO NOT move buildings. DO NOT change architecture. DO NOT change the skyline. DO NOT add or remove windows. The buildings, the position of every window, the roofline, and the silhouette must remain pixel-faithful to the input photograph. Your edit is a TEXTURE / STYLE pass on top of the existing pixels — not a regeneration of the scene.

YOUR EDIT (in this order):
1. Apply ${styleHint} stylistically across the whole image — soft watercolor brushstrokes, paper texture, gentle wash. The buildings keep their EXACT geometry, only their rendering changes from photographic to painted.
2. The figures (already painted in watercolor with interactive poses) are foreground — blend them into the scene by matching lighting and softening cutout edges. DO NOT change their poses.
3. REPAINT THE GROUND ONLY beneath/around the figures' feet so it reads as a continuation of the actual ground material the landmark stands on (cobblestone, paving stones, plaza, dirt, grass, sand, snow — whichever matches the landmark). Make the transition invisible. Do not extend ground OVER the buildings.${textLine}

PRESERVE EXACTLY:
- Every building, window, roofline, doorway — they are correct in the input.
- Every figure's pose, face, hair, skin tone, clothing.
- Every prop's silhouette and material.
- Every figure's GAZE DIRECTION — if a character is looking down at a held prop in the input, they are still looking down at that prop in the output. Do NOT redirect any gaze toward the camera.

DO NOT redraw or reposition buildings. DO NOT replace the landmark with a generic city. DO NOT change which figures appear or their order. DO NOT add new objects, animals, or extra characters. NOT photoreal — watercolor texture only.${textLine ? '' : ' NO text, no signage, no letters anywhere.'}${sceneSectionPass2}`;

  // 10. Call Grok pass 2
  log.info(`🎨 [COVER-COMPOSITE] ${label}: pass 2 (watercolor + landmark) — Grok edit`);
  const pass2 = await callGrokEdit(pass2Prompt, pass2Input);
  if (usageTracker) usageTracker('grok', { cost: 0.02, direct_cost: 0.02, inferenceTime: pass2.elapsedMs }, 'cover_composite_pass2', pass2.modelId);

  return {
    imageData: `data:image/jpeg;base64,${pass2.imageData.toString('base64')}`,
    modelId: pass2.modelId,
    prompt: pass2Prompt,
    totalAttempts: 1,
    debug: {
      sequence: sequence.map(c => c.name),
      pass1Input,
      pass1VbGrid: vbGridBuf || null,
      pass1Output: pass1.imageData,
      pass1Prompt,
      pass1ModelId: pass1.modelId,
      pass1ElapsedMs: pass1.elapsedMs,
      pass2Input,
      pass2Output: pass2.imageData,
      pass2Prompt,
      pass2ModelId: pass2.modelId,
      pass2ElapsedMs: pass2.elapsedMs,
    },
  };
}

/**
 * Build a serializable compositeAttempts array from the debug object
 * generateCoverViaComposite returns. Single source of truth for how
 * composite-debug Buffers turn into version-row fields — both the unified
 * pipeline (images.js:6745) and the user-triggered iterate endpoint
 * (regeneration.js:1720) MUST use this to build their version rows.
 *
 * Returns null when compositeDebug is absent (legacy iterate ran).
 * Returns [pass1] (length 1) when there's no landmark (pass-2 was skipped).
 * Returns [pass1, pass2] otherwise.
 *
 * @param {object|null|undefined} compositeDebug - from iterateCover result
 * @returns {Array<object>|null}
 */
function buildCompositeAttemptsFromDebug(compositeDebug) {
  if (!compositeDebug) return null;
  const bufToDataUrl = (b, mime = 'image/jpeg') => {
    if (!b) return null;
    if (typeof b === 'string') return b.startsWith('data:') ? b : `data:${mime};base64,${b}`;
    if (Buffer.isBuffer(b)) return `data:${mime};base64,${b.toString('base64')}`;
    return null;
  };
  const pass1 = {
    pass: 1,
    input: bufToDataUrl(compositeDebug.pass1Input, 'image/jpeg'),
    vbGrid: bufToDataUrl(compositeDebug.pass1VbGrid, 'image/jpeg'),
    output: bufToDataUrl(compositeDebug.pass1Output, 'image/jpeg'),
    prompt: compositeDebug.pass1Prompt || null,
    modelId: compositeDebug.pass1ModelId || null,
    elapsedMs: compositeDebug.pass1ElapsedMs || null,
  };
  if (!compositeDebug.pass2Input) {
    return [pass1];
  }
  const pass2 = {
    pass: 2,
    input: bufToDataUrl(compositeDebug.pass2Input, 'image/jpeg'),
    output: bufToDataUrl(compositeDebug.pass2Output, 'image/jpeg'),
    prompt: compositeDebug.pass2Prompt || null,
    modelId: compositeDebug.pass2ModelId || null,
    elapsedMs: compositeDebug.pass2ElapsedMs || null,
  };
  return [pass1, pass2];
}

module.exports = {
  generateCoverViaComposite,
  buildCompositeAttemptsFromDebug,
  // Exported for testing / reuse:
  sortByImportance,
  arrangeCenterOut,
  parseExplicitSequence,
  visualIdentifier,
};
