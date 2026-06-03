#!/usr/bin/env node
/**
 * One-shot: generate responsive WebP variants for every city hero JPG.
 *
 * The `/stadt/{cityId}` page renders four hero illustrations per city. They
 * ship as 1024×1024 JPEGs (~290 KB each) but render at ~319–600 px CSS-wide,
 * so they were both over-sized AND in a non-modern format. PageSpeed on
 * /stadt/baden estimated ~526 KB savings from format+size optimization.
 *
 * Output, per source JPG:
 *   foo.jpg              ← unchanged (kept as <img> fallback for old browsers)
 *   foo-640w.webp        ← mobile / 1× tablet, ~50–80 KB
 *   foo-1280w.webp       ← 2× desktop, ~150–200 KB
 *
 * The CityPage `<picture>` element picks WebP for modern browsers and the
 * correct width via `srcset` + `sizes`. JPG stays as the universal fallback.
 *
 * Usage:
 *   node scripts/admin/optimize-city-images.js          # apply (idempotent)
 *   node scripts/admin/optimize-city-images.js --dry    # show what would change
 *
 * Re-runs are safe: existing -640w.webp / -1280w.webp variants are skipped
 * unless --force is passed.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..', '..', 'client', 'public', 'images', 'cities');
const VARIANTS = [
  { width: 640, suffix: '-640w.webp', quality: 80 },
  { width: 1280, suffix: '-1280w.webp', quality: 78 },
];

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const FORCE = args.has('--force');

function* walkJpgs(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walkJpgs(full);
    else if (/\.jpe?g$/i.test(ent.name) && !ent.name.includes('-640w') && !ent.name.includes('-1280w')) {
      yield full;
    }
  }
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`Source dir not found: ${ROOT}`);
    process.exit(1);
  }

  console.log(`Mode: ${DRY ? 'DRY-RUN' : 'APPLY'}${FORCE ? ' (FORCE re-encode)' : ''}`);
  console.log(`Source: ${path.relative(process.cwd(), ROOT)}`);
  console.log();

  let processed = 0;
  let skipped = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const jpg of walkJpgs(ROOT)) {
    const stat = fs.statSync(jpg);
    bytesBefore += stat.size;
    const base = jpg.replace(/\.jpe?g$/i, '');
    const rel = path.relative(process.cwd(), jpg);

    for (const v of VARIANTS) {
      const out = `${base}${v.suffix}`;
      if (!FORCE && fs.existsSync(out)) {
        skipped++;
        bytesAfter += fs.statSync(out).size;
        continue;
      }
      if (DRY) {
        console.log(`  [would-write] ${path.relative(process.cwd(), out)}`);
        continue;
      }
      const outBuf = await sharp(jpg)
        .resize({ width: v.width, withoutEnlargement: true })
        .webp({ quality: v.quality, effort: 5 })
        .toBuffer();
      fs.writeFileSync(out, outBuf);
      bytesAfter += outBuf.length;
      processed++;
      const sizeKb = (outBuf.length / 1024).toFixed(1);
      console.log(`  [wrote] ${path.relative(process.cwd(), out)} (${sizeKb} KB)`);
    }
    if (!DRY) console.log(`  → ${rel}`);
  }

  console.log();
  console.log(`Wrote: ${processed} variants`);
  console.log(`Skipped (already exists): ${skipped}`);
  console.log(`Original JPG total: ${(bytesBefore / 1024).toFixed(0)} KB`);
  console.log(`WebP variants total: ${(bytesAfter / 1024).toFixed(0)} KB`);
}

main().catch(e => { console.error(e); process.exit(1); });
