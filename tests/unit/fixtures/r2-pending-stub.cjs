/**
 * Preload stub for tests/unit/r2-scripts-use-pending-ledger.test.ts.
 *
 * Replaces `pg`, `dotenv` and `server/lib/r2Pending` so
 * scripts/admin/cleanup-orphaned-data.js can be run as a real child process
 * with --apply and nothing touches a database or R2. Every r2Pending call is
 * appended to STUB_PRUNE_LOG as "<fn> <arg0> <arg1>"; a raw `server/lib/r2`
 * require is refused outright so a script that bypasses the ledger cannot
 * even load.
 *
 * Usage:  node -r tests/unit/fixtures/r2-pending-stub.cjs scripts/admin/cleanup-orphaned-data.js --apply
 */
'use strict';

const fs = require('fs');
const Module = require('module');
const origLoad = Module._load;

function record(fn, args) {
  const log = process.env.STUB_PRUNE_LOG;
  if (log) fs.appendFileSync(log, `${fn} ${args.join(' ')}\n`);
}

const ORPHAN_STORY_IDS = ['job_orphan_1', 'job_orphan_2'];

class Pool {
  async connect() {
    return {
      async query(sql) {
        if (/COUNT\(\*\).*FROM characters/s.test(sql)) return { rows: [{ count: '0' }] };
        if (/COUNT\(\*\).*FROM stories/s.test(sql)) return { rows: [{ count: String(ORPHAN_STORY_IDS.length) }] };
        if (/DELETE FROM stories/.test(sql)) {
          return { rowCount: ORPHAN_STORY_IDS.length, rows: ORPHAN_STORY_IDS.map((id) => ({ id })) };
        }
        throw new Error('STUB: unexpected query ' + sql);
      },
      release() {},
    };
  }
  async end() {}
}

const r2Pending = new Proxy({}, {
  get(_t, fn) {
    return async (...args) => {
      record(String(fn), args);
      if (process.env.STUB_PRUNE_THROWS === '1') throw new Error('stub: ledger unreachable');
      return 3;
    };
  },
});

Module._load = function (request) {
  if (request === 'pg') return { Pool };
  if (request === 'dotenv') return { config: () => {} };
  if (/[\/]r2Pending(\.js)?$/.test(request)) return r2Pending;
  if (/[\/]r2(\.js)?$/.test(request)) throw new Error('STUB: raw server/lib/r2 required — the script bypasses the ledger');
  return origLoad.apply(this, arguments);
};

process.env.DATABASE_URL = 'postgres://stub/stub';
