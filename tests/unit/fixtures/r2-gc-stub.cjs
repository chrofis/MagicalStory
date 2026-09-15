/**
 * Preload stub for the R2 cohort GC tools (tests/unit/r2-cohort-gc.test.ts).
 *
 * Replaces `@aws-sdk/client-s3`, `pg` and `dotenv` so the tools can be run as
 * real child processes without touching R2, the network or a database. Every
 * DeleteObjects call is appended to the file named by STUB_DELETE_LOG, so a test
 * can assert that a run deleted nothing.
 *
 * Usage:  node -r tests/unit/fixtures/r2-gc-stub.cjs scripts/admin/<tool>.js …
 */
'use strict';

const fs = require('fs');
const Module = require('module');
const origLoad = Module._load;

const HOST = 'https://images.magicalstory.ch/';
const now = Date.now();
const day = 86400000;

// One referenced (live) story cohort, one long-dead one, one too young to sweep,
// two character cohorts, the two protected prefixes and an unknown shape.
const OBJECTS = [
  { Key: 'stories/s1/page1.png', Size: 1000, LastModified: new Date(now - 400 * day) },
  { Key: 'stories/s1/debug/x.png', Size: 500, LastModified: new Date(now - 400 * day) },
  { Key: 'stories/s2/page1.png', Size: 2048, LastModified: new Date(now - 300 * day) },
  { Key: 'stories/s2/retry/a.png', Size: 4096, LastModified: new Date(now - 300 * day) },
  { Key: 'stories/s3/page1.png', Size: 77, LastModified: new Date(now - 3 * day) },
  { Key: 'characters/u1/c1/avatars/a.png', Size: 900, LastModified: new Date(now - 500 * day) },
  { Key: 'characters/u2/c9/photos/p.png', Size: 1234567, LastModified: new Date(now - 500 * day) },
  { Key: 'orders/o1/f.pdf', Size: 10, LastModified: new Date(now - 500 * day) },
  { Key: 'landmarks/l1/x.jpg', Size: 20, LastModified: new Date(now - 500 * day) },
  { Key: 'weird/thing.bin', Size: 30, LastModified: new Date(now - 500 * day) },
];

class ListObjectsV2Command { constructor(input) { this.input = input; } }
class DeleteObjectsCommand { constructor(input) { this.input = input; } }

function record(keys) {
  const log = process.env.STUB_DELETE_LOG;
  if (log) fs.appendFileSync(log, keys.join('\n') + '\n');
}

class S3Client {
  async send(cmd) {
    if (cmd instanceof ListObjectsV2Command) return { Contents: OBJECTS };
    if (cmd instanceof DeleteObjectsCommand) {
      record(cmd.input.Delete.Objects.map((o) => o.Key));
      return { Errors: [] };
    }
    throw new Error('STUB: unexpected command ' + cmd.constructor.name);
  }
}

// The staging database references a cohort production has never heard of —
// s2, which every production-only scan classifies as long-dead. That is the
// real shape of the 2026-09-13 loss: staging stories, production bucket.
const STAGING_URL = 'postgres://stub/staging';

class Pool {
  constructor(opts = {}) {
    this.staging = String(opts.connectionString || '') === STAGING_URL;
  }
  async query(sql) {
    if (/information_schema/.test(sql)) {
      return { rows: [{ table_name: 'characters' }, { table_name: 'story_images' }] };
    }
    if (this.staging) {
      if (/"story_images"/.test(sql)) return { rows: [{ s: HOST + 'stories/s2/page1.png' }] };
      return { rows: [{ s: null }] };
    }
    if (/FROM story_images WHERE image_url/.test(sql)) {
      return { rows: [{ image_url: HOST + 'stories/s1/page1.png' }] };
    }
    if (/"story_images"/.test(sql)) return { rows: [{ s: HOST + 'stories/s1/page1.png' }] };
    if (/"characters"/.test(sql)) return { rows: [{ s: `{"a":"${HOST}characters/u1/c1/avatars/a.png"}` }] };
    return { rows: [{ s: null }] };
  }
  async end() {}
}

Module._load = function (request) {
  if (request === '@aws-sdk/client-s3') return { S3Client, ListObjectsV2Command, DeleteObjectsCommand };
  if (request === 'pg') return { Pool };
  if (request === 'dotenv') return { config: () => {} };
  return origLoad.apply(this, arguments);
};

process.env.DATABASE_URL = 'postgres://stub/stub';
// Opt-in: only the two-database test sets it, so every other test keeps
// measuring the production-only scan.
if (process.env.STUB_WITH_STAGING === '1') process.env.STAGING_DATABASE_URL = STAGING_URL;
else delete process.env.STAGING_DATABASE_URL;
process.env.R2_BUCKET = 'stub-bucket';
process.env.R2_PUBLIC_URL = HOST;
process.env.R2_ACCOUNT_ID = 'stub-account';
process.env.R2_ACCESS_KEY_ID = 'stub';
process.env.R2_SECRET_ACCESS_KEY = 'stub';
