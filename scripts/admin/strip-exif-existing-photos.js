#!/usr/bin/env node
/**
 * Backfill: strip EXIF (GPS, camera model, timestamps) from existing
 * character photos stored in the `characters` table.
 *
 * Going forward, every new upload runs through `server/lib/imageMetadata.js`
 * `stripExif()` on its way into the DB. This script cleans the historical
 * rows that were written before that fix landed.
 *
 * Walks `characters.data.characters[*].photos.{face, body, bodyNoBg}`.
 * Re-encodes each data URI through sharp; sharp strips ALL metadata by
 * default. Idempotent — re-running is a no-op for already-stripped images.
 *
 * Usage:
 *   node scripts/admin/strip-exif-existing-photos.js --dry-run
 *   node scripts/admin/strip-exif-existing-photos.js --dry-run --character-id=N
 *   node scripts/admin/strip-exif-existing-photos.js                 (writes DB)
 *
 * Dry-run reports how many photos still carry EXIF without writing.
 */

require('dotenv').config();
const { Pool } = require('pg');
const sharp = require('sharp');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const charIdArg = args.find(a => a.startsWith('--character-id='));
const onlyCharacterId = charIdArg ? charIdArg.split('=')[1] : null;

const PHOTO_KEYS = ['face', 'body', 'bodyNoBg', 'original'];

// ---- helpers ----

async function hasExif(dataUri) {
  if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) return false;
  const match = dataUri.match(/^data:image\/[\w+-]+;base64,(.+)$/);
  if (!match) return false;
  try {
    const buf = Buffer.from(match[1], 'base64');
    const meta = await sharp(buf).metadata();
    // sharp returns exif as a Buffer; presence + non-zero length = real metadata.
    return !!(meta.exif && meta.exif.length > 0);
  } catch {
    return false;
  }
}

async function stripExif(dataUri) {
  if (!dataUri || typeof dataUri !== 'string' || !dataUri.startsWith('data:image/')) return dataUri;
  const match = dataUri.match(/^data:image\/([\w+-]+);base64,(.+)$/);
  if (!match) return dataUri;
  const [, mime, b64] = match;
  try {
    const buf = Buffer.from(b64, 'base64');
    const isPng = mime.toLowerCase() === 'png';
    const out = isPng
      ? await sharp(buf).png().toBuffer()
      : await sharp(buf).jpeg({ quality: 95 }).toBuffer();
    return `data:image/${isPng ? 'png' : 'jpeg'};base64,${out.toString('base64')}`;
  } catch (err) {
    console.warn(`  ⚠️ stripExif failed: ${err.message}`);
    return dataUri;
  }
}

// ---- main ----

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const where = onlyCharacterId ? 'WHERE id = $1' : '';
  const params = onlyCharacterId ? [onlyCharacterId] : [];
  const result = await pool.query(`SELECT id, data FROM characters ${where}`, params);

  console.log(`\n📸 EXIF strip backfill — ${DRY_RUN ? 'DRY RUN' : 'WRITING DB'}`);
  console.log(`Found ${result.rows.length} character row(s) to scan\n`);

  let rowsScanned = 0;
  let rowsTouched = 0;
  let photosScanned = 0;
  let photosWithExif = 0;
  let photosStripped = 0;
  const errors = [];

  for (const row of result.rows) {
    rowsScanned++;
    let data;
    try {
      data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    } catch (err) {
      errors.push({ id: row.id, error: `parse failed: ${err.message}` });
      continue;
    }

    const chars = Array.isArray(data?.characters) ? data.characters : [];
    let rowChanged = false;

    for (const char of chars) {
      if (!char.photos || typeof char.photos !== 'object') continue;
      for (const key of PHOTO_KEYS) {
        const val = char.photos[key];
        if (typeof val !== 'string' || !val.startsWith('data:image/')) continue;
        photosScanned++;
        const has = await hasExif(val);
        if (!has) continue;
        photosWithExif++;
        console.log(`  → row ${row.id} / char "${char.name}" / photos.${key} carries EXIF`);
        if (!DRY_RUN) {
          char.photos[key] = await stripExif(val);
          photosStripped++;
          rowChanged = true;
        }
      }
    }

    if (rowChanged) {
      try {
        await pool.query('UPDATE characters SET data = $1 WHERE id = $2', [JSON.stringify(data), row.id]);
        rowsTouched++;
      } catch (err) {
        errors.push({ id: row.id, error: `update failed: ${err.message}` });
      }
    }
  }

  console.log('\n──── summary ────');
  console.log(`Rows scanned:           ${rowsScanned}`);
  console.log(`Photos scanned:         ${photosScanned}`);
  console.log(`Photos with EXIF:       ${photosWithExif}`);
  if (!DRY_RUN) {
    console.log(`Photos stripped:        ${photosStripped}`);
    console.log(`Rows updated:           ${rowsTouched}`);
  }
  if (errors.length) {
    console.log(`Errors:                 ${errors.length}`);
    for (const e of errors) console.log(`  - ${e.id}: ${e.error}`);
  }
  console.log();

  await pool.end();
  process.exit(errors.length ? 1 : 0);
})();
