"""Regression tests for GET /health off-Linux, and for the worker bind family.

Both defects were local-dev-only (2026-09-14), and both were invisible in
production — which is exactly why they survived: Railway is Linux, where
`_rss_mb()` returns a number and waitress binds every address family.

  A. `_rss_mb()` reads /proc/self/status and returns None off-Linux BY DESIGN.
     /health therefore set `rss_mb` to None, and `body.get("rss_mb", 0)` handed
     back that None rather than the default — a `.get(k, default)` only defaults
     on a MISSING key, never on a present null. `None + worker_rss` raised
     TypeError, so every local GET /health 500'd.

  B. The waitress-missing fallback ran `app.run(host='::')`. IPV6_V6ONLY
     defaults to 0 on Linux but 1 on Windows, so the worker bound [::]:5001 and
     nothing on 127.0.0.1 — which is the literal address ensure_worker's
     readiness probe uses. A healthy worker looked dead for the full
     WORKER_START_TIMEOUT_S and /analyze answered "face worker not ready
     within 120s".

No ML model is loaded and no subprocess is spawned: the parent role defers
mediapipe/torch, and both bugs are pure bookkeeping.

Run:  python tests/manual/test_health_rss_null.py
"""

import json
import os
import re
import sys

os.environ.setdefault('ANALYZER_ROLE', 'parent')
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import photo_analyzer as pa  # noqa: E402

FAILURES = []


def check(label, ok, detail=''):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)


def _get_health(rss_value):
    """GET /health with `_rss_mb()` forced to a given value (None = off-Linux)."""
    real = pa._rss_mb
    pa._rss_mb = lambda: rss_value
    try:
        with pa.app.test_client() as client:
            resp = client.get('/health')
            return resp.status_code, (resp.get_json() if resp.data else None)
    finally:
        pa._rss_mb = real


def test_health_survives_a_null_router_rss():
    """The reproduction: this returned 500 TypeError before the fix."""
    status, body = _get_health(None)
    check('GET /health is 200 when rss_mb is null', status == 200, f'status={status}')
    if body is None:
        return
    check('rss_mb is reported as null, not faked', body.get('rss_mb') is None,
          repr(body.get('rss_mb')))
    # Unknown must stay unknown. Reporting 0 + workers would understate the
    # container by the whole router process, which is what this field exists
    # to stop.
    check('python_total_rss_mb is null rather than a wrong total',
          'python_total_rss_mb' in body and body['python_total_rss_mb'] is None,
          repr(body.get('python_total_rss_mb')))
    check('the total is still JSON-serialisable', json.dumps(body) is not None)


def test_health_still_totals_on_linux():
    """The fix must not break the case it was written for."""
    status, body = _get_health(42.5)
    check('GET /health is 200 with a real rss_mb', status == 200, f'status={status}')
    if body is None:
        return
    # No workers are up in this test, so the total is the router alone.
    check('python_total_rss_mb adds the router in',
          body.get('python_total_rss_mb') == 42.5,
          repr(body.get('python_total_rss_mb')))


def test_no_other_present_null_arithmetic():
    """`.get(k, 0)` feeding arithmetic is the trap; it must not come back."""
    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), 'photo_analyzer.py'),
        encoding='utf-8').read()
    # A `.get(..., 0)` immediately followed by + - * is only safe when the key
    # can never hold None. Every current one is an int counter; a new one on a
    # value that can be null is the bug this test pins.
    bad = re.findall(r'\.get\([^()]*,\s*0(?:\.0)?\)\s*[+\-*]', src)
    offenders = [b for b in bad if 'rss' in b]
    check('no rss value is summed through a .get(k, 0) default',
          not offenders, repr(offenders))


def test_dev_server_fallback_binds_the_probed_family():
    """The parent probes 127.0.0.1; the fallback must bind it on Windows."""
    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), 'photo_analyzer.py'),
        encoding='utf-8').read()
    check("ensure_worker still probes the IPv4 loopback (the invariant)",
          '127.0.0.1:{WORKER_PORTS[role]}' in src)
    check("the dev-server fallback is platform-aware, not a bare '::'",
          "'0.0.0.0' if sys.platform == 'win32' else '::'" in src)
    check("the waitress path still binds both families",
          "listen=f'*:{port}'" in src)


def test_stdout_rewrap_is_line_buffered():
    """A block-buffered rewrap hides a worker's own error behind the 503."""
    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))), 'photo_analyzer.py'),
        encoding='utf-8').read()
    wrapped = re.findall(r'sys\.(?:stdout|stderr) = io\.TextIOWrapper\(.*?\)', src,
                         re.S)
    check('both std streams are rewrapped', len(wrapped) == 2, str(len(wrapped)))
    check('both rewraps set line_buffering=True',
          all('line_buffering=True' in w for w in wrapped))


if __name__ == '__main__':
    print('/health null rss + worker bind family — regression test')
    test_health_survives_a_null_router_rss()
    test_health_still_totals_on_linux()
    test_no_other_present_null_arithmetic()
    test_dev_server_fallback_binds_the_probed_family()
    test_stdout_rewrap_is_line_buffered()
    print('\n' + ('FAILED: ' + ', '.join(FAILURES) if FAILURES else 'ALL PASSED'))
    sys.exit(1 if FAILURES else 0)
