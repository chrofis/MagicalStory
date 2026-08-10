/**
 * Unit tests for the retained garment colour SAMPLER
 * (server/lib/garmentHueNormalize.js).
 *
 * The hue-normalization PASS this file used to test was retired on 2026-08-08 in
 * favour of server/lib/garmentColourFix.js — see that module's header for why.
 * What remains is the colour maths its successors share: the skin/grey rejection
 * and the chroma-weighted hue clustering. The cases kept are the ones that
 * caught real bugs on real sheets:
 *   - a garment-dominated avatar sheet must keep its chroma (a gray-world "cast"
 *     discount on such a sheet cancelled the very signal being read)
 *   - a two-garment character must yield BOTH garments as separate clusters
 *   - hair must not outrank the garment once the sheet is cropped to the torso
 *
 * Run: node tests/manual/garmentHueNormalize.test.js
 */
const sharp = require('sharp');
const G = require('../../server/lib/garmentHueNormalize');
const { _rgbToLab } = require('../../server/lib/imageCompositing');

const DEG = 180 / Math.PI;
let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));
const hueOf = (rgb) => { const l = _rgbToLab(rgb[0], rgb[1], rgb[2]); return Math.atan2(l[2], l[1]) * DEG; };
const angDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

const RED = [210, 30, 40];
const BLUE = [40, 70, 180];
const SKIN = [232, 188, 158];
const HAIR = [150, 60, 25];   // auburn: saturated, so NOT rejected as grey

const W = 60, N = W * 60;
function canvas(bg) {
  const b = Buffer.alloc(N * 3);
  for (let i = 0; i < N; i++) { b[i * 3] = bg[0]; b[i * 3 + 1] = bg[1]; b[i * 3 + 2] = bg[2]; }
  return b;
}
function rect(buf, x0, y0, x1, y1, rgb) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = y * W + x; buf[i * 3] = rgb[0]; buf[i * 3 + 1] = rgb[1]; buf[i * 3 + 2] = rgb[2];
  }
}

(async () => {
  console.log('\nTEST 1 — isGarmentPixel rejects skin and grey, keeps garments');
  check('vivid red is a garment', G.isGarmentPixel(RED[0], RED[1], RED[2]));
  check('vivid blue is a garment', G.isGarmentPixel(BLUE[0], BLUE[1], BLUE[2]));
  check('skin is rejected', !G.isGarmentPixel(SKIN[0], SKIN[1], SKIN[2]));
  check('mid grey is rejected', !G.isGarmentPixel(150, 150, 150));
  check('neutral white is rejected', !G.isGarmentPixel(250, 250, 250));
  // The grey cut is on SATURATION, not lightness: rgb(248,248,246) computes to
  // s=0.124, just over the 0.12 floor, so a barely-tinted near-white still
  // counts as a garment. That is why the avatar sampler crops to the torso
  // band and the page sampler works inside a segmentation mask — neither may
  // rely on this classifier alone to exclude a pale background.
  check('a barely-tinted near-white is NOT excluded by this classifier',
    G.isGarmentPixel(248, 248, 246));

  // Read in ABSOLUTE space (cast {0,0}). Discounting a gray-world mean here is
  // exactly what cancelled the signal on real avatar sheets.
  console.log('\nTEST 2 — a garment-dominated sheet keeps its chroma');
  const sheet = canvas([250, 250, 250]);
  rect(sheet, 6, 6, 54, 50, RED);
  const cl = G.sampleGarmentClusters(sheet, N, null, { a: 0, b: 0 }, {}, 3);
  check('a cluster is found', cl.length >= 1);
  check('chroma clears the floor', cl[0].chroma >= G.DEFAULTS.chromaMin,
    `chroma=${cl[0] && cl[0].chroma.toFixed(1)}`);
  check('hue is the garment hue', angDist(cl[0].hueRad * DEG, hueOf(RED)) < 8,
    `got ${(cl[0].hueRad * DEG).toFixed(1)}deg`);
  check('cluster carries a mean L*', cl[0].L > 0 && cl[0].L < 100, `L=${cl[0].L}`);

  console.log('\nTEST 3 — a two-garment character yields both as clusters');
  const two = canvas([250, 250, 250]);
  rect(two, 6, 4, 54, 26, RED);    // top
  rect(two, 6, 28, 54, 54, BLUE);  // trousers
  const cl2 = G.sampleGarmentClusters(two, N, null, { a: 0, b: 0 }, {}, 3);
  check('two clusters found', cl2.length >= 2, `got ${cl2.length}`);
  const hues = cl2.map(c => c.hueRad * DEG);
  check('red is among them', hues.some(h => angDist(h, hueOf(RED)) < 12),
    JSON.stringify(hues.map(h => +h.toFixed(0))));
  check('blue is among them', hues.some(h => angDist(h, hueOf(BLUE)) < 12),
    JSON.stringify(hues.map(h => +h.toFixed(0))));

  console.log('\nTEST 4 — the torso band excludes the head, so hair cannot win');
  const rows = 80;
  const sheetBuf = Buffer.alloc(W * rows * 3, 250);
  const put = (x0, y0, x1, y1, rgb) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * W + x; sheetBuf[i * 3] = rgb[0]; sheetBuf[i * 3 + 1] = rgb[1]; sheetBuf[i * 3 + 2] = rgb[2];
    }
  };
  put(4, 2, 56, 34, HAIR);        // head row — plenty of hair
  put(4, 36, 56, 38, [0, 0, 0]);  // row divider
  put(4, 52, 56, 70, RED);        // body row torso — the garment
  const png = await sharp(sheetBuf, { raw: { width: W, height: rows, channels: 3 } }).png().toBuffer();
  const band = await G._internal.avatarTorsoBand(png, W, rows);
  check('band starts below the head row', band.top > 38, `top=${band.top}`);
  const { data, info } = await sharp(png).extract(band).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bandCl = G.sampleGarmentClusters(data, info.width * info.height, null, { a: 0, b: 0 }, {}, 3);
  check('a cluster is found in the band', bandCl.length >= 1);
  check('it is the GARMENT, not the hair',
    angDist(bandCl[0].hueRad * DEG, hueOf(RED)) < angDist(bandCl[0].hueRad * DEG, hueOf(HAIR)),
    `got ${(bandCl[0].hueRad * DEG).toFixed(1)}deg, garment ${hueOf(RED).toFixed(1)}deg, hair ${hueOf(HAIR).toFixed(1)}deg`);

  // ── TEST 5 ───────────────────────────────────────────────────────────────
  // The recolour is a REPAIR METHOD inside the round loop, not a pass bolted on
  // before it or after it (owner, 2026-08-10). The rule:
  //   iterate            → no recolour; the pixels are about to be replaced, so
  //                        correcting them first is wasted work (proved on
  //                        job_1786287569165_7f75jspcz p8: recoloured, then
  //                        iterated, and the recolour died with v0);
  //   inpaint / char-fix → recolour FIRST so the repair works on corrected
  //                        pixels — and a wrong garment colour is one of the
  //                        things that triggers char-fix, so fixing it
  //                        mechanically can remove that Grok call entirely;
  //   nothing else wrong → the recolour IS the repair, method 'recolour'.
  //
  // It ALWAYS produces its OWN separately-graded version (the recolour phase,
  // with its own evaluateImageBatch), even when an inpaint or char-fix follows
  // on the same page: one combined version would mean a failed inpaint drags the
  // good recolour down with it, and the recolour could never ship alone. The
  // repair still receives the corrected bytes through inputOverride, NOT through
  // pick-best — garment colour carries no severity, so the recolour version ties
  // with the original and eval noise would decide what the repair reads.
  //
  // The version is scored by applyScore from its own evaluation, so a recolour
  // that made the page worse loses pick-best. That is what keeps it checked —
  // nothing recoloured ships unseen.
  //
  // Source-level guards, CRLF-normalised: core.autocrlf=true checks this repo
  // out with CR-LF, so LF-only needles would never match.
  console.log('\nTEST 5 — the recolour is a scored repair method in the round loop');
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../../server/lib/repairPipeline.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  // Neither of the two rejected placements survives.
  check('it no longer runs before the repair loop (old "Step 1b")',
    !/Step 1b — mechanical/.test(src));
  check('and not after pick-best either (rejected "Step 4a")',
    !/Step 4a — mechanical/.test(src));

  // A colour-only page scores fine, so findBadPages never returns it.
  check('a colour-only page is pulled into the round',
    /const colourOnlyNums = \[\.\.\.garmentWork\.keys\(\)\]\.filter/.test(src));
  check('and is given the recolour method',
    /\(method === 'skip' \|\| method == null\) && garmentWork\.has/.test(src));
  check('recolour counts as actionable work',
    /counts\.recolour \|\| 0\)/.test(src));

  // The recolour phase — its own pass over pageStrategies, before the repairs.
  check('there is a recolour phase keyed off the decided methods',
    /const recolourTargets = pageStrategies\.filter/.test(src));
  check('NEVER recoloured before an iterate',
    /pStrat\.method !== 'iterate'\s*\n\s*&& garmentWork\.has\(pStrat\.img\.pageNumber\)/.test(src));
  check('skipped and no-op pages are not recoloured either',
    /!pStrat\.skipped/.test(src) && /pStrat\.method !== 'skip'/.test(src));

  // ONE result per page per batch: the round machinery is keyed by pageNumber
  // (roundImageMap, eval lookups, pageVersions.get(ev.pageNumber)), so the
  // recolour cannot share the round's eval call.
  const phaseFrom = src.indexOf('const recolourBytes = new Map()');
  const phaseTo = src.indexOf('const roundStart = Date.now();', phaseFrom);
  check('the recolour phase exists before the repairs', phaseFrom > 0 && phaseTo > phaseFrom);
  const phase = src.slice(phaseFrom, phaseTo);
  check('it evaluates in its OWN batch, not the round batch',
    /await images\(\)\.evaluateImageBatch\(\s*\n?\s*buildEvalInputs\(recolourResults\)/.test(phase));
  check('it pushes its own version with the garment-recolour source',
    /source: `garment-recolour-round-\$\{round\}`/.test(phase)
    && /versions\.push\(recolourVersion\)/.test(phase));
  check('and that version is SCORED, never appointed',
    /applyScore\(recolourVersion, \{/.test(phase)
    && /evalResult: ev/.test(phase)
    && /entityResult: evEntityResult/.test(phase)
    && /consolidatedPlan: recolourConsolidated\.get\(ev\.pageNumber\)/.test(phase));
  check('the corrected bytes are remembered for the repair',
    /recolourBytes\.set\(rc\.pageNumber, rc\.imageData\)/.test(phase));

  // inputOverride is KEPT: the repair must not depend on the recolour version
  // winning pick-best (garment colour carries no severity → the scores tie).
  check('the repair reads the recoloured bytes via the override map',
    /const recolourInput = recolourBytes\.get\(pageNumber\) \|\| null;/.test(src));
  check('inpaint receives the recoloured bytes',
    /executeInpaintAction\(img, latestEval, round, recolourInput\)/.test(src));
  check('char-fix receives the recoloured bytes',
    /executeCharFixAction\(img, decision, round, recolourInput\)/.test(src));
  check('both default the override to null, so nothing else changes',
    /executeInpaintAction = async \(img, latestEval, roundNum = null, inputOverride = null\)/.test(src)
    && /executeCharFixAction = async \(img, decision, roundNum, inputOverride = null\)/.test(src));

  // The dispatch no longer produces a recolour image — phase (c) owns that.
  check('the dispatch has no recolour branch returning imageData',
    /if \(method === 'recolour'\) \{\s*\n\s*return \{ pageNumber, imageData: null, skipped: true \};/.test(src));
  check('and never calls runGarmentRecolour itself',
    src.split('runGarmentRecolour').length - 1 === 2);  // the definition + the phase

  check('a failed repair does not discard a good recolour',
    /const failed = \(error\) => \(\(recolourInput && !recolourVersioned\.has\(pageNumber\)\)/.test(src));
  check('the recolour reads the scored best, not merely the newest',
    /selectBestVersion\(pageVersions\.get\(pageNumber\) \|\| \[\]\)/.test(src));
  check('an already-handled mismatch is not recoloured twice',
    /if \(m\.fixOutcome\) continue;/.test(src));
  check('changed bytes invalidate the stamped detection',
    /if \(detection\) detection\.sourceImageFp = null;/.test(src));

  // ── TEST 6 ───────────────────────────────────────────────────────────────
  // The low-chroma blind spot, which is WHY the reference now gets a SAM mask.
  // Old avatar path: DINO box -> raw rectangle -> sampleGarmentClusters. The
  // rectangle around a cream hat also holds background, white hair and brown
  // boots; the clustering rejects near-grey as "not garment", so the cream is
  // discarded and the saturated brown beside it is returned. That is exactly
  // how a correct cream hat was repainted brown (Lab exp 485). A plain mean
  // over a true silhouette has no such blind spot.
  console.log('\nTEST 6 — a cream garment survives a masked mean but is lost to the clustering');
  const { meanLabMasked } = require('../../server/lib/garmentColourFix');
  const CREAM = [232, 224, 200];   // low chroma, high L — a cream hat
  const BOOT = [120, 74, 34];      // saturated brown sitting in the same box
  const cropBuf = canvas(BOOT);                 // the rectangle is mostly NOT the hat
  rect(cropBuf, 0, 0, W, 18, CREAM);            // the hat occupies the top band
  const creamHue = hueOf(CREAM);

  const clustered = G.sampleGarmentClusters(cropBuf, N, null, { a: 0, b: 0 }, {}, 3);
  check('the clustering does NOT return the cream', clustered.length === 0
    || angDist(clustered[0].hueRad * DEG, creamHue) > angDist(clustered[0].hueRad * DEG, hueOf(BOOT)),
    clustered.length ? `got ${(clustered[0].hueRad * DEG).toFixed(1)}deg, cream ${creamHue.toFixed(1)}deg` : 'no cluster at all');

  // Same pixels, but with a silhouette covering only the hat.
  const alpha = Buffer.alloc(N);
  for (let y = 0; y < 18; y++) for (let x = 0; x < W; x++) alpha[y * W + x] = 255;
  const m = meanLabMasked(cropBuf, alpha);
  const creamLab = _rgbToLab(CREAM[0], CREAM[1], CREAM[2]);
  check('the masked mean returns the cream', m && Math.abs(m.L - creamLab[0]) < 1.5,
    m ? `L ${m.L.toFixed(1)} vs cream L ${creamLab[0].toFixed(1)}` : 'null');
  check('it counts only the masked pixels', m && m.count === W * 18, `count=${m?.count}`);

  // Source guard: the avatar path must segment, not crop-and-cluster.
  const gsrc = require('fs')
    .readFileSync(require.resolve('../../server/lib/garmentColourFix.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const aFrom = gsrc.indexOf('async function avatarGarmentLab');
  const aTo = gsrc.indexOf('async function fixFigureGarmentColour');
  const avatarFn = gsrc.slice(aFrom, aTo);
  check('avatarGarmentLab segments the reference', /await segmentGarment\(/.test(avatarFn));
  check('and takes a plain masked mean', /meanLabMasked\(data, seg\.alpha\)/.test(avatarFn));
  // The torso band used to be the fallback here. It is gone entirely now — see
  // TEST 7, which asserts that — so this only checks nothing measures a target
  // by any route other than the mask.
  check('there is no second, unmasked way to produce a target',
    !/sampleGarmentClusters\(/.test(avatarFn));

  // ── TEST 7 ───────────────────────────────────────────────────────────────
  // The garment word goes to GroundingDINO verbatim. The old table mapped it
  // onto one of six canned prompts with an unconditional `'top'` fallback, and
  // `top` selected the avatar's TORSO — so an unrecognised word aimed the repair
  // at the wrong part of the body. On job_1786287569165_7f75jspcz "breeches"
  // became `top` (legwear matched to the chest) and "sash" became `top` too,
  // colliding with breeches on the caller's dedupe key so the sash vanished with
  // no outcome recorded at all.
  console.log('\nTEST 7 — the garment word is passed through, not translated');
  const { garmentQueryFor } = require('../../server/lib/garmentColourFix');
  const q = (g) => garmentQueryFor(g);

  check('breeches stay breeches', q('breeches').prompt === 'the breeches worn by the person',
    q('breeches').prompt);
  check('sash stays sash', q('sash').prompt === 'the sash worn by the person', q('sash').prompt);
  // "hood" fell through too: a stray 0x08 byte had been written into the
  // headwear pattern where \b was intended, so the alternative required a
  // literal backspace after "hood" and never matched.
  check('hood stays hood', q('hood').prompt === 'the hood worn by the person', q('hood').prompt);
  check('multi-word garments survive', q('tricorn hat').key === 'tricorn hat', q('tricorn hat').key);
  check('the key is normalised for dedupe', q('  Waistcoat! ').key === 'waistcoat', q('  Waistcoat! ').key);

  check('no garment word REFUSES rather than defaulting', q('').key === null && q(null).key === null);
  check('and offers no prompt to fall back on', q('').prompt === null);

  // Distinct garments must not collide on the caller's dedupe key.
  const dedupeKey = (name, page, garment) => `${name.toLowerCase()}|${page}|${garmentQueryFor(garment).key || '(unnamed)'}`;
  check('breeches and sash no longer share a dedupe key',
    dedupeKey('Hans', 8, 'breeches') !== dedupeKey('Hans', 8, 'sash'),
    `${dedupeKey('Hans', 8, 'breeches')} vs ${dedupeKey('Hans', 8, 'sash')}`);
  check('the same garment still dedupes', dedupeKey('Hans', 8, 'Sash') === dedupeKey('Hans', 8, 'sash'));

  const gfix = require('fs')
    .readFileSync(require.resolve('../../server/lib/garmentColourFix.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  check('the kind table is gone', !/garmentPrompts\s*:/.test(gfix));
  check('and so is its default', !/defaultGarment/.test(gfix));
  check('the torso-band fallback is gone with it', !/avatarTorsoBand\(/.test(gfix));
  const pipe = require('fs')
    .readFileSync(require.resolve('../../server/lib/repairPipeline.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  check('the pipeline dedupes on character + garment word per page',
    // collectGarmentWork keys a per-page Map by character+garment, so two
    // different garments on one page can never collapse into one entry.
    /const k = `\$\{charName\.toLowerCase\(\)\}\|\$\{garmentKey\}`/.test(pipe));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
