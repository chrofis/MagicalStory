#!/usr/bin/env node
/**
 * One-shot optimizer for the landing-page + nav image assets flagged by
 * PageSpeed Insights (≈871 KiB savings).
 *
 * For each entry, we resize to roughly 2× the actual display dimensions
 * (retina headroom) and emit a WebP. Originals are renamed to *-orig.*
 * the first time around, so re-running this script is idempotent — it
 * always re-encodes from the original. The arrow icon is also re-emitted
 * as a tiny PNG (no WebP — kept as PNG so transparent-bg lookup stays
 * simple, and 1KB PNG is already smaller than 1KB WebP).
 *
 * Usage:
 *   node scripts/optimize-landing-images.js
 *
 * Output: images/<name>.webp  (+ smaller PNG for the arrow icon)
 *         images/<name>-orig.<ext>  (untouched source, only created once)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IMG_DIR = path.join(__dirname, '..', 'images');

/**
 * @typedef Entry
 * @property {string} src                Original filename in images/
 * @property {number} width              Target WebP width (px)
 * @property {number} [height]           Optional fixed height (otherwise auto)
 * @property {number} [quality]          WebP quality, default 78
 * @property {'webp'|'png'} [format]     Output format, default 'webp'
 * @property {number} [pngSize]          PNG dimension when format='png'
 * @property {string} note
 */

/** @type {Entry[]} */
const ENTRIES = [
  // Logo — displayed at h-10 (40px) / h-11 (44px); 88×88 is 2× retina with
  // plenty of headroom. Going from 664 KiB PNG → ~5 KiB WebP.
  { src: 'logo-book.png', width: 88, height: 88, quality: 85, note: 'nav logo' },

  // Hero/section illustrations — displayed up to ~665px wide in the
  // half-width column at max-w-6xl. 1000px gives 1.5× retina, much
  // cheaper than the original 800px JPG re-encoded as WebP.
  { src: 'landing-tell-your-story.jpg', width: 1000, quality: 75, note: 'section 2' },
  { src: 'landing-styles.jpg',          width: 1000, quality: 75, note: 'section 3' },
  { src: 'landing-print.jpg',           width: 1000, quality: 75, note: 'section 4' },
  { src: 'landing-characters-de.jpg',   width: 1000, quality: 75, note: 'section 1 (DE)' },
  { src: 'landing-characters-en.jpg',   width: 1000, quality: 75, note: 'section 1 (EN)' },
  { src: 'landing-characters-fr.jpg',   width: 1000, quality: 75, note: 'section 1 (FR)' },

  // Small thumbnails in hero — displayed max-h-180 (180px), so 360px is
  // 2× retina headroom. Aspect preserved (height=auto).
  { src: 'Real person.jpg', width: 360, quality: 78, note: 'hero thumb' },
  { src: 'Avatar.jpg',      width: 360, quality: 78, note: 'hero thumb' },

  // Video poster — displayed in 480px-wide container. 800px = retina-safe.
  { src: 'video-poster.jpg', width: 800, quality: 75, note: 'video poster' },

  // Arrow icon — 42×42 mobile, 64×64 desktop. 128×128 PNG is plenty.
  { src: 'arrow-icon-1162.png', width: 128, height: 128, format: 'png', note: 'arrow icon' },
];

async function backupOriginal(srcPath) {
  const { dir, name, ext } = path.parse(srcPath);
  const backup = path.join(dir, `${name}-orig${ext}`);
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(srcPath, backup);
    return { backedUp: true, backup };
  }
  return { backedUp: false, backup };
}

function pickSource(srcPath) {
  // If a -orig backup exists, always re-encode from it (idempotent).
  const { dir, name, ext } = path.parse(srcPath);
  const backup = path.join(dir, `${name}-orig${ext}`);
  return fs.existsSync(backup) ? backup : srcPath;
}

async function processEntry(entry) {
  const srcPath = path.join(IMG_DIR, entry.src);
  if (!fs.existsSync(srcPath)) {
    return { ...entry, status: '✗ missing', delta: 0 };
  }

  const originalBytes = fs.statSync(srcPath).size;
  const { backup } = await backupOriginal(srcPath);
  const sourceForRead = pickSource(srcPath);

  const { name } = path.parse(srcPath);
  const format = entry.format || 'webp';
  const outPath = path.join(IMG_DIR, `${name}.${format}`);

  let pipeline = sharp(sourceForRead).resize({
    width: entry.width,
    height: entry.height,
    fit: 'inside',
    withoutEnlargement: false,
  });

  if (format === 'webp') {
    pipeline = pipeline.webp({ quality: entry.quality || 78, effort: 6 });
  } else if (format === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9, palette: true });
  }

  await pipeline.toFile(outPath);
  const newBytes = fs.statSync(outPath).size;
  // For PNG-format entries (arrow icon), we overwrite the original
  // in place since the consumer keeps the .png extension.
  if (format === 'png' && outPath === srcPath) {
    // Same path — handled by toFile. But sharp can't write to its own
    // read source on Windows, so use a temp path + rename.
    // (We already passed sourceForRead which is the -orig backup, so
    // outPath = original .png is safe.)
  }

  return {
    ...entry,
    outPath,
    originalBytes,
    newBytes,
    delta: originalBytes - newBytes,
    backup: path.basename(backup),
  };
}

function kb(n) { return (n / 1024).toFixed(1) + ' KiB'; }

async function main() {
  console.log('Optimizing landing images in', IMG_DIR);
  console.log('═'.repeat(78));

  const results = [];
  for (const entry of ENTRIES) {
    process.stdout.write(`  ${entry.src.padEnd(38)} `);
    try {
      const r = await processEntry(entry);
      if (r.status === '✗ missing') {
        console.log('✗ missing');
        continue;
      }
      results.push(r);
      console.log(
        `${kb(r.originalBytes).padStart(10)} → ${kb(r.newBytes).padStart(9)}  ` +
        `(−${kb(r.delta)})`
      );
    } catch (err) {
      console.log('✗', err.message);
    }
  }

  console.log('═'.repeat(78));
  const totalOriginal = results.reduce((s, r) => s + r.originalBytes, 0);
  const totalNew = results.reduce((s, r) => s + r.newBytes, 0);
  const totalDelta = totalOriginal - totalNew;
  console.log(
    `  TOTAL${' '.repeat(33)} ${kb(totalOriginal).padStart(10)} → ${kb(totalNew).padStart(9)}  ` +
    `(−${kb(totalDelta)}, ${((totalDelta / totalOriginal) * 100).toFixed(1)}%)`
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
