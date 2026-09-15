#!/usr/bin/env node
/**
 * List, mark and unmark EVIDENCE stories — the rows automatic cleanup skips.
 *
 * An exemption nobody can see is one redeploy from being useless, so this is
 * the human-facing side of server/lib/evidenceStories.js (migration 038):
 *
 *   node scripts/admin/evidence-stories.js list
 *   node scripts/admin/evidence-stories.js mark <storyId> "what it proves"
 *   node scripts/admin/evidence-stories.js unmark <storyId>
 *
 * Defaults to staging (--prod for production). `mark`/`unmark` write to the
 * database; `list` is read-only.
 */
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const {
  listEvidenceStories, markEvidenceStory, unmarkEvidenceStory,
} = require('../../server/lib/evidenceStories');
const { ch } = require('../lib/chTime');

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--prod');
  const prod = process.argv.includes('--prod');
  const conn = prod ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;
  if (!conn) throw new Error(`no connection string for ${prod ? 'production' : 'staging'}`);

  const [cmd, storyId, ...reasonParts] = args;
  const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  try {
    if (!cmd || cmd === 'list') {
      const rows = await listEvidenceStories(pool);
      console.log(`=== ${prod ? 'PRODUCTION' : 'STAGING'} — ${rows.length} protected story(ies)\n`);
      for (const r of rows) {
        console.log(`${r.id}  (created ${ch(r.created_at)})`);
        console.log(`  marked ${r.evidence_marked_at ? ch(r.evidence_marked_at) : 'unknown'} — ${r.evidence_reason}\n`);
      }
      if (!rows.length) console.log('(nothing protected — cleanup will treat every story as disposable)');
      return;
    }
    if (cmd === 'mark') {
      const ok = await markEvidenceStory(pool, storyId, reasonParts.join(' '));
      console.log(ok ? `✓ ${storyId} marked as evidence` : `✗ no story ${storyId} in this database`);
      return;
    }
    if (cmd === 'unmark') {
      const ok = await unmarkEvidenceStory(pool, storyId);
      console.log(ok ? `✓ ${storyId} released to normal cleanup` : `✗ ${storyId} was not marked`);
      return;
    }
    throw new Error(`unknown command "${cmd}" — use list | mark | unmark`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exit(1); });
