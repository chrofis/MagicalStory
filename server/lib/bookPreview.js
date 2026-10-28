/**
 * Book preview: the customer sees the FULL printed book, page by page, before paying
 * (docs/decisions.md 2026-10-28 "Book preview").
 *
 * ONE implementation: the preview is the print PDF itself. `gelato.buildBookPrintPdf` (the function the paid order
 * uses) draws it with fillMethod 'grok', `pdfRaster.rasterisePdfPages` turns each PDF page into a JPEG, and the pages
 * are stored in R2 under a key derived from the inputs. The Grok-painted text strips are stored per page by
 * pdf.js buildStripBackground, so the order that follows reuses them and pays nothing again.
 *
 * Job model: `requestPreview` is idempotent. It returns the stored preview when one exists, joins a running job for the
 * same book (no double spend, also across users: jobs are indexed by key), or starts one. The caller polls it.
 * Errors are kept for ERROR_TTL_MS so a polling client sees them; `retry: true` clears one and starts again.
 * No fallback to a mirror fill: a failed fill or render is an error state.
 */

const crypto = require('crypto');
const r2 = require('./r2');
const { log } = require('../utils/logger');

const LAYOUTS = ['single', 'spread'];
const COVER_TYPES = ['softcover', 'hardcover'];
const PREFIX = 'bookPreview';
const MAX_RUNNING = 2;               // each job holds a ~20 MB PDF plus image buffers; more would risk the 3 GB heap
const ERROR_TTL_MS = 10 * 60 * 1000;
const MAX_STORIES = 8;

class PreviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const jobsByKey = new Map();         // key -> job
const keyBySignature = new Map();    // userId|ids|layout|cover -> key (fast poll path, no database read while running)

const signatureOf = (userId, ids, layout, coverType) => `${userId}|${ids.join(',')}|${layout}|${coverType}`;
const manifestKey = (key) => `${PREFIX}/${key}/manifest.json`;
const pageKey = (key, index) => `${PREFIX}/${key}/p${String(index).padStart(3, '0')}.jpg`;

function defaultDeps() {
  const { getPool } = require('../services/database');
  return {
    dbPool: getPool(),
    buildBookPrintPdf: require('./gelato').buildBookPrintPdf,
    rasterisePdfPages: require('./pdfRaster').rasterisePdfPages,
    r2,
    codeVersion: process.env.RAILWAY_GIT_COMMIT_SHA || '',
  };
}

function validateInput({ storyIds, layout, coverType }) {
  if (!Array.isArray(storyIds) || !storyIds.length || storyIds.length > MAX_STORIES || storyIds.some(id => typeof id !== 'string' || !id)) {
    throw new PreviewError(400, 'storyIds must be 1 to ' + MAX_STORIES + ' story ids');
  }
  if (!LAYOUTS.includes(layout)) throw new PreviewError(400, `layout must be one of ${LAYOUTS.join('|')}`);
  if (!COVER_TYPES.includes(coverType)) throw new PreviewError(400, `coverType must be one of ${COVER_TYPES.join('|')}`);
}

/**
 * Owner check + the key. The key covers the story ids in order, the layout, the cover type, each story's stored data,
 * its picture rows (type, page, version, size, url, time) and the deployed code, so an edit, a repaired picture or a
 * code change gives a new key and the old preview is simply never looked up again.
 * Throws PreviewError 404 when a story is missing or not the caller's (admins may read any).
 */
async function resolvePreviewKey(deps, { userId, isAdmin, storyIds, layout, coverType }) {
  const { rows } = await deps.dbPool.query('SELECT id, user_id, data FROM stories WHERE id = ANY($1::text[])', [storyIds]);
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of storyIds) {
    const row = byId.get(id);
    if (!row || (!isAdmin && String(row.user_id) !== String(userId))) throw new PreviewError(404, 'Story not found');
  }
  const imgs = await deps.dbPool.query(
    `SELECT story_id, image_type, page_number, version_index, COALESCE(image_url, '') AS url, COALESCE(length(image_data), 0) AS len, generated_at
       FROM story_images WHERE story_id = ANY($1::text[]) AND NOT COALESCE(is_test, false)
      ORDER BY story_id, image_type, page_number NULLS FIRST, version_index`, [storyIds]);
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ storyIds, layout, coverType, code: deps.codeVersion || '' }));
  for (const id of storyIds) h.update(typeof byId.get(id).data === 'string' ? byId.get(id).data : JSON.stringify(byId.get(id).data));
  h.update(JSON.stringify(imgs.rows));
  return h.digest('hex').slice(0, 32);
}

async function readManifest(deps, key) {
  const k = manifestKey(key);
  if (!(await deps.r2.objectExists(k))) return null;
  const bytes = await deps.r2.fetchImageBytes(deps.r2.publicUrlForKey(k));
  if (!bytes) throw new Error(`stored preview manifest ${k} exists but could not be read`);
  return JSON.parse(bytes.toString('utf8'));
}

/** Build the PDF, rasterise it, store the pages and the manifest. Updates `job` as it goes. */
async function runJob(deps, job) {
  const fillStats = { grokCalls: 0 };
  job.stage = 'preparing';
  const built = await deps.buildBookPrintPdf(deps.dbPool, job.storyIds, job.coverType, job.layout, {
    fillMethod: 'grok', fillStats, onStage: (s) => { job.stage = s === 'pdf' ? 'painting' : s; },
  });
  job.stage = 'rendering';
  const pages = [];
  for await (const p of deps.rasterisePdfPages(built.pdfBuffer)) {
    const url = await deps.r2.uploadImage(p.jpeg, pageKey(job.key, p.index));
    if (!url) throw new Error(`could not store preview page ${p.index + 1} in R2`);
    pages.push({ url, width: p.width, height: p.height });
    job.done = p.index + 1;
    job.total = p.total;
  }
  const manifest = {
    key: job.key, layout: job.layout, coverType: job.coverType, bookFormat: built.pageInfo.bookFormat,
    printedPages: built.targetPageCount,
    pages,   // pages[i] is PDF page i + 1: cover spread, inside front blank, interior..., inside back blank
    grokPainted: fillStats.grokCalls, grokReused: fillStats.reused || 0, createdAt: new Date().toISOString(),
  };
  const stored = await deps.r2.uploadImage(Buffer.from(JSON.stringify(manifest)), manifestKey(job.key), 'application/json');
  if (!stored) throw new Error('could not store the preview manifest in R2');
  log.info(`📖 [BOOK PREVIEW] ${job.key}: ${pages.length} pages, Grok painted ${fillStats.grokCalls}, reused ${fillStats.reused || 0}`);
  return manifest;
}

function publicState(job) {
  if (job.state === 'error') return { state: 'error', error: job.error };
  return { state: 'running', stage: job.stage, done: job.done, total: job.total };
}

/**
 * Idempotent start-or-status. Returns {state:'ready', manifest} | {state:'running', stage, done, total} | {state:'error', error}.
 * @param {Object} req { userId, isAdmin, storyIds, layout, coverType, retry }
 * @param {Object} [deps] test seam
 */
async function requestPreview(req, deps = defaultDeps()) {
  validateInput(req);
  const sig = signatureOf(req.userId, req.storyIds, req.layout, req.coverType);

  // Fast path: this user's job for this book is already known (no database read while it runs).
  const knownKey = keyBySignature.get(sig);
  const known = knownKey && jobsByKey.get(knownKey);
  if (known && known.state === 'running') return publicState(known);
  if (known && known.state === 'error') {
    if (!req.retry && Date.now() - known.at < ERROR_TTL_MS) return publicState(known);
    jobsByKey.delete(knownKey); keyBySignature.delete(sig);
  }

  const key = await resolvePreviewKey(deps, req);
  keyBySignature.set(sig, key);
  const existing = jobsByKey.get(key);
  if (existing && existing.state === 'running') return publicState(existing);   // joined: no second spend
  if (existing && existing.state === 'error' && !req.retry && Date.now() - existing.at < ERROR_TTL_MS) return publicState(existing);

  const manifest = await readManifest(deps, key);
  if (manifest) { jobsByKey.delete(key); return { state: 'ready', manifest }; }

  // Re-check after the awaits above: a concurrent request may have started this job meanwhile. From here to
  // jobsByKey.set() nothing awaits, so exactly one request starts it (the join the no-double-spend rule needs).
  const raced = jobsByKey.get(key);
  if (raced && raced.state === 'running') return publicState(raced);

  const running = [...jobsByKey.values()].filter(j => j.state === 'running').length;
  if (running >= MAX_RUNNING) throw new PreviewError(429, 'Too many previews are being prepared right now, try again in a minute');

  const job = { key, state: 'running', stage: 'preparing', done: 0, total: 0, storyIds: req.storyIds, layout: req.layout, coverType: req.coverType, at: Date.now() };
  jobsByKey.set(key, job);
  job.promise = runJob(deps, job).then(
    () => { jobsByKey.delete(key); },
    (err) => {
      log.error(`❌ [BOOK PREVIEW] ${key}: ${err.message}`);
      job.state = 'error'; job.error = err.message; job.at = Date.now();
    });
  return publicState(job);
}

module.exports = { requestPreview, resolvePreviewKey, PreviewError, manifestKey, pageKey, LAYOUTS, COVER_TYPES, _jobsForTest: { jobsByKey, keyBySignature } };
