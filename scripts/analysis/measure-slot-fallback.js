#!/usr/bin/env node
// Free (DB read): over stored staging Visual Bibles, how often does the name-noun slot guess
// (wornItems.deriveSlotFromName) decide a slot where the declared field (wornAs / type) does not?
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const { Pool } = require('pg');
const W = require('../../server/lib/wornItems');
(async () => {
  const pool = new Pool({ connectionString: process.env.STAGING_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const rows = (await pool.query("select id, data->'visualBible' as vb from stories where data ? 'visualBible' order by created_at desc limit 300")).rows;
  const sections = ['artifacts', 'clothing', 'animals', 'secondaryCharacters', 'locations', 'vehicles'];
  const c = { stories: 0, els: 0, typed: 0, wornAsKnown: 0, guessOnly: 0, guessAgreesTyped: 0, guessDisagreesTyped: 0, none: 0 }; const guessOnly = {}; const dis = [];
  for (const r of rows) {
    const vb = r.vb || {}; c.stories++;
    for (const s of sections) for (const e of (Array.isArray(vb[s]) ? vb[s] : [])) {
      c.els++;
      const link = W.parseWornAs(e.wornAs);
      const t = W.slotFromType(e.type);
      const g = W.deriveSlotFromName(e.label || e.name);
      if (link && link.slotKnown) { c.wornAsKnown++; continue; }
      if (t) { c.typed++; if (g) (g === t ? c.guessAgreesTyped++ : (c.guessDisagreesTyped++, dis.push(`${e.name} type=${e.type} typed=${t} guess=${g}`))); continue; }
      if (g) { c.guessOnly++; const k = `${s}|${e.type}|${e.name}`; guessOnly[k] = 1; continue; }
      c.none++;
    }
  }
  console.log(JSON.stringify(c)); console.log('GUESS-ONLY:\n' + Object.keys(guessOnly).slice(0, 60).join('\n')); console.log('DISAGREE:\n' + dis.slice(0, 20).join('\n'));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
