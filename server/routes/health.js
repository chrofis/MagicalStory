const { photoAnalyzerUrl } = require('../lib/photoAnalyzerClient');
/**
 * Health & Utility Routes - /api/health, /api/check-ip, /api/log-error
 *
 * Server health checks and debugging utilities
 */

const express = require('express');
const router = express.Router();
const { errorLoggingLimiter } = require('../middleware/rateLimit');
const { validateBody, schemas } = require('../middleware/validation');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { log } = require('../utils/logger');

// GET /api/health - Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/health/config — what behaviour is this environment actually running?
//
// Exists because there was no way to answer that question from outside. Every
// behavioural setting was a Railway env var, one dashboard per environment, so
// staging and production silently disagreed about the generation pipeline for
// weeks and nobody could see it. Diffing the two environments is now:
//   curl https://magicalstory.ch/api/health/config
//   curl https://staging.magicalstory.ch/api/health/config
//
// Reports the resolved values from server/config/runtime.js only. It must NEVER
// include secrets, keys or connection strings — that invariant is what lets it
// stay unauthenticated, which is what makes it actually get used.
router.get('/health/config', (req, res) => {
  const { runtimeSnapshot } = require('../config/runtime');
  const { ARCFACE_MIN } = require('../lib/faceIdentity');
  res.json({
    ...runtimeSnapshot(),
    // The ArcFace avatar gate FAILS OPEN by design: if the Python service or the
    // weights are missing, avatars still generate and the second opinion simply
    // does nothing. That is the right behaviour and the wrong thing to have to
    // discover by generating a paid avatar and finding no score. Reporting the
    // threshold here makes "is the gate deployed at all" a free GET.
    arcfaceGate: ARCFACE_MIN,
    // The image tiers that actually render, resolved to the model id xAI bills
    // for. pageRenderModel/coverRenderModel above are the runtime KEYS; this is
    // what those keys, plus the two deliberately-pinned tiers, resolve to. The
    // page/cover tier differs per environment and the plate tier does not —
    // "which model is this environment paying for" should be one free GET, not
    // a read of three files.
    imageModels: (() => {
      const { MODEL_DEFAULTS, IMAGE_MODELS } = require('../config/models');
      const resolve = (key) => ({ key, modelId: IMAGE_MODELS[key]?.modelId || null });
      return {
        page: resolve(MODEL_DEFAULTS.pageRenderImage),
        cover: resolve(MODEL_DEFAULTS.coverImage),
        emptyScenePlate: resolve(MODEL_DEFAULTS.emptyScenePlateModel),
        editInpaint: resolve(MODEL_DEFAULTS.pageImage),
        avatar: resolve(MODEL_DEFAULTS.avatar),
      };
    })(),
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 8) || '(unset)',
  });
});

// POST /api/health/release-memory - reclaim RAM now, without a restart.
//
// The Python idle reapers only fire after 10-15 min of no use. That is correct
// for normal running but leaves no way to reclaim memory on demand, or to prove
// that the release works, without redeploying — and a redeploy restarts the
// container, which resets RSS and destroys whatever you were measuring.
//
// ?unload=true also drops the lazily-loaded models (rembg / MobileSAM /
// GroundingDINO); they reload on next use in a few seconds.
// Admin-only: this evicts models and briefly slows the next request.
router.post('/health/release-memory', authenticateToken, requireAdmin, async (req, res) => {
  const url = photoAnalyzerUrl();
  // Forward BOTH flags. `recycle` was previously dropped here, so the only way
  // to reclaim a framework that cannot be unloaded in-process (TensorFlow keeps
  // ~350MB of allocator arenas after its weights are freed) was to redeploy.
  const flags = [];
  if (req.query.unload === 'true') flags.push('unload=true');
  if (req.query.recycle === 'true') flags.push('recycle=true');
  const unload = flags.length ? `?${flags.join('&')}` : '';
  const nodeBefore = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
  try {
    const r = await fetch(`${url}/release-memory${unload}`, { method: 'POST', signal: AbortSignal.timeout(30000) });
    const python = await r.json();
    // Node's own heap too. `--expose-gc` is in the start script for exactly
    // this: without it `global.gc` is undefined, this line quietly does
    // nothing, and the endpoint reports success having reclaimed only the
    // Python half. Measured on production 2026-09-01 — Python freed 118 MB
    // while Node sat at 588 MB RSS against 123 MB of live heap, i.e. ~460 MB
    // the allocator was holding and nobody could reach.
    const gcAvailable = typeof global.gc === 'function';
    if (gcAvailable) global.gc();
    const nodeAfter = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    if (!gcAvailable) {
      log.warn('[HEALTH] release-memory: global.gc unavailable — node was started without --expose-gc, so only Python was reclaimed');
    }
    res.json({ success: true, python, node: { rss_before_mb: nodeBefore, rss_after_mb: nodeAfter, gc_available: gcAvailable } });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// GET /api/health/memory - Live memory breakdown for this container.
//
// Railway bills resident memory per MB per MINUTE, so what this process HOLDS
// is the bill. Railway's own metrics are container-total at 5-minute
// resolution, which can't separate Node from the Python analyzer and is too
// coarse to see whether memory is released after a story generation.
//
// The number that matters is `external` vs `rss`: page images move through Node
// as large Buffers, which live OUTSIDE the V8 heap in malloc'd memory. When
// those are freed, glibc can keep the pages in per-thread arenas instead of
// returning them to the OS — that retention is why RSS used to climb to a peak
// and stay there until a redeploy. If rss stays high while heapUsed and
// external have fallen back, the allocator is holding freed pages, not the app.
// Read the container's OWN memory accounting — the number Railway bills.
//
// WHY THIS EXISTS. On 2026-09-03 production was billed 2.74-2.93 GB while the
// two processes in the container held 567 MB between them (Node RSS 447 with a
// 70 MB heap, analyzer 119 with no models loaded). Everything the app could
// plausibly be holding was ruled out — heap cap in force, no models, and every
// grid/thumbnail disk write is behind `saveGrids: false`. The missing ~2.3 GB
// is not visible to `process.memoryUsage()` by construction.
//
// The cgroup is the only thing that can say what it is. `file` (v2) / `cache`
// (v1) is the OS page cache: every file the container reads or writes stays
// resident, the cgroup counts it as used memory, and Linux evicts it only under
// pressure — so it accumulates for the life of the container. That is the same
// accounting that made a 1,818 MB database look like a 2.14 GB Postgres
// container. If `file` is the bulk, the fix is about file I/O and restarts, not
// about the app's working set; if `anon` is the bulk, something really is
// holding memory and the process numbers above are lying.
//
// Both cgroup versions are handled: v2 exposes memory.current + memory.stat
// with `anon`/`file` keys, v1 exposes memory.usage_in_bytes + memory.stat with
// `rss`/`cache`. Absent or unreadable (macOS, Windows, some sandboxes) returns
// a reason rather than throwing — this is a diagnostic, it must never take the
// endpoint down.
function readCgroupMemory() {
  const fsSync = require('fs');
  const mb = (n) => Math.round(n / 1024 / 1024 * 10) / 10;
  const readNum = (p) => {
    const raw = fsSync.readFileSync(p, 'utf8').trim();
    return raw === 'max' ? null : Number(raw);
  };
  const parseStat = (p) => {
    const out = {};
    for (const line of fsSync.readFileSync(p, 'utf8').split('\n')) {
      const [k, v] = line.split(/\s+/);
      if (k && v !== undefined) out[k] = Number(v);
    }
    return out;
  };

  try {
    if (fsSync.existsSync('/sys/fs/cgroup/memory.current')) {
      const stat = parseStat('/sys/fs/cgroup/memory.stat');
      return {
        version: 'v2',
        usage_mb: mb(readNum('/sys/fs/cgroup/memory.current')),
        limit_mb: (() => { const l = readNum('/sys/fs/cgroup/memory.max'); return l === null ? 'max' : mb(l); })(),
        anon_mb: mb(stat.anon || 0),          // process memory
        file_mb: mb(stat.file || 0),          // page cache — the suspect
        slab_mb: mb(stat.slab || 0),          // kernel structures (inodes/dentries)
        file_mapped_mb: mb(stat.file_mapped || 0),
        file_dirty_mb: mb(stat.file_dirty || 0),
        file_writeback_mb: mb(stat.file_writeback || 0),
      };
    }
    if (fsSync.existsSync('/sys/fs/cgroup/memory/memory.usage_in_bytes')) {
      const stat = parseStat('/sys/fs/cgroup/memory/memory.stat');
      return {
        version: 'v1',
        usage_mb: mb(readNum('/sys/fs/cgroup/memory/memory.usage_in_bytes')),
        limit_mb: mb(readNum('/sys/fs/cgroup/memory/memory.limit_in_bytes')),
        anon_mb: mb(stat.rss || 0),
        file_mb: mb(stat.cache || 0),
        file_mapped_mb: mb(stat.mapped_file || 0),
      };
    }
    return { error: 'no cgroup memory interface found' };
  } catch (err) {
    return { error: err.message };
  }
}

router.get('/health/memory', async (req, res) => {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1024 / 1024 * 10) / 10;

  // The Python analyzer is a separate process in the same container, so it is
  // billed with us but invisible to process.memoryUsage(). Fetch it so the two
  // can be compared with what Railway charges for. They do NOT add up to it —
  // see the `cgroup` block below, which is the number Railway actually bills.
  // Never fail the endpoint over it.
  let python = null;
  try {
    const url = photoAnalyzerUrl();
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
    const j = await r.json();
    // rss_mb is the analyzer's ROUTER process alone, and the router is the small
    // one — it proxies to short-lived workers that hold the models. Measured
    // mid-story: router 89 MB, workers 1.43 GB + 985 MB. Reporting only rss_mb
    // understated the container by >1 GB and hid a 9.85 GB peak entirely, so
    // total_rss_mb (router + workers) is what to compare against the cgroup.
    python = {
      rss_mb: j.rss_mb,
      workers_rss_mb: j.workers_rss_mb,
      total_rss_mb: j.python_total_rss_mb ?? j.rss_mb,
      workers: j.workers,
      active_sessions: j.active_sessions,
      rembg_loaded: j.rembg_loaded, mobilesam_loaded: j.mobilesam_loaded, groundingdino_loaded: j.groundingdino_loaded,
      boot_rss: j.boot_rss, cpu: j.cpu,
    };
  } catch (err) {
    python = { error: err.message };
  }

  // Railway bills per vCPU-minute, so CPU-SECONDS is the billable figure —
  // wall-clock over-states it badly (most of the images stage is network wait
  // on the image model). Both numbers are cumulative since process start:
  // read the endpoint before and after a story and subtract to get that
  // story's true CPU cost, Node and analyzer separately.
  const cpu = process.cpuUsage();
  res.json({
    timestamp: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    node: {
      cpu_seconds: Math.round((cpu.user + cpu.system) / 1000) / 1000,
      rss_mb: mb(m.rss),
      heapUsed_mb: mb(m.heapUsed),
      heapTotal_mb: mb(m.heapTotal),
      external_mb: mb(m.external),
      arrayBuffers_mb: mb(m.arrayBuffers),
      heapLimit_mb: mb(require('v8').getHeapStatistics().heap_size_limit),
    },
    python,
    env: {
      mallocArenaMax: process.env.MALLOC_ARENA_MAX || '(unset)',
      railwayEnv: process.env.RAILWAY_ENVIRONMENT_NAME || '(unset)',
    },
    // Renamed from container_total_mb: it is the sum of the two PROCESSES, and
    // measurement on 2026-09-03 showed that is not the container total at all
    // (567 MB of processes against 2.9 GB billed). `cgroup` below is.
    process_total_mb: python && python.total_rss_mb ? Math.round(mb(m.rss) + python.total_rss_mb) : null,
    cgroup: readCgroupMemory(),
  });
});

// GET /api/debug-landmarks/:city - Temporary debug endpoint for landmarks
const { getPool } = require('../services/database');
router.get('/debug-landmarks/:city', async (req, res) => {
  try {
    const city = req.params.city.toLowerCase();
    const pool = getPool();
    const result = await pool.query(
      "SELECT location_key, city, country, landmarks, landmark_count, created_at FROM discovered_landmarks WHERE LOWER(city) = $1",
      [city]
    );
    const formatted = result.rows.map(row => ({
      location_key: row.location_key,
      city: row.city,
      country: row.country,
      landmark_count: row.landmark_count,
      created_at: row.created_at,
      landmarks: typeof row.landmarks === 'string' ? JSON.parse(row.landmarks) : row.landmarks
    }));
    res.json({ count: result.rowCount, entries: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/check-ip - Shows Railway's outgoing IP for debugging
router.get('/check-ip', async (req, res) => {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    res.json({
      railwayOutgoingIp: data.ip,
      requestIp: req.ip,
      forwardedFor: req.headers['x-forwarded-for'],
      message: 'Railway outgoing IP address for debugging'
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// POST /api/log-error - Browser error logging endpoint
// Rate limited to prevent DoS via log flooding
router.post('/log-error', errorLoggingLimiter, validateBody(schemas.logError), (req, res) => {
  try {
    const { message, stack, url, line, column, userAgent, userId, timestamp, errorType } = req.body;

    // Log to console with emoji for visibility in Railway logs
    console.error('🔴 BROWSER ERROR:', {
      type: errorType || 'JavaScript Error',
      message,
      url,
      location: line && column ? `Line ${line}, Column ${column}` : 'Unknown',
      user: userId || 'Anonymous',
      userAgent: userAgent || 'Unknown',
      timestamp: timestamp || new Date().toISOString(),
      stack: stack ? stack.substring(0, 500) : 'No stack trace' // Limit stack trace length
    });

    res.json({ success: true, message: 'Error logged' });
  } catch (err) {
    console.error('Error logging browser error:', err);
    res.status(500).json({ success: false, error: 'Failed to log error' });
  }
});

// ── Analyzer presence ───────────────────────────────────────────────────────
// The trial/create wizards send anonymous heartbeats while the user is there
// and active; the first beat warms the analyzer's photo workers so the first
// upload never pays a cold start, and expiry (~5 min idle, owner's spec) or an
// explicit leave closes the session. Public by design — trial users have no
// account; the token cap in presenceSessions bounds abuse.
router.post('/analyzer-presence', (req, res) => {
  const { token, surface, bye } = req.body || {};
  const presence = require('../lib/presenceSessions');
  const result = bye ? presence.leave(token) : presence.beat(token, String(surface || 'unknown').slice(0, 24));
  res.json(result);
});

module.exports = router;
