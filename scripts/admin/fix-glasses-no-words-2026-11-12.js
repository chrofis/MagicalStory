#!/usr/bin/env node
/**
 * Data repair (bugs.json glasses-nein-read-as-glasses 2026-11-12, none-value-rules-disagree 2026-11-13):
 * stored physical.glasses / other / facialHair values that are a typed "no" word instead of the canonical
 * sentinel 'none'. Covers the `characters` table AND each story's own snapshot (`stories.data`, found by key:
 * characters[].physical, avatars.extractedTraits, every page's sceneCharacters).
 *
 * The no-word list lives in server/lib/traitNone.js (the one rule), consumed through scripts/lib/noWordTraits.js.
 * Production code never reads free text (docs/decisions.md 2026-11-12, 2026-11-13); this script repairs data
 * written before the character form became a yes/no switch.
 *
 * Default is DRY-RUN (read-only transaction, lists). --write needs the owner's approval: it backs up every changed
 * row to tasks/customer-*.json (gitignored: customer data) first, then updates. Uses DATABASE_URL (production)
 * unless --staging.
 *   node scripts/admin/fix-glasses-no-words-2026-11-12.js [--write] [--staging] [--no-stories]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { isNoWord, FIELDS, SENTINEL, NO_VALUES, findNoWordFields, replaceNoWordFields } = require('../lib/noWordTraits');

const write = process.argv.includes('--write');
const withStories = !process.argv.includes('--no-stories');
const url = process.argv.includes('--staging') ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
if (!url) throw new Error('database URL env var not set');

const esc = (w) => w.replace(/[-\^$*+?.()|[\]{}]/g, '\$&');
// jsonb::text renders `"key": "value"`; case-insensitive and padded values are matched in JS afterwards
const PRE_FILTER = `"(${FIELDS.join('|')})": *" *(${NO_VALUES.map(esc).join('|')}) *"`;

(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  if (!write) await client.query('SET default_transaction_read_only = on');

  const { rows } = await client.query('SELECT id, user_id, data, metadata, created_at FROM characters');
  const charChanges = [];
  for (const row of rows) {
    const chars = Array.isArray(row.data && row.data.characters) ? row.data.characters : [];
    const hits = [];
    chars.forEach((ch, i) => {
      for (const f of FIELDS) {
        const v = ch && ch.physical && ch.physical[f];
        if (isNoWord(v)) hits.push({ i, name: ch.name, field: f, from: v });
      }
    });
    if (hits.length) charChanges.push({ row, hits });
  }
  console.log(`${write ? 'WRITE' : 'DRY-RUN'} characters table: ${charChanges.length} row(s), ${charChanges.reduce((n, c) => n + c.hits.length, 0)} field(s)`);
  for (const c of charChanges) for (const h of c.hits) console.log(`  ${c.row.id} (user ${String(c.row.user_id).slice(0, 8)}) [${h.i}] ${h.name}: physical.${h.field} "${h.from}" -> "${SENTINEL}"`);

  const storyChanges = [];
  if (withStories) {
    const { rows: ids } = await client.query('SELECT id FROM stories WHERE data::text ~* $1', [PRE_FILTER]);
    for (const { id } of ids) {
      const { rows: [row] } = await client.query('SELECT id, user_id, data FROM stories WHERE id = $1', [id]);
      const hits = findNoWordFields(row.data);
      if (hits.length) storyChanges.push({ row, hits });
    }
    console.log(`${write ? 'WRITE' : 'DRY-RUN'} stories snapshots: ${storyChanges.length} story(ies), ${storyChanges.reduce((n, c) => n + c.hits.length, 0)} field(s)`);
    for (const c of storyChanges) {
      const byKey = {};
      for (const h of c.hits) byKey[`${h.key}="${h.from}"`] = (byKey[`${h.key}="${h.from}"`] || 0) + 1;
      console.log(`  ${c.row.id} (user ${String(c.row.user_id).slice(0, 8)}): ${JSON.stringify(byKey)}`);
    }
  }
  if (!write || (!charChanges.length && !storyChanges.length)) { client.release(); await pool.end(); return; }

  const dir = path.join(__dirname, '..', '..', 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `customer-glasses-no-words-before-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ characters: charChanges.map((c) => c.row), stories: storyChanges.map((c) => c.row) }, null, 2));
  console.log(`backup written: ${file}`);
  for (const c of charChanges) {
    const data = JSON.parse(JSON.stringify(c.row.data));
    for (const h of c.hits) data.characters[h.i].physical[h.field] = SENTINEL;
    await client.query('UPDATE characters SET data = $1 WHERE id = $2', [data, c.row.id]);
  }
  for (const c of storyChanges) {
    const data = JSON.parse(JSON.stringify(c.row.data));
    replaceNoWordFields(data);
    await client.query('UPDATE stories SET data = $1 WHERE id = $2', [data, c.row.id]);
  }
  console.log('updated.');
  client.release(); await pool.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
