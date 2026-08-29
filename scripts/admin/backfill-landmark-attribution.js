#!/usr/bin/env node
/**
 * Give every stored landmark photo its CREDIT.
 *
 * WHY: `fetch-landmark-photos-free.js` wrote `photo_url` and nothing else, so
 * 3,024 rows ended up holding a usable Commons picture with no author and no
 * licence recorded. Commons content is overwhelmingly CC BY / CC BY-SA, and
 * both require attribution — storing the URL without the author is the one
 * thing a free image source does not permit. (The fetcher now stores credit
 * inline; this repairs everything written before that.)
 *
 * Credit travels in the SAME slot as its photo. Pairing slot 3's picture with
 * slot 1's author names the wrong photographer, which breaches the licence as
 * surely as no credit at all — the same rule the serving code follows.
 *
 * FREE: Wikipedia/Commons APIs only, no model calls. Resumable — it selects
 * only rows still missing credit, so re-running continues where it stopped.
 *
 *   node scripts/admin/backfill-landmark-attribution.js [--limit=N] [--staging] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const UA = { 'User-Agent': 'MagicalStory/1.0 (https://magicalstory.ch; rogerfischer@hotmail.com) landmark-attribution' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SLOTS = [1, 2, 3, 4, 5, 6];
const col = (base, slot) => (slot === 1 ? base : `${base}_${slot}`);

async function api(host, params) {
  const res = await fetch(`https://${host}/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`,
    { headers: UA, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${host} ${res.status}`);
  return res.json();
}

/** Commons file name out of either URL shape we store. */
function fileNameOf(url) {
  const m = /Special:FilePath\/([^?]+)|\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/.exec(url || '');
  return decodeURIComponent(m?.[1] || m?.[2] || '') || null;
}

/**
 * `extmetadata` carries the uploader's own Artist string and the licence;
 * `user` is the fallback for files with no structured author. Both are what
 * the CC deed means by "attribution as the licensor requests".
 */
async function attributionFor(url) {
  const file = fileNameOf(url);
  if (!file) return null;
  try {
    const j = await api('commons.wikimedia.org', {
      action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'user|extmetadata',
    });
    const info = Object.values(j?.query?.pages || {})[0]?.imageinfo?.[0];
    if (!info) return null;
    const meta = info.extmetadata || {};
    const artist = String(meta.Artist?.value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const licence = meta.LicenseShortName?.value || '';
    const who = artist || info.user || 'Unknown';
    return `Photo by ${who}${licence ? `, ${licence}` : ''}, Wikimedia Commons`;
  } catch {
    return null;
  }
}

(async () => {
  const cs = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });

  // Any slot holding a picture but no credit. Resumable by construction.
  const missing = SLOTS.map(s => `(${col('photo_url', s)} IS NOT NULL AND ${col('photo_attribution', s)} IS NULL)`).join(' OR ');
  const rows = (await pool.query(
    `SELECT id, name, ${SLOTS.map(s => col('photo_url', s)).join(', ')},
            ${SLOTS.map(s => col('photo_attribution', s)).join(', ')}
       FROM landmark_index WHERE ${missing}
      ORDER BY id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`)).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'}: ${rows.length} row(s) with an uncredited photo`);
  if (DRY) { await pool.end(); return; }

  let fixed = 0, credits = 0, unresolved = 0;
  for (const r of rows) {
    const cols = [], vals = [r.id];
    for (const s of SLOTS) {
      if (!r[col('photo_url', s)] || r[col('photo_attribution', s)]) continue;
      const a = await attributionFor(r[col('photo_url', s)]);
      await sleep(120);
      if (!a) { unresolved++; continue; }
      vals.push(a);
      cols.push(`${col('photo_attribution', s)} = $${vals.length}`);
    }
    if (!cols.length) continue;
    await pool.query(`UPDATE landmark_index SET ${cols.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
    fixed++; credits += cols.length;
    if (fixed % 50 === 0) console.log(`  ${fixed}/${rows.length} rows, ${credits} credits`);
  }

  console.log(`\n✅ ${fixed} row(s) credited, ${credits} photo(s) total, ${unresolved} slot(s) unresolved.`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
