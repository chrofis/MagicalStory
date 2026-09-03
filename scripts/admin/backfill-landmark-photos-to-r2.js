#!/usr/bin/env node
/**
 * Store every landmark_index reference photo on R2 (migration 035).
 *
 * Selects every (landmark, slot) with photo_url_<N> set and photo_r2_url_<N>
 * NULL, fetches the Commons file at ~1280px, uploads it under a content-stable
 * key and writes photo_r2_url_<N> — one slot at a time, ~2 s apart, because
 * Commons throttles sustained pulls (faster silently drops). ~19,400 slots on
 * prod ≈ 11 h. Resumable: a stored slot is no longer selected, so a restart
 * continues where the last run stopped. Failures are logged and skipped (the
 * slot stays NULL and is selected again next run); exit code 1 when any failed.
 *
 *   node scripts/admin/backfill-landmark-photos-to-r2.js [--staging] [--dry-run]
 *        [--limit=N slots] [--ids=a,b,c] [--delay=MS default 2000]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { ch } = require('../lib/chTime');
const { storeLandmarkPhoto } = require('../../server/lib/landmarkPhotoStore');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const flag = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const LIMIT = flag('limit') ? parseInt(flag('limit'), 10) : null;
const IDS = flag('ids') ? flag('ids').split(',').map(s => parseInt(s, 10)).filter(Number.isFinite) : null;
const DELAY = flag('delay') ? parseInt(flag('delay'), 10) : 2000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  // Best-judged landmarks first, so an interrupted run has covered the places
  // stories actually use.
  const rows = (await pool.query(`
    SELECT id, name, s.slot, s.url
      FROM landmark_index
      CROSS JOIN LATERAL unnest(
        ARRAY[1,2,3,4,5,6],
        ARRAY[photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6],
        ARRAY[photo_r2_url, photo_r2_url_2, photo_r2_url_3, photo_r2_url_4, photo_r2_url_5, photo_r2_url_6]
      ) AS s(slot, url, r2_url)
     WHERE s.url IS NOT NULL AND s.r2_url IS NULL
       ${IDS ? 'AND id = ANY($1)' : ''}
     ORDER BY story_score DESC NULLS LAST, id, s.slot
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}`, IDS ? [IDS] : [])).rows;

  const total = (await pool.query(`
    SELECT count(*)::int n FROM landmark_index CROSS JOIN LATERAL unnest(
      ARRAY[photo_url, photo_url_2, photo_url_3, photo_url_4, photo_url_5, photo_url_6],
      ARRAY[photo_r2_url, photo_r2_url_2, photo_r2_url_3, photo_r2_url_4, photo_r2_url_5, photo_r2_url_6]
    ) AS s(url, r2_url) WHERE s.url IS NOT NULL AND s.r2_url IS NULL`)).rows[0].n;

  console.log(`${ch(new Date())}  ${STAGING ? 'STAGING' : 'PROD'}: ${total} slot(s) without an R2 copy; this run takes ${rows.length}` +
    ` (~${Math.round(rows.length * DELAY / 60000)} min at ${DELAY} ms spacing)`);
  if (DRY) {
    rows.slice(0, 20).forEach(r => console.log(`   #${r.id}_${r.slot}  ${r.name}  ${r.url.slice(-60)}`));
    if (rows.length > 20) console.log(`   ... ${rows.length - 20} more`);
    await pool.end();
    return;
  }

  let ok = 0, failed = 0;
  const t0 = Date.now();
  for (const [i, r] of rows.entries()) {
    try {
      const st = await storeLandmarkPhoto(pool, r.id, r.slot, r.url, { currentR2Url: null });
      ok++;
      if (i < 10 || (i + 1) % 50 === 0) {
        const perSlot = (Date.now() - t0) / (i + 1);
        const etaMin = Math.round((rows.length - i - 1) * perSlot / 60000);
        console.log(`${ch(new Date())}  ${ok + failed}/${rows.length} ok=${ok} failed=${failed} eta ${etaMin} min   #${r.id}_${r.slot} ${r.name} -> ${st.url}`);
      }
    } catch (e) {
      failed++;
      console.log(`${ch(new Date())}  FAIL #${r.id}_${r.slot} ${r.name}: ${e.message}`);
    }
    if (i < rows.length - 1) await sleep(DELAY);
  }

  console.log(`\n${ch(new Date())}  done: ${ok} stored, ${failed} failed, ${total - ok} slot(s) still without an R2 copy`);
  await pool.end();
  if (failed) process.exit(1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
