#!/usr/bin/env node
/**
 * Correct `landmark_index.country` from Wikidata P17 ($0 — Wikidata is free).
 *
 * WHY: discovery searched a radius around each Swiss town and stamped every hit
 * `country = 'Switzerland'`. Near the border that radius crosses into Germany,
 * France and Austria, so the Swiss index holds real foreign places — measured
 * 2026-08-27 on a 400-row sample, 1.3% were not Swiss: Kapuzinerkloster
 * Stühlingen and Waldshut (both Q183 Deutschland), Heilige Familie in Lörrach,
 * Nepomukkapelle in Hohenems (Q40 Österreich), the Jewish cemetery at Hégenheim
 * (Q142 France).
 *
 * These cannot be caught geometrically: Stühlingen sits at 47.74/8.44, inside
 * any bounding box drawn around Switzerland. Only the stated country identifies
 * them, and Wikidata states it.
 *
 * The row is KEPT, only its country corrected. A landmark 2km over the border is
 * still genuinely near Basel or Kreuzlingen, and the proximity fallback may
 * legitimately offer it; what must never happen is a story telling a Swiss child
 * that Lörrach is their home town.
 *
 *   node scripts/admin/fix-landmark-country.js [--staging] [--dry-run] [--limit=N]
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

const UA = 'MagicalStory/1.0 (https://magicalstory.ch; rogerfischer@hotmail.com) landmark-country';
const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);

// Only the neighbours a Swiss-radius search can actually reach, plus Liechtenstein.
// An unknown QID is left alone rather than guessed at — the whole point is to
// stop inventing geography.
const COUNTRY = {
  Q39: 'Switzerland', Q183: 'Germany', Q142: 'France', Q38: 'Italy',
  Q40: 'Austria', Q347: 'Liechtenstein',
};

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const rows = (await pool.query(
    `SELECT id, name, country, nearest_city, municipality, wikidata_qid
       FROM landmark_index
      WHERE country ILIKE '%switzerland%' AND wikidata_qid IS NOT NULL
      ORDER BY id${LIMIT ? ` LIMIT ${LIMIT}` : ''}`)).rows;

  console.log(`${STAGING ? 'STAGING' : 'PROD'} — checking ${rows.length} Swiss-labelled row(s) against Wikidata P17`);

  let checked = 0, fixed = 0, unknown = 0, noClaim = 0;
  const byCountry = {};
  for (const [i, batch] of chunk(rows, 50).entries()) {
    let entities;
    try {
      const u = `https://www.wikidata.org/w/api.php?${new URLSearchParams({
        format: 'json', action: 'wbgetentities', ids: batch.map(r => r.wikidata_qid).join('|'), props: 'claims',
      })}`;
      const res = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(String(res.status));
      entities = (await res.json()).entities || {};
    } catch (e) {
      console.log(`  batch ${i}: ${e.message} — skipped, rerun to retry`);
      continue;
    }

    for (const r of batch) {
      const qids = (entities[r.wikidata_qid]?.claims?.P17 || [])
        .map(c => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
      if (!qids.length) { noClaim++; continue; }
      checked++;
      if (qids.includes('Q39')) continue;          // genuinely Swiss (or partly)
      const name = COUNTRY[qids[0]];
      if (!name) { unknown++; continue; }          // never guess
      byCountry[name] = (byCountry[name] || 0) + 1;
      fixed++;
      if (DRY) {
        console.log(`  ${r.name}  [${r.municipality || r.nearest_city}]  →  ${name}`);
      } else {
        await pool.query('UPDATE landmark_index SET country = $2, updated_at = NOW() WHERE id = $1', [r.id, name]);
      }
    }
    if ((i + 1) % 20 === 0) process.stdout.write(`  ${checked} checked, ${fixed} foreign\r`);
  }

  console.log(`\n${DRY ? '[dry-run] ' : ''}checked ${checked}, corrected ${fixed} — ${JSON.stringify(byCountry)}`);
  console.log(`(${noClaim} had no P17 claim, ${unknown} named a country outside the neighbour list; both left untouched)`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
