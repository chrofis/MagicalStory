"""Unit tests for analyzer_reap_policy (pure; loads no model).
Run: python tests/unit/test_analyzer_reap_policy.py
(or python tests/unit/test_analyzer_reap_policy.py)"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from analyzer_reap_policy import SESSION_END_GRACE_S, reap_wait_seconds, cache_drop_allowed  # noqa: E402


class ReapGrace(unittest.TestCase):
    def test_bounce_keeps_worker(self):
        # 12:31:05 leave -> reap check the same second must wait ~the full grace
        self.assertAlmostEqual(reap_wait_seconds(0, 1000.0, 1000.2), SESSION_END_GRACE_S - 0.2)

    def test_reaps_after_grace(self):
        self.assertEqual(reap_wait_seconds(0, 1000.0, 1000.0 + SESSION_END_GRACE_S + 1), 0.0)

    def test_sessionless_work_reaps_immediately(self):
        self.assertEqual(reap_wait_seconds(0, 0.0, 5000.0), 0.0)

    def test_active_session_never_waits(self):
        self.assertEqual(reap_wait_seconds(1, 1000.0, 1000.1), 0.0)


class CacheDrop(unittest.TestCase):
    def test_allowed_only_when_idle(self):
        self.assertTrue(cache_drop_allowed(0, False, False))
        self.assertFalse(cache_drop_allowed(1, False, False))
        self.assertFalse(cache_drop_allowed(0, True, False))
        self.assertFalse(cache_drop_allowed(0, False, True))


if __name__ == '__main__':
    unittest.main()
