"""Contract tests for photo_analyzer.py that load NO ML model.

flask, flask_cors and cv2 are replaced with stubs BEFORE the module is
imported, so this runs on a bare interpreter with numpy + Pillow only (the
16GB rule in CLAUDE.md: never start the analyzer or import mediapipe / rembg /
torch locally). Each test calls the Flask view function directly; `request`
is the stub below, so no server, no port, no worker spawn.

Run:  python3 -m pytest tests/analyzer/ -q
  or: python3 tests/analyzer/test_photo_analyzer_contract.py   (no pytest needed)
"""
import os
import sys
import types
from unittest import mock

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


# ── stubs ────────────────────────────────────────────────────────────────────
class _Request:
    """Stand-in for flask.request: tests assign `json` per call."""
    json = None
    path = '/'
    query_string = b''
    headers = {}

    def get_json(self, silent=False):
        return self.json

    def get_data(self):
        return b''


class _Flask:
    """Every decorator (`route`, `before_request`, `teardown_request`, ...)
    returns the function unchanged so the module's views stay callable."""

    def __init__(self, *a, **k):
        self.config = {}

    def __getattr__(self, name):
        def deco(*a, **k):
            if a and callable(a[0]) and not k:
                return a[0]
            return lambda fn: fn
        return deco


def _install_stubs():
    flask = types.ModuleType('flask')
    flask.Flask = _Flask
    flask.request = _Request()
    flask.jsonify = lambda *a, **k: (a[0] if a else dict(k))
    sys.modules['flask'] = flask

    flask_cors = types.ModuleType('flask_cors')
    flask_cors.CORS = lambda app, **k: app
    sys.modules['flask_cors'] = flask_cors

    cv2 = mock.MagicMock(name='cv2')
    cv2.data.haarcascades = ''
    cv2.CascadeClassifier.return_value.empty.return_value = True
    sys.modules['cv2'] = cv2
    return flask, cv2


def _load_module():
    flask, cv2 = _install_stubs()
    os.environ['ANALYZER_ROLE'] = 'face'   # the role that serves /analyze
    sys.path.insert(0, ROOT)
    if 'photo_analyzer' in sys.modules:
        del sys.modules['photo_analyzer']
    import photo_analyzer
    return photo_analyzer, flask, cv2


pa, _flask, _cv2 = _load_module()


def _call(view):
    rv = view()
    return rv if isinstance(rv, tuple) else (rv, 200)


NO_FACE = {"success": False, "error": "no_face_detected",
           "error_message": "No face was detected in the photo."}


# ── /analyze status contract ────────────────────────────────────────────────
def test_analyze_no_face_is_a_200_result_not_a_server_error():
    """no_face_detected is an answer about the user's photo, not a failure of
    the service. Node (routes/avatars.js, routes/trial.js) checks
    `analyzerResponse.ok` FIRST and turns every non-2xx into a 502 "Photo
    analysis service error" — so a 500 here makes the `error ===
    'no_face_detected'` branch unreachable and the user sees the generic
    failure message instead of t.noFaceDetected."""
    _flask.request.json = {"image": "data:image/jpeg;base64,AAAA"}
    with mock.patch.object(pa, 'process_photo', return_value=dict(NO_FACE)):
        body, status = _call(pa.analyze_photo)
    assert status == 200
    assert body["success"] is False
    assert body["error"] == "no_face_detected"


def test_analyze_real_failure_stays_500():
    _flask.request.json = {"image": "data:image/jpeg;base64,AAAA"}
    failed = {"success": False, "error": "Failed to load image"}
    with mock.patch.object(pa, 'process_photo', return_value=failed):
        body, status = _call(pa.analyze_photo)
    assert status == 500
    assert body["error"] == "Failed to load image"


def test_analyze_missing_image_is_400():
    _flask.request.json = {}
    body, status = _call(pa.analyze_photo)
    assert status == 400


# ── process_photo must not persist the upload ───────────────────────────────
def test_process_photo_writes_no_copy_of_the_photo_to_disk():
    """A decoded copy of every uploaded photo used to be written to TEMP_DIR
    (one shared filename for every concurrent request) — the same class of
    leak the comment above the decode step says was removed."""
    _cv2.reset_mock()
    _cv2.imdecode.return_value = np.zeros((100, 80, 3), dtype=np.uint8)
    one_face = [{'id': 0, 'x': 30.0, 'y': 20.0, 'width': 20.0, 'height': 25.0,
                 'confidence': 0.99}]
    with mock.patch.object(pa, 'detect_all_faces_mediapipe', return_value=one_face), \
         mock.patch.object(pa, 'remove_background', return_value=(None, None)):
        result = pa.process_photo("data:image/jpeg;base64,AAAA", is_base64=True)
    assert result["face_count"] == 1
    assert not _cv2.imwrite.called, \
        f"photo written to disk: {[c.args[0] for c in _cv2.imwrite.call_args_list]}"


# ── shared face detector under concurrent requests ─────────────────────────
class _NotThreadSafeDetector:
    """Behaves like mtcnn_cv2's MTCNN (cv2.dnn Nets): a second thread entering
    while one is inside corrupts the shared net. Staging, 2026-10-07: 3 parallel
    trial uploads, 2 answered no_face_detected for photos with a clear face."""
    def __init__(self):
        import threading as _t
        self.inside = 0
        self.max_inside = 0
        self._guard = _t.Lock()

    def detect_faces(self, rgb):
        import time as _time
        with self._guard:
            self.inside += 1
            self.max_inside = max(self.max_inside, self.inside)
            clash = self.inside > 1
        try:
            _time.sleep(0.05)
            if clash:
                raise RuntimeError('cv2.dnn: net reused concurrently')
            return [{'box': [10, 10, 30, 30], 'confidence': 0.99}]
        finally:
            with self._guard:
                self.inside -= 1


def test_concurrent_detections_never_overlap_and_all_find_the_face():
    import threading as _t
    det = _NotThreadSafeDetector()
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    results, errors = [], []

    def run():
        try:
            results.append(pa.detect_all_faces_mtcnn(img, min_confidence=0.9))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    with mock.patch.object(pa, 'mtcnn_detector', det), mock.patch.object(pa, 'MTCNN_AVAILABLE', True):
        threads = [_t.Thread(target=run) for _ in range(3)]
        for t in threads: t.start()
        for t in threads: t.join()
    assert det.max_inside == 1, f"detector entered by {det.max_inside} threads at once"
    assert not errors, errors
    assert [len(r) for r in results] == [1, 1, 1]


def test_a_detector_failure_is_an_error_not_no_face():
    """Returning [] on a detector exception made /analyze answer
    no_face_detected; the failure must surface as success:false with the
    detector error (HTTP 500 from /analyze), never as 'no face'."""
    class Broken:
        def detect_faces(self, rgb):
            raise RuntimeError('boom')
    _cv2.imdecode.return_value = np.zeros((100, 80, 3), dtype=np.uint8)
    with mock.patch.object(pa, 'mtcnn_detector', Broken()), mock.patch.object(pa, 'MTCNN_AVAILABLE', True):
        result = pa.process_photo("data:image/jpeg;base64,AAAA", is_base64=True)
    assert result["success"] is False
    assert result["error"] != "no_face_detected"
    assert "face detection failed" in result["error"]


if __name__ == '__main__':
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception as e:  # noqa: BLE001
                failures += 1
                print(f"FAIL {name}: {type(e).__name__}: {e}")
    sys.exit(1 if failures else 0)
