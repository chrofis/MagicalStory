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

/** Queue every byte-string in the tree, keyed by its own JSON path. */
function collect(data, prefix) {
  const tasks = [];
  const used = new Set();
  const seen = new WeakSet();
  const walk = (node, segs) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (typeof child === 'string' && looksLikeBytes(child)) {
        const base = `${prefix}/${[...segs, safe(k)].join('-')}`;
        let key = `${base}.jpg`;
        let n = 1;
        while (used.has(key)) key = `${base}__${n++}.jpg`;
        used.add(key);
        tasks.push({ input: child, key, apply: (url) => { node[k] = url; }, bytes: child.length });
      } else if (child && typeof child === 'object') {
        walk(child, [...segs, safe(k)]);
      }
    }
  };
  walk(data, []);
  return tasks;
}

/**
 * Move every inline image byte out of characters.data / stories.data into R2.
 *
 * All-or-nothing per row: a row whose uploads partly fail is left ALONE and
 * counted in `skipped`. A half-migrated row is both still bloated AND
 * internally inconsistent, which is strictly worse than not touching it.
 */
async function offloadInlineImages(pool, log, { tables = TABLES, limit = null } = {}) {
  const result = { rows: 0, images: 0, mb: 0, skipped: 0, byTable: {} };
  if (!r2.isConfigured()) {
    log.warn('[db-housekeeping] R2 not configured — cannot offload inline images; skipping');
    return result;
  }

  for (const table of tables) {
    const rows = (await pool.query(
      `SELECT id, user_id AS owner, data FROM ${table}
        WHERE data::text LIKE '%data:image%'
        ORDER BY pg_column_size(data) DESC${limit ? ` LIMIT ${limit}` : ''}`)).rows;
    result.byTable[table] = rows.length;
    if (!rows.length) continue;

    for (const row of rows) {
      const prefix = `${table}/${safe(row.owner || 'unknown')}/${safe(row.id)}/migrated`;
      const tasks = collect(row.data, prefix);
      if (!tasks.length) continue;

      let failed = 0;
      const uploaded = [];
      const PARALLEL = 12;
      let next = 0;
      await Promise.all(new Array(Math.min(PARALLEL, tasks.length)).fill(null).map(async () => {
        while (true) {
          const i = next++;
          if (i >= tasks.length) return;
          try {
            const url = await r2.uploadImage(tasks[i].input, tasks[i].key);
            if (!url) throw new Error('no URL');
            tasks[i].apply(url);
            uploaded.push(tasks[i].key);
          } catch { failed++; }
        }
      }));

      if (failed) {
        // The row keeps its inline bytes, so the uploads that DID succeed are
        // referenced by nothing. Record them for reclamation instead of leaving
        // them in the bucket unreachable. Safe because the row still holds the
        // inline bytes: a later pass re-uploads the same deterministic keys.
        // That is also why the pending retry runs BEFORE this offload in
        // runDailyHousekeeping — reversing the order would delete an object the
        // same run had just re-uploaded and referenced.
        log.warn(`[db-housekeeping] ${table}/${row.id}: ${failed}/${tasks.length} uploads failed — row left unchanged`);
        try {
          const r2Pending = require('./r2Pending');
          for (const key of uploaded) {
            await r2Pending.recordPending('object', key, `partial JSONB offload of ${table}/${row.id}`);
          }
        } catch (err) {
          log.warn(`[db-housekeeping] could not record ${uploaded.length} unreferenced upload(s): ${err.message}`);
        }
        result.skipped++;
        continue;
      }
      await pool.query(`UPDATE ${table} SET data = $2 WHERE id = $1`, [row.id, JSON.stringify(row.data)]);
      result.rows++;
      result.images += tasks.length;
      result.mb += MB(tasks.reduce((a, t) => a + t.bytes, 0));
    }
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

  await vacuumAnalyze(pool, log);

  const report = await bloatReport(pool);
  logBloatReport(report, log);
  return { offload, report, pendingR2 };
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
  vacuumAnalyze,
  bloatReport,
  logBloatReport,
  restartOwnPostgres,
  shouldRun,
  collect,
  looksLikeBytes,
  databaseSize,
  TABLES,
};
