/**
 * Local test for the Sarah occluder-subtraction fix.
 *
 * Loads the orignal.jpg + estimated bboxes for Sarah (target) and the
 * boy in front of her (occluder). Reproduces the silhouette + mask
 * pipeline from repairCharacterMismatchWithGrok with BOTH the BEFORE
 * (no subtraction — boy bleeds into the magenta) and AFTER (subtract
 * boy's silhouette via dest-out) variants, dumping every intermediate
 * to /tmp/sarah-test/ so we can eyeball the result.
 *
 * Requires the Python photo_analyzer service running on :5000.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ORIG = 'C:/Users/roger/Downloads/orignal.jpg';
const OUT  = '/tmp/sarah-test';

// Sarah's bbox in normalized 0..1 [ymin, xmin, ymax, xmax].
// Estimated from the 1024x1024 scene by eyeballing the woman with the
// white shirt + blue skirt + glasses, top-center-right of the frame.
const SARAH_BBOX = [0.08, 0.58, 0.72, 0.78];

// The boy on the right (green dino hoodie, kneeling, holding letter).
// He occludes Sarah's lower half — his shoulder + arm + letter overlap
// with the magenta region in the overlay.png artifact.
const BOY_BBOX = [0.45, 0.66, 0.94, 0.90];

/**
 * Keep only the connected component of the silhouette that contains the
 * seed pixel. The boy-padded crop's rembg result is "boy + Sarah's
 * protruding parts (foot, hand)"; without isolation we'd subtract Sarah's
 * own body from her own mask. A flood fill from the boy's bbox center
 * keeps just the boy and drops disconnected parts (Sarah's foot is
 * separated by a gap of background, so it's a separate component).
 */
async function isolateConnectedComponent(silhouettePngBuffer, seedX, seedY) {
  const { data, info } = await sharp(silhouettePngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const C = info.channels;
  const A = C - 1;
  const isFg = (x, y) => x >= 0 && x < W && y >= 0 && y < H && data[(y * W + x) * C + A] > 128;
  // If seed is in background, search outwards for nearest foreground pixel.
  let sx = seedX, sy = seedY;
  if (!isFg(sx, sy)) {
    let found = false;
    for (let r = 1; r < Math.max(W, H) && !found; r++) {
      for (let dy = -r; dy <= r && !found; dy++) {
        for (let dx = -r; dx <= r && !found; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          if (isFg(sx + dx, sy + dy)) { sx += dx; sy += dy; found = true; }
        }
      }
    }
    if (!found) return silhouettePngBuffer;
  }
  const visited = new Uint8Array(W * H);
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const idx = y * W + x;
    if (visited[idx]) continue;
    if (data[idx * C + A] <= 128) continue;
    visited[idx] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255;
    out[i * 4 + 3] = visited[i] ? 255 : 0;
  }
  return await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

async function fetchSilhouette(cropJpegBuffer, label) {
  const photoAnalyzerUrl = process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
  const res = await fetch(`${photoAnalyzerUrl}/silhouette-edge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: `data:image/jpeg;base64,${cropJpegBuffer.toString('base64')}`,
      color: [255, 255, 255],
      alpha: 255,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    console.error(`[${label}] silhouette-edge returned ${res.status}`);
    return null;
  }
  const j = await res.json();
  const m = j?.image?.match?.(/^data:image\/\w+;base64,(.+)$/);
  if (!j?.success || !m) {
    console.error(`[${label}] silhouette-edge response malformed: success=${j?.success}`);
    return null;
  }
  return Buffer.from(m[1], 'base64');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const sceneBuffer = fs.readFileSync(ORIG);
  const sceneMeta = await sharp(sceneBuffer).metadata();
  console.log(`Scene: ${sceneMeta.width}x${sceneMeta.height}`);

  // Step 1 — translate Sarah's bbox → pixel hatch region.
  const [tymin, txmin, tymax, txmax] = SARAH_BBOX;
  const hatchLeft   = Math.floor(txmin * sceneMeta.width);
  const hatchTop    = Math.floor(tymin * sceneMeta.height);
  const hatchRight  = Math.ceil(txmax * sceneMeta.width);
  const hatchBottom = Math.ceil(tymax * sceneMeta.height);
  const hatchWidth  = hatchRight - hatchLeft;
  const hatchHeight = hatchBottom - hatchTop;
  console.log(`Sarah hatch region: (${hatchLeft},${hatchTop}) ${hatchWidth}x${hatchHeight}`);

  // Step 2 — crop the hatch region and save for inspection.
  const hatchCrop = await sharp(sceneBuffer)
    .extract({ left: hatchLeft, top: hatchTop, width: hatchWidth, height: hatchHeight })
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '01-sarah-bbox-crop.jpg'), hatchCrop);

  // Step 3 — fetch the BEFORE silhouette (rembg on Sarah's crop returns
  // Sarah + the boy because both are foreground inside this crop).
  const sarahSilhouette = await fetchSilhouette(hatchCrop, 'sarah');
  if (!sarahSilhouette) throw new Error('rembg failed for Sarah');
  // The raw silhouette is white-on-transparent which renders blank in image
  // viewers. Save BOTH the raw mask AND a visible debug version where the
  // mask area is tinted magenta over the original crop.
  fs.writeFileSync(path.join(OUT, '02a-sarah-silhouette-raw.png'), sarahSilhouette);
  const sarahSilhouetteTinted = await sharp({
    create: { width: hatchWidth, height: hatchHeight, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } }
  }).composite([{ input: sarahSilhouette, blend: 'dest-in' }]).png().toBuffer();
  const sarahDebug = await sharp(hatchCrop)
    .composite([{ input: sarahSilhouetteTinted, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '02b-sarah-silhouette-BEFORE-debug.jpg'), sarahDebug);

  // Step 4 — for the occluder, crop the boy's bbox (with 20% padding so
  // rembg sees the full body — a tight bbox truncates the silhouette at
  // the bbox edges) and get his own silhouette.
  const OCC_PAD = 0.20;
  const [bymin, bxmin, bymax, bxmax] = BOY_BBOX;
  const bh = bymax - bymin;
  const bw = bxmax - bxmin;
  const bxminPad = Math.max(0, bxmin - bw * OCC_PAD);
  const bxmaxPad = Math.min(1, bxmax + bw * OCC_PAD);
  const byminPad = Math.max(0, bymin - bh * OCC_PAD);
  const bymaxPad = Math.min(1, bymax + bh * OCC_PAD);
  const occLeft   = Math.floor(bxminPad * sceneMeta.width);
  const occTop    = Math.floor(byminPad * sceneMeta.height);
  const occRight  = Math.ceil(bxmaxPad * sceneMeta.width);
  const occBottom = Math.ceil(bymaxPad * sceneMeta.height);
  const occWidth  = occRight - occLeft;
  const occHeight = occBottom - occTop;
  console.log(`Boy occluder region: (${occLeft},${occTop}) ${occWidth}x${occHeight}`);

  const boyCrop = await sharp(sceneBuffer)
    .extract({ left: occLeft, top: occTop, width: occWidth, height: occHeight })
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '03-boy-bbox-crop.jpg'), boyCrop);

  const boySilhouetteRaw = await fetchSilhouette(boyCrop, 'boy');
  if (!boySilhouetteRaw) throw new Error('rembg failed for boy');
  fs.writeFileSync(path.join(OUT, '04a-boy-silhouette-raw.png'), boySilhouetteRaw);
  const boyRawTinted = await sharp({
    create: { width: occWidth, height: occHeight, channels: 4, background: { r: 0, g: 255, b: 255, alpha: 1 } }
  }).composite([{ input: boySilhouetteRaw, blend: 'dest-in' }]).png().toBuffer();
  const boyRawDebug = await sharp(boyCrop)
    .composite([{ input: boyRawTinted, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '04b-boy-silhouette-raw-debug.jpg'), boyRawDebug);

  // Isolate the boy's connected component using a seed at the center of
  // his UNPADDED bbox (translated into padded-crop coords).
  const unpaddedBoyCenterX = (bxmin + bxmax) / 2;
  const unpaddedBoyCenterY = (bymin + bymax) / 2;
  const seedX = Math.round(unpaddedBoyCenterX * sceneMeta.width - occLeft);
  const seedY = Math.round(unpaddedBoyCenterY * sceneMeta.height - occTop);
  console.log(`Boy CC seed @ (${seedX},${seedY}) within ${occWidth}x${occHeight} padded crop`);
  const boySilhouette = await isolateConnectedComponent(boySilhouetteRaw, seedX, seedY);
  fs.writeFileSync(path.join(OUT, '04c-boy-silhouette-isolated.png'), boySilhouette);
  const boyIsoTinted = await sharp({
    create: { width: occWidth, height: occHeight, channels: 4, background: { r: 0, g: 255, b: 255, alpha: 1 } }
  }).composite([{ input: boySilhouette, blend: 'dest-in' }]).png().toBuffer();
  const boyIsoDebug = await sharp(boyCrop)
    .composite([{ input: boyIsoTinted, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '04d-boy-silhouette-isolated-debug.jpg'), boyIsoDebug);

  // Step 5 — subtract boy from Sarah via dest-out.
  // sharp.composite requires the input image to fit inside the dest, so when
  // the occluder bbox is wider/taller than the target hatch or sticks outside
  // it, we crop the occluder silhouette to the intersection of the two
  // rectangles first, then offset by the intersection's top-left inside the
  // Sarah-hatch coordinate frame.
  const iLeft   = Math.max(hatchLeft, occLeft);
  const iTop    = Math.max(hatchTop,  occTop);
  const iRight  = Math.min(hatchLeft + hatchWidth,  occLeft + occWidth);
  const iBottom = Math.min(hatchTop  + hatchHeight, occTop  + occHeight);
  const iW = iRight - iLeft;
  const iH = iBottom - iTop;
  console.log(`Intersection rect: (${iLeft},${iTop}) ${iW}x${iH}`);

  const boySubRect = await sharp(boySilhouette)
    .extract({ left: iLeft - occLeft, top: iTop - occTop, width: iW, height: iH })
    .png().toBuffer();

  const subtractedMask = await sharp(sarahSilhouette)
    .composite([{ input: boySubRect, left: iLeft - hatchLeft, top: iTop - hatchTop, blend: 'dest-out' }])
    .png().toBuffer();

  // --- Alternative path: subtract the UNPADDED boy bbox as a solid rect.
  // No rembg on the occluder. Loses any Sarah pixels that fall inside the
  // boy's bbox (lower skirt, foot, hand if reaching there) but does NOT
  // get confused by rembg lumping touching figures together. Compared to
  // the silhouette path, this trades smooth boy-edges for predictable
  // collateral.
  const unpaddedBoyLeft   = Math.floor(bxmin * sceneMeta.width);
  const unpaddedBoyTop    = Math.floor(bymin * sceneMeta.height);
  const unpaddedBoyRight  = Math.ceil(bxmax * sceneMeta.width);
  const unpaddedBoyBottom = Math.ceil(bymax * sceneMeta.height);
  const rectLeft   = Math.max(hatchLeft, unpaddedBoyLeft);
  const rectTop    = Math.max(hatchTop,  unpaddedBoyTop);
  const rectRight  = Math.min(hatchLeft + hatchWidth,  unpaddedBoyRight);
  const rectBottom = Math.min(hatchTop  + hatchHeight, unpaddedBoyBottom);
  const rectW = rectRight - rectLeft;
  const rectH = rectBottom - rectTop;
  const blackRect = await sharp({
    create: { width: rectW, height: rectH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
  }).png().toBuffer();
  const subtractedMaskRect = await sharp(sarahSilhouette)
    .composite([{ input: blackRect, left: rectLeft - hatchLeft, top: rectTop - hatchTop, blend: 'dest-out' }])
    .png().toBuffer();
  const subtractedRectTinted = await sharp({
    create: { width: hatchWidth, height: hatchHeight, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } }
  }).composite([{ input: subtractedMaskRect, blend: 'dest-in' }]).png().toBuffer();
  const subtractedRectDebug = await sharp(hatchCrop)
    .composite([{ input: subtractedRectTinted, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '05c-sarah-silhouette-AFTER-RECT-debug.jpg'), subtractedRectDebug);
  fs.writeFileSync(path.join(OUT, '05a-sarah-silhouette-AFTER-subtract-raw.png'), subtractedMask);
  const subtractedTinted = await sharp({
    create: { width: hatchWidth, height: hatchHeight, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } }
  }).composite([{ input: subtractedMask, blend: 'dest-in' }]).png().toBuffer();
  const subtractedDebug = await sharp(hatchCrop)
    .composite([{ input: subtractedTinted, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '05b-sarah-silhouette-AFTER-debug.jpg'), subtractedDebug);

  // Step 6 — build the magenta crosshatch (same SVG as production).
  const HATCH_STROKE = 2;
  const HATCH_COLOR = '#FF00FF';
  const hatchSpacing = Math.max(16, Math.round(Math.min(hatchWidth, hatchHeight) * 0.06));
  const hatchSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${hatchWidth}" height="${hatchHeight}">
  <defs>
    <pattern id="h" x="0" y="0" width="${hatchSpacing}" height="${hatchSpacing}" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="${hatchSpacing}" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
      <line x1="${hatchSpacing}" y1="0" x2="0" y2="${hatchSpacing}" stroke="${HATCH_COLOR}" stroke-width="${HATCH_STROKE}"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${hatchWidth}" height="${hatchHeight}" fill="url(#h)"/>
</svg>`;
  const hatchOnly = await sharp(Buffer.from(hatchSvg)).png().toBuffer();

  // Step 7 — clip the crosshatch to the BEFORE mask (production prior to fix).
  const hatchBefore = await sharp(hatchOnly)
    .composite([{ input: sarahSilhouette, blend: 'dest-in' }])
    .png().toBuffer();
  const overlayBefore = await sharp(sceneBuffer)
    .composite([{ input: hatchBefore, left: hatchLeft, top: hatchTop, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '06-overlay-BEFORE.jpg'), overlayBefore);

  // Step 8 — clip the crosshatch to the AFTER mask (with boy subtracted).
  const hatchAfter = await sharp(hatchOnly)
    .composite([{ input: subtractedMask, blend: 'dest-in' }])
    .png().toBuffer();
  const overlayAfter = await sharp(sceneBuffer)
    .composite([{ input: hatchAfter, left: hatchLeft, top: hatchTop, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '07-overlay-AFTER.jpg'), overlayAfter);

  // Step 8b — same, but using the rect-subtraction mask.
  const hatchAfterRect = await sharp(hatchOnly)
    .composite([{ input: subtractedMaskRect, blend: 'dest-in' }])
    .png().toBuffer();
  const overlayAfterRect = await sharp(sceneBuffer)
    .composite([{ input: hatchAfterRect, left: hatchLeft, top: hatchTop, blend: 'over' }])
    .jpeg({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(OUT, '08-overlay-AFTER-RECT.jpg'), overlayAfterRect);

  console.log(`\n✅ Done. Output in ${OUT}`);
  console.log('Files:');
  for (const f of fs.readdirSync(OUT).sort()) {
    const s = fs.statSync(path.join(OUT, f));
    console.log(`  ${f}  (${(s.size/1024).toFixed(1)} KB)`);
  }
})().catch(err => { console.error(err); process.exit(1); });
