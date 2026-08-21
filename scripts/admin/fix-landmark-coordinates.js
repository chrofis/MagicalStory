#!/usr/bin/env node
/**
 * Repair `landmark_index` coordinates against the Wikidata P625 claim.
 *
 * WHY: `Landesmuseum Zürich` is stored 25km from Zurich centre — the real one
 * stands beside Hauptbahnhof. Bad coordinates are silent and two-way harmful:
 * the landmark disappears from its own city's radius search, AND it turns up in
 * the candidate list of whatever town its false position lands near. That one
 * was found by accident, so the true extent was unknown.
 *
 * Uses the same SPARQL batching as backfill-landmark-types.js: ~200 QIDs per
 * query, so the whole index is a handful of requests.
 *
 * Usage:
 *   node scripts/admin/fix-landmark-coordinates.js --dry-run        # report only
 *   node scripts/admin/fix-landmark-coordinates.js                  # write
 *   node scripts/admin/fix-landmark-coordinates.js --threshold=0.5  # km, default 0.5
 */

require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const thrArg = args.find(a => a.startsWith('--threshold='));
const THRESHOLD_KM = thrArg ? parseFloat(thrArg.split('=')[1]) : 0.5;
const QIDS_PER_QUERY = 200;
const USER_AGENT = 'MagicalStory/1.0 (https://magicalstory.ch; landmark coordinate repair)';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function sparql(query) {
  const body = 'query=' + encodeURIComponent(query) + '&format=json';
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'query.wikidata.org',
      path: '/sparql',
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/sparql-results+json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const { rows } = await pool.query(`
    SELECT id, name, nearest_city, wikidata_qid, latitude, longitude
    FROM landmark_index
    WHERE wikidata_qid IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY id`);
  console.log(`Rows to verify: ${rows.length}${dryRun ? '  (DRY RUN — no writes)' : ''}`);
  console.log(`Flagging any disagreement over ${THRESHOLD_KM}km\n`);

  const byQid = new Map();
  for (const r of rows) {
    if (!byQid.has(r.wikidata_qid)) byQid.set(r.wikidata_qid, []);
    byQid.get(r.wikidata_qid).push(r);
  }
  const qids = [...byQid.keys()];

  const truth = new Map();  // qid -> { lat, lon }
  for (let i = 0; i < qids.length; i += QIDS_PER_QUERY) {
    const slice = qids.slice(i, i + QIDS_PER_QUERY);
    const query = `SELECT ?item ?coord WHERE {
      VALUES ?item { ${slice.map(q => `wd:${q}`).join(' ')} }
      ?item wdt:P625 ?coord .
    }`;
    try {
      const json = await sparql(query);
      for (const b of json.results.bindings) {
        const qid = b.item.value.split('/').pop();
        // Wikidata returns "Point(lon lat)" — longitude FIRST.
        const m = /Point\(([-\d.]+)\s+([-\d.]+)\)/.exec(b.coord.value);
        if (m && !truth.has(qid)) truth.set(qid, { lon: parseFloat(m[1]), lat: parseFloat(m[2]) });
      }
      console.log(`  resolved ${Math.min(i + QIDS_PER_QUERY, qids.length)}/${qids.length} QIDs`);
    } catch (err) {
      console.error(`  [ERROR] batch at ${i}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  const bad = [];
  let noClaim = 0;
  for (const [qid, landmarkRows] of byQid) {
    const t = truth.get(qid);
    if (!t) { noClaim += landmarkRows.length; continue; }
    for (const r of landmarkRows) {
      const km = haversineKm(parseFloat(r.latitude), parseFloat(r.longitude), t.lat, t.lon);
      if (km > THRESHOLD_KM) bad.push({ ...r, trueLat: t.lat, trueLon: t.lon, km });
    }
  }

  bad.sort((a, b) => b.km - a.km);
  console.log(`\nRows with no P625 claim (left alone): ${noClaim}`);
  console.log(`Rows with WRONG coordinates: ${bad.length}\n`);
  if (bad.length) {
    console.log('  worst offenders:');
    bad.slice(0, 20).forEach(b => console.log(
      `    ${String(b.name).slice(0, 34).padEnd(36)} off by ${b.km.toFixed(1).padStart(7)}km  [${b.nearest_city || '?'}]`));
  }

  if (!dryRun && bad.length) {
    let written = 0;
    for (const b of bad) {
      await pool.query('UPDATE landmark_index SET latitude = $1, longitude = $2 WHERE id = $3',
        [b.trueLat, b.trueLon, b.id]);
      written++;
    }
    console.log(`\n  corrected: ${written} row(s)`);
  }
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
