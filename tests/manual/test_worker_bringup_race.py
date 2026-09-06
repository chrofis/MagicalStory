"""Regression test for the cold-start 502 on the first photo upload.

Reproduces the two defects fixed on 2026-09-05, with no ML model loaded and no
real subprocess — a fake Popen plus a fake /health probe are enough, because
both bugs live purely in the worker-lifecycle bookkeeping.

  A. The idle reaper killed a worker that was still starting. /warmup returns
     immediately and spawns on a BACKGROUND thread, so the warmup request's own
     teardown fires _maybe_reap_workers() with sessions=0 and nothing in flight.
     It terminated the worker it had just asked for.

  B. ensure_worker() returned early on _worker_alive(), which is only
     `poll() is None`. A process that has started but not yet bound its port
     passes that test, so callers got a URL that answered
     `[Errno 111] Connection refused` — the user-visible 502.

Run:  python tests/manual/test_worker_bringup_race.py
"""

import os
import sys
import threading
import time

os.environ.setdefault('ANALYZER_ROLE', 'parent')
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

import photo_analyzer as pa  # noqa: E402

FAILURES = []


def check(label, ok, detail=''):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        FAILURES.append(label)


class FakeProc:
    """A process that stays alive; readiness is driven separately."""

    def __init__(self, *a, **kw):
        self._rc = None

    def poll(self):
        return self._rc

    def terminate(self):
        self._rc = -15

    def kill(self):
        self._rc = -9

    def wait(self, timeout=None):
        self._rc = self._rc if self._rc is not None else 0
        return self._rc


def install_fakes(ready_after_s):
    """Worker becomes healthy `ready_after_s` after it is spawned."""
    spawned_at = {}

    def fake_popen(*a, **kw):
        role = kw.get('env', {}).get('ANALYZER_ROLE', '?')
        spawned_at[role] = time.time()
        return FakeProc()

    def fake_health(role, timeout=2):
        proc = pa._workers.get(role)
        if proc is None or proc.poll() is not None:
            return False  # dead process never answers
        t0 = spawned_at.get(role)
        return t0 is not None and (time.time() - t0) >= ready_after_s

    pa.subprocess.Popen = fake_popen
    pa._worker_health_ok = fake_health
    return spawned_at


def reset_state():
    pa._workers.clear()
    pa._bringing_up.clear()
    pa._worker_ready.clear()
    pa._sessions.clear()
    pa._active_sessions = 0
    pa._active_sessions = 0
    pa._inflight_requests = 0


def test_reaper_cannot_kill_a_starting_worker():
    """Defect A: the reap that fires while a worker boots must abort."""
    print('\n[A] idle reap during startup')
    reset_state()
    install_fakes(ready_after_s=1.5)

    result = {}

    def bring_up():
        try:
            result['url'] = pa.ensure_worker('face')
        except Exception as e:  # noqa: BLE001
            result['error'] = e

    t = threading.Thread(target=bring_up)
    t.start()

    # The worker is mid-startup. This is precisely what /warmup's teardown does.
    time.sleep(0.4)
    check('worker is registered as starting', bool(pa._bringing_up),
          f'_bringing_up={dict(pa._bringing_up)}')
    killed = pa.kill_workers('sessions=0, idle', expect_epoch=None)
    check('kill_workers refuses while starting', killed is False, f'returned {killed}')

    t.join(timeout=10)
    check('ensure_worker succeeded', 'error' not in result,
          str(result.get('error', '')))
    check('returned the worker URL', result.get('url', '').endswith(':5001'),
          result.get('url', ''))
    check('bring-up guard released afterwards', not pa._bringing_up,
          f'_bringing_up={dict(pa._bringing_up)}')


def test_alive_but_not_listening_is_not_ready():
    """Defect B: a live-but-unbound worker must not be handed out."""
    print('\n[B] alive is not ready')
    reset_state()
    spawned_at = install_fakes(ready_after_s=1.0)

    # Pre-register a live process that is NOT yet answering — exactly the state
    # the old fast path short-circuited on. Seeding spawned_at is what makes it
    # "started 0s ago", i.e. alive but still unbound.
    pa._workers['face'] = FakeProc()
    spawned_at['face'] = time.time()
    t0 = time.time()
    url = pa.ensure_worker('face')
    waited = time.time() - t0

    # It cannot return before the worker actually answers /health.
    check('waited for readiness rather than returning immediately', waited >= 0.4,
          f'returned after {waited:.2f}s')
    check('returned the worker URL', url.endswith(':5001'), url)


def test_force_still_kills():
    """The documented override must still win."""
    print('\n[C] force=True overrides the guard')
    reset_state()
    install_fakes(ready_after_s=5.0)

    def bring_up():
        try:
            pa.ensure_worker('face')
        except Exception:  # noqa: BLE001, S110
            pass

    t = threading.Thread(target=bring_up, daemon=True)
    t.start()
    time.sleep(0.4)
    killed = pa.kill_workers('release-memory', force=True)
    check('force kills a starting worker', killed is True, f'returned {killed}')
    t.join(timeout=10)


def test_ready_worker_skips_the_probe():
    """A proven-ready worker must not pay a health round trip per request."""
    print('\n[D] ready cache')
    reset_state()
    install_fakes(ready_after_s=0)

    pa.ensure_worker('face')  # proves readiness, populates the cache
    probes = {'n': 0}
    inner = pa._worker_health_ok

    def counting(role, timeout=2):
        probes['n'] += 1
        return inner(role, timeout)

    pa._worker_health_ok = counting
    for _ in range(5):
        pa.ensure_worker('face')
    check('no health probe on the hot path', probes['n'] == 0,
          f'{probes["n"]} probe(s) across 5 calls')

    # Killing the worker must invalidate the cache, not strand it.
    pa.kill_workers('test', force=True)
    check('kill clears the ready cache', 'face' not in pa._worker_ready,
          f'_worker_ready={pa._worker_ready}')


def test_wedged_worker_fails_fast():
    """Alive but not answering, nobody starting it -> fast 503, not a 120s hang."""
    print('\n[E] wedged worker')
    reset_state()
    install_fakes(ready_after_s=10**6)  # never becomes healthy

    # Shorten the budget so this runs on every push; the code reads the module
    # global at call time. What is under test is that the SHORT budget is chosen
    # at all, not its exact value.
    original = (pa.WEDGED_WORKER_TIMEOUT_S, pa.WORKER_START_TIMEOUT_S)
    pa.WEDGED_WORKER_TIMEOUT_S = 2
    pa.WORKER_START_TIMEOUT_S = 2
    try:
        wedged = FakeProc()  # alive, unproven, no bring-up in flight
        pa._workers['face'] = wedged
        t0 = time.time()
        try:
            pa.ensure_worker('face')
            check('raised for a wedged worker', False, 'returned normally')
        except RuntimeError as e:
            waited = time.time() - t0
            # The wedge is detected on the SHORT budget, the process is killed,
            # and a replacement is spawned that gets the full start budget. What
            # must never happen again is the old behaviour: recognise the wedge
            # and then leave the process running forever.
            check('terminated the wedged process', wedged.poll() is not None,
                  f'poll()={wedged.poll()}')
            check('respawned rather than giving up', pa._workers.get('face') is not wedged,
                  f'registered process is {"a replacement" if pa._workers.get("face") is not wedged else "STILL THE WEDGED ONE"}')
            check('bounded by short + start budget, not unbounded', waited < 30,
                  f'raised after {waited:.1f}s: {e}')
    finally:
        pa.WEDGED_WORKER_TIMEOUT_S, pa.WORKER_START_TIMEOUT_S = original


def test_session_end_cannot_steal_another_session():
    """F1: an end for an id that was never opened must not close someone else's."""
    print('\n[F] session identities')
    reset_state()
    client = pa.app.test_client()

    # Story B opens a session. Story A's begin was lost (never arrived).
    client.post('/session/begin', json={'id': 'story-B', 'label': 'story:B'})
    check('B is open', pa._active_sessions == 1, f'active={pa._active_sessions}')

    # A finishes and ends its session. Under the old refcount this decremented
    # B's count to zero and reaped B's workers mid-repair.
    r = client.post('/session/end', json={'id': 'story-A'})
    check('ending an unknown id is a no-op', pa._active_sessions == 1,
          f'active={pa._active_sessions} after ending story-A')
    check('response reports B still open', r.get_json()['active'] == 1,
          str(r.get_json()))

    # A duplicate end must not double-decrement either.
    client.post('/session/end', json={'id': 'story-B'})
    client.post('/session/end', json={'id': 'story-B'})
    check('B closes once and stays closed', pa._active_sessions == 0,
          f'active={pa._active_sessions}')

    # Reset clears everything.
    client.post('/session/begin', json={'id': 'x', 'label': 'x'})
    client.post('/session/reset')
    check('reset clears all sessions', pa._active_sessions == 0 and not pa._sessions,
          f'active={pa._active_sessions} sessions={pa._sessions}')


if __name__ == '__main__':
    print('worker bring-up race — regression test')
    test_reaper_cannot_kill_a_starting_worker()
    test_alive_but_not_listening_is_not_ready()
    test_force_still_kills()
    test_ready_worker_skips_the_probe()
    test_wedged_worker_fails_fast()
    test_session_end_cannot_steal_another_session()
    print('\n' + ('FAILED: ' + ', '.join(FAILURES) if FAILURES else 'ALL PASSED'))
    sys.exit(1 if FAILURES else 0)
