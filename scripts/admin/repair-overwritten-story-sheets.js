#!/usr/bin/env node
/**
 * Re-point story character sheets that a later story overwrote.
 *
 * Until 2026-10-09 the full-story job offloaded `{ styledAvatars }` under positional R2 names
 * (`characters/<user>/<char>/inline/styledAvatars-<i>-standard.jpg`), so every later story overwrote the
 * sheets earlier stories still referenced. Each story archived its own copy at a content-stable key
 * (`story-sheets/<jobId>-costumed.jpg` / `-styled-standard.jpg`, recorded in the character's
 * `avatars.storyHistory[].sheetUrl`). This script finds the story references whose bytes differ from that
 * archive and, with --apply, re-points them to the archived copy. See docs/decisions.md 2026-10-09
 * "Offloaded images are named by content".
 *
 *   node scripts/admin/repair-overwritten-story-sheets.js --env=staging            (dry run, default)
 *   node scripts/admin/repair-overwritten-story-sheets.js --env=prod --db-url=...   (dry run)
 *   ... --apply                                                                    (writes; owner decides)
 *
 * A story reference is matched to its archive by (story id, character id, sheet kind), never by name.
 */
require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const r2 = require('../../server/lib/r2');

const arg = (n) => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
const APPLY = process.argv.includes('--apply');
const ENV = arg('env') || 'staging';
const url = arg('db-url') || (ENV === 'staging' ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL);
if (!url) { console.error(`no database url for --env=${ENV}`); process.exit(1); }

const ARCHIVE = /characters\/[^/]+\/([^/]+)\/story-sheets\/(job_[^/]+?)-(costumed|styled-standard)\.jpg/;
const cache = new Map();
const digest = (u) => {
  if (!cache.has(u)) cache.set(u, (async () => {
    const b = await r2.bytesFromAnyImage(u);
    return b ? crypto.createHash('md5').update(b).digest('hex') : null;
  })());
  return cache.get(u);
};

(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const archive = new Map(); // `${storyId}|${charId}|${kind}` -> archived url
  const addHistory = (c) => {
    for (const h of (c.avatars?.storyHistory || [])) {
      const m = ARCHIVE.exec(h.sheetUrl || '');
      if (m) archive.set(`${m[2]}|${m[1]}|${m[3]}`, h.sheetUrl);
    }
  };
  for (const r of (await pool.query('SELECT data FROM characters')).rows) for (const c of (r.data?.characters || [])) addHistory(c);
  const stories = (await pool.query(`SELECT id, data FROM stories WHERE data::text LIKE '%/inline/styledAvatars-%'`)).rows;
  for (const s of stories) for (const c of (s.data?.characters || [])) addHistory(c);

  const counts = { refs: 0, same: 0, differ: 0, noArchive: 0, unreadable: 0 };
  const fixes = new Map(); // storyId -> [{ apply() }]
  for (const s of stories) {
    const style = s.data?.artStyle;
    for (const c of (s.data?.characters || [])) {
      const sa = c.avatars?.styledAvatars?.[style];
      if (!sa) continue;
      const slots = [];
      if (typeof sa.standard === 'string') slots.push(['styled-standard', sa.standard, (u) => { sa.standard = u; }]);
      for (const [k, v] of Object.entries(sa.costumed || {})) if (typeof v === 'string') slots.push(['costumed', v, (u) => { sa.costumed[k] = u; }]);
      for (const [kind, cur, set] of slots) {
        if (!cur.includes('/inline/styledAvatars-')) continue;
        counts.refs++;
        const arch = archive.get(`${s.id}|${c.id}|${kind}`);
        if (!arch) { counts.noArchive++; continue; }
        const [a, b] = await Promise.all([digest(cur), digest(arch)]);
        if (!a || !b) { counts.unreadable++; continue; }
        if (a === b) { counts.same++; continue; }
        counts.differ++;
        console.log(`${s.id} ${c.name} ${kind}: ${cur.split('/').slice(-3).join('/')} -> ${arch.split('/').slice(-2).join('/')}`);
        (fixes.get(s.id) || fixes.set(s.id, []).get(s.id)).push(() => set(arch));
      }
    }
  }
  console.log(`[${ENV}] stories scanned: ${stories.length}`, counts, `stories to repair: ${fixes.size}`, APPLY ? '(APPLYING)' : '(dry run)');
  if (APPLY) {
    for (const s of stories) {
      if (!fixes.has(s.id)) continue;
      fixes.get(s.id).forEach(f => f());
      await pool.query('UPDATE stories SET data = $1 WHERE id = $2', [JSON.stringify(s.data), s.id]);
    }
    console.log('applied');
  }
  await pool.end();
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
