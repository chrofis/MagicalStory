#!/usr/bin/env node
/**
 * Write agent-produced photo descriptions into landmark_index, one slot column
 * at a time. Counterpart of prep-landmark-descriptions.js.
 *
 * Agents write descs_<batch>.json —
 *   { "<landmarkId>_<slot>": { description, scope, season, timeOfDay, subjectMatch, discard } }
 * This merges every such file in the directory (oldest first, so a re-describe
 * wins), validates the enums and the description length, and UPDATEs only that
 * slot's photo_description[_N] column with a compact tag line in front —
 * `[whole, green, day] ` + description — so downstream consumers get
 * scope/season/time in the same column without a schema change. Nothing else
 * on the row is touched, so a re-run writes the same text again — idempotent.
 *
 * DISCARDS ARE INERT BY DEFAULT: an entry with `discard` set (wrong subject,
 * unrecognisable, map/print/archival, duplicate of a lower slot) is listed in
 * a DISCARD table and written to <dir>/discards.json; the column stays NULL so
 * the slot is selected again by prep.
 *
 * --apply-discards REMOVES THE PHOTO: every discarded slot is dropped from the
 * landmark and the later slots shift down so slots stay contiguous (slot 1 is
 * the unsuffixed column). All four per-slot columns move together —
 * photo_url, photo_attribution, photo_description, photo_type — because the
 * attribution is a licence condition tied to THAT picture. landmark_photo_scores
 * rows are keyed (landmark_id, slot), so the discarded slot's row is deleted and
 * the surviving rows are re-numbered with their photo. The whole landmark is
 * rewritten in ONE transaction (row locked FOR UPDATE, current slots read from
 * the DB, not from the manifest), and kept descriptions for that landmark are
 * written in the same transaction at their POST-compaction slot number.
 * Landmarks without a discard take the plain per-column UPDATE. A discarded
 * slot that is already empty is a no-op, so a re-run is idempotent.
 *
 * A COVERAGE CHECK IS MANDATORY: an agent that dies mid-batch leaves keys out,
 * and a missing key is indistinguishable from a never-prepped slot. What the
 * manifest listed but no file described gets printed.
 *
 *   node scripts/admin/merge-landmark-descriptions.js --dir=DIR [--staging] [--dry-run] [--apply-discards]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const { ch } = require('../lib/chTime');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const APPLY_DISCARDS = args.includes('--apply-discards');
const dirArg = args.find(a => a.startsWith('--dir='));
const DIR = dirArg ? dirArg.split('=').slice(1).join('=') : path.join(process.env.TEMP || '/tmp', 'lm_describe');

// Bounds for the 1-2 sentence description: shorter is a fragment (the
// 2026-08-29 Gemini truncation stored 60-character stubs), longer is the
// layout prose the 2026-09-01 pilot rejected.
const MIN_CHARS = 40;
const MAX_CHARS = 400;
const ENUMS = {
  scope: ['whole', 'tower', 'entrance', 'interior', 'detail', 'distant', 'other'],
  season: ['snow', 'green', 'autumn', 'bare', 'unclear'],
  timeOfDay: ['day', 'dusk', 'night'],
  subjectMatch: ['yes', 'uncertain', 'no'],
};

const SLOTS = [1, 2, 3, 4, 5, 6];
const SLOT_FIELDS = ['photo_url', 'photo_attribution', 'photo_description', 'photo_type'];
const colName = (field, slot) => (slot === 1 ? field : `${field}_${slot}`);

// Compaction plan for one landmark. `row` is the live landmark_index row,
// `discardSlots` the slot numbers to drop, `kept` maps ORIGINAL slot -> text.
// Returns the surviving old slots in order, the old->new slot map, and the
// full 6-slot layout to write (every per-slot column, NULL for the tail).
function planCompaction(row, discardSlots, kept) {
  const filled = SLOTS.filter(s => row[colName('photo_url', s)]);
  const survivors = filled.filter(s => !discardSlots.has(s));
  const newSlotOf = {};
  survivors.forEach((old, i) => { newSlotOf[old] = i + 1; });
  const layout = SLOTS.map(s => {
    const old = survivors[s - 1];
    if (!old) return { slot: s, from: null, values: Object.fromEntries(SLOT_FIELDS.map(f => [f, null])) };
    const values = Object.fromEntries(SLOT_FIELDS.map(f => [f, row[colName(f, old)]]));
    if (kept[old] !== undefined) values.photo_description = kept[old];
    return { slot: s, from: old, values };
  });
  return { filled, survivors, newSlotOf, layout };
}

// Returns a reason string when the entry is malformed, else null.
function validate(v) {
  if (!v || typeof v !== 'object') return 'not an object';
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(v[k])) return `${k}=${JSON.stringify(v[k])} not in ${allowed.join('|')}`;
  }
  if (v.discard !== null && v.discard !== undefined && typeof v.discard !== 'string') return 'discard must be null or a string';
  const text = String(v.description || '').trim();
  if (text.length < MIN_CHARS) return `description ${text.length} chars < ${MIN_CHARS}`;
  if (text.length > MAX_CHARS) return `description ${text.length} chars > ${MAX_CHARS}`;
  if (/the (image|photo) shows/i.test(text)) return 'description talks about "the image"';
  return null;
}

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const files = fs.readdirSync(DIR)
    .filter(f => /^descs_\d+\.json$/.test(f))
    .sort((a, b) => fs.statSync(path.join(DIR, a)).mtimeMs - fs.statSync(path.join(DIR, b)).mtimeMs);
  const merged = {};       // kept entries -> UPDATE
  const discards = {};     // discarded entries -> table + discards.json, no DB write
  const rejected = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
    catch (e) { console.log(`  ${f}: unreadable (${e.message})`); continue; }
    for (const [key, v] of Object.entries(j)) {
      const m = /^(\d+)_([1-6])$/.exec(key);
      if (!m) continue;
      const why = validate(v);
      if (why) { rejected.push(`${key} (${f}): ${why}`); continue; }
      const entry = { landmarkId: Number(m[1]), slot: Number(m[2]), description: String(v.description).trim(),
        scope: v.scope, season: v.season, timeOfDay: v.timeOfDay, subjectMatch: v.subjectMatch, discard: v.discard || null };
      // A later file overrides an earlier one in both directions.
      delete merged[key]; delete discards[key];
      if (entry.discard) discards[key] = entry;
      else merged[key] = { ...entry, text: `[${entry.scope}, ${entry.season}, ${entry.timeOfDay}] ${entry.description}` };
    }
  }
  console.log(`${ch(new Date())}  ${files.length} descs file(s) -> ${Object.keys(merged).length} kept, ${Object.keys(discards).length} discarded, ${rejected.length} rejected`);
  if (rejected.length) {
    console.log(`⚠ ${rejected.length} rejected (bad enum, description outside ${MIN_CHARS}-${MAX_CHARS} chars, or talks about "the image"):`);
    rejected.slice(0, 12).forEach(r => console.log(`    ${r}`));
  }

  const manifest = fs.existsSync(path.join(DIR, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) : [];
  const nameOf = {};
  manifest.forEach(m => { nameOf[`${m.id}_${m.slot}`] = m.name; });
  const missing = manifest.filter(m => merged[`${m.id}_${m.slot}`] === undefined && discards[`${m.id}_${m.slot}`] === undefined);
  if (missing.length) {
    console.log(`⚠ ${missing.length} prepped image(s) have NO description yet:`);
    missing.slice(0, 12).forEach(m => console.log(`    ${m.id}_${m.slot}  ${m.name}`));
  }

  if (Object.keys(discards).length) {
    console.log(`\nDISCARD  id      slot  name                                      reason`);
    for (const d of Object.values(discards)) {
      console.log(`DISCARD  ${String(d.landmarkId).padEnd(7)} ${String(d.slot).padEnd(5)} ${String(nameOf[`${d.landmarkId}_${d.slot}`] || '').slice(0, 40).padEnd(41)} ${d.discard}`);
    }
    if (!DRY) fs.writeFileSync(path.join(DIR, 'discards.json'), JSON.stringify(Object.values(discards), null, 1));
  }

  // Group by landmark so a landmark with a discard is rewritten whole.
  const byLandmark = {};
  const bucket = id => (byLandmark[id] ||= { kept: {}, discards: new Set() });
  for (const v of Object.values(merged)) bucket(v.landmarkId).kept[v.slot] = v.text;
  if (APPLY_DISCARDS) for (const d of Object.values(discards)) bucket(d.landmarkId).discards.add(d.slot);
  const compactIds = Object.keys(byLandmark).map(Number).filter(id => byLandmark[id].discards.size);

  // Live rows for every landmark to be compacted — also in a dry run, so the
  // printed plan is the real resulting layout, not a guess from the manifest.
  const liveRows = {};
  const loadLive = async (q, ids) => {
    const r = await q.query(`SELECT * FROM landmark_index WHERE id = ANY($1)`, [ids]);
    r.rows.forEach(row => { liveRows[row.id] = { ...row, scores: [] }; });
    const sc = await q.query(`SELECT * FROM landmark_photo_scores WHERE landmark_id = ANY($1) ORDER BY landmark_id, slot`, [ids]);
    sc.rows.forEach(x => { if (liveRows[x.landmark_id]) liveRows[x.landmark_id].scores.push(x); });
  };
  if (compactIds.length) await loadLive(pool, compactIds);

  // Prints the per-slot layout a landmark ends up with; returns the plan.
  const printPlan = (id) => {
    const { kept, discards: ds } = byLandmark[id];
    const row = liveRows[id];
    if (!row) { console.log(`  #${id}: NO SUCH LANDMARK — skipped`); return null; }
    const plan = planCompaction(row, ds, kept);
    const scoreSlots = row.scores.map(x => x.slot);
    console.log(`  #${id} ${String(row.name).slice(0, 40)}  filled=[${plan.filled}] discard=[${[...ds].sort()}] -> ` +
      `${plan.survivors.map(o => `${o}→${plan.newSlotOf[o]}`).join(' ') || '(no photo left)'}` +
      `  scores [${scoreSlots}] -> [${scoreSlots.filter(sl => plan.newSlotOf[sl]).map(sl => plan.newSlotOf[sl])}]`);
    for (const l of plan.layout) {
      if (!l.from) { console.log(`      slot ${l.slot}: NULL`); continue; }
      const desc = l.values.photo_description ? String(l.values.photo_description).slice(0, 70) : 'NULL';
      console.log(`      slot ${l.slot} <- old ${l.from}${kept[l.from] !== undefined ? ' (new desc)' : ''}: ...${String(l.values.photo_url).slice(-45)} | ${desc}`);
    }
    return plan;
  };

  if (DRY) {
    const plain = Object.values(merged).filter(v => !byLandmark[v.landmarkId].discards.size);
    console.log(`\nDRY RUN — would write ${plain.length} description(s) by plain UPDATE:`);
    for (const v of plain) console.log(`  #${v.landmarkId}.${colName('photo_description', v.slot)} = ${v.text}`);
    if (compactIds.length) {
      console.log(`\nDRY RUN — would COMPACT ${compactIds.length} landmark(s) (${Object.keys(discards).length} discarded slot(s)); resulting layout:`);
      compactIds.forEach(printPlan);
    } else if (Object.keys(discards).length) {
      console.log(`  (+ discards.json with ${Object.keys(discards).length} entries; pass --apply-discards to clear the slots)`);
    }
    await pool.end();
    return;
  }

  let written = 0, failed = 0, compacted = 0, cleared = 0;

  // Plain path: landmarks without a discard get one UPDATE per description.
  for (const v of Object.values(merged)) {
    if (byLandmark[v.landmarkId].discards.size) continue;
    const col = colName('photo_description', v.slot);
    try {
      const r = await pool.query(
        `UPDATE landmark_index SET ${col} = $2, updated_at = NOW() WHERE id = $1`, [v.landmarkId, v.text]);
      if (r.rowCount === 1) written++;
      else { failed++; console.log(`  #${v.landmarkId}_${v.slot}: no such landmark`); }
    } catch (e) {
      failed++;
      console.log(`  #${v.landmarkId}_${v.slot}: ${e.message}`);
    }
  }

  // Compaction path: one transaction per landmark, row re-read under lock.
  if (compactIds.length) console.log(`\nCOMPACTING ${compactIds.length} landmark(s):`);
  for (const id of compactIds) {
    const { kept, discards: ds } = byLandmark[id];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM landmark_index WHERE id = $1 FOR UPDATE`, [id]);
      await loadLive(client, [id]);
      const plan = printPlan(id);
      if (!plan) { await client.query('ROLLBACK'); failed += Object.keys(kept).length; continue; }

      const sets = [], vals = [id];
      for (const l of plan.layout) for (const f of SLOT_FIELDS) { vals.push(l.values[f]); sets.push(`${colName(f, l.slot)} = $${vals.length}`); }
      await client.query(`UPDATE landmark_index SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);

      // Scores: drop every row for the landmark, re-insert survivors at their new slot.
      await client.query(`DELETE FROM landmark_photo_scores WHERE landmark_id = $1`, [id]);
      for (const sr of liveRows[id].scores) {
        const ns = plan.newSlotOf[sr.slot];
        if (!ns) continue;
        await client.query(
          `INSERT INTO landmark_photo_scores (landmark_id, slot, draw_score, photo_score, reason, judged_at, framing) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, ns, sr.draw_score, sr.photo_score, sr.reason, sr.judged_at, sr.framing]);
      }
      await client.query('COMMIT');
      compacted++;
      cleared += plan.filled.filter(s => ds.has(s)).length;
      written += Object.keys(kept).filter(o => plan.newSlotOf[Number(o)]).length;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      failed += Object.keys(kept).length;
      console.log(`  #${id}: ROLLED BACK — ${e.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`\n${ch(new Date())}  ${written} description(s) written, ${failed} failed, ${Object.keys(discards).length} discarded (discards.json)` +
    (APPLY_DISCARDS ? `, ${cleared} slot(s) cleared across ${compacted} compacted landmark(s)` : '') + `, ${missing.length} still missing.`);
  await pool.end();
  if (failed) process.exit(1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
