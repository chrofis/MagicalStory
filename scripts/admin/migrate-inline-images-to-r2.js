#!/usr/bin/env node
/**
 * Move every inline image byte out of `characters.data` / `stories.data` into R2.
 *
 * WHY: the no-images-in-JSONB rule was enforced at the STORY save path only
 * (`extractInlineImagesToR2`, whose every call site passes a storyId).
 * Characters have their own write paths and were never covered, and story rows
 * written before the June 2026 fix were never back-migrated. Measured on
 * production 2026-09-01: 621 MB of `stories.data` and 73 MB of `characters.data`
 * still held base64.
 *
 * This is not cosmetic. Railway bills the container's memory, which counts the
 * OS page cache holding the database files — `shared_buffers` is only 160 MB,
 * so Postgres RAM tracks database SIZE almost exactly (prod DB 1,818 MB → 2.14 GB
 * container). Shrinking the rows is what lowers the memory line.
 *
 * R2 is the only store. A row whose uploads fail is left ALONE and reported;
 * it is never written back half-migrated.
 *
 *   node scripts/admin/migrate-inline-images-to-r2.js [--staging] [--table=characters|stories] [--limit=N] [--apply]
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const r2 = require('../../server/lib/r2');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const STAGING = args.includes('--staging');
const tableArg = args.find(a => a.startsWith('--table='));
const TABLES = tableArg ? [tableArg.split('=')[1]] : ['characters', 'stories'];
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const looksLikeBytes = (s) =>
  typeof s === 'string'
  && (s.startsWith('data:image/') || s.startsWith('/9j/') || s.startsWith('iVBORw0')
      || s.startsWith('R0lGOD') || s.startsWith('UklGR'))
  && s.length > 1024;

const safe = (v) => String(v).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
const MB = (n) => (n / 1024 / 1024).toFixed(1);

/** Queue every byte-string in the tree, keyed by its own JSON path. */
function collect(data, prefix) {
  const tasks = [];
  const used = new Set();
  const seen = new WeakSet();
  const walk = (node, segs) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (typeof child === 'string' && looksLikeBytes(child)) {
        const base = `${prefix}/${[...segs, safe(k)].join('-')}`;
        let key = `${base}.jpg`;
        let n = 1;
        while (used.has(key)) key = `${base}__${n++}.jpg`;
        used.add(key);
        tasks.push({ input: child, key, apply: (url) => { node[k] = url; }, bytes: child.length });
      } else if (child && typeof child === 'object') {
        walk(child, [...segs, safe(k)]);
      }
    }
  };
  walk(data, []);
  return tasks;
}

(async () => {
  if (!r2.isConfigured()) {
    console.error('R2 is not configured — refusing to run. Bytes must go somewhere real.');
    process.exit(1);
  }
  const cs = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  const label = STAGING ? 'STAGING' : 'PROD';

  for (const table of TABLES) {
    const owner = table === 'characters' ? 'user_id' : 'user_id';
    const rows = (await pool.query(
      `SELECT id, ${owner} AS owner, data FROM ${table}
        WHERE data::text LIKE '%data:image%'
        ORDER BY pg_column_size(data) DESC${LIMIT ? ` LIMIT ${LIMIT}` : ''}`)).rows;

    const totalBytes = rows.reduce((s, r) => s + collect(r.data, 'x').reduce((a, t) => a + t.bytes, 0), 0);
    console.log(`\n=== ${label} ${table}: ${rows.length} row(s) with inline images, ~${MB(totalBytes)} MB ===`);
    if (!APPLY) { console.log('(dry run — pass --apply)'); continue; }

    let done = 0, movedTotal = 0, skipped = 0;
    for (const row of rows) {
      const prefix = `${table}/${safe(row.owner || 'unknown')}/${safe(row.id)}/migrated`;
      const tasks = collect(row.data, prefix);
      if (!tasks.length) continue;

      let failed = 0;
      const PARALLEL = 12;
      let next = 0;
      await Promise.all(new Array(Math.min(PARALLEL, tasks.length)).fill(null).map(async () => {
        while (true) {
          const i = next++;
          if (i >= tasks.length) return;
          try {
            const url = await r2.uploadImage(tasks[i].input, tasks[i].key);
            if (!url) throw new Error('no URL');
            tasks[i].apply(url);
          } catch { failed++; }
        }
      }));

      // All-or-nothing per row: a partial write leaves the row both bloated
      // AND inconsistent, which is worse than leaving it untouched.
      if (failed) {
        console.log(`  ! ${row.id}: ${failed}/${tasks.length} uploads failed — row left unchanged`);
        skipped++;
        continue;
      }
      await pool.query(`UPDATE ${table} SET data = $2 WHERE id = $1`, [row.id, JSON.stringify(row.data)]);
      movedTotal += tasks.length;
      done++;
      if (done % 10 === 0) console.log(`  ${done}/${rows.length} rows, ${movedTotal} images moved`);
    }
    console.log(`  ✅ ${table}: ${done} row(s) migrated, ${movedTotal} image(s) to R2, ${skipped} skipped`);
  }

  const sz = await pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) s`);
  console.log(`\n${label} database now ${sz.rows[0].s}`);
  console.log('NOTE: space is not returned to the OS until VACUUM FULL / pg_repack runs.');
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
