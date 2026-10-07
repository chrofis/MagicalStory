/**
 * Client plumbing for the Python photo-analyzer service.
 *
 * Split out of images.js 2026-08-09. Two things live here and nothing else:
 * where the analyzer is, and how many requests may be in flight at once. Both
 * were needed by three separate clusters (figure detection, compositing/masks,
 * garment-colour fix), and garmentColourFix.js had grown its own copy of the
 * URL helper — one definition now.
 */

const pLimit = require('p-limit');
const { log } = require('../utils/logger');

function photoAnalyzerUrl() {
  return process.env.PHOTO_ANALYZER_URL || 'http://127.0.0.1:5000';
}

// Bounded in-flight requests to the Python analyzer.
//
// The page loop dispatches every page at once (pLimit(50)), and each page needs
// several mask/detect calls, so a 14-page story fired 30-80 concurrent requests
// at one CPU-bound service. It responded by dropping segmentations
// (sam_no_mask), returning no detections (detection_fallback -> Gemini) and
// stretching each pass into a ~30-40s staircase. Bounding the queue here is what
// prevents the contention; the 150s timeout downstream only waits it out.
//
// Held around the HTTP request ONLY, so a caller can never hold a slot while
// awaiting another analyzer call (which would deadlock).
// Sized from the analyzer's OWN cpu_quota (exposed on /health), because the
// right number is the one the service can actually serve: waitress runs one
// thread per vCPU, so more in-flight than that only queues at the HTTP layer
// while starving nothing. A hardcoded default risked the opposite error —
// throttling to 6 on a 24-vCPU box would have left most cores idle.
//
// p-limit@3 has no working concurrency setter (assigning to .concurrency is a
// silent no-op), so the limiter is BUILT once the quota is known rather than
// resized. Probed once per process; the quota cannot change under us.
let _analyzerLimit = null;
let _analyzerLimitPromise = null;

function _buildAnalyzerLimit() {
  return (async () => {
    let n = parseInt(process.env.ANALYZER_MAX_INFLIGHT, 10) || 0;
    let source = n ? 'ANALYZER_MAX_INFLIGHT' : '';
    if (!n) {
      try {
        const r = await fetch(`${photoAnalyzerUrl()}/health`, { signal: AbortSignal.timeout(5000) });
        const q = (await r.json())?.cpu?.cpu_quota;
        if (Number.isFinite(q) && q >= 1) { n = Math.max(2, Math.min(32, q)); source = 'analyzer cpu_quota'; }
      } catch { /* analyzer down/starting — fall through to the default */ }
    }
    if (!n) { n = 6; source = 'default (quota probe failed)'; }
    log.info(`🔧 [ANALYZER] in-flight cap ${n} (${source})`);
    _analyzerLimit = pLimit(n);
    return _analyzerLimit;
  })();
}

async function withAnalyzerSlot(fn) {
  if (_analyzerLimit) return _analyzerLimit(fn);
  if (!_analyzerLimitPromise) _analyzerLimitPromise = _buildAnalyzerLimit();
  return (await _analyzerLimitPromise)(fn);
}

// ─── Failing loudly (owner, 2026-10-07: "fail loudly too") ────────────────────
//
// Every Node call into the analyzer used to map "the service could not answer"
// (unreachable, timeout, non-2xx, success:false) onto the same value a real
// answer produces — null, [], "no mask", "no figures". A dead analyzer then read
// as an empty page, and nothing counted it. The rule now: the CLIENT throws an
// AnalyzerError on every failure shape, and the CALLER reports it through
// reportAnalyzerFailure (ERROR log + failure_log row under a stable kind) and
// then either stops that piece of work or keeps a result that is explicitly
// marked as degraded. A null/[] from a client means only "the model found
// nothing".

class AnalyzerError extends Error {
  constructor(endpoint, message, { status = null, cause = null } = {}) {
    super(`analyzer ${endpoint} failed: ${message}`);
    this.name = 'AnalyzerError';
    this.endpoint = endpoint;
    this.status = status;
    if (cause) this.cause = cause;
    this.kind = analyzerFailureKind(endpoint);
  }
}

/** Stable failure_log kind for an endpoint: '/figure-mask' → 'analyzer_figure_mask_failed'. */
function analyzerFailureKind(endpoint) {
  const slug = String(endpoint || '').replace(/^\//, '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return `analyzer_${slug || 'call'}_failed`;
}

/**
 * POST JSON to the analyzer and return the parsed answer, or THROW an
 * AnalyzerError. Failure shapes that throw: the service is unreachable or the
 * call times out, a non-2xx status, an unparseable body, `success` not true.
 * `slot` routes the request through withAnalyzerSlot (the in-flight cap);
 * `retryRestart` through analyzerClient.analyzerFetch (rides out a restart).
 */
async function analyzerJson(endpoint, body, { timeoutMs = 60_000, slot = false, retryRestart = false } = {}) {
  const url = `${photoAnalyzerUrl()}${endpoint}`;
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  };
  const doFetch = retryRestart
    ? () => require('./analyzerClient').analyzerFetch(endpoint, options)
    : () => fetch(url, options);
  let res;
  try {
    res = await (slot ? withAnalyzerSlot(doFetch) : doFetch());
  } catch (err) {
    throw new AnalyzerError(endpoint, `unavailable: ${err?.cause?.code || err?.message || err}`, { cause: err });
  }
  if (!res.ok) {
    const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    throw new AnalyzerError(endpoint, `HTTP ${res.status} ${String(text).slice(0, 200)}`.trim(), { status: res.status });
  }
  let json;
  try { json = await res.json(); } catch (err) {
    throw new AnalyzerError(endpoint, `unparseable answer: ${err.message}`, { status: res.status });
  }
  if (!json || json.success !== true) {
    throw new AnalyzerError(endpoint, String(json?.error || 'success:false'), { status: res.status });
  }
  return json;
}

/**
 * The caller's half of the rule: ERROR log + failure_log row. `err` is normally
 * an AnalyzerError (its `kind` names the endpoint); any other error is filed
 * under 'analyzer_call_failed'. Never throws.
 */
function reportAnalyzerFailure(tag, err, { pageLabel = '', severity = 'internal', storyId, pageNumber, character, userId, detail } = {}) {
  const message = String(err?.message || err);
  log.error(`❌ ${tag} ${pageLabel}${message}`);
  try {
    require('./failureLog').recordFailure({
      kind: err?.kind || 'analyzer_call_failed',
      severity,
      fingerprint: message.slice(0, 80),
      summary: `${tag} ${pageLabel}${message.slice(0, 160)}`,
      storyId, pageNumber, character, userId, detail,
    });
  } catch { /* reporting must never break the caller */ }
}

module.exports = { photoAnalyzerUrl, withAnalyzerSlot, AnalyzerError, analyzerFailureKind, analyzerJson, reportAnalyzerFailure };
