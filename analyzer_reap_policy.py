"""Pure reap-timing policy for the analyzer's worker lifecycle (no ML imports).

Kept out of photo_analyzer.py so it can be unit-tested without loading any
model. See docs/decisions.md, 2026-10-10 "Analyzer: a leave/arrive bounce keeps
the warm worker".
"""

# A wizard remount / navigation sends presence 'bye' and a new beat a few
# seconds apart (staging 2026-10-10: leave 12:31:05, arrive 12:31:05, the
# first arrive 3 s earlier). 30 s covers that with margin; a visitor who truly
# left costs one extra half-minute of worker memory.
SESSION_END_GRACE_S = 30.0


def reap_wait_seconds(sessions, last_session_end_ts, now, grace_s=SESSION_END_GRACE_S):
    """Seconds to keep workers alive before a zero-session reap may proceed.

    0.0 means reap now. A reap is deferred only when sessions are zero AND a
    session ended less than `grace_s` ago. Sessionless work (an upload that
    never had a session) has last_session_end_ts == 0 and reaps immediately.
    """
    if sessions > 0:
        return 0.0
    if not last_session_end_ts:
        return 0.0
    remaining = grace_s - (now - last_session_end_ts)
    return remaining if remaining > 0 else 0.0


def cache_drop_allowed(sessions, have_workers, bringing_up):
    """A page-cache sweep is only worth it when nothing is about to reload the
    files it would evict: no session, no worker, no worker coming up."""
    return sessions == 0 and not have_workers and not bringing_up
