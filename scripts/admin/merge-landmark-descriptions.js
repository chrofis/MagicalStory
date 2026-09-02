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
 * DISCARDS NEVER TOUCH THE DB: an entry with `discard` set (wrong subject,
 * unrecognisable, map/print/archival, duplicate of a lower slot) is listed in
 * a DISCARD table and written to <dir>/discards.json for a later slot-clearing
 * pass; the column stays NULL so the slot is selected again by prep.
 *
 * A COVERAGE CHECK IS MANDATORY: an agent that dies mid-batch leaves keys out,
 * and a missing key is indistinguishable from a never-prepped slot. What the
 * manifest listed but no file described gets printed.
 *
 *   node scripts/admin/merge-landmark-descriptions.js --dir=DIR [--staging] [--dry-run]
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

  if (DRY) {
    console.log(`\nDRY RUN — would write ${Object.keys(merged).length} description(s):`);
    for (const v of Object.values(merged)) {
      const col = v.slot === 1 ? 'photo_description' : `photo_description_${v.slot}`;
      console.log(`  #${v.landmarkId}.${col} = ${v.text}`);
    }
    if (Object.keys(discards).length) console.log(`  (+ discards.json with ${Object.keys(discards).length} entries)`);
    await pool.end();
    return;
  }

  let written = 0, failed = 0;
  for (const v of Object.values(merged)) {
    const col = v.slot === 1 ? 'photo_description' : `photo_description_${v.slot}`;
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

  console.log(`\n${ch(new Date())}  ${written} description(s) written, ${failed} failed, ${Object.keys(discards).length} discarded (discards.json), ${missing.length} still missing.`);
  await pool.end();
  if (failed) process.exit(1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
