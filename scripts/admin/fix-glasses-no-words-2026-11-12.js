#!/usr/bin/env node
/**
 * One-off data repair (2026-11-12, bug glasses-nein-read-as-glasses): stored characters whose
 * physical.glasses / physical.other is a typed "no" instead of the canonical sentinel 'none'.
 *
 * The list of no-words below is the ONLY place such a list is allowed. Production code never
 * reads free text (docs/decisions.md 2026-11-12); this script repairs data written before the
 * character form became a yes/no switch. The values are the distinct stored values found in
 * production (characters table, 2026-11-12) that mean "no": only 'nein' (3x glasses, 4x other
 * in characters; 'Brille', 'schwarze Brille', 'wears glasses' etc. mean YES and are left alone).
 *
 * Default is --dry-run (lists). --write backs up every changed row to backups/ first, then
 * updates `characters`. Uses DATABASE_URL (production) unless --staging.
 *   node scripts/admin/fix-glasses-no-words-2026-11-12.js [--write] [--staging]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const NO_VALUES = ['nein'];          // exact stored values meaning "no"
const FIELDS = ['glasses', 'other'];
const SENTINEL = 'none';

const write = process.argv.includes('--write');
const url = process.argv.includes('--staging') ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
if (!url) throw new Error('database URL env var not set');

(async () => {
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const { rows } = await pool.query('SELECT id, user_id, data, metadata, created_at FROM characters');
  const changes = [];
  for (const row of rows) {
    const chars = Array.isArray(row.data && row.data.characters) ? row.data.characters : [];
    const hits = [];
    chars.forEach((ch, i) => {
      for (const f of FIELDS) {
        const v = ch && ch.physical && ch.physical[f];
        if (typeof v === 'string' && NO_VALUES.includes(v)) hits.push({ i, name: ch.name, field: f, from: v });
      }
    });
    if (hits.length) changes.push({ row, hits });
  }
  console.log(`${write ? 'WRITE' : 'DRY-RUN'}: ${changes.length} row(s), ${changes.reduce((n, c) => n + c.hits.length, 0)} field(s)`);
  for (const c of changes) for (const h of c.hits) console.log(`  ${c.row.id} [${h.i}] ${h.name}: physical.${h.field} "${h.from}" -> "${SENTINEL}"`);
  if (!write || !changes.length) { await pool.end(); return; }

  const dir = path.join(__dirname, '..', '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'glasses-no-words-2026-11-12-characters-before.json');
  fs.writeFileSync(file, JSON.stringify(changes.map((c) => c.row), null, 2));
  console.log(`backup written: ${file}`);
  for (const c of changes) {
    const data = JSON.parse(JSON.stringify(c.row.data));
    for (const h of c.hits) data.characters[h.i].physical[h.field] = SENTINEL;
    await pool.query('UPDATE characters SET data = $1 WHERE id = $2', [data, c.row.id]);
  }
  console.log('updated.');
  await pool.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
