#!/usr/bin/env node
'use strict';
/**
 * Free replay (SELECT only, no model call) of the phantom-patch decision over stored production stories
 * (bugs.json phantom-patch-after-main-cast-filter). For each story of the last N days it classifies the names in
 * sceneDescriptions[].characterClothing against the stored roster with the stored visual bible emptied of
 * secondaries/animals (the state the patch saw), and reports per story how many names the OLD rule would have sent
 * to the patch (phantoms + ambiguous) and how many the NEW rule sends (phantoms only), and how many of the NEW ones
 * still resolve to a main-cast member by an independent canonical-name check (must be 0).
 *
 *   node scripts/analysis/replay-phantom-patch-names.js [--days 60]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { classifyUnknownNames } = require('../../server/lib/phantomCharacters');
const { canonicalName } = require('../../server/lib/castResolver');

const DAYS = Number(process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : 60);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  await client.query('SET default_transaction_read_only = on');
  const { rows } = await client.query(
    `select id, data::jsonb->'characters' as chars, data::jsonb->'sceneDescriptions' as scenes
       from stories
      where created_at > now() - ($1 || ' days')::interval
        and jsonb_typeof(data::jsonb->'characters') = 'array'
        and jsonb_typeof(data::jsonb->'sceneDescriptions') = 'array'`, [String(DAYS)]);
  let oldTotal = 0, newTotal = 0, ambTotal = 0, castLeak = 0, storiesWithAmb = 0;
  for (const r of rows) {
    const chars = r.chars.filter(c => c && c.name);
    const pages = r.scenes.map(s => ({ pageNumber: s.pageNumber, characterClothing: s.characterClothing || {} }));
    const { phantoms, ambiguous } = classifyUnknownNames(pages, { secondaryCharacters: [] }, chars);
    const castCanon = new Set();
    for (const c of chars) {
      castCanon.add(canonicalName(c.name));
      if (c.name.includes(',')) castCanon.add(canonicalName(c.name.replace(/,/g, ' ')));
    }
    const leaks = phantoms.filter(n => castCanon.has(canonicalName(n)));
    oldTotal += phantoms.length + ambiguous.length; newTotal += phantoms.length; ambTotal += ambiguous.length;
    castLeak += leaks.length;
    if (ambiguous.length) { storiesWithAmb++; console.log(`${r.id} ambiguous refused: ${JSON.stringify(ambiguous)}`); }
    if (leaks.length) console.log(`${r.id} CAST LEAK: ${JSON.stringify(leaks)}`);
  }
  console.log(`stories: ${rows.length}; names sent to patch OLD=${oldTotal} NEW=${newTotal}; ambiguous refused=${ambTotal} (stories ${storiesWithAmb}); cast names reaching the patch (NEW)=${castLeak}`);
  client.release(); await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
