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

module.exports = { photoAnalyzerUrl, withAnalyzerSlot };
