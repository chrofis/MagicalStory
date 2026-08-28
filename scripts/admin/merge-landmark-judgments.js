#!/usr/bin/env node
/**
 * Write agent-produced image scores into landmark_photo_scores, then recompute
 * each landmark's story_score from them.
 *
 * The agents judge visually (Read tool on downloaded thumbnails) and each writes
 * picks_<batch>.json — `{ "<landmarkId>_<slot>": { draw, photo, reason } }`.
 * This merges every picks file in a judging directory and applies it.
 *
 * WHY TWO SCORES IN, ONE OUT: draw and photo answer different questions (see
 * migrations/031) and are kept apart so the ranking can be retuned without
 * re-judging. story_score stays as the single number production filters on, but
 * it is now DERIVED, never authored: a landmark is worth offering if the place
 * is drawable AND at least one of its photos shows it, so the landmark takes its
 * best slot rather than being condemned by a bad lead image.
 *
 * A COVERAGE CHECK IS MANDATORY, not decoration: agents sometimes return fewer
 * keys than they were given (they die mid-batch, or quietly skip an image that
 * would not open). A missing key is indistinguishable from an unjudged image and
 * would be re-prepped forever, so what is still missing gets printed.
 *
 *   node scripts/admin/merge-landmark-judgments.js --dir=DIR [--staging] [--dry-run]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const STAGING = args.includes('--staging');
const dirArg = args.find(a => a.startsWith('--dir='));
const DIR = dirArg ? dirArg.split('=')[1] : path.join(process.env.TEMP || '/tmp', 'lm_judge');

const clamp = v => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};

(async () => {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  // OLDEST FIRST, so a later re-judge of the same image wins. Directory order is
  // alphabetical, which puts picks_1000 before picks_999 — a stale file then
  // silently overwrote a fresh one, and a re-judge that added the framing field
  // came out with framing NULL.
  const files = fs.readdirSync(DIR)
    .filter(f => /^picks_\d+\.json$/.test(f))
    .sort((a, b) => fs.statSync(path.join(DIR, a)).mtimeMs - fs.statSync(path.join(DIR, b)).mtimeMs);
  const merged = {};
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      for (const [key, v] of Object.entries(j)) {
        const m = /^(\d+)_([1-6])$/.exec(key);
        if (!m) continue;
        const draw = clamp(v?.draw);
        const photo = clamp(v?.photo);
        if (draw === null && photo === null) continue;
        // An unrecognised framing word becomes NULL, which the selection query
        // reads as 'medium'. Storing the agent's typo would silently create a
        // sixth framing class that never matches the CASE and sorts mid-pack.
        const f = String(v?.framing || '').toLowerCase().trim();
        merged[key] = {
          landmarkId: Number(m[1]), slot: Number(m[2]), draw, photo,
          // 'view-from' matches the spelling already used by photo_type in
          // landmark_index (view-from, not view_from) — one vocabulary, not two.
          framing: ['medium', 'closeup', 'interior', 'wide', 'view-from', 'aerial'].includes(f) ? f : null,
          reason: String(v?.reason || '').slice(0, 300),
        };
      }
    } catch (e) { console.log(`  ${f}: unreadable (${e.message})`); }
  }
  console.log(`${files.length} picks file(s) → ${Object.keys(merged).length} scored image(s)`);

  const manifest = fs.existsSync(path.join(DIR, 'manifest.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) : [];
  const missing = manifest.filter(m => merged[`${m.id}_${m.slot}`] === undefined);
  if (missing.length) {
    console.log(`⚠ ${missing.length} prepped image(s) were NOT scored — re-run those before assuming coverage:`);
    missing.slice(0, 12).forEach(m => console.log(`    ${m.id}_${m.slot}  ${m.name}`));
  }

  if (DRY) { await pool.end(); return; }

  const touched = new Set();
  for (const v of Object.values(merged)) {
    await pool.query(
      `INSERT INTO landmark_photo_scores (landmark_id, slot, draw_score, photo_score, framing, reason, judged_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (landmark_id, slot) DO UPDATE
         SET draw_score = EXCLUDED.draw_score, photo_score = EXCLUDED.photo_score,
             framing = EXCLUDED.framing, reason = EXCLUDED.reason, judged_at = NOW()`,
      [v.landmarkId, v.slot, v.draw, v.photo, v.framing, v.reason]);
    touched.add(v.landmarkId);
  }

  // Derive story_score for every landmark whose images changed.
  //
  // The place is judged by its BEST draw score across slots (they describe the
  // same place, so a low one is a bad photo talking, not a worse subject), and
  // the picture by its best photo score. A landmark is only as good as its
  // weakest necessary half — a wonderful place with no usable picture cannot be
  // illustrated, and a sharp photo of a car park is still a car park — so the
  // two are combined with min(), not an average that would let one hide the other.
  const ids = [...touched];
  if (ids.length) {
    await pool.query(`
      UPDATE landmark_index l SET
        story_score = s.derived,
        story_score_at = NOW(),
        story_score_reason = s.reason
      FROM (
        SELECT landmark_id,
               LEAST(MAX(draw_score), MAX(photo_score)) derived,
               (ARRAY_AGG(reason ORDER BY LEAST(draw_score, photo_score) DESC NULLS LAST))[1] reason
          FROM landmark_photo_scores WHERE landmark_id = ANY($1) GROUP BY landmark_id
      ) s WHERE l.id = s.landmark_id`, [ids]);
  }

  const stats = (await pool.query(
    `SELECT count(*) n, count(*) FILTER (WHERE story_score < 40) rejected
       FROM landmark_index WHERE id = ANY($1)`, [ids])).rows[0];
  console.log(`\n✅ ${Object.keys(merged).length} image(s) scored across ${stats.n} landmark(s) — ${stats.rejected} now below 40 (the usable-picture cutoff) and no longer offered.`);
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
