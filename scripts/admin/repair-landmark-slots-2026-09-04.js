#!/usr/bin/env node
/**
 * One-off data repair for the 2026-09-04 slot-compaction incident
 * (tasks/bugs.json: merge-landmark-descriptions-slot-number-rerun).
 *
 * WHAT HAPPENED: merge-landmark-descriptions.js --apply-discards discarded by
 * SLOT NUMBER against the live row. After the first run compacted a landmark
 * (survivors shifted down), a re-run of the same descs dir discarded the same
 * slot numbers again and removed the photo that had shifted into that slot —
 * columns NULLed, landmark_photo_scores rows dropped, R2 object deleted. The
 * same dirs were merged several times on PROD; ~118 surviving photos are gone.
 * Kept descriptions were also written by prep-time slot number, so some sit on
 * the wrong photo.
 *
 * SOURCES OF TRUTH
 *  - STAGING landmark_index still holds the layout from before any run (last
 *    synced 2026-08-29..09-01, before the first merge on 2026-09-02). Staging
 *    ids differ from prod ids — rows are matched on wikidata_qid, the key
 *    sync-landmark-index-to-staging.js upserts on. Verified 2026-09-04: prod's
 *    surviving photo order is a strict subsequence of staging's for 345 of the
 *    350 affected landmarks; the other 5 had photos re-fetched on prod after the
 *    sync and are reported as DIVERGED, never rewritten.
 *  - The prep dirs (manifest.json = prep-time (id, slot); descs_*.json = the
 *    agents' verdicts; discards.json = every discard the merge recorded). The
 *    manifests of these dirs predate the `url` field, so an (id, slot) is
 *    resolved to its photo through staging's slot of the same number — valid
 *    because every manifest was prepped from the pre-run layout (checked: no
 *    manifest slot exceeds staging's slot count, and the six landmarks prepped
 *    twice were re-prepped for slots whose numbers had not moved).
 *
 * INTENDED LAYOUT per landmark = staging's ordered slots (url, attribution,
 * type) MINUS the URLs of the true discards (union of every discards.json),
 * with descriptions from the descs files keyed by URL (later dir / later file
 * wins, stored as `[scope, season, timeOfDay] description` exactly as the
 * merge does), falling back to staging's own description, else NULL.
 *
 * --dry-run prints the per-landmark diff against prod (photos missing, wrong
 * order, description differences, true discards still live) and totals.
 * The real run, per landmark in ONE transaction: row locked FOR UPDATE and
 * re-checked against the dry-run snapshot, all 30 per-slot columns rewritten
 * (photo_r2_url carried over from prod where the photo survived), scores
 * deleted and re-inserted FROM STAGING at the new slot numbers (surviving
 * photos only). After the commit every slot without an R2 copy is stored via
 * storeLandmarkPhoto (Commons fetch, 2 s apart); the R2 objects of true
 * discards removed by the repair are deleted last. Idempotent: a second run
 * finds no diff and writes nothing.
 *
 *   node scripts/admin/repair-landmark-slots-2026-09-04.js --dirs=DIR1,DIR2,... [--dry-run] [--ids=a,b,c] [--delay=MS]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const fs = require('fs');
const { ch } = require('../lib/chTime');
const { storeLandmarkPhoto, deleteStoredPhotos, colName, SLOTS } = require('../../server/lib/landmarkPhotoStore');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const flag = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const DIRS = (flag('dirs') || '').split(',').map(s => s.trim()).filter(Boolean);
const IDS = flag('ids') ? new Set(flag('ids').split(',').map(s => parseInt(s, 10)).filter(Number.isFinite)) : null;
const DELAY = flag('delay') ? parseInt(flag('delay'), 10) : 2000;   // Wikimedia spacing
const SLOT_FIELDS = ['photo_url', 'photo_attribution', 'photo_description', 'photo_type', 'photo_r2_url'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tail = u => `...${String(u).slice(-40)}`;
const log = msg => console.log(`${ch(new Date())}  ${msg}`);

// ---------- prep dirs ----------------------------------------------------------

// Reads every dir: manifest entries, discards and kept descriptions, in dir
// order then file mtime order so a later description of the same photo wins.
function loadDirs(dirs) {
  const manifest = {};   // "id_slot" -> { id, slot, url|null, name }
  const discards = [];   // { id, slot, reason, dir }
  const kept = [];       // { id, slot, text, dir, file }  (in override order)
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error(`${dir}: no manifest.json`);
    for (const m of JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))) {
      manifest[`${m.id}_${m.slot}`] = { id: m.id, slot: m.slot, url: m.url || null, name: m.name };
    }
    if (fs.existsSync(path.join(dir, 'discards.json'))) {
      for (const d of JSON.parse(fs.readFileSync(path.join(dir, 'discards.json'), 'utf8'))) {
        discards.push({ id: d.landmarkId, slot: d.slot, reason: d.discard, dir });
      }
    }
    const files = fs.readdirSync(dir).filter(f => /^descs_\d+\.json$/.test(f))
      .sort((a, b) => fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs);
    for (const f of files) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const [key, v] of Object.entries(j)) {
        const m = /^(\d+)_([1-6])$/.exec(key);
        if (!m || !v || typeof v !== 'object') continue;
        if (v.discard) { discards.push({ id: Number(m[1]), slot: Number(m[2]), reason: v.discard, dir, fromDescs: true }); continue; }
        const text = String(v.description || '').trim();
        if (text.length < 40 || text.length > 400) continue;   // merge would have rejected it too
        kept.push({ id: Number(m[1]), slot: Number(m[2]), text: `[${v.scope}, ${v.season}, ${v.timeOfDay}] ${text}`, dir, file: f });
      }
    }
  }
  return { manifest, discards, kept };
}

// ---------- per-landmark plan ------------------------------------------------

const urlsOf = row => SLOTS.map(s => row[colName('photo_url', s)]).filter(Boolean);
const isSubsequence = (small, big) => {
  let j = 0;
  for (const u of small) { while (j < big.length && big[j] !== u) j++; if (j >= big.length) return false; j++; }
  return true;
};

// Builds the intended layout for one prod landmark and diffs it against the
// live prod row. `resolve(slot)` gives the prep-time photo URL for a slot.
function planLandmark({ prod, staging, stagingScores, prodScores, discards, kept, manifest }) {
  const id = prod.id;
  const prodUrls = urlsOf(prod);
  const stagingSlots = SLOTS.filter(s => staging[colName('photo_url', s)]).map(s => ({
    stagingSlot: s,
    url: staging[colName('photo_url', s)],
    attribution: staging[colName('photo_attribution', s)],
    type: staging[colName('photo_type', s)],
    stagingDesc: staging[colName('photo_description', s)],
  }));
  const stagingUrls = stagingSlots.map(x => x.url);
  const problems = [];
  if (!isSubsequence(prodUrls, stagingUrls)) {
    return { id, name: prod.name, diverged: true, note: `prod holds photo(s) not on staging: ${prodUrls.filter(u => !stagingUrls.includes(u)).map(tail).join(', ')}` };
  }

  // (id, slot) -> URL: the manifest's own url when prep recorded one, else the
  // pre-run layout's slot of that number.
  const resolve = (slot) => {
    const m = manifest[`${id}_${slot}`];
    if (m && m.url) return m.url;
    const st = stagingSlots.find(x => x.stagingSlot === slot);
    return st ? st.url : null;
  };

  const discardUrls = new Set();
  for (const d of discards) {
    const u = resolve(d.slot);
    if (!u) { problems.push(`discard ${id}_${d.slot} (${d.dir}) cannot be resolved to a photo — staging has no slot ${d.slot}`); continue; }
    discardUrls.add(u);
  }
  const descByUrl = {};
  for (const k of kept) {   // in override order: the last one wins
    const u = resolve(k.slot);
    if (!u) { problems.push(`description ${id}_${k.slot} (${k.dir}/${k.file}) cannot be resolved to a photo`); continue; }
    descByUrl[u] = k.text;
  }

  const intended = stagingSlots.filter(x => !discardUrls.has(x.url)).map((x, i) => ({
    slot: i + 1,
    stagingSlot: x.stagingSlot,
    url: x.url,
    attribution: x.attribution,
    type: x.type,
    description: descByUrl[x.url] !== undefined ? descByUrl[x.url] : (x.stagingDesc || null),
    descSource: descByUrl[x.url] !== undefined ? 'descs' : (x.stagingDesc ? 'staging' : null),
    // Prod's R2 copy survives with the photo wherever it sits now; a photo that
    // was removed lost its object (deleteStoredPhotos) and must be re-stored.
    r2Url: (() => { const at = SLOTS.find(s => prod[colName('photo_url', s)] === x.url); return at ? prod[colName('photo_r2_url', at)] || null : null; })(),
  }));

  // Diff against prod.
  const intendedUrls = intended.map(x => x.url);
  const missing = intended.filter(x => !prodUrls.includes(x.url));
  const extra = prodUrls.filter(u => !intendedUrls.includes(u));   // true discards still live
  const orderWrong = !missing.length && !extra.length && JSON.stringify(prodUrls) !== JSON.stringify(intendedUrls);
  const descDiffs = [];
  for (const x of intended) {
    const at = SLOTS.find(s => prod[colName('photo_url', s)] === x.url);
    if (!at) continue;
    const cur = prod[colName('photo_description', at)] || null;
    if (cur !== x.description) descDiffs.push({ url: x.url, prodSlot: at, newSlot: x.slot, from: cur, to: x.description });
  }
  const scoresNew = stagingScores.filter(sc => intended.some(x => x.stagingSlot === sc.slot))
    .map(sc => ({ ...sc, slot: intended.find(x => x.stagingSlot === sc.slot).slot }));
  const stagingNewest = Math.max(0, ...stagingScores.map(sc => +new Date(sc.judged_at || 0)));
  const prodNewerScores = prodScores.filter(sc => +new Date(sc.judged_at || 0) > stagingNewest).length;
  const changed = missing.length || extra.length || orderWrong || descDiffs.length;
  return { id, name: prod.name, intended, prodUrls, missing, extra, orderWrong, descDiffs, scoresNew, prodScores, prodNewerScores, problems, changed, discardUrls };
}

// ---------- main -------------------------------------------------------------

async function main() {
  if (!DIRS.length) throw new Error('--dirs=DIR1,DIR2,... is required (the prep dirs whose merges were re-run)');
  if (!process.env.DATABASE_URL || !process.env.STAGING_DATABASE_URL) throw new Error('DATABASE_URL and STAGING_DATABASE_URL must both be set');
  const prodPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const stgPool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const { manifest, discards, kept } = loadDirs(DIRS);
  let ids = [...new Set([...discards.map(d => d.id), ...kept.map(k => k.id)])].sort((a, b) => a - b);
  if (IDS) ids = ids.filter(id => IDS.has(id));
  log(`${DIRS.length} dir(s): ${Object.keys(manifest).length} prepped slots, ${discards.length} discard entries, ${kept.length} kept descriptions -> ${ids.length} landmark(s) to check`);

  const prodRows = (await prodPool.query(`SELECT * FROM landmark_index WHERE id = ANY($1)`, [ids])).rows;
  const prodScores = (await prodPool.query(`SELECT * FROM landmark_photo_scores WHERE landmark_id = ANY($1) ORDER BY landmark_id, slot`, [ids])).rows;
  const qids = prodRows.map(r => r.wikidata_qid).filter(Boolean);
  const stgRows = (await stgPool.query(`SELECT * FROM landmark_index WHERE wikidata_qid = ANY($1)`, [qids])).rows;
  const stgScores = (await stgPool.query(
    `SELECT s.*, l.wikidata_qid FROM landmark_photo_scores s JOIN landmark_index l ON l.id = s.landmark_id WHERE l.wikidata_qid = ANY($1) ORDER BY s.slot`, [qids])).rows;
  await stgPool.end();
  const stgByQid = new Map(stgRows.map(r => [r.wikidata_qid, r]));
  const byId = (rows, key) => rows.reduce((m, r) => ((m[r[key]] ||= []).push(r), m), {});
  const discardsById = byId(discards, 'id'), keptById = byId(kept, 'id'), prodScoresById = byId(prodScores, 'landmark_id'), stgScoresByQid = byId(stgScores, 'wikidata_qid');

  const plans = [];
  const unrestorable = [];
  for (const prod of prodRows) {
    const staging = prod.wikidata_qid ? stgByQid.get(prod.wikidata_qid) : null;
    if (!staging) { unrestorable.push(`#${prod.id} ${prod.name}: no staging row for qid ${prod.wikidata_qid} — pre-run layout unknown`); continue; }
    const plan = planLandmark({ prod, staging, stagingScores: stgScoresByQid[prod.wikidata_qid] || [], prodScores: prodScoresById[prod.id] || [],
      discards: discardsById[prod.id] || [], kept: keptById[prod.id] || [], manifest });
    if (plan.diverged) { unrestorable.push(`#${plan.id} ${plan.name}: DIVERGED — ${plan.note}`); continue; }
    plan.problems.forEach(p => unrestorable.push(p));
    plans.push(plan);
  }
  for (const id of ids) if (!prodRows.some(r => r.id === id)) unrestorable.push(`#${id}: no such landmark on prod`);

  const changedPlans = plans.filter(p => p.changed);
  const totals = {
    landmarksChecked: plans.length,
    landmarksToRewrite: changedPlans.length,
    photosToRestore: changedPlans.reduce((n, p) => n + p.missing.length, 0),
    trueDiscardsStillLive: changedPlans.reduce((n, p) => n + p.extra.length, 0),
    orderOnlyFixes: changedPlans.filter(p => p.orderWrong).length,
    descriptionFixes: changedPlans.reduce((n, p) => n + p.descDiffs.length, 0),
    r2CopiesToStore: changedPlans.reduce((n, p) => n + p.intended.filter(x => !x.r2Url).length, 0),
    scoreRowsToInsert: changedPlans.reduce((n, p) => n + p.scoresNew.length, 0),
    scoreRowsReplaced: changedPlans.reduce((n, p) => n + p.prodScores.length, 0),
    landmarksWithNewerProdScores: changedPlans.filter(p => p.prodNewerScores).length,
  };

  console.log(`\nPER-LANDMARK DIFF (${changedPlans.length} landmark(s) differ from the intended layout):`);
  for (const p of changedPlans) {
    console.log(`  #${p.id} ${String(p.name).slice(0, 45)}  prod ${p.prodUrls.length} photo(s) -> intended ${p.intended.length}` +
      (p.prodNewerScores ? `  ⚠ ${p.prodNewerScores} prod score row(s) newer than staging's` : ''));
    for (const x of p.intended) {
      const at = SLOTS.find(s => p.prodUrls[s - 1] === x.url);
      const state = !at ? 'RESTORE' : at === x.slot ? 'keep   ' : `move ${at}→${x.slot}`;
      console.log(`      slot ${x.slot} ${state} ${tail(x.url)}${x.r2Url ? '' : ' [no R2 copy]'}${x.descSource ? ` desc:${x.descSource}` : ' desc:NULL'}`);
    }
    for (const u of p.extra) console.log(`      REMOVE (true discard still live) ${tail(u)}`);
    for (const d of p.descDiffs) console.log(`      desc slot ${d.newSlot}: ${d.from ? `"${String(d.from).slice(0, 40)}…"` : 'NULL'} -> ${d.to ? `"${String(d.to).slice(0, 40)}…"` : 'NULL'}`);
  }
  if (unrestorable.length) {
    console.log(`\nCANNOT RESTORE (${unrestorable.length}):`);
    unrestorable.forEach(u => console.log(`  ${u}`));
  }
  console.log(`\nTOTALS ${JSON.stringify(totals, null, 1)}`);

  if (DRY) { log('DRY RUN — nothing written.'); await prodPool.end(); return; }

  let rewritten = 0, failed = 0, stored = 0, storeFailed = 0, r2Deleted = 0;
  const toDelete = [];
  for (const p of changedPlans) {
    const client = await prodPool.connect();
    try {
      await client.query('BEGIN');
      const live = (await client.query(`SELECT * FROM landmark_index WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
      if (!live || JSON.stringify(urlsOf(live)) !== JSON.stringify(p.prodUrls)) throw new Error('row changed since the plan was made — re-run');
      const sets = [], vals = [p.id];
      for (const s of SLOTS) {
        const x = p.intended[s - 1];
        const values = x ? { photo_url: x.url, photo_attribution: x.attribution, photo_description: x.description, photo_type: x.type, photo_r2_url: x.r2Url }
          : Object.fromEntries(SLOT_FIELDS.map(f => [f, null]));
        for (const f of SLOT_FIELDS) { vals.push(values[f]); sets.push(`${colName(f, s)} = $${vals.length}`); }
      }
      await client.query(`UPDATE landmark_index SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
      await client.query(`DELETE FROM landmark_photo_scores WHERE landmark_id = $1`, [p.id]);
      for (const sc of p.scoresNew) {
        await client.query(
          `INSERT INTO landmark_photo_scores (landmark_id, slot, draw_score, photo_score, reason, judged_at, framing) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [p.id, sc.slot, sc.draw_score, sc.photo_score, sc.reason, sc.judged_at, sc.framing]);
      }
      // R2 objects of true discards this repair removes — read before COMMIT, deleted after all rows are done.
      for (const u of p.extra) { const at = SLOTS.find(s => live[colName('photo_url', s)] === u); if (at && live[colName('photo_r2_url', at)]) toDelete.push(live[colName('photo_r2_url', at)]); }
      await client.query('COMMIT');
      rewritten++;
      log(`#${p.id} ${String(p.name).slice(0, 40)}: rewritten — ${p.missing.length} restored, ${p.extra.length} removed, ${p.scoresNew.length} score row(s)`);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      failed++;
      log(`#${p.id} ${String(p.name).slice(0, 40)}: ROLLED BACK — ${e.message}`);
      continue;
    } finally {
      client.release();
    }
    // Our own copy of every restored photo: fetched from Commons 2 s apart.
    for (const x of p.intended) {
      if (x.r2Url) continue;
      try {
        const st = await storeLandmarkPhoto(prodPool, p.id, x.slot, x.url, { currentR2Url: null });
        stored++;
        log(`   R2 #${p.id}_${x.slot} -> ${st.url}`);
      } catch (e) {
        storeFailed++;
        log(`   R2 FAIL #${p.id}_${x.slot} ${tail(x.url)}: ${e.message} (backfill-landmark-photos-to-r2.js --ids=${p.id} picks it up)`);
      }
      await sleep(DELAY);
    }
  }
  r2Deleted = await deleteStoredPhotos(toDelete);
  log(`done: ${rewritten} landmark(s) rewritten, ${failed} failed, ${stored} R2 cop${stored === 1 ? 'y' : 'ies'} stored (${storeFailed} failed), ${r2Deleted} discarded object(s) deleted`);
  await prodPool.end();
  if (failed || storeFailed) process.exit(1);
}

module.exports = { planLandmark, loadDirs, isSubsequence };
if (require.main === module) main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
