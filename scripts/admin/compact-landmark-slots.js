#!/usr/bin/env node
/**
 * Close gaps in landmark_index photo slots: a landmark whose slot N is empty
 * while a later slot holds a photo gets its photos shifted down, so slots are
 * contiguous from slot 1.
 *
 * WHY: every serving query filters on `photo_url IS NOT NULL` (HAS_PHOTO_SQL,
 * slot 1 only), so a landmark with an empty slot 1 is invisible to stories
 * however good its other photos are — measured 2026-09-24: 17 such landmarks
 * on prod, among them Stadtturm (Baden, story_score 85) and Wildnispark Zürich
 * (72). 51 more had gaps further down (68 in all). Two producers: the indexer
 * put exteriors in slots 1-3 and interiors in 4-6, leaving holes whenever it
 * found fewer than three exteriors (fixed in saveLandmarkToIndex, which now
 * packs the slots), and the 2026-09-01 non-free-image cleanup cleared slots
 * in place (decisions.md, 2026-09-24).
 *
 * The compaction is merge-landmark-descriptions.js's own — planCompaction()
 * with no discards and writeCompaction() — so every per-slot column moves with
 * its photo (photo_url, attribution, description, type, R2 copy) and the
 * landmark_photo_scores rows are re-keyed to the photo's new slot. One
 * transaction per landmark, row locked FOR UPDATE and re-planned from the
 * locked row; it refuses to commit if any photo or score row would be lost.
 * story_score is derived from MAX(draw)/MAX(photo) across slots, which a
 * re-numbering cannot change; it is re-derived inside the transaction and the
 * run aborts that landmark if it moved. Every row it will touch (landmark row
 * + its score rows) is written to a JSON backup before the first write.
 *
 *   node scripts/admin/compact-landmark-slots.js [--staging] [--dry-run] [--ids=1,2] [--backup=FILE]
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { planCompaction, writeCompaction, colName } = require('./merge-landmark-descriptions');

const SLOTS = [1, 2, 3, 4, 5, 6];

/** True when some slot is empty while a later slot holds a photo. Pure. */
function hasSlotGap(row) {
  const filled = SLOTS.map(s => !!row[colName('photo_url', s)]);
  return filled.some((f, i) => !f && filled.slice(i + 1).some(Boolean));
}

/** The same test in SQL, for selecting the rows. */
const SLOT_GAP_SQL = `(${[1, 2, 3, 4, 5].map(n =>
  `(${colName('photo_url', n)} IS NULL AND COALESCE(${SLOTS.filter(s => s > n).map(s => colName('photo_url', s)).join(', ')}) IS NOT NULL)`).join(' OR ')})`;

const DERIVED_SQL = `SELECT LEAST(MAX(draw_score), MAX(photo_score)) d FROM landmark_photo_scores WHERE landmark_id = $1`;

async function main() {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
  const { Pool } = require('pg');
  const args = process.argv.slice(2);
  const DRY = args.includes('--dry-run');
  const STAGING = args.includes('--staging');
  const flag = n => { const a = args.find(x => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
  const IDS = flag('ids') ? flag('ids').split(',').map(Number).filter(Number.isFinite) : null;
  const BACKUP = flag('backup') || path.join(process.env.TEMP || '/tmp', `landmark-slot-compaction-${STAGING ? 'staging' : 'prod'}-${Date.now()}.json`);
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const rows = (await pool.query(
    `SELECT * FROM landmark_index WHERE ${SLOT_GAP_SQL}${IDS ? ' AND id = ANY($1)' : ''} ORDER BY id`, IDS ? [IDS] : [])).rows;
  const scores = rows.length ? (await pool.query(
    `SELECT * FROM landmark_photo_scores WHERE landmark_id = ANY($1) ORDER BY landmark_id, slot`, [rows.map(r => r.id)])).rows : [];
  const scoresOf = id => scores.filter(s => s.landmark_id === id);
  console.log(`${STAGING ? 'STAGING' : 'PROD'}: ${rows.length} landmark(s) with a slot gap (${rows.filter(r => !r.photo_url).length} with slot 1 empty)`);

  for (const row of rows) {
    const plan = planCompaction(row, {}, {});
    const sc = scoresOf(row.id).map(s => `${s.slot}→${plan.newSlotOf[s.slot] || 'LOST'}`);
    console.log(`  #${row.id} ${String(row.name).slice(0, 45)}  [${SLOTS.map(s => (row[colName('photo_url', s)] ? 'X' : '.')).join('')}] ` +
      `${plan.survivors.map(o => `${o}→${plan.newSlotOf[o]}`).join(' ')}  scores ${sc.join(' ') || '-'}`);
  }
  if (DRY || !rows.length) { console.log(DRY ? '\n--dry-run: nothing written.' : ''); await pool.end(); return; }

  fs.writeFileSync(BACKUP, JSON.stringify(rows.map(r => ({ landmark: r, scores: scoresOf(r.id) })), null, 1));
  console.log(`\nbackup of ${rows.length} landmark row(s) + ${scores.length} score row(s) → ${BACKUP}`);

  let done = 0, failed = 0;
  for (const { id } of rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const live = (await client.query(`SELECT * FROM landmark_index WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      const liveScores = (await client.query(`SELECT * FROM landmark_photo_scores WHERE landmark_id = $1 ORDER BY slot FOR UPDATE`, [id])).rows;
      if (!live || !hasSlotGap(live)) throw new Error('no gap on the locked row — changed since the read');
      const before = (await client.query(DERIVED_SQL, [id])).rows[0].d;
      const plan = planCompaction(live, {}, {});
      if (plan.survivors.length !== plan.filled.length) throw new Error(`plan would drop ${plan.filled.length - plan.survivors.length} photo(s)`);
      const lost = liveScores.filter(s => !plan.newSlotOf[s.slot]);
      if (lost.length) throw new Error(`score row(s) on empty slot(s) ${lost.map(s => s.slot)} would be lost — resolve them first`);
      const n = await writeCompaction(client, id, plan, liveScores);
      if (n !== liveScores.length) throw new Error(`wrote ${n} score rows, expected ${liveScores.length}`);
      const after = (await client.query(DERIVED_SQL, [id])).rows[0].d;
      if (before !== after) throw new Error(`derived story score moved ${before} → ${after}`);
      const check = (await client.query(`SELECT * FROM landmark_index WHERE id = $1`, [id])).rows[0];
      if (hasSlotGap(check)) throw new Error('row still has a gap after the write');
      await client.query('COMMIT');
      done++;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      failed++;
      console.log(`  #${id}: ROLLED BACK — ${e.message}`);
    } finally {
      client.release();
    }
  }
  const left = (await pool.query(`SELECT count(*) n FROM landmark_index WHERE ${SLOT_GAP_SQL}`)).rows[0].n;
  console.log(`\n✅ ${done} landmark(s) compacted, ${failed} rolled back; ${left} landmark(s) with a slot gap remain.`);
  await pool.end();
  if (failed) process.exit(1);
}

module.exports = { hasSlotGap, SLOT_GAP_SQL };

if (require.main === module) main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
