#!/usr/bin/env node
/**
 * Download every photo in ambiguous-photos.json to a local cache, so the
 * Read tool can open them without network round-trips.
 *
 * Output layout:
 *   scripts/admin/ambiguous-cache/
 *     0001-baden-bahnhof-baden-slot-2.jpg
 *     0002-baden-bahnhof-baden-slot-3.jpg
 *     ...
 *   ambiguous-photos.json   (in-place updated with `cachedAt` for each entry)
 *
 * The numeric prefix gives a stable iteration order; the slug encodes the
 * landmark for at-a-glance identification while reviewing.
 *
 * Usage:
 *   node scripts/admin/download-ambiguous-photos.js
 *
 * After this:
 *   - Open the cache directory and review each image
 *   - Edit ambiguous-photos.json: add `"decision": "<distant|close|interior|view_from|bad>"` to each entry
 *   - Run: node scripts/admin/classify-via-read.js --tier2-apply --push
 */

const fs = require('fs');
const path = require('path');

const AMBIGUOUS_PATH = path.join(__dirname, 'ambiguous-photos.json');
const CACHE_DIR = path.join(__dirname, 'ambiguous-cache');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function slugify(s) {
  return (s || 'unknown')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function downloadOne(item, index) {
  const ext = (item.filename || '').match(/\.(jpe?g|png|webp)$/i)?.[1] || 'jpg';
  const filename = `${String(index).padStart(4, '0')}-${slugify(item.nearest_city)}-${slugify(item.name)}-slot-${item.slot}.${ext}`;
  const dest = path.join(CACHE_DIR, filename);

  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return { ok: true, cached: true, path: dest, filename };
  }

  let res;
  try {
    res = await fetch(item.url, { headers: { 'User-Agent': 'MagicalStory classifier-cache/1.0 (info@magicalstory.ch)' } });
  } catch (err) {
    return { ok: false, error: 'fetch failed' };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return { ok: true, cached: false, path: dest, filename, bytes: buf.length };
}

async function main() {
  if (!fs.existsSync(AMBIGUOUS_PATH)) {
    console.error(`Missing ${AMBIGUOUS_PATH} — run classify-via-read.js --tier2-emit first.`);
    process.exit(1);
  }
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const list = JSON.parse(fs.readFileSync(AMBIGUOUS_PATH, 'utf8'));
  console.log(`Caching ${list.length} ambiguous photos to ${path.relative(process.cwd(), CACHE_DIR)}/`);

  let ok = 0, cached = 0, failed = 0;
  for (let i = 0; i < list.length; i++) {
    const r = await downloadOne(list[i], i + 1);
    list[i].cachedPath = r.path || null;
    list[i].cachedFilename = r.filename || null;
    if (!r.ok) {
      console.log(`  ✗ [${i+1}/${list.length}] ${list[i].name} slot ${list[i].slot} — ${r.error}`);
      list[i].cacheError = r.error;
      failed++;
    } else if (r.cached) {
      cached++;
    } else {
      ok++;
      if ((i + 1) % 25 === 0) console.log(`  [${i+1}/${list.length}] cached`);
    }
    await sleep(80);
  }

  // Persist cachedPath back into JSON so Tier-2 review knows where the image is
  fs.writeFileSync(AMBIGUOUS_PATH, JSON.stringify(list, null, 2));

  console.log(`\n  Downloaded:     ${ok}`);
  console.log(`  Already cached: ${cached}`);
  console.log(`  Failed:         ${failed}`);
  console.log(`\nNext: edit ${path.relative(process.cwd(), AMBIGUOUS_PATH)} — add "decision": "<...>" to each item, then run:`);
  console.log(`  node scripts/admin/classify-via-read.js --tier2-apply --push`);
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
