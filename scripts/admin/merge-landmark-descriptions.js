#!/usr/bin/env node
/**
 * Write agent-produced photo descriptions into landmark_index, one slot column
 * at a time. Counterpart of prep-landmark-descriptions.js.
 *
 * Agents write descs_<batch>.json — `{ "<landmarkId>_<slot>": "text" }`. This
 * merges every such file in the directory (oldest first, so a re-describe
 * wins) and UPDATEs only that slot's photo_description[_N] column. Nothing
 * else on the row is touched, so a re-run writes the same text again — idempotent.
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

// A description shorter than this is a fragment, not a brief (the 2026-08-29
// Gemini truncation stored 60-character stubs — see analyzeLandmarkPhoto).
const MIN_CHARS = 80;

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  const files = fs.readdirSync(DIR)
    .filter(f => /^descs_\d+\.json$/.test(f))
    .sort((a, b) => fs.statSync(path.join(DIR, a)).mtimeMs - fs.statSync(path.join(DIR, b)).mtimeMs);
  const merged = {};
  const rejected = [];
  for (const f of files) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
    catch (e) { console.log(`  ${f}: unreadable (${e.message})`); continue; }
    for (const [key, v] of Object.entries(j)) {
      const m = /^(\d+)_([1-6])$/.exec(key);
      if (!m) continue;
      const text = String(v || '').trim();
      if (text.length < MIN_CHARS || /the (image|photo) shows/i.test(text)) { rejected.push(`${key} (${f})`); continue; }
      merged[key] = { landmarkId: Number(m[1]), slot: Number(m[2]), text };
    }
  }
  console.log(`${ch(new Date())}  ${files.length} descs file(s) -> ${Object.keys(merged).length} description(s)`);
  if (rejected.length) {
    console.log(`⚠ ${rejected.length} rejected (shorter than ${MIN_CHARS} chars or talks about "the image"):`);
    rejected.slice(0, 12).forEach(r => console.log(`    ${r}`));
  }

  const manifest = fs.existsSync(path.join(DIR, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) : [];
  const missing = manifest.filter(m => merged[`${m.id}_${m.slot}`] === undefined);
  if (missing.length) {
    console.log(`⚠ ${missing.length} prepped image(s) have NO description yet:`);
    missing.slice(0, 12).forEach(m => console.log(`    ${m.id}_${m.slot}  ${m.name}`));
  }

  if (DRY) { await pool.end(); return; }

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

  console.log(`\n${ch(new Date())}  ${written} description(s) written, ${failed} failed, ${missing.length} still missing.`);
  await pool.end();
  if (failed) process.exit(1);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
