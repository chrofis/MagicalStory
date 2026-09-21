/**
 * Database housekeeping, run by the app itself inside Railway.
 *
 * WHY IT LIVES HERE AND NOT IN A CLOUD ROUTINE. The same two jobs (daily
 * housekeeping, weekly reclaim) existed as Anthropic-cloud routines from
 * 2026-09-01 and never ran once: they needed DATABASE_URL / STAGING_DATABASE_URL
 * inside a third-party sandbox, and production database credentials are not
 * going there. The clean resolution is that every Railway service ALREADY has
 * DATABASE_URL for its own database — staging's web container maintains
 * staging's DB, production's maintains production's. No cross-environment
 * credentials, no new secret stored anywhere.
 *
 * WHAT GOES WRONG WITHOUT IT (measured on staging, 2026-09-06):
 *   - `characters` held 9 rows with base64 images inside JSONB. The
 *     no-images-in-JSONB rule is enforced on the STORY save path only, so
 *     character write paths keep re-introducing them.
 *   - `characters` was 259 MB for 41 MB of live data — 84% dead — and the
 *     database 676 MB. After moving the images to R2 and VACUUM FULL: 422 MB.
 *   - The container still read 1,093 MB until Postgres was restarted, then
 *     695 MB. Railway bills cgroup memory, which counts the OS page cache, and
 *     page cache is only evicted under memory pressure or a teardown. Shrinking
 *     the database lowers the ceiling; the restart is what returns the memory.
 *
 * The bloat-report and image-offload logic used to live in
 * scripts/admin/db-housekeeping.js and scripts/admin/migrate-inline-images-to-r2.js.
 * Both now require this module, so there is exactly one implementation.
 */
'use strict';

const crypto = require('crypto');
const r2 = require('./r2');

const TABLES = ['characters', 'stories'];
const TZ = 'Europe/Zurich';
const DAILY_AFTER_MINUTES = 3 * 60 + 30; // 03:30 CH
// Tuesday, not Sunday (owner, 2026-09-06). Saturday and Sunday are the busiest
// days — families make stories at the weekend, and Sunday is the modal day even
// in the small production sample (4 of 9 jobs). A reclaim takes an ACCESS
// EXCLUSIVE lock and then drops every database connection, so it belongs as far
// from the weekend as possible in both directions. 03:30 CH holds: no story job
// has ever been created between 01:00 and 07:00 Swiss local.
const RECLAIM_WEEKDAY = 2; // Tuesday

const MB = (n) => Number(n) / 1024 / 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling — pure, so it is testable without a clock or a database.
// ─────────────────────────────────────────────────────────────────────────────

const zurichFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short',
});

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Swiss-local calendar date, minutes-since-midnight and weekday for an instant. */
function zurichParts(instant) {
  const p = {};
  for (const { type, value } of zurichFmt.formatToParts(instant)) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
    weekday: WEEKDAY_INDEX[p.weekday],
  };
}

/**
 * Is a job due? Both jobs run at most once per Swiss calendar DAY, at/after
 * 03:30 CH; the weekly one additionally only on Sunday. The last-run marker is
 * a full ISO timestamp (not a date string) so it stays unambiguous no matter
 * which timezone reads it — the comparison rehomes it to Zurich here.
 *
 * Pure by design: server time, DST and the Zurich/UTC offset are the whole
 * risk surface of a scheduler like this, and this is where they are tested.
 */
function shouldRun(nowUtc, lastRunIso, { weekday } = {}) {
  const now = zurichParts(nowUtc instanceof Date ? nowUtc : new Date(nowUtc));
  if (weekday !== undefined && now.weekday !== weekday) return false;
  if (now.minutes < DAILY_AFTER_MINUTES) return false;
  if (!lastRunIso) return true;
  const last = new Date(lastRunIso);
  if (isNaN(last)) return true; // an unreadable marker must not wedge the job forever
  return zurichParts(last).date !== now.date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline-image offload (shared with scripts/admin/migrate-inline-images-to-r2.js)
// ─────────────────────────────────────────────────────────────────────────────

const looksLikeBytes = (s) =>
  typeof s === 'string'
  && (s.startsWith('data:image/') || s.startsWith('/9j/') || s.startsWith('iVBORw0')
      || s.startsWith('R0lGOD') || s.startsWith('UklGR'))
  && s.length > 1024;

const safe = (v) => String(v).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);

// -----------------------------------------------------------------------------
// The standing guard for the IRON RULE: no image bytes in JSONB, R2 only.
//
// offloadInlineImages() below only cleans `characters.data` and `stories.data`
// - the two columns it was built for. This sweep asks the question the rule
// actually states, of EVERY json/jsonb column in the schema, discovered from
// information_schema so a column added tomorrow is covered tomorrow. It is
// read-only: it reports, it never writes, and the daily routine logs an error
// when it finds anything, so a new leak is loud the next morning rather than
// whenever someone thinks to look.
// -----------------------------------------------------------------------------

// `story_job_checkpoints.step_data` carries page/cover base64 on purpose for
// these two steps: they ARE the progressive-display payload the status poll
// streams to the wizard before the story row exists, and they die with the job.
const TRANSIENT_CHECKPOINT_STEPS = new Set(['partial_page', 'partial_cover']);

// Postgres caps a POSIX repetition count at 255, so "a long unbroken base64
// run" is spelled as four chained quantifiers (~1000 chars). The prefilter is
// deliberately looser than looksLikeBytes: it only decides which rows are
// pulled into node, and the walker applies the real test.
const BASE64_RUN_SQL = '[A-Za-z0-9+/]{250}'.repeat(4);

/** Bytes with no recognisable header still count - a 1 KB base64 run is not prose. */
const looksLikeHeaderlessBytes = (s) =>
  typeof s === 'string' && s.length > 1024 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(s);

/** Walk a JSON value and list every inline-image string with its exact key path. */
function findInlineImages(node, keyPath = '$', out = [], seen = new WeakSet()) {
  if (typeof node === 'string') {
    const kind = looksLikeBytes(node) ? 'header'
      : looksLikeHeaderlessBytes(node) ? 'raw-base64' : null;
    if (kind) out.push({ keyPath, kind, bytes: Buffer.byteLength(node) });
    return out;
  }
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((v, i) => findInlineImages(v, `${keyPath}[${i}]`, out, seen));
    return out;
  }
  for (const k of Object.keys(node)) findInlineImages(node[k], `${keyPath}.${k}`, out, seen);
  return out;
}

/** `$.sceneImages[7].imageData` -> `$.sceneImages[].imageData`, so 40 page leaks read as one path. */
const collapsePath = (p) => p.replace(/\[\d+\]/g, '[]');

async function listJsonColumns(pool) {
  const { rows } = await pool.query(`
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      AND c.data_type IN ('json', 'jsonb')
    ORDER BY c.table_name, c.column_name`);
  return rows;
}

/**
 * Sweep every json/jsonb column for inline image bytes.
 *
 * Returns { columns, rowsScanned, violations[], transient }, where a violation is
 * { table, column, row, paths[{path,count,bytes}], bytes }. The declared
 * checkpoint exception is counted separately and never reported as a violation.
 */
async function sweepInlineImages(pool) {
  const columns = await listJsonColumns(pool);
  const violations = [];
  const transient = { rows: 0, bytes: 0 };
  let rowsScanned = 0;

  for (const { table_name: table, column_name: column } of columns) {
    const { rows: candidates } = await pool.query(`
      SELECT ctid::text AS ctid
      FROM "${table}"
      WHERE ${candidatePredicate(column)}`);
    rowsScanned += candidates.length;

    for (const { ctid } of candidates) {
      const { rows } = await pool.query(`SELECT "${column}" AS v FROM "${table}" WHERE ctid = $1::tid`, [ctid]);
      if (!rows.length) continue;
      const value = typeof rows[0].v === 'string' ? JSON.parse(rows[0].v) : rows[0].v;
      const found = findInlineImages(value);
      if (!found.length) continue;

      if (table === 'story_job_checkpoints' && column === 'step_data') {
        const step = (await pool.query('SELECT step_name FROM story_job_checkpoints WHERE ctid = $1::tid', [ctid])).rows[0]?.step_name;
        if (TRANSIENT_CHECKPOINT_STEPS.has(step)) {
          transient.rows++;
          transient.bytes += found.reduce((a, f) => a + f.bytes, 0);
          continue;
        }
      }

      let row = ctid;
      for (const idCol of ['id', 'job_id', 'story_id', 'user_id']) {
        try {
          const r = await pool.query(`SELECT "${idCol}"::text AS id FROM "${table}" WHERE ctid = $1::tid`, [ctid]);
          if (r.rows.length) { row = r.rows[0].id; break; }
        } catch { /* no such column on this table */ }
      }

      const byPath = new Map();
      for (const f of found) {
        const key = collapsePath(f.keyPath);
        const e = byPath.get(key) || { path: key, count: 0, bytes: 0 };
        e.count++; e.bytes += f.bytes;
        byPath.set(key, e);
      }
      violations.push({
        table, column, row,
        paths: [...byPath.values()].sort((a, b) => b.bytes - a.bytes),
        bytes: found.reduce((a, f) => a + f.bytes, 0),
      });
    }
  }
  return { columns: columns.length, rowsScanned, violations, transient };
}

/**
 * Queue every byte-string in the tree, keyed by its own JSON path.
 *
 * Content-addressed: the R2 key ends in the md5 of the DECODED bytes, so the
 * same image always lands on the same object. That is what makes the offload
 * idempotent (a second run finds the object already there and re-derives the
 * identical URL) and what lets a reused object be PROVEN identical rather than
 * assumed. The readable path segment stays in front of the hash so a key is
 * still traceable back to the field it came from.
 *
 * Both byte shapes are collected — headered (`data:`, `/9j/`, …) and a long
 * unbroken headerless base64 run — because the sweep flags both, and a value
 * the sweep calls a violation but the offload walks past is a row that can
 * never be cleaned.
 */
function collectInlineImageTasks(data, prefix) {
  const tasks = [];
  const seen = new WeakSet();
  const walk = (node, segs) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const isArray = Array.isArray(node);
    for (const k of Object.keys(node)) {
      const child = node[k];
      const jsonSeg = isArray ? `[${k}]` : `.${k}`;
      if (typeof child === 'string' && (looksLikeBytes(child) || looksLikeHeaderlessBytes(child))) {
        const buf = decodeInlineImage(child);
        if (!buf || !buf.length) continue;          // not decodable: not an image
        const hash = md5(buf);
        const key = `${prefix}/${[...segs.map(s => s.safe), safe(k)].join('-')}-${hash.slice(0, 12)}.jpg`;
        tasks.push({
          input: child,
          buf,
          hash,
          key,
          jsonPath: `$${[...segs.map(s => s.json), jsonSeg].join('')}`,
          pathSegs: [...segs.map(s => s.raw), k],
          apply: (url) => { node[k] = url; },
          bytes: child.length,
        });
      } else if (child && typeof child === 'object') {
        // segs carry the raw key (sibling lookup), a JSON-path fragment
        // (reporting) and a filesystem-safe slug (the R2 key).
        walk(child, [...segs, { raw: k, json: jsonSeg, safe: safe(k) }]);
      }
    }
  };
  walk(data, []);
  return tasks;
}

/** Decode an inline image string to its bytes. Returns null when it is not base64. */
function decodeInlineImage(s) {
  if (typeof s !== 'string') return null;
  const stripped = s.replace(/^data:image\/\w+;base64,/, '').replace(/\s+/g, '');
  try {
    const buf = Buffer.from(stripped, 'base64');
    return buf.length ? buf : null;
  } catch { return null; }
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

/** Follow a raw key path (as recorded by the collector) into a parsed JSON value. */
function valueAtPath(root, pathSegs) {
  let node = root;
  for (const seg of pathSegs) {
    if (node === null || typeof node !== 'object') return undefined;
    node = Array.isArray(node) ? node[Number(seg)] : node[seg];
  }
  return node;
}

/**
 * The columns that are allowed to be offloaded, and how to address a row in
 * each. `story_job_checkpoints.step_data` is deliberately absent: it is the
 * declared exception (progressive-display payload, dies with its job).
 *
 * `reuseColumn` names a SIBLING column on the same row that mirrors the JSON
 * shape. `characters.data` was cleaned by the 2026-09-01 migration while
 * `.metadata` was not, so for most of those rows the identical sheet is ALREADY
 * in R2 and its URL is sitting at the same JSON path in `data`. Reuse is only
 * taken when the bytes behind that URL hash-match the inline copy.
 */
const OFFLOADABLE_COLUMNS = [
  { table: 'characters', column: 'data', idColumn: 'id', ownerColumn: 'user_id' },
  { table: 'characters', column: 'metadata', idColumn: 'id', ownerColumn: 'user_id', reuseColumn: 'data' },
  { table: 'stories', column: 'data', idColumn: 'id', ownerColumn: 'user_id' },
  { table: 'story_jobs', column: 'input_data', idColumn: 'id', ownerColumn: 'user_id' },
  { table: 'story_jobs', column: 'result_data', idColumn: 'id', ownerColumn: 'user_id' },
  { table: 'users', column: 'trial_data', idColumn: 'id', ownerColumn: 'id' },
  { table: 'testlab_experiments', column: 'results', idColumn: 'id', ownerColumn: 'created_by' },
  { table: 'testlab_experiments', column: 'params', idColumn: 'id', ownerColumn: 'created_by' },
];

/** The row-candidate predicate, shared with the sweep so both see the same rows. */
const candidatePredicate = (column) => `
  "${column}" IS NOT NULL
  AND (strpos("${column}"::text, 'data:image/') > 0
    OR strpos("${column}"::text, '"/9j/') > 0
    OR strpos("${column}"::text, '"iVBORw0') > 0
    OR strpos("${column}"::text, '"R0lGOD') > 0
    OR strpos("${column}"::text, '"UklGR') > 0
    OR "${column}"::text ~ '${BASE64_RUN_SQL}')`;

/**
 * Move every inline image byte out of ONE json/jsonb column into R2.
 *
 * The one implementation. Every caller — the daily housekeeping routine, the
 * on-demand admin tool — goes through here, so there is no second uploader to
 * drift from this one.
 *
 * Guarantees, in the order they matter:
 *  - NOTHING IS EVER DELETED. A value is replaced by a URL only after the bytes
 *    behind that URL have been fetched back and hash-matched against the value
 *    being replaced. An unverifiable value fails its row.
 *  - All-or-nothing per row. A row whose uploads partly fail is left ALONE and
 *    counted in `skipped` — a half-migrated row is both still bloated AND
 *    internally inconsistent, which is strictly worse than not touching it.
 *  - Idempotent and resumable. Keys are content-addressed, so a second run
 *    re-derives the same key, finds the object, verifies it and writes the same
 *    URL; a crash mid-way leaves every row either fully old or fully new.
 *  - Concurrency-safe. The row is re-read inside the transaction and skipped if
 *    it changed while the uploads were in flight.
 *
 * @param {Pool}   pool
 * @param {Object} log
 * @param {Object} spec    one entry of OFFLOADABLE_COLUMNS
 * @param {Object} [opts]  { limit, dryRun, onRow }
 */
async function offloadJsonbColumn(pool, log, spec, { limit = null, dryRun = false, onRow = null } = {}) {
  const { table, column, idColumn = 'id', ownerColumn = null, reuseColumn = null } = spec;
  const out = { table, column, rows: 0, images: 0, reused: 0, bytes: 0, skipped: 0, candidates: 0, details: [] };
  if (!dryRun && !r2.isConfigured()) {
    log.warn(`[db-housekeeping] R2 not configured — cannot offload ${table}.${column}`);
    return out;
  }

  const { rows: candidates } = await pool.query(`
    SELECT "${idColumn}"::text AS id
    FROM "${table}"
    WHERE ${candidatePredicate(column)}
    ORDER BY pg_column_size("${column}") DESC${limit ? ` LIMIT ${limit}` : ''}`);
  out.candidates = candidates.length;

  for (const { id } of candidates) {
    // `::text`, not the parsed value: the walker MUTATES the parsed tree in
    // place, so a parsed snapshot would silently become the post-offload state
    // and the concurrency check below would compare the row against itself.
    // Postgres renders jsonb deterministically, so the stored text is an exact,
    // stable fingerprint of what was read.
    const sel = await pool.query(
      `SELECT "${column}"::text AS v${ownerColumn ? `, "${ownerColumn}"::text AS owner` : ''}`
      + `${reuseColumn ? `, "${reuseColumn}"::text AS reuse` : ''} FROM "${table}" WHERE "${idColumn}"::text = $1`, [id]);
    if (!sel.rows.length) continue;
    const beforeText = sel.rows[0].v;
    const value = beforeText ? JSON.parse(beforeText) : null;
    if (!value || typeof value !== 'object') continue;
    const reuseTree = reuseColumn && sel.rows[0].reuse ? JSON.parse(sel.rows[0].reuse) : null;
    const owner = sel.rows[0].owner || 'unknown';

    const prefix = `jsonb-offload/${table}/${safe(column)}/${safe(owner)}/${safe(id)}`;
    const tasks = collectInlineImageTasks(value, prefix);
    if (!tasks.length) continue;

    const rowDetail = {
      row: id, table, column,
      images: tasks.length,
      bytes: tasks.reduce((a, t) => a + t.bytes, 0),
      paths: tasks.map(t => ({ path: collapsePath(t.jsonPath), key: t.key, bytes: t.bytes })),
    };
    if (dryRun) {
      out.rows++; out.images += tasks.length; out.bytes += rowDetail.bytes;
      out.details.push({ ...rowDetail, action: 'would-offload' });
      if (onRow) await onRow({ ...rowDetail, value, action: 'would-offload' });
      continue;
    }
    if (onRow) await onRow({ ...rowDetail, value, action: 'about-to-offload' });

    const failures = [];
    const uploaded = [];
    let reusedHere = 0;
    const PARALLEL = 8;
    let next = 0;
    await Promise.all(new Array(Math.min(PARALLEL, tasks.length)).fill(null).map(async () => {
      while (true) {
        const i = next++;
        if (i >= tasks.length) return;
        const t = tasks[i];
        try {
          const resolved = await resolveTaskUrl(t, reuseTree);
          t.apply(resolved.url);
          if (resolved.reused) reusedHere++; else uploaded.push(t.key);
        } catch (err) {
          failures.push(`${t.key}: ${err.message}`);
        }
      }
    }));

    if (failures.length) {
      // The row keeps its inline bytes, so the uploads that DID succeed are
      // referenced by nothing. Record them for reclamation instead of leaving
      // them in the bucket unreachable. Safe because the row still holds the
      // inline bytes: a later pass re-uploads the same deterministic keys.
      // That is also why the pending retry runs BEFORE this offload in
      // runDailyHousekeeping — reversing the order would delete an object the
      // same run had just re-uploaded and referenced.
      log.warn(`[db-housekeeping] ${table}.${column}/${id}: ${failures.length}/${tasks.length} `
        + `image(s) could not be verified in R2 — row left unchanged (${failures[0]})`);
      try {
        const r2Pending = require('./r2Pending');
        for (const key of uploaded) {
          await r2Pending.recordPending('object', key, `partial JSONB offload of ${table}.${column}/${id}`);
        }
      } catch (err) {
        log.warn(`[db-housekeeping] could not record ${uploaded.length} unreferenced upload(s): ${err.message}`);
      }
      out.skipped++;
      out.details.push({ ...rowDetail, action: 'skipped', reason: failures[0] });
      continue;
    }

    const wrote = await writeIfUnchanged(pool, { table, column, idColumn, id, beforeText, after: value });
    if (!wrote) {
      log.warn(`[db-housekeeping] ${table}.${column}/${id}: row changed under us — left unchanged`);
      out.skipped++;
      out.details.push({ ...rowDetail, action: 'skipped', reason: 'row changed during upload' });
      continue;
    }
    out.rows++;
    out.images += tasks.length;
    out.reused += reusedHere;
    out.bytes += rowDetail.bytes;
    out.details.push({ ...rowDetail, action: 'offloaded', reused: reusedHere });
    log.info(`[db-housekeeping] ${table}.${column}/${id}: ${tasks.length} image(s) `
      + `(${reusedHere} reused) → R2, ${MB(rowDetail.bytes).toFixed(2)} MB out of JSONB`);
  }
  return out;
}

/**
 * Resolve one inline value to a URL whose bytes are PROVEN to be the same.
 *
 * Three routes, cheapest first, and all three end in the same proof:
 *   1. the sibling column already holds a URL at this exact JSON path,
 *   2. the content-addressed object already exists (a previous run, or another
 *      row carrying the identical image),
 *   3. upload it.
 * In every case the bytes are fetched back over HTTP and hash-compared before
 * the caller is allowed to drop the inline copy.
 */
async function resolveTaskUrl(task, reuseTree) {
  if (reuseTree) {
    const sibling = valueAtPath(reuseTree, task.pathSegs);
    if (typeof sibling === 'string' && /^https?:\/\//i.test(sibling)) {
      if (await urlMatches(sibling, task.hash)) return { url: sibling, reused: true };
    }
  }
  const existingUrl = r2.publicUrlForKey(task.key);
  if (existingUrl && await r2.objectExists(task.key)) {
    if (await urlMatches(existingUrl, task.hash)) return { url: existingUrl, reused: true };
  }
  const url = await r2.uploadImage(task.buf, task.key);
  if (!url) throw new Error('upload returned no URL');
  if (!await urlMatches(url, task.hash)) {
    throw new Error('uploaded object did not read back with the same bytes');
  }
  return { url, reused: false };
}

/** True when the object at `url` is byte-identical to the hash we are replacing. */
async function urlMatches(url, hash) {
  const buf = await r2.fetchImageBytes(url, { retries: 2, timeoutMs: 30000 });
  return !!buf && buf.length > 0 && md5(buf) === hash;
}

/**
 * Write the cleaned value back, but only if nothing else touched the row while
 * the uploads were in flight. The comparison is on the stored text itself, so
 * it needs no version column and cannot be fooled by an equal-looking update.
 */
async function writeIfUnchanged(pool, { table, column, idColumn, id, beforeText, after }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT "${column}"::text AS t FROM "${table}" WHERE "${idColumn}"::text = $1 FOR UPDATE`, [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return false; }
    if (md5(Buffer.from(cur.rows[0].t)) !== md5(Buffer.from(beforeText))) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE "${table}" SET "${column}" = $2::jsonb WHERE "${idColumn}"::text = $1`,
      [id, JSON.stringify(after)]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The daily routine's offload: characters.data and stories.data, the two
 * columns it has always cleaned. Everything else is driven by
 * scripts/admin/offload-jsonb-images.js, against the same one implementation.
 */
async function offloadInlineImages(pool, log, { tables = TABLES, limit = null } = {}) {
  const result = { rows: 0, images: 0, mb: 0, skipped: 0, byTable: {} };
  if (!r2.isConfigured()) {
    log.warn('[db-housekeeping] R2 not configured — cannot offload inline images; skipping');
    return result;
  }
  for (const table of tables) {
    const spec = OFFLOADABLE_COLUMNS.find(s => s.table === table && s.column === 'data');
    if (!spec) continue;
    const r = await offloadJsonbColumn(pool, log, spec, { limit });
    result.byTable[table] = r.candidates;
    result.rows += r.rows;
    result.images += r.images;
    result.mb += MB(r.bytes);
    result.skipped += r.skipped;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vacuum + reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VACUUM (ANALYZE) — takes no exclusive lock, safe on a live database.
 *
 * The ANALYZE half is the load-bearing part: autovacuum was not blocked here,
 * it was BLIND. pg_stat_user_tables reported `stories` as live=2 with
 * last_analyze NEVER for a ~174-row table of GB-scale blobs, so autovacuum's
 * threshold (50 + 0.2 × 2) was never crossed and the dead TOAST chunks piled up.
 */
async function vacuumAnalyze(pool, log, { tables = TABLES } = {}) {
  const out = [];
  for (const t of tables) {
    const t0 = Date.now();
    await pool.query(`VACUUM (ANALYZE) ${t}`);
    const seconds = (Date.now() - t0) / 1000;
    out.push({ table: t, seconds });
    log.info(`[db-housekeeping] VACUUM ANALYZE ${t}: ${seconds.toFixed(1)}s`);
  }
  return out;
}

async function databaseSize(pool) {
  const r = await pool.query(`SELECT pg_size_pretty(pg_database_size(current_database())) s,
                                     pg_database_size(current_database()) b`);
  return { pretty: r.rows[0].s, bytes: Number(r.rows[0].b) };
}

/** Per-table total vs live size, plus the TOAST relations that are majority dead. */
async function bloatReport(pool) {
  const largest = (await pool.query(`
    SELECT c.relname,
           pg_total_relation_size(c.oid) total,
           COALESCE(pg_total_relation_size(t.oid), 0) toast,
           s.n_live_tup, s.n_dead_tup
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
      LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 5`)).rows;

  const tables = [];
  for (const b of largest) {
    const live = await pool.query(`SELECT COALESCE(SUM(pg_column_size(t.*)),0) b FROM ${b.relname} t`);
    const totalMB = MB(b.total);
    const liveMB = MB(live.rows[0].b);
    tables.push({
      table: b.relname,
      totalMB,
      liveMB,
      reclaimablePct: totalMB > 1 ? Math.max(0, 100 * (1 - liveMB / totalMB)) : 0,
    });
  }

  const toast = (await pool.query(`
    SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_all_tables
     WHERE schemaname='pg_toast' AND n_dead_tup > n_live_tup AND n_dead_tup > 100
     ORDER BY n_dead_tup DESC LIMIT 5`)).rows;

  return { tables, toast, database: await databaseSize(pool) };
}

function logBloatReport(report, log) {
  log.info(`[db-housekeeping] database ${report.database.pretty}`);
  for (const t of report.tables) {
    log.info(`[db-housekeeping]   ${t.table}: ${t.totalMB.toFixed(0)} MB total, ` +
             `~${t.liveMB.toFixed(0)} MB live → ~${t.reclaimablePct.toFixed(0)}% reclaimable`);
  }
  for (const t of report.toast) {
    log.info(`[db-housekeeping]   TOAST ${t.relname}: ${t.n_dead_tup} dead vs ${t.n_live_tup} live`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Railway control plane
// ─────────────────────────────────────────────────────────────────────────────

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

/**
 * Railway has two token families and they use DIFFERENT headers:
 *
 *   account / workspace tokens -> Authorization: Bearer
 *   PROJECT tokens             -> Project-Access-Token
 *
 * Both environments here hold a PROJECT token — verified against the live API
 * on 2026-09-06: production's authenticates only as Project-Access-Token, and
 * `Bearer` is rejected. Sending Bearer meant the reclaim would run its VACUUM
 * FULL and then fail the restart, freeing disk but never the memory that is the
 * entire point of the job — and it would have failed QUIETLY, because
 * restartOwnPostgres swallows its errors by design.
 *
 * Project tokens are UUIDs, so the shape picks the header; if that is rejected
 * we retry with the other one, so a future token format cannot silently break
 * this again.
 */
function railwayHeaders(token, useProjectHeader) {
  return useProjectHeader
    ? { 'Content-Type': 'application/json', 'Project-Access-Token': token }
    : { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

const LOOKS_LIKE_PROJECT_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function railwayGql(query, variables, token) {
  const preferProject = LOOKS_LIKE_PROJECT_TOKEN.test(token || '');
  let lastErr;
  for (const useProjectHeader of [preferProject, !preferProject]) {
    const res = await fetch(RAILWAY_API, {
      method: 'POST',
      headers: railwayHeaders(token, useProjectHeader),
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.errors) return body.data;
    lastErr = body.errors.map(e => e.message).join('; ').slice(0, 300);
    // Only an auth rejection is worth retrying with the other header; a real
    // query error would just fail twice and muddy the log.
    if (!/not authorized|unauthorized|authentication/i.test(lastErr)) break;
  }
  throw new Error(lastErr || 'Railway API call failed');
}

/**
 * Restart THIS environment's Postgres so the page cache is actually returned.
 *
 * VACUUM FULL returns the space to the OS but the container keeps reading at the
 * old high-water mark — cgroup memory counts page cache, and nothing ever asks
 * the kernel to reclaim it (memory.high, the correct lever, is not exposed by
 * Railway; its replica limits set memory.max, which OOM-kills instead).
 *
 * The service id is DISCOVERED from the injected RAILWAY_PROJECT_ID /
 * RAILWAY_ENVIRONMENT_ID rather than hardcoded, so this stays correct if a
 * database is ever recreated. Never throws: a missing token means the reclaim
 * still freed disk, which is the valuable half.
 */
async function restartOwnPostgres(log) {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  if (!token || !projectId || !environmentId) {
    log.warn('[db-housekeeping] RAILWAY_API_TOKEN / project / environment id missing — ' +
             'disk space was reclaimed, but the container\'s memory will NOT drop until ' +
             'someone restarts Postgres (scripts/admin/railway-restart-service.js)');
    return { restarted: false, reason: 'no-credentials' };
  }

  try {
    const proj = await railwayGql(
      `query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }`,
      { id: projectId }, token);
    const svc = (proj?.project?.services?.edges || [])
      .map(e => e.node)
      .find(n => /postgres/i.test(n.name || ''));
    if (!svc) {
      log.warn('[db-housekeeping] no service matching /postgres/i in this project — not restarting');
      return { restarted: false, reason: 'service-not-found' };
    }

    const deps = await railwayGql(
      `query($p:String!,$e:String!,$s:String!){
         deployments(first:1, input:{projectId:$p, environmentId:$e, serviceId:$s}){
           edges{ node{ id status } } } }`,
      { p: projectId, e: environmentId, s: svc.id }, token);
    const dep = deps?.deployments?.edges?.[0]?.node;
    if (!dep) {
      log.warn(`[db-housekeeping] no deployment for service ${svc.name} — not restarting`);
      return { restarted: false, reason: 'deployment-not-found' };
    }

    await railwayGql(`mutation($id:String!){ deploymentRestart(id:$id) }`, { id: dep.id }, token);
    log.info(`[db-housekeeping] restarted ${svc.name} (deployment ${dep.id.slice(0, 8)}) — ` +
             'page cache returns as the container is torn down');
    return { restarted: true, service: svc.name, deploymentId: dep.id };
  } catch (err) {
    log.warn(`[db-housekeeping] Postgres restart failed: ${err.message} — disk was still reclaimed`);
    return { restarted: false, reason: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The two jobs
// ─────────────────────────────────────────────────────────────────────────────

/** Daily: offload stray inline images, un-blind autovacuum, report bloat. */
async function runDailyHousekeeping({ pool, log }) {
  const before = await databaseSize(pool);
  log.info(`[db-housekeeping] daily start — database ${before.pretty}`);

  // Retry every R2 prune that failed after its owning row was already gone.
  // Without this the keys in r2_pending_deletions would just be a nicer record
  // of an orphan; with it they are recoverable (server/lib/r2Pending.js).
  // Runs BEFORE the offload on purpose — see the note in offloadInlineImages.
  let pendingR2 = { tried: 0, settled: 0, stillFailing: 0 };
  try {
    pendingR2 = await require('./r2Pending').retryPending();
    if (pendingR2.stillFailing > 0) {
      log.warn(`[db-housekeeping] ${pendingR2.stillFailing} R2 deletion(s) still failing after retry — ` +
               `see r2_pending_deletions (deleted_at IS NULL)`);
    }
  } catch (err) {
    log.warn(`[db-housekeeping] pending R2 deletion retry failed: ${err.message}`);
  }

  const offload = await offloadInlineImages(pool, log);
  if (offload.rows > 0 || offload.skipped > 0) {
    // Not routine noise. Rows only get here because a write path stored image
    // bytes in JSONB instead of an R2 URL — the offload cleaned up after a bug.
    const where = Object.entries(offload.byTable)
      .filter(([, n]) => n > 0).map(([t, n]) => `${t}: ${n} row(s)`).join(', ');
    log.warn(`[db-housekeeping] BUG: inline images found in JSONB (${where}) — ` +
             `a write path is bypassing the R2 offload. Moved ${offload.images} image(s), ` +
             `${offload.mb.toFixed(1)} MB, from ${offload.rows} row(s); ${offload.skipped} row(s) skipped`);
  }

  // The standing guard. offloadInlineImages only reaches characters.data and
  // stories.data; this asks the whole schema, so a leak in a column nobody
  // thought about (characters.metadata, story_jobs.input_data and
  // users.trial_data all held megabytes on 2026-09-21) is loud the next morning.
  let inlineSweep = null;
  try {
    inlineSweep = await sweepInlineImages(pool);
    if (inlineSweep.violations.length) {
      const byColumn = new Map();
      for (const v of inlineSweep.violations) {
        const k = `${v.table}.${v.column}`;
        const e = byColumn.get(k) || { rows: 0, bytes: 0, paths: new Set() };
        e.rows++; e.bytes += v.bytes;
        for (const p of v.paths) e.paths.add(p.path);
        byColumn.set(k, e);
      }
      for (const [col, e] of byColumn) {
        log.error(`[db-housekeeping] IRON RULE BROKEN: ${col} - ${e.rows} row(s), ` +
                  `${MB(e.bytes).toFixed(1)} MB of image bytes in JSONB at ` +
                  `${[...e.paths].slice(0, 8).join(', ')}. R2 is the only byte store.`);
      }
    } else {
      log.info(`[db-housekeeping] inline-image sweep clean across ${inlineSweep.columns} json/jsonb column(s)`);
    }
  } catch (err) {
    log.warn(`[db-housekeeping] inline-image sweep failed: ${err.message}`);
  }

  await vacuumAnalyze(pool, log);

  const report = await bloatReport(pool);
  logBloatReport(report, log);
  return { offload, report, pendingR2, inlineSweep };
}

/**
 * Weekly: return the space to the OS, then to Railway's memory bill.
 *
 * VACUUM FULL takes an ACCESS EXCLUSIVE lock — no reads, no writes, for minutes
 * on a GB-scale table — so a story generating at that moment dies. The busy
 * check narrows that window; it does not close it (a generation can still start
 * in the seconds before the lock lands — accepted trade-off, owner 2026-09-01).
 * A busy environment simply skipping is CORRECT behaviour, not a failure.
 */
async function runWeeklyReclaim({ pool, log }) {
  const { busyReport } = require('./idleShutdown');

  const busy = await busyReport();
  if (busy.busy) {
    log.info(`[db-housekeeping] reclaim skipped — work in flight (${busy.reasons.join('; ')})`);
    return { skipped: 'busy', reasons: busy.reasons };
  }

  const before = await databaseSize(pool);
  log.info(`[db-housekeeping] reclaim — database ${before.pretty}, locking tables`);

  const locked = [];
  for (const t of TABLES) {
    const t0 = Date.now();
    await pool.query(`VACUUM (FULL, ANALYZE) ${t}`);
    const seconds = (Date.now() - t0) / 1000;
    locked.push({ table: t, seconds });
    log.info(`[db-housekeeping] VACUUM FULL ${t}: ${seconds.toFixed(0)}s locked`);
  }

  const after = await databaseSize(pool);
  log.info(`[db-housekeeping] database ${before.pretty} → ${after.pretty}`);

  // Re-check: the reclaim itself takes minutes, and a generation may have
  // started behind it. A restart drops every connection and would kill it.
  const stillIdle = await busyReport();
  if (stillIdle.busy) {
    log.info(`[db-housekeeping] not restarting Postgres — work started during the reclaim ` +
             `(${stillIdle.reasons.join('; ')}); memory stays at the old high-water mark until a restart`);
    return { before, after, locked, restart: { restarted: false, reason: 'busy' } };
  }

  const restart = await restartOwnPostgres(log);
  return { before, after, locked, restart };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────

const KEY_DAILY = 'db_housekeeping_last_daily';
const KEY_WEEKLY = 'db_housekeeping_last_weekly';
const TICK_MS = 5 * 60 * 1000;

async function readMarker(pool, key) {
  const r = await pool.query('SELECT config_value FROM config WHERE config_key = $1', [key]);
  return r.rows[0]?.config_value || null;
}

async function writeMarker(pool, key, iso) {
  await pool.query(
    `INSERT INTO config (config_key, config_value) VALUES ($1, $2)
     ON CONFLICT (config_key) DO UPDATE SET config_value = $2`,
    [key, iso]
  );
}

/**
 * Tick every 5 minutes and run whatever is due. The last-run markers live in
 * the `config` table (not in memory) so a redeploy — of which there are many —
 * cannot replay a job that already ran today.
 *
 * Every run is wrapped: housekeeping is maintenance, and must never be the
 * reason the server goes down.
 */
function startDbHousekeeping({ pool, log }) {
  const { ch } = require('../../scripts/lib/chTime');

  // Production reclaims on Sundays; STAGING reclaims DAILY (owner, 2026-09-06).
  // Staging churns test data far faster than prod — one day of Test Lab runs and
  // showcase stories produced 84% dead space in `characters` — and it has no
  // paying users, so the ACCESS EXCLUSIVE lock and the Postgres restart cost
  // nothing there. Anything that is not explicitly staging keeps the weekly
  // cadence, so an unknown environment errs toward the safer schedule.
  const isStaging = process.env.RAILWAY_ENVIRONMENT_NAME === 'staging';
  const reclaimOpts = isStaging ? {} : { weekday: RECLAIM_WEEKDAY };
  const reclaimCadence = isStaging ? 'daily' : 'Tuesdays';

  const tick = async () => {
    try {
      const now = new Date();

      const lastWeekly = await readMarker(pool, KEY_WEEKLY);
      if (shouldRun(now, lastWeekly, reclaimOpts)) {
        // Marker first: a crash mid-reclaim must not retry the lock every 5 min.
        await writeMarker(pool, KEY_WEEKLY, now.toISOString());
        log.info(`[db-housekeeping] reclaim (${reclaimCadence}) due at ${ch(now)}`);
        await runWeeklyReclaim({ pool, log });
        return; // the restart may drop our own connections; leave daily to the next tick
      }

      const lastDaily = await readMarker(pool, KEY_DAILY);
      if (shouldRun(now, lastDaily)) {
        await writeMarker(pool, KEY_DAILY, now.toISOString());
        log.info(`[db-housekeeping] daily housekeeping due at ${ch(now)}`);
        await runDailyHousekeeping({ pool, log });
      }
    } catch (err) {
      log.error(`[db-housekeeping] tick failed: ${err.message}`);
    }
  };

  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  log.info(`[db-housekeeping] armed — housekeeping daily 03:30 CH, reclaim ${reclaimCadence} 03:30 CH`);
  return timer;
}

module.exports = {
  startDbHousekeeping,
  runDailyHousekeeping,
  runWeeklyReclaim,
  offloadInlineImages,
  offloadJsonbColumn,
  OFFLOADABLE_COLUMNS,
  candidatePredicate,
  decodeInlineImage,
  vacuumAnalyze,
  bloatReport,
  logBloatReport,
  restartOwnPostgres,
  shouldRun,
  collectInlineImageTasks,
  looksLikeBytes,
  looksLikeHeaderlessBytes,
  findInlineImages,
  collapsePath,
  sweepInlineImages,
  TRANSIENT_CHECKPOINT_STEPS,
  databaseSize,
  TABLES,
};
