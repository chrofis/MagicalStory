#!/usr/bin/env node
'use strict';
/**
 * Free replay (SELECT only) of filterMainCharactersFromVisualBible over the last N production stories that
 * hold visualBible.secondaryCharacters and characters. OLD = exact lowercase name compare (what ran);
 * NEW = the shipped filter (castResolver). Lists every secondary each variant would drop, so every removal
 * can be eyeballed against the roster (bugs.json vb-secondary-duplicates-cast-named-with-relationship).
 *
 *   node scripts/analysis/replay-vb-secondary-cast-filter.js [--n 120]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { filterMainCharactersFromVisualBible } = require('../../server/lib/visualBible');

const N = Number(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 120);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query(
    `select id, created_at,
            data::jsonb->'characters' as chars,
            data::jsonb->'visualBible'->'secondaryCharacters' as sec
       from stories
      where jsonb_typeof(data::jsonb->'visualBible'->'secondaryCharacters') = 'array'
        and jsonb_array_length(data::jsonb->'visualBible'->'secondaryCharacters') > 0
        and jsonb_typeof(data::jsonb->'characters') = 'array'
      order by created_at desc limit $1`, [N]);
  let oldStories = 0; let newStories = 0; let secTotal = 0;
  const removed = [];
  for (const r of rows) {
    const chars = r.chars.filter(c => c && c.name);
    const sec = r.sec.filter(s => s && s.name);
    secTotal += sec.length;
    const oldNames = new Set(chars.map(c => c.name.toLowerCase()));
    const oldDrop = sec.filter(s => oldNames.has(String(s.name).toLowerCase())).map(s => s.name);
    const vb = { secondaryCharacters: sec.map(s => ({ ...s })) };
    filterMainCharactersFromVisualBible(vb, chars);
    const kept = new Set(vb.secondaryCharacters.map(s => s.name));
    const newDrop = sec.filter(s => !kept.has(s.name)).map(s => s.name);
    if (oldDrop.length) oldStories++;
    if (newDrop.length) newStories++;
    const extra = newDrop.filter(n => !oldDrop.includes(n));
    // stored secondaries that survive the OLD filter (what production kept) but the NEW one removes
    if (extra.length) removed.push({ id: r.id, extra, roster: chars.map(c => c.name) });
  }
  console.log(`stories replayed: ${rows.length}, secondaries: ${secTotal}`);
  console.log(`stored secondaries are what the OLD filter left; so "survivors that are roster characters" = NEW drops`);
  console.log(`stories where NEW filter removes a surviving secondary: ${removed.length}`);
  for (const x of removed) console.log(`- ${x.id}\n    removed: ${JSON.stringify(x.extra)}\n    roster:  ${JSON.stringify(x.roster)}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
