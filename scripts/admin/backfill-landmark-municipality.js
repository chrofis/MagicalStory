#!/usr/bin/env node
/**
 * Backfill `landmark_index.municipality` from Wikidata P131.
 *
 * WHY: `nearest_city` is the city discovery was SEARCHING around, not the town
 * the landmark is in — see migrations/028_landmark_municipality.sql. Without
 * the real municipality we cannot tell a genuinely local landmark from one
 * 6km away in the next town, and the story prompt asserts the landmark is in
 * the child's home town either way.
 *
 * Wikidata is free and batchable: wbgetentities takes 50 QIDs per call, so the
 * whole production index (4762 rows with a qid) is ~96 requests. P131 gives the
 * containing administrative entity as another QID, which needs a second pass to
 * resolve to a label — those are cached, since a few hundred municipalities
 * cover thousands of landmarks.
 *
 *   node scripts/admin/backfill-landmark-municipality.js [--staging] [--city=X] [--limit=N] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const cityArg = args.find(a => a.startsWith('--city='));
const CITY = cityArg ? cityArg.split('=').slice(1).join('=') : null;
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const API = 'https://www.wikidata.org/w/api.php';
const UA = 'MagicalStory/1.0 (landmark municipality backfill; contact: rogerfischer@hotmail.com)';
const labelCache = new Map();

const chunk = (arr, n) => arr.reduce((a, x, i) => (i % n ? a[a.length - 1].push(x) : a.push([x]), a), []);

async function wd(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`wikidata ${res.status}`);
  return res.json();
}

// P131 points at whatever administrative level Wikidata happened to record, and
// for a fair number of entries that is a canton or a district, not a town:
// measured on Dübendorf, "St. Gallus (Zürich-Schwamendingen)" resolves to
// "Kanton Zürich" and "St. Michael (Dietlikon)" to "Bezirk Bülach". Storing
// those would make a municipality filter reject genuinely local landmarks, so
// a P131 target is only accepted when it is a MUNICIPALITY-class entity.
const MUNICIPALITY_CLASSES = new Set([
  'Q70208',    // municipality of Switzerland
  'Q13402009', // Swiss municipality (alt class in use)
  'Q262166',   // municipality of Germany
  'Q484170',   // commune of France
  'Q747074',   // comune of Italy
  'Q515',      // city
  'Q3957',     // town
  'Q532',      // village
  'Q15284',    // municipality (generic)
]);

/** QID → { label, isMunicipality }, cached. A few hundred towns cover thousands of rows. */
async function labelsFor(qids) {
  const missing = [...new Set(qids)].filter(q => q && !labelCache.has(q));
  for (const batch of chunk(missing, 50)) {
    const j = await wd({ action: 'wbgetentities', ids: batch.join('|'), props: 'labels|claims', languages: 'de|en' });
    for (const [qid, ent] of Object.entries(j.entities || {})) {
      const l = ent.labels || {};
      const classes = (ent.claims?.P31 || [])
        .map(c => c.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
      labelCache.set(qid, {
        label: l.de?.value || l.en?.value || null,
        isMunicipality: classes.some(c => MUNICIPALITY_CLASSES.has(c)),
      });
    }
    for (const q of batch) if (!labelCache.has(q)) labelCache.set(q, { label: null, isMunicipality: false });
  }
  return labelCache;
}

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const where = ['wikidata_qid IS NOT NULL', 'municipality IS NULL'];
  const params = [];
  if (CITY) {
    params.push(CITY);
    where.push(`LOWER(translate(nearest_city, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns')) = LOWER(translate($1, 'üùäàâöôéèêëîïçñß', 'uuaaaooeeeeiicns'))`);
  }
  const rows = (await pool.query(
    `SELECT id, name, wikidata_qid, nearest_city FROM landmark_index WHERE ${where.join(' AND ')} ORDER BY id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`,
    params
  )).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'} — ${rows.length} row(s) needing municipality${CITY ? ` (city=${CITY})` : ''}`);
  if (!rows.length) { await pool.end(); return; }

  let resolved = 0, unknown = 0, mismatched = 0;
  for (const batch of chunk(rows, 50)) {
    const j = await wd({ action: 'wbgetentities', ids: batch.map(r => r.wikidata_qid).join('|'), props: 'claims' });
    // Keep EVERY P131 claim, not just the first: an entity often lists both its
    // town and its canton, and the town is not reliably first.
    const pending = [];
    for (const r of batch) {
      const qids = (j.entities?.[r.wikidata_qid]?.claims?.P131 || [])
        .map(c => c.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
      pending.push({ row: r, qids });
    }
    await labelsFor(pending.flatMap(p => p.qids));

    for (const { row, qids } of pending) {
      const hit = qids.map(q => labelCache.get(q)).find(e => e?.isMunicipality && e.label);
      const label = hit?.label || null;
      if (!label) { unknown++; continue; }
      const differs = String(label).toLowerCase() !== String(row.nearest_city || '').toLowerCase();
      if (differs) mismatched++;
      resolved++;
      if (DRY) {
        if (differs) console.log(`  ${row.name}\n      nearest_city=${row.nearest_city}  →  municipality=${label}`);
      } else {
        await pool.query('UPDATE landmark_index SET municipality = $2, municipality_updated_at = NOW() WHERE id = $1', [row.id, label]);
      }
    }
    process.stdout.write(`  resolved ${resolved}/${rows.length}\r`);
  }

  console.log(`\n${DRY ? '[dry-run] ' : ''}resolved ${resolved}, unknown ${unknown}, DIFFERENT from nearest_city: ${mismatched}`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
