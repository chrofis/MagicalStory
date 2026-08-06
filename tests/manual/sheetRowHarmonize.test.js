/**
 * Unit tests for the 2x4 sheet row-colour consistency gate + harmonize backstop
 * (server/lib/sheetRowHarmonize.js).
 *
 * Builds synthetic two-row "sheets" with sharp (real encode/decode, no model,
 * no network) and asserts the measurement contract and the correction contract:
 *   - agreeing rows          → consistent, harmonize is a no-op
 *   - washed-out bottom row  → inconsistent, bottom is corrected onto the top
 *   - washed-out TOP row     → authority follows CHROMA, not row position
 *   - head row with no garment (head-and-neck cells) → skip, never invent
 *   - genuinely different garments per row           → skip, never merge
 *   - the corrected row lands on the authority's LAB colour (L* DOES move here:
 *     both rows are the same garment under the same studio light, unlike a page)
 *
 * Run: node tests/manual/sheetRowHarmonize.test.js
 */
const assert = require('assert');
const sharp = require('sharp');
const H = require('../../server/lib/sheetRowHarmonize');
const { _rgbToLab } = require('../../server/lib/images');

const W = 120, ROW = 80, FULL = ROW * 2;

let passed = 0, failed = 0;
function check(desc, cond, extra) {
  if (cond) { passed++; console.log(`  ok  ${desc}`); }
  else { failed++; console.log(`FAIL  ${desc}${extra ? '  — ' + extra : ''}`); }
}

// Build a 2-row sheet: each row is neutral grey with a garment patch.
// `garment` null → that row has no garment at all (bare head cells).
async function sheet(topGarment, bottomGarment) {
  const buf = Buffer.alloc(W * FULL * 3, 200); // light neutral background
  const paint = (rowTop, rgb) => {
    if (!rgb) return;
    for (let y = rowTop + 20; y < rowTop + 70; y++) {
      for (let x = 20; x < 100; x++) {
        const i = (y * W + x) * 3;
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2];
      }
    }
  };
  paint(0, topGarment);
  paint(ROW, bottomGarment);
  const png = await sharp(buf, { raw: { width: W, height: FULL, channels: 3 } }).png().toBuffer();
  return 'data:image/png;base64,' + png.toString('base64');
}

// Vivid vs washed-out versions of the SAME hue family (a pink top, stylised vs
// left photographic) — the exact real-world failure this module exists for.
const PINK_VIVID = [235, 60, 130];
const PINK_PALE = [236, 190, 205];
const BLUE = [40, 70, 180];

(async () => {
  // ── 1 — rows agree → consistent, harmonize is a no-op ──────────────────────
  console.log('\nTEST 1 — matching rows are consistent and untouched');
  {
    const s = await sheet(PINK_VIVID, PINK_VIVID);
    const m = await H.measureRowConsistency(s, ROW);
    check('consistent', m.consistent === true, m.reason);
    const h = await H.harmonizeSheetRows(s, ROW);
    check('harmonize is a no-op', h.changed === false);
    check('image returned unchanged', h.imageData === s);
  }

  // ── 2 — washed-out BOTTOM row → detected + corrected onto the top ──────────
  console.log('\nTEST 2 — washed-out body row is detected and corrected');
  {
    const s = await sheet(PINK_VIVID, PINK_PALE);
    const m = await H.measureRowConsistency(s, ROW);
    check('flagged inconsistent', m.consistent === false, m.reason);
    check('chroma ratio is the signal', m.chromaRatio > H.DEFAULTS.maxChromaRatio, `ratio=${m.chromaRatio}`);
    const h = await H.harmonizeSheetRows(s, ROW);
    check('harmonize applied', h.changed === true, h.measurement.reason);
    check('head row is the authority (higher chroma)', h.authority === 'headRow', h.authority);
    check('the LAB move raises chroma and darkens toward the vivid row',
      Math.hypot(h.deltaLab.a, h.deltaLab.b) > 5 && h.deltaLab.L < 0,
      JSON.stringify(h.deltaLab));
    // Re-measure the corrected sheet: the rows must now agree.
    const m2 = await H.measureRowConsistency(h.imageData, ROW);
    check('corrected sheet now measures consistent', m2.consistent === true, m2.reason);
    check('bottom row chroma moved toward the top', m2.chromaRatio < m.chromaRatio,
      `${m.chromaRatio} → ${m2.chromaRatio}`);
  }

  // ── 3 — authority follows CHROMA, not row position ────────────────────────
  console.log('\nTEST 3 — authority is the higher-chroma row, not always the head row');
  {
    const s = await sheet(PINK_PALE, PINK_VIVID); // inverted: TOP is the weak one
    const h = await H.harmonizeSheetRows(s, ROW);
    check('harmonize applied', h.changed === true, h.measurement.reason);
    check('body row is the authority', h.authority === 'bodyRow', h.authority);
    const m2 = await H.measureRowConsistency(h.imageData, ROW);
    check('corrected sheet now measures consistent', m2.consistent === true, m2.reason);
  }

  // ── 4 — head row with NO garment → skip, never invent a colour ─────────────
  console.log('\nTEST 4 — a head row with no garment is skipped, not invented');
  {
    const s = await sheet(null, PINK_VIVID);
    const m = await H.measureRowConsistency(s, ROW);
    check('reported consistent (nothing to compare)', m.consistent === true, m.reason);
    check('reason names the missing head-row garment', /head row/.test(m.reason), m.reason);
    const h = await H.harmonizeSheetRows(s, ROW);
    check('harmonize is a no-op', h.changed === false);
  }

  // ── 5 — genuinely DIFFERENT garments per row → skip, never merge ───────────
  console.log('\nTEST 5 — different garments in each row are left alone');
  {
    const s = await sheet(PINK_VIVID, BLUE);
    const m = await H.measureRowConsistency(s, ROW);
    check('not flagged as a split', m.consistent === true, m.reason);
    check('reason names the association failure', /no shared garment/.test(m.reason), m.reason);
    const h = await H.harmonizeSheetRows(s, ROW);
    check('harmonize is a no-op — a blue row is never repainted pink', h.changed === false);
  }

  // ── 6 — L* preserved by the correction ────────────────────────────────────
  console.log('\nTEST 6 — the weak row lands on the authority row colour');
  {
    const s = await sheet(PINK_VIVID, PINK_PALE);
    const h = await H.harmonizeSheetRows(s, ROW);
    const after = await sharp(Buffer.from(h.imageData.split(',')[1], 'base64')).removeAlpha().raw().toBuffer();
    const at = (y, x) => { const i = (y * W + x) * 3; return _rgbToLab(after[i], after[i + 1], after[i + 2]); };
    const top = at(45, 60), bot = at(ROW + 45, 60); // both garment centres
    const dE = Math.hypot(top[0] - bot[0], top[1] - bot[1], top[2] - bot[2]);
    check('the two rows now read as the same colour (dE < 10)', dE < 10, `dE=${dE.toFixed(1)}`);
    const pale = _rgbToLab(PINK_PALE[0], PINK_PALE[1], PINK_PALE[2]);
    check('the bottom row actually moved off its original pale pink',
      Math.hypot(bot[0] - pale[0], bot[1] - pale[1], bot[2] - pale[2]) > 10);
  }

  // ── 7 — an unusable split is a safe no-op ─────────────────────────────────
  console.log('\nTEST 7 — an unusable row divider degrades safely');
  {
    const s = await sheet(PINK_VIVID, PINK_PALE);
    for (const bad of [0, -5, FULL, FULL + 10]) {
      const m = await H.measureRowConsistency(s, bad);
      assert(m.consistent === true, `splitY=${bad} should be a safe no-op`);
    }
    check('every out-of-range divider is a safe no-op', true);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
