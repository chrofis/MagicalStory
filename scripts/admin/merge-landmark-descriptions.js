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
 * the unsuffixed column). All five per-slot columns move together —
 * photo_url, photo_attribution, photo_description, photo_type, photo_r2_url —
 * because the attribution is a licence condition tied to THAT picture. The R2
 * object of a discarded slot is deleted AFTER the transaction commits; R2 keys
 * are content-stable (landmarks/index/<id>/<hash-of-source>.jpg, see
 * landmarkPhotoStore.js), so a surviving photo's object never needs re-keying
 * when its slot number changes. landmark_photo_scores
 * rows are keyed (landmark_id, slot), so the discarded slot's row is deleted and
 * the surviving rows are re-numbered with their photo. The whole landmark is
 * rewritten in ONE transaction (row locked FOR UPDATE, current slots read from
 * the DB, not from the manifest), and kept descriptions for that landmark are
 * written in the same transaction at their POST-compaction slot number.
 * Landmarks without a discard take the plain per-column UPDATE.
 *
 * EVERY WRITE IS KEYED ON THE PHOTO'S SOURCE URL, NOT ITS SLOT NUMBER. The
 * agent saw slot numbers as they were at prep time; after one compaction the
 * later slots hold different photos. prep writes each slot's Commons URL into
 * manifest.json, and the merge applies a discard only when the live slot still
 * holds that URL (otherwise the entry is skipped with a log line), and writes a
 * kept description to whichever live slot holds the photo now (or skips it
 * when the photo is gone). A re-run of the same dir is therefore a no-op for
 * everything already applied. Dirs whose manifest predates the `url` field
 * cannot be verified and are refused entirely (re-prep them). The 2026-09-04
 * incident — a re-run discarding by stale slot number deleted ~118 surviving
 * photos on prod — is what this guard prevents (tasks/bugs.json
 * merge-landmark-descriptions-slot-number-rerun).
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
const { deleteStoredPhotos } = require('../../server/lib/landmarkPhotoStore');

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
const SLOT_FIELDS = ['photo_url', 'photo_attribution', 'photo_description', 'photo_type', 'photo_r2_url'];
const colName = (field, slot) => (slot === 1 ? field : `${field}_${slot}`);

// Live slot that holds `url` on `row`, preferring `slot` when it still does;
// null when the photo is no longer on the row.
function liveSlotOf(row, slot, url) {
  if (!url) return null;
  if (row[colName('photo_url', slot)] === url) return slot;
  return SLOTS.find(s => row[colName('photo_url', s)] === url) || null;
}

// Compaction plan for one landmark. `row` is the live landmark_index row,
// `discards` maps prep-time slot -> source URL of the photo to drop, `kept`
// maps prep-time slot -> { url, text }. A discard applies only when the live
// slot still holds that URL; a kept text goes to whichever live slot holds its
// photo now. Returns the surviving old slots in order, the old->new slot map,
// the full 6-slot layout to write (every per-slot column, NULL for the tail),
// and `skipped` — every entry that did not match the live row, with a reason.
function planCompaction(row, discards, kept) {
  const filled = SLOTS.filter(s => row[colName('photo_url', s)]);
  const skipped = [];
  const dropSlots = new Set();
  for (const [slot, url] of Object.entries(discards || {})) {
    const s = Number(slot);
    const live = row[colName('photo_url', s)];
    if (!url) skipped.push({ slot: s, url, reason: 'no source URL in manifest' });
    else if (!live) skipped.push({ slot: s, url, reason: 'live slot is empty' });
    else if (live !== url) skipped.push({ slot: s, url, reason: `live slot holds a different photo (...${String(live).slice(-40)})` });
    else dropSlots.add(s);
  }
  const textAt = {};   // old (live) slot -> new description
  for (const [slot, k] of Object.entries(kept || {})) {
    const s = Number(slot);
    if (!k.url) { skipped.push({ slot: s, url: k.url, reason: 'no source URL in manifest' }); continue; }
    const at = liveSlotOf(row, s, k.url);
    if (!at) { skipped.push({ slot: s, url: k.url, reason: 'photo is no longer on the row' }); continue; }
    if (dropSlots.has(at)) { skipped.push({ slot: s, url: k.url, reason: 'photo is being discarded' }); continue; }
    textAt[at] = k.text;
  }
  const survivors = filled.filter(s => !dropSlots.has(s));
  const newSlotOf = {};
  survivors.forEach((old, i) => { newSlotOf[old] = i + 1; });
  const layout = SLOTS.map(s => {
    const old = survivors[s - 1];
    if (!old) return { slot: s, from: null, values: Object.fromEntries(SLOT_FIELDS.map(f => [f, null])) };
    const values = Object.fromEntries(SLOT_FIELDS.map(f => [f, row[colName(f, old)]]));
    if (textAt[old] !== undefined) values.photo_description = textAt[old];
    return { slot: s, from: old, values };
  });
  return { filled, survivors, newSlotOf, layout, dropSlots, textAt, skipped };
}

// Returns a reason string when the entry is malformed, else null.
function validate(v) {
  if (!v || typeof v !== 'object') return 'not an object';
  if (v.discard !== null && v.discard !== undefined) {
    // A discarded photo is removed, never described: only the reason has to be sound.
    return typeof v.discard === 'string' && v.discard.trim().length >= 3 ? null : 'discard must be a non-empty reason';
  }
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

async function main() {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const manifest = fs.existsSync(path.join(DIR, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) : [];
  const nameOf = {}, urlOf = {};
  manifest.forEach(m => { nameOf[`${m.id}_${m.slot}`] = m.name; urlOf[`${m.id}_${m.slot}`] = m.url || null; });
  // A manifest without per-slot source URLs predates the URL guard: nothing in
  // it can be matched against the live row, so nothing from it may be written.
  if (manifest.length && !manifest.every(m => m.url)) {
    throw new Error(`${DIR}/manifest.json has entries without \`url\` — re-prep the dir (prep-landmark-descriptions.js writes it); refusing to write by slot number`);
  }

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
      const entry = { landmarkId: Number(m[1]), slot: Number(m[2]), url: urlOf[key] || null, description: String(v.description).trim(),
        scope: v.scope, season: v.season, timeOfDay: v.timeOfDay, subjectMatch: v.subjectMatch, discard: v.discard || null };
      if (!entry.url) { rejected.push(`${key} (${f}): not in manifest.json (no source URL to match the live slot against)`); continue; }
      // A later file overrides an earlier one in both directions.
      delete merged[key]; delete discards[key];
      if (entry.discard) discards[key] = entry;
      else merged[key] = { ...entry, text: `[${entry.scope}, ${entry.season}, ${entry.timeOfDay}] ${entry.description}` };
    }
  }
  console.log(`${ch(new Date())}  ${files.length} descs file(s) -> ${Object.keys(merged).length} kept, ${Object.keys(discards).length} discarded, ${rejected.length} rejected`);
  if (rejected.length) {
    console.log(`⚠ ${rejected.length} rejected (bad enum, description outside ${MIN_CHARS}-${MAX_CHARS} chars, talks about "the image", or not in the manifest):`);
    rejected.slice(0, 12).forEach(r => console.log(`    ${r}`));
  }
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
  const bucket = id => (byLandmark[id] ||= { kept: {}, discards: {} });
  for (const v of Object.values(merged)) bucket(v.landmarkId).kept[v.slot] = { url: v.url, text: v.text };
  if (APPLY_DISCARDS) for (const d of Object.values(discards)) bucket(d.landmarkId).discards[d.slot] = d.url;
  const hasDiscards = id => Object.keys(byLandmark[id].discards).length > 0;
  const compactIds = Object.keys(byLandmark).map(Number).filter(hasDiscards);

  // Live rows for every landmark touched — also in a dry run, so the printed
  // plan is the real resulting layout, not a guess from the manifest, and so
  // every write can be matched against the photo's current slot by URL.
  const liveRows = {};
  const loadLive = async (q, ids) => {
    const r = await q.query(`SELECT * FROM landmark_index WHERE id = ANY($1)`, [ids]);
    r.rows.forEach(row => { liveRows[row.id] = { ...row, scores: [] }; });
    const sc = await q.query(`SELECT * FROM landmark_photo_scores WHERE landmark_id = ANY($1) ORDER BY landmark_id, slot`, [ids]);
    sc.rows.forEach(x => { if (liveRows[x.landmark_id]) liveRows[x.landmark_id].scores.push(x); });
  };
  const allIds = Object.keys(byLandmark).map(Number);
  if (allIds.length) await loadLive(pool, allIds);

  // Plain-path target for one kept description: the live slot holding its photo.
  const plainTarget = (v) => {
    const row = liveRows[v.landmarkId];
    if (!row) return { slot: null, reason: 'no such landmark' };
    const at = liveSlotOf(row, v.slot, v.url);
    return at ? { slot: at } : { slot: null, reason: 'photo is no longer on the row' };
  };
  const logSkips = (id, skipped) => skipped.forEach(sk =>
    console.log(`  SKIP #${id}_${sk.slot} ${String(nameOf[`${id}_${sk.slot}`] || '').slice(0, 30)}: ${sk.reason}`));

  // Prints the per-slot layout a landmark ends up with; returns the plan.
  const printPlan = (id) => {
    const { kept, discards: ds } = byLandmark[id];
    const row = liveRows[id];
    if (!row) { console.log(`  #${id}: NO SUCH LANDMARK — skipped`); return null; }
    const plan = planCompaction(row, ds, kept);
    const scoreSlots = row.scores.map(x => x.slot);
    logSkips(id, plan.skipped);
    console.log(`  #${id} ${String(row.name).slice(0, 40)}  filled=[${plan.filled}] discard=[${[...plan.dropSlots].sort()}] -> ` +
      `${plan.survivors.map(o => `${o}→${plan.newSlotOf[o]}`).join(' ') || '(no photo left)'}` +
      `  scores [${scoreSlots}] -> [${scoreSlots.filter(sl => plan.newSlotOf[sl]).map(sl => plan.newSlotOf[sl])}]`);
    for (const l of plan.layout) {
      if (!l.from) { console.log(`      slot ${l.slot}: NULL`); continue; }
      const desc = l.values.photo_description ? String(l.values.photo_description).slice(0, 70) : 'NULL';
      console.log(`      slot ${l.slot} <- old ${l.from}${plan.textAt[l.from] !== undefined ? ' (new desc)' : ''}: ...${String(l.values.photo_url).slice(-45)} | ${desc}`);
    }
    return plan;
  };

  if (DRY) {
    const plain = Object.values(merged).filter(v => !hasDiscards(v.landmarkId));
    console.log(`\nDRY RUN — would write ${plain.length} description(s) by plain UPDATE (at the photo's live slot):`);
    for (const v of plain) {
      const t = plainTarget(v);
      if (!t.slot) { console.log(`  SKIP #${v.landmarkId}_${v.slot}: ${t.reason}`); continue; }
      console.log(`  #${v.landmarkId}.${colName('photo_description', t.slot)}${t.slot !== v.slot ? ` (prepped as slot ${v.slot})` : ''} = ${v.text}`);
    }
    if (compactIds.length) {
      console.log(`\nDRY RUN — would COMPACT ${compactIds.length} landmark(s) (${Object.keys(discards).length} discarded slot(s)); resulting layout:`);
      compactIds.forEach(printPlan);
    } else if (Object.keys(discards).length) {
      console.log(`  (+ discards.json with ${Object.keys(discards).length} entries; pass --apply-discards to clear the slots)`);
    }
    await pool.end();
    return;
  }

  let written = 0, failed = 0, skipped = 0, compacted = 0, cleared = 0, r2Deleted = 0;

  // Plain path: landmarks without a discard get one UPDATE per description,
  // at the slot that holds the photo NOW, guarded on the URL so a slot that
  // moved between the read and the write is left alone.
  for (const v of Object.values(merged)) {
    if (hasDiscards(v.landmarkId)) continue;
    const t = plainTarget(v);
    if (!t.slot) { skipped++; console.log(`  SKIP #${v.landmarkId}_${v.slot}: ${t.reason}`); continue; }
    const col = colName('photo_description', t.slot);
    try {
      const r = await pool.query(
        `UPDATE landmark_index SET ${col} = $2, updated_at = NOW() WHERE id = $1 AND ${colName('photo_url', t.slot)} = $3`, [v.landmarkId, v.text, v.url]);
      if (r.rowCount === 1) written++;
      else { skipped++; console.log(`  SKIP #${v.landmarkId}_${v.slot}: slot ${t.slot} changed under us`); }
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
      if (!plan.dropSlots.size && !Object.keys(plan.textAt).length) {
        // Nothing matched the live row (a re-run after everything was applied): leave it untouched.
        await client.query('ROLLBACK'); skipped += plan.skipped.length; continue;
      }

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
      // R2 objects of the discarded slots, read from the locked row BEFORE the
      // UPDATE overwrote the columns; deleted only once the commit is in.
      const droppedR2 = [...plan.dropSlots].map(s => liveRows[id][colName('photo_r2_url', s)]).filter(Boolean);
      await client.query('COMMIT');
      compacted++;
      cleared += plan.dropSlots.size;
      written += Object.keys(plan.textAt).length;
      skipped += plan.skipped.length;
      r2Deleted += await deleteStoredPhotos(droppedR2);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      failed += Object.keys(kept).length;
      console.log(`  #${id}: ROLLED BACK — ${e.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`\n${ch(new Date())}  ${written} description(s) written, ${failed} failed, ${skipped} skipped (photo not at its prep-time slot — see SKIP lines), ${Object.keys(discards).length} discarded (discards.json)` +
    (APPLY_DISCARDS ? `, ${cleared} slot(s) cleared across ${compacted} compacted landmark(s), ${r2Deleted} R2 object(s) deleted` : '') + `, ${missing.length} still missing.`);
  await pool.end();
  if (failed) process.exit(1);
}

module.exports = { planCompaction, liveSlotOf, colName, SLOT_FIELDS };
if (require.main === module) main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
