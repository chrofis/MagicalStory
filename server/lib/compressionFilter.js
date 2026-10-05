const compression = require('compression');

/**
 * Server-sent events are never gzipped. The compression middleware buffers a
 * response until zlib has a block to emit, so a stream of small events (the
 * idea stream's `generating` event and its `: generating` comment pings) sat in
 * the buffer and reached the browser in one piece when the response ended: 65 to
 * 112 s of silence on staging, past the client's 2-minute idle timeout, so the
 * idea cards never appeared (2026-10-05). The streams only started working
 * before 2026-09-24 because they wrote enough text to fill the buffer.
 * Every SSE route (idea streams, trial idea stream) is covered by this one
 * filter; see docs/decisions.md 2026-10-05.
 */
function compressionFilter(req, res) {
  if (String(res.getHeader('Content-Type') || '').toLowerCase().startsWith('text/event-stream')) return false;
  return compression.filter(req, res);
}

module.exports = { compressionFilter };
