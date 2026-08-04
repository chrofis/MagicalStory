/**
 * Verdict tests for the pre-push idle gate (scripts/admin/check-push-idle.js).
 *
 * This logic decides whether ANY push in this repo is allowed, so both failure
 * directions are load-bearing: too strict and nobody can deploy, too loose and
 * it silently stops protecting in-flight runs. Each case is served by a real
 * local HTTP server so the fetch path is exercised, not mocked.
 *
 * Run: node tests/manual/test-push-idle-gate.js
 */

const http = require('http');
const { probe, parseRefs, ENVIRONMENTS } = require('../../scripts/admin/check-push-idle');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  if (actual === expected) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      expected: ${expected}\n      actual:   ${actual}`); }
}

/** Serve one canned response, run the probe against it, shut down. */
function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', async () => {
      try {
        const result = await fn(`http://127.0.0.1:${server.address().port}`);
        server.close(() => resolve(result));
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
}

const json = (status, body) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

(async () => {
  console.log('\nprobe() verdicts');

  let r = await withServer(json(200, { busy: false, reasons: [], commit: 'abc12345' }), probe);
  check('idle app → idle', r.verdict, 'idle');

  r = await withServer(json(200, { busy: true, reasons: ['testlab: 1 experiment(s) running'] }), probe);
  check('busy app → busy', r.verdict, 'busy');
  check('busy app keeps the reason', r.reasons[0], 'testlab: 1 experiment(s) running');

  r = await withServer(json(502, { error: 'Application failed to respond' }), probe);
  check('502 (Railway stopped the container) → idle', r.verdict, 'idle');

  r = await withServer(json(503, {}), probe);
  check('503 → idle', r.verdict, 'idle');

  r = await withServer(json(404, { error: 'not found' }), probe);
  check('404 (gate not deployed) → ungated', r.verdict, 'ungated');

  r = await withServer(json(500, { busy: true, reasons: ['busy check failed: db down'] }), probe);
  check('500 from the busy route → unknown, blocks', r.verdict, 'unknown');

  r = await withServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>nope'); }, probe);
  check('200 with a non-JSON body → unknown, blocks', r.verdict, 'unknown');

  r = await withServer(json(200, { reasons: [] }), probe);
  check('200 without a busy boolean → unknown, blocks', r.verdict, 'unknown');

  // A port that WAS listening and is now closed → real ECONNREFUSED. (Port 1 is
  // no good here: undici rejects it as "bad port" before ever connecting.)
  const closedPort = await withServer(json(200, {}), async base => new URL(base).port);
  r = await probe(`http://127.0.0.1:${closedPort}`);
  check('connection refused → idle', r.verdict, 'idle');

  r = await probe('http://this-host-does-not-exist.invalid');
  check('DNS failure → idle', r.verdict, 'idle');

  console.log('\nparseRefs()');
  const refs = parseRefs('refs/heads/staging aaa refs/heads/staging bbb\n');
  check('parses one ref line', refs.length, 1);
  check('reads the remote ref', refs[0].remoteRef, 'refs/heads/staging');
  check('ignores malformed lines', parseRefs('garbage\n\n').length, 0);

  console.log('\nenvironment map');
  check('staging → staging host', ENVIRONMENTS['refs/heads/staging'].base, 'https://staging.magicalstory.ch');
  check('master → production host', ENVIRONMENTS['refs/heads/master'].base, 'https://magicalstory.ch');
  check('feature branches are not gated', ENVIRONMENTS['refs/heads/feature/x'], undefined);

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exitCode = fail ? 1 : 0;
})();
