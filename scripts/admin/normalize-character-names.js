#!/usr/bin/env node
/**
 * One-off cleanup of stored character names (docs/decisions.md 2026-11-13).
 *
 * Customers typed relationship text into the character name box ("Noah, Freund von Louis und Tobias",
 * trailing spaces, all caps). New saves are cleaned by server/lib/characterName.js; this applies the SAME
 * function to rows already stored: the name is trimmed / one-spaced / cut at the first comma, and the text
 * after the comma moves to traits.specialDetails (never lost). No second implementation.
 *
 * DRY RUN is the default: a read-only transaction that lists every row whose names would change
 * (user id, character id, old -> new, length of the moved text; the moved text itself is never printed, it is
 * customer text). `--write` backs the affected rows up to tasks/customer-names-before-normalize-<ts>.json
 * (tasks/* is gitignored) and then updates them in one transaction.
 *
 *   node scripts/admin/normalize-character-names.js                       # dry run against DATABASE_URL
 *   node scripts/admin/normalize-character-names.js --exclude-user=<id>   # also skip this user (repeatable)
 *   node scripts/admin/normalize-character-names.js --write
 *   --staging  uses STAGING_DATABASE_URL
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { splitCharacterName, appendSpecialDetails } = require('../../server/lib/characterName');

// The owner said this user's names must NOT be changed (2026-11-13). Always excluded; --exclude-user adds more.
const ALWAYS_EXCLUDED_USER_IDS = ['b472a64e-f9b8-41cf-b85a-92b4f9d57b0c'];

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const STAGING = argv.includes('--staging');
const excluded = new Set([
  ...ALWAYS_EXCLUDED_USER_IDS,
  ...argv.filter(a => a.startsWith('--exclude-user=')).map(a => a.slice('--exclude-user='.length)),
]);

/** The cleaned copy of one character, or null when nothing changes. Pure. */
function cleanedCharacter(c) {
  if (!c || typeof c.name !== 'string') return null;
  const { name, moved } = splitCharacterName(c.name);
  if (!name) return null; // a name that is only a comma tail is left for a human
  if (name === c.name && !moved) return null;
  const out = { ...c, name };
  if (moved) out.traits = { ...(c.traits || {}), specialDetails: appendSpecialDetails(c.traits?.specialDetails, moved) };
  // Sheets pre-generated for a trial are keyed by the name (routes/trial.js renames them the same way).
  if (c.preGeneratedStyledAvatars && c.preGeneratedStyledAvatars[c.name] !== undefined && c.name !== name) {
    const { [c.name]: carried, ...others } = c.preGeneratedStyledAvatars;
    out.preGeneratedStyledAvatars = { ...others, [name]: carried };
  }
  return { out, moved };
}

/** Apply cleanedCharacter over one list; returns { list, changes } where list is the new array. */
function cleanList(list) {
  const changes = [];
  const next = (Array.isArray(list) ? list : []).map(c => {
    const r = cleanedCharacter(c);
    if (!r) return c;
    changes.push({ id: c.id, from: c.name, to: r.out.name, movedLength: r.moved.length });
    return r.out;
  });
  return { list: next, changes };
}

const parse = v => (typeof v === 'string' ? JSON.parse(v) : v);

async function main() {
  const url = STAGING ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) throw new Error(`${STAGING ? 'STAGING_DATABASE_URL' : 'DATABASE_URL'} is not set`);
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!WRITE) await client.query('SET TRANSACTION READ ONLY');
    await client.query('SET default_transaction_read_only = ' + (WRITE ? 'off' : 'on'));
    const { rows } = await client.query(`SELECT id, user_id, data, metadata FROM characters ${WRITE ? 'FOR UPDATE' : ''}`);
    const affected = [];
    let chars = 0, rowsSeen = 0, skippedExcluded = 0, moved = 0;
    for (const row of rows) {
      rowsSeen++;
      const data = parse(row.data);
      const meta = parse(row.metadata);
      const dataRes = cleanList(data?.characters);
      const metaRes = cleanList(meta?.characters);
      if (!dataRes.changes.length && !metaRes.changes.length) continue;
      if (excluded.has(String(row.user_id))) { skippedExcluded += dataRes.changes.length; continue; }
      for (const ch of dataRes.changes) {
        chars++;
        if (ch.movedLength) moved++;
        console.log(`user ${row.user_id}  char ${ch.id}  ${JSON.stringify(ch.from)} -> ${JSON.stringify(ch.to)}  moved ${ch.movedLength} chars`);
      }
      // metadata is a name-bearing copy of the list; report names that only it holds
      for (const ch of metaRes.changes) if (!dataRes.changes.some(d => String(d.id) === String(ch.id))) {
        console.log(`user ${row.user_id}  char ${ch.id}  (metadata copy only) ${JSON.stringify(ch.from)} -> ${JSON.stringify(ch.to)}  moved ${ch.movedLength} chars`);
      }
      affected.push({ row, data, meta, dataRes, metaRes });
    }
    console.log(`\n${WRITE ? 'WRITE' : 'DRY RUN'}: ${rowsSeen} characters rows, ${affected.length} rows / ${chars} characters would change`
      + ` (${moved} with text moved to special details); ${skippedExcluded} characters skipped for excluded users: ${[...excluded].join(', ')}`);
    if (WRITE && affected.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(__dirname, '../../tasks', `customer-names-before-normalize-${stamp}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(affected.map(a => ({ id: a.row.id, user_id: a.row.user_id, data: a.data, metadata: a.meta })), null, 2));
      console.log(`backup written: ${file}`);
      for (const a of affected) {
        const data = a.data && a.dataRes.changes.length ? { ...a.data, characters: a.dataRes.list } : a.data;
        const meta = a.meta && a.metaRes.changes.length ? { ...a.meta, characters: a.metaRes.list } : a.meta;
        await client.query('UPDATE characters SET data = $1, metadata = $2 WHERE id = $3', [JSON.stringify(data), JSON.stringify(meta), a.row.id]);
      }
      console.log(`updated ${affected.length} rows`);
    }
    await client.query(WRITE ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main().catch(e => { console.error('ERR:', e.message); process.exit(1); });
module.exports = { cleanedCharacter, cleanList, ALWAYS_EXCLUDED_USER_IDS };
