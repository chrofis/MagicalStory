#!/usr/bin/env python3
"""
Photo Analyzer API - Face Detection and Background Removal
Uses MediaPipe for fast face detection and background removal (no heavy AI models)
"""

# Disable MediaPipe GPU to avoid OpenGL/EGL errors on headless systems
import os
os.environ["MEDIAPIPE_DISABLE_GPU"] = "1"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"  # Suppress TF/MediaPipe C++ logs


# ── Boot memory instrumentation ─────────────────────────────────────────────
# Railway bills resident memory per MB per MINUTE, so whatever this process
# holds at boot is charged 24/7 whether or not a single photo is ever uploaded.
# This service idled at 1035 MB with NO heavy model loaded, and we had no way to
# say which import owned it. These marks attribute the floor to a specific
# import block; the totals are also served from /health so they can be read
# without log access. Defined before the heavy imports so it can measure them.
def _rss_mb():
    """Current resident set size in MB (Linux /proc), or None."""
    try:
        with open('/proc/self/status') as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    return round(int(line.split()[1]) / 1024, 1)
    except Exception:
        return None
    return None


BOOT_RSS_LOG = []
_boot_last_rss = None


def _boot_mark(label):
    """Record RSS at this point in module load, plus the delta since the last mark."""
    global _boot_last_rss
    rss = _rss_mb()
    if rss is None:
        return  # non-Linux (local dev) — instrumentation is a no-op
    delta = None if _boot_last_rss is None else round(rss - _boot_last_rss, 1)
    _boot_last_rss = rss
    BOOT_RSS_LOG.append({"stage": label, "rss_mb": rss, "delta_mb": delta})
    suffix = "" if delta is None else f"   (+{delta} MB)"
    print(f"[BOOT-RSS] {label:<26} rss={rss:8.1f} MB{suffix}")


_boot_mark("python interpreter")

from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import base64
from io import BytesIO
from PIL import Image
import traceback
import logging
import sys
import time
import threading
import gc

_boot_mark("flask+cv2+numpy+PIL")

# Fix Windows encoding issues - force UTF-8 for stdout/stderr
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Suppress Flask development server warning
cli = sys.modules.get('flask.cli')
if cli:
    cli.show_server_banner = lambda *args: None
logging.getLogger('werkzeug').setLevel(logging.ERROR)
logging.getLogger('mediapipe').setLevel(logging.CRITICAL)

app = Flask(__name__)
CORS(app)
# Cap request body at 16 MB. Image endpoints decode base64 then expand into
# numpy arrays; without this guard a 20 MB base64 payload (~14 MP image)
# balloons to 50+ MB of process memory per request, and rembg on top of
# that can hit 200–400 MB. The cap rejects oversized inputs at the Flask
# layer before any decoding happens, removing the DoS vector.
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
# Per-image pixel cap applied AFTER cv2.imdecode but BEFORE rembg / heavy
# pipelines. Anything larger is downscaled proportionally.
MAX_IMAGE_DIM = 2048

# ── Request accounting ──────────────────────────────────────────────────────
# In-flight counting is what makes the worker reap safe: workers are only ever
# killed when the session count is zero AND nothing is mid-request. The
# RSS-threshold self-recycler and its warm-hold that lived here were deleted
# 2026-08-23 — heavy models run in worker processes now, whose exit returns
# everything (fragmentation and torch pools included, which malloc_trim
# measurably could not: 1192.2MB -> 1192.9MB on staging).
_request_lock = threading.Lock()
_inflight_requests = 0
_last_request_ts = time.time()
# Monotonic count of request ARRIVALS. Only ever compared for equality, so
# wraparound is irrelevant; see kill_workers(expect_epoch=...).
_request_epoch = 0

# ── Process role ─────────────────────────────────────────────────────────────
# The analyzer runs as a lean PARENT (port 5000, pure cv2/PIL — ~53MB) that
# proxies model endpoints to short-lived WORKER processes it spawns on demand:
#   face    (5001)  mediapipe               ~300MB   /analyze, /extract-face
#   rembg   (5002)  rembg/U2-Net             ~80MB   /remove-bg, /silhouette-edge
#   torch   (5003)  SAM/pose/lpips/DINO   148MB-2GB  /figure-mask, /pose-heads,
#                                                    /lpips, /detect-figures-text
#   arcface (5004)  TF/deepface (+mediapipe) ~790MB  /face-embedding, /compare-identity
# Workers die when the active-session count hits zero (see the session block),
# which returns ALL of their memory to the OS. Python cannot un-import a module,
# so every in-process scheme (RSS thresholds, idle reapers) was guesswork; this
# replaces all of it with one rule. Owner direction 2026-08-23: "if a story is
# done everything should be freed again — no arbitrary recycling."
ANALYZER_ROLE = os.environ.get('ANALYZER_ROLE', 'parent')
WORKER_PORTS = {'face': 5001, 'torch': 5003, 'arcface': 5004}
WORKER_ENDPOINTS = {
    # 'face' owns the WHOLE photo-upload path — face detection AND background
    # removal. They were separate workers until 2026-08-23, when staging showed
    # U2-Net loading TWICE ([REMBG] U2-Net loaded at 1126.8MB in face and again
    # at 690.1MB in rembg): /analyze removes the background in-process, so the
    # face worker needs its own session, and a separate rembg worker then paid
    # for a second copy of the same ~600MB model plus another process base.
    # They are always warmed together by presence anyway, so splitting them
    # bought nothing.
    #
    # /split-grid is here because it calls detect_face_mediapipe: in a
    # mediapipe-less parent that helper silently degrades to a Haar cascade —
    # the exact failure mode that produced garbage likeness scores on
    # 2026-08-22. Anything that MIGHT touch mediapipe runs where mediapipe IS.
    # /face-embedding-onnx needs Face Mesh for alignment -> face as well.
    'face': {'/analyze', '/extract-face', '/split-grid', '/face-embedding-onnx',
             '/remove-bg', '/silhouette-edge'},
    'torch': {'/figure-mask', '/pose-heads', '/lpips', '/detect-figures-text'},
    # /detect-all-faces embeds faces via DeepFace to dedupe them -> needs TF.
    'arcface': {'/face-embedding', '/compare-identity', '/detect-all-faces'},
}
_ROLE_FOR_PATH = {p: role for role, paths in WORKER_ENDPOINTS.items() for p in paths}

# Try to initialize MediaPipe (may fail on newer Python versions)
mp_face_detection = None
mp_selfie_segmentation = None
MEDIAPIPE_AVAILABLE = False
MEDIAPIPE_TASKS_AVAILABLE = False
mp_tasks_face_detector = None

try:
    # The parent must NOT import mediapipe: it is 299MB (measured) and was more
    # than half of the analyzer's idle footprint, resident even when no face was
    # ever detected. Only the roles that detect faces pay for it. arcface needs
    # it too — Face Mesh supplies the 5 landmarks ArcFace aligns on.
    if ANALYZER_ROLE not in ('face', 'arcface'):
        raise ImportError('mediapipe deferred to the face/arcface workers')
    import mediapipe as mp
    # Check if legacy solutions API is available
    if hasattr(mp, 'solutions'):
        mp_face_detection = mp.solutions.face_detection
        mp_selfie_segmentation = mp.solutions.selfie_segmentation
        MEDIAPIPE_AVAILABLE = True
        print("[OK] MediaPipe legacy API available")
    elif hasattr(mp, 'tasks'):
        # Try new Tasks API (Python 3.14+)
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        # Download model if needed
        model_path = os.path.join(os.path.dirname(__file__), 'blaze_face_short_range.tflite')
        if not os.path.exists(model_path):
            print("[INFO] Downloading MediaPipe face detection model...")
            import urllib.request
            model_url = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
            urllib.request.urlretrieve(model_url, model_path)
            print(f"[OK] Downloaded model to {model_path}")

        MEDIAPIPE_TASKS_AVAILABLE = True
        print("[OK] MediaPipe Tasks API available (Python 3.14+)")
    else:
        print("[WARN] MediaPipe installed but no usable API found")
except ImportError:
    print("[WARN] MediaPipe not installed - face detection disabled")

_boot_mark("mediapipe")

# Try to initialize MTCNN (best accuracy)
# Try mtcnn-opencv first (lightweight, no TensorFlow), then fall back to mtcnn (TensorFlow)
MTCNN_AVAILABLE = False
mtcnn_detector = None
try:
    from mtcnn_cv2 import MTCNN
    mtcnn_detector = MTCNN()
    MTCNN_AVAILABLE = True
    print("[OK] MTCNN face detector available (OpenCV version)")
except ImportError:
    try:
        from mtcnn import MTCNN
        mtcnn_detector = MTCNN()
        MTCNN_AVAILABLE = True
        print("[OK] MTCNN face detector available (TensorFlow version)")
    except ImportError:
        print("[INFO] MTCNN not available - will use MediaPipe fallback")

# rembg / U2-Net background removal — LAZY.
#
# This used to build the U2-Net ONNX session at import, so every container held
# the model 24/7 even if no photo was ever uploaded. Railway bills resident
# memory per minute, which made that a permanent charge for an idle capability
# (~$10/month per GB held). MobileSAM and GroundingDINO below were already lazy
# with an idle reaper — the two BIGGEST models were on demand while this smaller
# one was eager, which was backwards.
#
# Now: the session is built on first use and reaped after idle, same as the
# others. REMBG_AVAILABLE only reports whether the module is importable, which
# is checked via find_spec so it costs nothing at boot.
import importlib.util

try:
    # find_spec only LOCATES the module — it does not import rembg or build the
    # ONNX session, so this costs nothing at boot. It can still raise on a
    # broken/partial install, which must not take the whole service down.
    REMBG_AVAILABLE = importlib.util.find_spec("rembg") is not None
except Exception as _e:
    print(f"[WARN] rembg availability check failed: {_e}")
    REMBG_AVAILABLE = False
rembg_remove = None
_rembg_session = None
_rembg_last_used = 0.0
# Serialize the import + session build. Photo analysis runs concurrently, so two
# threads racing `from rembg import ...` would otherwise double-load the model.
_rembg_lock = threading.Lock()
_REMBG_IDLE_UNLOAD_S = int(os.environ.get('REMBG_IDLE_UNLOAD_S', '900'))

if REMBG_AVAILABLE:
    print("[OK] rembg background removal available (U2-Net, lazy)")
else:
    print("[INFO] rembg not installed - MediaPipe fallback will be used")


def get_rembg_session():
    """Build (or reuse) the U2-Net session. Returns None if rembg is unusable."""
    global rembg_remove, _rembg_session, _rembg_last_used
    _rembg_last_used = time.time()
    if _rembg_session is not None:
        return _rembg_session
    if not REMBG_AVAILABLE:
        return None
    with _rembg_lock:
        if _rembg_session is None:  # re-check under the lock
            try:
                from rembg import remove as _remove, new_session
                print("[REMBG] Loading U2-Net session...")
                _rembg_session = new_session("u2net")
                rembg_remove = _remove
                _rembg_last_used = time.time()
                print(f"[REMBG] U2-Net loaded — RSS now {_rss_mb()} MB")
            except Exception as e:
                # Stay None so the caller falls back to MediaPipe rather than 500ing.
                print(f"[WARN] rembg initialization failed: {e}")
                return None
    return _rembg_session

_boot_mark("rembg (lazy — not loaded)")

# Create temp directory for processing
TEMP_DIR = os.path.join(os.path.dirname(__file__), 'temp_photos')
os.makedirs(TEMP_DIR, exist_ok=True)

# Load the OpenCV frontal-face Haar cascade ONCE at module load. Per-request
# CascadeClassifier(...) parses + loads the XML every call (~10–30 ms wasted).
# detect_face_opencv() / detect_all_faces_opencv() now read this global.
try:
    _FRONTAL_FACE_CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    if _FRONTAL_FACE_CASCADE.empty():
        print("[WARN] Frontal face cascade failed to load")
        _FRONTAL_FACE_CASCADE = None
    else:
        print("[OK] Frontal face cascade loaded (Haar)")
except Exception as _e:
    print(f"[WARN] Frontal face cascade init error: {_e}")
    _FRONTAL_FACE_CASCADE = None

# Load anime face cascade (for illustrated/cartoon faces)
ANIME_CASCADE_AVAILABLE = False
anime_face_cascade = None
try:
    cascade_path = os.path.join(os.path.dirname(__file__), 'lbpcascade_animeface.xml')
    if os.path.exists(cascade_path):
        anime_face_cascade = cv2.CascadeClassifier(cascade_path)
        if not anime_face_cascade.empty():
            ANIME_CASCADE_AVAILABLE = True
            print("[OK] Anime face cascade available (lbpcascade_animeface)")
        else:
            print("[WARN] Anime face cascade failed to load")
    else:
        print("[INFO] Anime face cascade not found at:", cascade_path)
except Exception as e:
    print(f"[WARN] Anime face cascade error: {e}")

_boot_mark("haar cascades (ready)")


# Observing the process must not keep it alive. /health is polled by monitoring
# and by /api/health/memory, so counting it as activity would reset the idle
# timer forever and the recycler could never fire — the watcher would silently
# prevent the thing it was watching. These paths are still counted as in-flight
# (we must not exit mid-response), just not as *activity*.
_NON_ACTIVITY_PATHS = frozenset({'/health', '/release-memory'})


def _is_activity(path):
    return path not in _NON_ACTIVITY_PATHS


@app.before_request
def _track_request_start():
    """Count in-flight work so the recycler can prove the process is idle."""
    global _inflight_requests, _last_request_ts, _request_epoch
    with _request_lock:
        _inflight_requests += 1
        # Bumped on EVERY arrival so a reaper that has already read "idle" can
        # detect that the world changed under it before it terminates anything.
        # See kill_workers(expect_epoch=...).
        _request_epoch += 1
        if _is_activity(request.path):
            _last_request_ts = time.time()


@app.teardown_request
def _track_request_end(exc=None):
    global _inflight_requests, _last_request_ts
    with _request_lock:
        _inflight_requests = max(0, _inflight_requests - 1)
        # Stamp on the way OUT too: a 90s mask call must count as activity at
        # the moment it FINISHES, not when it started, or a long inference could
        # age past the idle window while it is still running.
        try:
            if _is_activity(request.path):
                _last_request_ts = time.time()
        except Exception:
            # teardown can run without a request context in edge cases
            pass
    # Sessionless work (a photo upload that never becomes an avatar job) must
    # not leave workers squatting: with no session active, workers live only as
    # long as requests do. Event-driven — this is the whole reason there is no
    # idle timer anywhere in this file.
    if ANALYZER_ROLE == 'parent':
        try:
            _maybe_reap_workers()
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════════════════
# Worker lifecycle — the ONLY memory-management mechanism in this service.
#
# This replaced _recycle_watchdog (RSS>700MB threshold), _idle_model_reaper
# (per-model idle timers) and _arcface_idle_recycler (2026-08-23). All three
# were guesses about when memory was safe to reclaim, and each had a measured
# failure: the RSS threshold never fired at 551MB resident, the ArcFace reaper
# required a service-wide idle that never occurs during Lab runs, and none of
# them could return TensorFlow's allocator arenas at all. Killing a process
# returns 100%, deterministically. Owner direction: no arbitrary thresholds.
#
# Rules:
#   - Node brackets real work with /session/begin and /session/end (refcounted;
#     two concurrent stories never kill each other's workers).
#   - When the count hits zero and nothing is in flight, ALL workers are killed.
#   - A request OUTSIDE any session (e.g. a photo upload that never becomes an
#     avatar job) spawns workers per-request: the zero-session check also runs
#     on request completion, so they die seconds later instead of squatting.
#   - /session/reset (Node calls it at boot) zeroes the count and kills workers,
#     so a crashed-and-restarted Node can never leak sessions. In the container
#     this is redundant (start.sh exits with Node, killing everything) but local
#     dev restarts Node independently.
#   - Workers watch the parent PID and exit if it dies, so a crashed parent
#     cannot orphan a 2GB torch worker onto its port.
# ═══════════════════════════════════════════════════════════════════════════
import json
import subprocess
import urllib.request as _urlreq
import urllib.error as _urlerr

_workers_lock = threading.Lock()
_workers = {}            # role -> subprocess.Popen
_active_sessions = 0
# Roles currently being brought up — spawned, or alive but not yet answering
# /health. A worker in here is NOT reap-eligible: see kill_workers().
# REFCOUNTED, not a set: /warmup's thread and a concurrent photo upload can both
# be waiting on the same role, and whichever finished first would otherwise drop
# the protection while the other was still waiting.
_bringing_up = {}

def _note_arcface_used():
    """Stub kept for the embed paths; lifecycle is session-driven now."""
    return None


def _worker_alive(role):
    proc = _workers.get(role)
    return proc is not None and proc.poll() is None


def _worker_health_ok(role, timeout=2):
    try:
        with _urlreq.urlopen(f"http://127.0.0.1:{WORKER_PORTS[role]}/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def ensure_worker(role, wait_ready=True):
    """Spawn (or adopt) the worker for `role`; return its base URL.

    Adoption: if something already answers /health on the role's port — an
    orphan from a previous parent that hasn't noticed the PID change yet — use
    it rather than colliding with the port.

    ALIVE IS NOT READY (2026-09-05). `_worker_alive` only tests `poll() is
    None`, which a process that has started but not yet bound its port passes.
    Returning early on it handed callers a URL that answers `[Errno 111]
    Connection refused` — the 502 a user got on the first photo upload after a
    deploy. So a live-but-unproven worker falls through to the readiness poll
    below instead of short-circuiting; once it is serving, the poll costs one
    loopback /health call.

    The role is held in `_bringing_up` for the whole wait so the idle reaper
    cannot terminate a worker that is still starting. Without that, warmup
    could never work at all: /warmup returns immediately and spawns on a
    background thread, so its own request teardown fires `_maybe_reap_workers`
    with sessions=0 and nothing in flight, and killed the worker it had just
    asked for.
    """
    url = f"http://127.0.0.1:{WORKER_PORTS[role]}"
    with _workers_lock:
        if not _worker_alive(role):
            if _worker_health_ok(role):
                print(f"[WORKERS] adopting existing {role} worker on :{WORKER_PORTS[role]}")
                return url
            env = dict(os.environ)
            env['ANALYZER_ROLE'] = role
            env['PHOTO_ANALYZER_PORT'] = str(WORKER_PORTS[role])
            env['ANALYZER_PARENT_PID'] = str(os.getpid())
            print(f"[WORKERS] spawning {role} worker on :{WORKER_PORTS[role]}")
            _workers[role] = subprocess.Popen(
                [sys.executable, '-u', os.path.abspath(__file__)], env=env)
        if not wait_ready:
            return url
        _bringing_up[role] = _bringing_up.get(role, 0) + 1
    try:
        # Model imports gate readiness (mediapipe ~5s, TF ~15s). Poll rather
        # than sleep so the fast workers don't pay the slow ones' budget.
        deadline = time.time() + 120
        while time.time() < deadline:
            if _worker_health_ok(role):
                break
            if not _worker_alive(role):
                raise RuntimeError(f"{role} worker exited during startup")
            time.sleep(0.5)
        else:
            raise RuntimeError(f"{role} worker not ready within 120s")
    finally:
        with _workers_lock:
            if _bringing_up.get(role, 0) > 1:
                _bringing_up[role] -= 1
            else:
                _bringing_up.pop(role, None)
    return url


def kill_workers(reason, expect_epoch=None, force=False):
    """Terminate every worker. Deterministic, total reclaim — that's the point.

    `expect_epoch` closes a TOCTOU race. `_maybe_reap_workers` reads "no session,
    nothing in flight" under `_request_lock`, RELEASES it, and only then calls
    here — so a request arriving in that gap increments the in-flight count,
    calls `ensure_worker()` (which sees a live worker), issues its HTTP call, and
    is then terminated underneath, surfacing as a 502. Holding `_request_lock`
    across the kill is not an option: `terminate()` + `wait(5)` would block all
    request accounting for up to five seconds.

    So the caller passes the epoch it made its decision on, and we abort if any
    request has arrived since. The int read needs no lock — it is a single
    CPython bytecode — and the remaining window is microseconds instead of the
    whole check-to-kill span. Returns True if the kill actually happened.
    """
    if expect_epoch is not None and _request_epoch != expect_epoch:
        print(f"[WORKERS] kill aborted ({reason}): a request arrived since the "
              f"idle check (epoch {expect_epoch} -> {_request_epoch})")
        return False
    with _workers_lock:
        # The epoch guard above only sees REQUESTS. A worker brought up off a
        # request — /warmup does exactly that, on a background thread — is
        # invisible to it, and killing one mid-startup surfaces to the user as
        # a 502 from their first photo upload after a deploy.
        # `force` is the deliberate override: /release-memory?force=true is
        # documented as "kill it anyway", and a Node-boot reset is claiming a
        # clean slate. Everything else waits.
        if _bringing_up and not force:
            print(f"[WORKERS] kill aborted ({reason}): "
                  f"{', '.join(sorted(_bringing_up))} still starting")
            return False
        for role, proc in list(_workers.items()):
            if proc.poll() is None:
                print(f"[WORKERS] killing {role} worker ({reason})")
                try:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                except Exception as e:
                    print(f"[WORKERS] kill {role} failed: {e}")
            _workers.pop(role, None)
    return True


# A session that has seen no request traffic for this long did not end cleanly.
# Generous on purpose: a real story issues analyzer calls throughout, and the
# gap between its stages is minutes, not half an hour.
_SESSION_LEAK_TIMEOUT_S = int(os.environ.get('SESSION_LEAK_TIMEOUT_S', '1800'))


def _maybe_reap_workers():
    """Kill workers when no session is active and nothing is in flight.

    Called from session/end AND from request teardown — the latter is what
    reaps sessionless work (photo uploads) seconds after it finishes.
    Also reclaims a session that leaked (see the stuck-session block below).
    """
    global _active_sessions
    with _request_lock:
        # Only ever called from request TEARDOWN, after the decrement — so the
        # finishing request is no longer counted and >0 means someone else is
        # genuinely mid-request.
        busy = _inflight_requests > 0
        sessions = _active_sessions
        epoch = _request_epoch
    if sessions == 0 and not busy and _workers:
        # Pass the epoch: if a request arrived between the check above and the
        # kill, abort rather than terminate a worker mid-call.
        if kill_workers('sessions=0, idle', expect_epoch=epoch):
            # The workers are gone, so their library mappings are gone with them
            # — this is the one moment the page cache is droppable. Story over,
            # cache released, without waiting for a restart that may never come.
            _drop_file_cache_async('workers reaped')
        return

    # ── Stuck-session recovery (2026-09-05) ──
    # `sessions` is a refcount, and a session that never ends pins it above zero
    # forever: the reap above can then NEVER fire, workers stay resident and the
    # page cache is never released.
    #
    # This used to self-heal by accident. The analyzer ran inside the Node
    # container, so a Node restart restarted the analyzer and zeroed the counter
    # whether or not /session/reset was delivered. Since the analyzer became its
    # own Railway service (2026-09-04) that coupling is GONE — Node can restart
    # all it likes and this process keeps its stale count. `sessionReset()` is
    # fire-and-forget with one 5s retry (analyzerClient.js), and the paths that
    # leak a session are exactly the ones where that call is most likely to
    # miss.
    #
    # So: a session that has seen no request traffic at all for this long did not
    # end cleanly. Reclaim it. The guard is REQUEST activity, not wall-clock —
    # a genuinely long story is issuing analyzer calls throughout, and any
    # in-flight request blocks this.
    if sessions > 0 and not busy and _workers:
        idle_for = time.time() - _last_request_ts
        if idle_for > _SESSION_LEAK_TIMEOUT_S:
            print(f"[SESSIONS] {sessions} session(s) open but no request for "
                  f"{idle_for:.0f}s — treating as leaked, resetting to 0")
            with _request_lock:
                _active_sessions = 0
            if kill_workers('leaked session reclaimed', expect_epoch=epoch):
                _drop_file_cache_async('leaked session reclaimed')


@app.route('/session/begin', methods=['POST'])
def session_begin():
    global _active_sessions
    with _request_lock:
        _active_sessions += 1
        n = _active_sessions
    print(f"[SESSION] begin -> {n} active")
    return jsonify({"success": True, "active": n})


@app.route('/session/end', methods=['POST'])
def session_end():
    global _active_sessions
    with _request_lock:
        _active_sessions = max(0, _active_sessions - 1)
        n = _active_sessions
    print(f"[SESSION] end -> {n} active")
    # No reap here: the teardown hook fires _maybe_reap_workers the moment THIS
    # request finishes, with the counter already decremented. One trigger path,
    # no race between a route-spawned thread and the teardown accounting.
    return jsonify({"success": True, "active": n})


@app.route('/session/reset', methods=['POST'])
def session_reset():
    """Node calls this at boot: a restarted Node cannot know how many sessions
    its predecessor left open, so the only correct count is zero."""
    global _active_sessions
    with _request_lock:
        _active_sessions = 0
    # force: a restarted Node is claiming a clean slate, so a worker left
    # starting by the previous era must not survive the reset.
    kill_workers('session reset (Node boot)', force=True)
    # Same reasoning as the idle reap: the workers are gone, so their library
    # mappings are gone and the page cache is droppable. This path matters MORE,
    # not less — it is the recovery route for a session that leaked (a crashed
    # job, a killed generation), which is exactly the case where the idle reaper
    # never fired and the cache has been sitting billed since.
    _drop_file_cache_async('session reset (Node boot)')
    return jsonify({"success": True, "active": 0})


@app.before_request
def _proxy_to_worker():
    """Parent-only: forward model endpoints to their worker, spawning it first.

    Bodies pass through verbatim — every endpoint keeps its exact contract, so
    no Node caller changes. Returning a response here short-circuits the local
    route, which is how the parent serves 22 paths while importing none of the
    model libraries.
    """
    if ANALYZER_ROLE != 'parent':
        return None
    role = _ROLE_FOR_PATH.get(request.path)
    if role is None:
        return None
    try:
        base = ensure_worker(role)
    except Exception as e:
        return jsonify({"success": False, "error": f"{role} worker unavailable: {e}"}), 503
    try:
        url = f"{base}{request.path}" + (f"?{request.query_string.decode()}" if request.query_string else "")
        req = _urlreq.Request(
            url,
            data=request.get_data(),
            headers={'Content-Type': request.headers.get('Content-Type', 'application/json')},
            method=request.method,
        )
        with _urlreq.urlopen(req, timeout=600) as r:
            return app.response_class(r.read(), status=r.status, mimetype='application/json')
    except _urlerr.HTTPError as e:
        return app.response_class(e.read(), status=e.code, mimetype='application/json')
    except Exception as e:
        return jsonify({"success": False, "error": f"{role} worker call failed: {e}"}), 502


def _parent_watchdog():
    """Worker-only: exit when the spawning parent is gone. Without this, a
    crashed parent leaves a 2GB orphan squatting on the port, and the NEXT
    parent adopts a worker whose lifecycle nobody owns."""
    ppid = int(os.environ.get('ANALYZER_PARENT_PID', '0'))
    if not ppid:
        return
    import psutil
    while True:
        time.sleep(5)
        if not psutil.pid_exists(ppid):
            print(f"[WORKERS] parent {ppid} gone — exiting")
            sys.stdout.flush()
            os._exit(0)


if ANALYZER_ROLE != 'parent':
    threading.Thread(target=_parent_watchdog, daemon=True).start()


def detect_all_faces_anime(image, min_size=30, scale_factor=1.1, min_neighbors=2):
    """
    Detect faces in illustrated/anime images using lbpcascade_animeface.
    Returns list of faces with bounding boxes.
    """
    if not ANIME_CASCADE_AVAILABLE or anime_face_cascade is None:
        print("[WARN] Anime face cascade not available")
        return []

    try:
        # Convert to grayscale for detection
        if len(image.shape) == 3:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            gray = image

        # Equalize histogram for better detection
        gray = cv2.equalizeHist(gray)

        height, width = gray.shape[:2]

        # Detect faces - anime cascade works better with smaller scale factor
        faces_detected = anime_face_cascade.detectMultiScale(
            gray,
            scaleFactor=scale_factor,
            minNeighbors=min_neighbors,
            minSize=(min_size, min_size)
        )

        faces = []
        for idx, (x, y, w, h) in enumerate(faces_detected):
            # Filter out detections in bottom 25% of image (usually shoes/feet)
            if y + h/2 > height * 0.75:
                print(f"[ANIME] Skipping detection at y={y} (bottom of image, likely shoes)")
                continue

            faces.append({
                'index': len(faces),
                'box': {
                    'x': int(x),
                    'y': int(y),
                    'width': int(w),
                    'height': int(h)
                },
                'confidence': 0.8,  # Cascade doesn't give confidence, assume reasonable
                'detector': 'anime_cascade'
            })

        print(f"[ANIME] Detected {len(faces)} faces (filtered)")
        return faces

    except Exception as e:
        print(f"[ANIME] Error: {e}")
        return []


def detect_all_faces_mtcnn(image, min_confidence=0.9):
    """
    Detect ALL faces using MTCNN (accurate and lightweight).
    Returns list of faces sorted by confidence (highest first).
    """
    if not MTCNN_AVAILABLE or mtcnn_detector is None:
        return []

    try:
        img_h, img_w = image.shape[:2]

        # MTCNN expects RGB, OpenCV uses BGR
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # Detect faces
        faces_data = mtcnn_detector.detect_faces(rgb_image)

        faces = []
        for idx, face in enumerate(faces_data):
            conf = face.get('confidence', 0)
            if conf < min_confidence:
                continue

            # MTCNN returns box as [x, y, width, height]
            box = face.get('box', [0, 0, 0, 0])
            x, y, w, h = box

            faces.append({
                'id': idx,
                'x': (x / img_w) * 100,
                'y': (y / img_h) * 100,
                'width': (w / img_w) * 100,
                'height': (h / img_h) * 100,
                'confidence': conf
            })

        # Sort by confidence (highest first), then by x position for stability
        # This ensures consistent ordering between API calls when confidence is similar
        faces.sort(key=lambda f: (-f['confidence'], f['x']))
        for i, face in enumerate(faces):
            face['id'] = i

        print(f"[MTCNN] Detected {len(faces)} faces")
        return faces

    except Exception as e:
        print(f"[MTCNN] Error: {e}")
        return []


def detect_face_opencv(image):
    """
    Fallback face detection using OpenCV's Haar cascade.
    Used when MediaPipe is not available (e.g., Python 3.14+).
    Returns bounding box as percentage of image dimensions (0-100)
    """
    # Module-level cascade (loaded once at startup) — see _FRONTAL_FACE_CASCADE.
    face_cascade = _FRONTAL_FACE_CASCADE
    if face_cascade is None:
        return None

    # Convert to grayscale for detection
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Detect faces
    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(30, 30)
    )

    if len(faces) > 0:
        # Get the largest face (by area)
        largest = max(faces, key=lambda f: f[2] * f[3])
        x, y, w, h = largest
        img_h, img_w = image.shape[:2]

        return {
            'x': (x / img_w) * 100,
            'y': (y / img_h) * 100,
            'width': (w / img_w) * 100,
            'height': (h / img_h) * 100,
            'confidence': 0.8  # Haar cascade doesn't provide confidence
        }

    return None


def detect_face_mediapipe(image):
    """
    Detect face using MediaPipe Face Detection.
    Falls back to OpenCV Haar cascade if MediaPipe is unavailable.
    Returns bounding box as percentage of image dimensions (0-100)
    """
    if not MEDIAPIPE_AVAILABLE:
        # Fallback to OpenCV when MediaPipe is not available (Python 3.14+)
        return detect_face_opencv(image)

    with mp_face_detection.FaceDetection(
        model_selection=1,  # 0 for close faces, 1 for far faces
        min_detection_confidence=0.5
    ) as face_detection:
        # Convert BGR to RGB
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = face_detection.process(rgb_image)

        if results.detections:
            # Get the first (most confident) detection
            detection = results.detections[0]
            bbox = detection.location_data.relative_bounding_box

            # Convert to percentage (0-100)
            return {
                'x': bbox.xmin * 100,
                'y': bbox.ymin * 100,
                'width': bbox.width * 100,
                'height': bbox.height * 100,
                'confidence': detection.score[0]
            }

    return None


def detect_all_faces_opencv(image):
    """
    Fallback to detect all faces using OpenCV's Haar cascade.
    Returns list of faces sorted by size (largest first).
    More strict settings to reduce false positives.
    """
    # Module-level cascade (loaded once at startup) — see _FRONTAL_FACE_CASCADE.
    face_cascade = _FRONTAL_FACE_CASCADE
    if face_cascade is None:
        return []

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    img_h, img_w = image.shape[:2]

    # Minimum face size: at least 4% of smaller image dimension (not too strict)
    min_face_size = int(min(img_w, img_h) * 0.04)
    min_face_size = max(min_face_size, 30)  # At least 30px (original OpenCV default)

    faces_detected = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,  # Keep original to catch more faces
        minSize=(min_face_size, min_face_size)
    )

    faces = []

    for idx, (x, y, w, h) in enumerate(faces_detected):
        # Additional filter: face should be roughly square-ish (not too elongated)
        aspect_ratio = w / h if h > 0 else 0
        if aspect_ratio < 0.5 or aspect_ratio > 2.0:
            continue  # Skip non-face-shaped detections

        faces.append({
            'id': idx,
            'x': (x / img_w) * 100,
            'y': (y / img_h) * 100,
            'width': (w / img_w) * 100,
            'height': (h / img_h) * 100,
            'confidence': 0.5  # Lower confidence - OpenCV is less reliable than MediaPipe
        })

    # Sort by size (area) descending - larger faces first
    faces.sort(key=lambda f: f['width'] * f['height'], reverse=True)

    # Re-number IDs after filtering
    for i, face in enumerate(faces):
        face['id'] = i

    return faces


def detect_all_faces_mediapipe_tasks(image, min_confidence=0.15):
    """
    Detect ALL faces using MediaPipe Tasks API (Python 3.14+).
    Returns list of faces sorted by confidence (highest first).
    """
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision

    model_path = os.path.join(os.path.dirname(__file__), 'blaze_face_short_range.tflite')

    # Create face detector
    base_options = mp_python.BaseOptions(model_asset_path=model_path)
    options = mp_vision.FaceDetectorOptions(
        base_options=base_options,
        min_detection_confidence=min_confidence
    )

    faces = []
    with mp_vision.FaceDetector.create_from_options(options) as detector:
        # Convert BGR to RGB
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # Create MediaPipe Image
        import mediapipe as mp
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_image)

        # Detect faces
        detection_result = detector.detect(mp_image)

        img_h, img_w = image.shape[:2]

        for idx, detection in enumerate(detection_result.detections):
            bbox = detection.bounding_box
            confidence = detection.categories[0].score if detection.categories else 0.5

            face = {
                'id': idx,
                'x': (bbox.origin_x / img_w) * 100,
                'y': (bbox.origin_y / img_h) * 100,
                'width': (bbox.width / img_w) * 100,
                'height': (bbox.height / img_h) * 100,
                'confidence': confidence
            }
            faces.append(face)

    # Sort by confidence, then by x position for stability between API calls
    faces.sort(key=lambda f: (-f['confidence'], f['x']))
    for i, face in enumerate(faces):
        face['id'] = i

    return faces


def detect_all_faces_mediapipe(image, min_confidence=0.15):
    """
    Detect ALL faces using MTCNN (most accurate).
    Falls back to MediaPipe only if MTCNN not available.
    No OpenCV fallback to avoid false positives.

    Returns: list of {id, x, y, width, height, confidence}
    """
    # Use MTCNN (most accurate) - no fallbacks to avoid false positives
    if MTCNN_AVAILABLE:
        return detect_all_faces_mtcnn(image, min_confidence=0.9)

    # Fall back to MediaPipe Tasks API if MTCNN not available
    if MEDIAPIPE_TASKS_AVAILABLE:
        faces = detect_all_faces_mediapipe_tasks(image, min_confidence=min_confidence)
        # Sort by confidence, then by x position for stability
        faces.sort(key=lambda f: (-f['confidence'], f['x']))
        for i, face in enumerate(faces):
            face['id'] = i
        return faces

    # Fall back to legacy MediaPipe if Tasks API not available
    if not MEDIAPIPE_AVAILABLE:
        print("[WARN] No face detector available (MTCNN, MediaPipe Tasks, or MediaPipe legacy)")
        return []

    faces = []
    rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    # Try BOTH model types and combine results for better detection
    # model_selection=0: close faces (within 2m), model_selection=1: far faces (up to 5m)
    for model_type in [0, 1]:
        with mp_face_detection.FaceDetection(
            model_selection=model_type,
            min_detection_confidence=0.1  # Very low - we filter ourselves at 0.15
        ) as face_detection:
            results = face_detection.process(rgb_image)

            if results.detections:
                for idx, detection in enumerate(results.detections):
                    confidence = detection.score[0]

                    # Filter by our threshold
                    if confidence < min_confidence:
                        continue

                    bbox = detection.location_data.relative_bounding_box
                    face = {
                        'id': len(faces),
                        'x': bbox.xmin * 100,
                        'y': bbox.ymin * 100,
                        'width': bbox.width * 100,
                        'height': bbox.height * 100,
                        'confidence': confidence
                    }

                    # Check if this face overlaps with existing faces (avoid duplicates)
                    is_duplicate = False
                    for existing in faces:
                        # Check if centers are close (within 10% of image)
                        center_x = face['x'] + face['width'] / 2
                        center_y = face['y'] + face['height'] / 2
                        existing_cx = existing['x'] + existing['width'] / 2
                        existing_cy = existing['y'] + existing['height'] / 2
                        if abs(center_x - existing_cx) < 10 and abs(center_y - existing_cy) < 10:
                            # Keep the higher confidence one
                            if face['confidence'] > existing['confidence']:
                                existing.update(face)
                            is_duplicate = True
                            break

                    if not is_duplicate:
                        faces.append(face)

    # Sort by confidence, then by x position for stability between API calls
    faces.sort(key=lambda f: (-f['confidence'], f['x']))
    for i, face in enumerate(faces):
        face['id'] = i

    return faces


def create_face_thumbnail(image, face_box, size=200):
    """
    Create a square thumbnail for a detected face.
    Uses 30% padding around face, centers in square.

    Args:
        image: BGR or BGRA image (numpy array)
        face_box: dict with x, y, width, height (percentages 0-100)
        size: output thumbnail size (default 200x200)

    Returns: base64-encoded JPEG string
    """
    # Asymmetric padding: more top for hair, less bottom to avoid shoulders
    # top=50% for full hair, bottom=15% below chin, sides=25%
    face_box_padded = add_asymmetric_padding_to_box(face_box, top=0.50, bottom=0.15, left=0.25, right=0.25)
    face_img = crop_to_box(image, face_box_padded)

    if face_img.size == 0:
        return None

    # Make it square with warm peach background
    h, w = face_img.shape[:2]
    max_dim = max(h, w)

    # Create square canvas
    if len(face_img.shape) == 3 and face_img.shape[2] == 4:
        # BGRA image - composite with peach background
        square = np.full((max_dim, max_dim, 4), [230, 240, 255, 255], dtype=np.uint8)
        y_off = (max_dim - h) // 2
        x_off = (max_dim - w) // 2

        face_region = square[y_off:y_off+h, x_off:x_off+w]
        alpha = face_img[:, :, 3:4] / 255.0
        face_region[:, :, :3] = (face_img[:, :, :3] * alpha + face_region[:, :, :3] * (1 - alpha)).astype(np.uint8)
        face_region[:, :, 3] = 255

        # Convert to BGR for encoding
        square_bgr = cv2.cvtColor(square, cv2.COLOR_BGRA2BGR)
    else:
        # BGR image - just place on background
        square_bgr = np.full((max_dim, max_dim, 3), [230, 240, 255], dtype=np.uint8)
        y_off = (max_dim - h) // 2
        x_off = (max_dim - w) // 2
        square_bgr[y_off:y_off+h, x_off:x_off+w] = face_img[:, :, :3] if len(face_img.shape) == 3 else cv2.cvtColor(face_img, cv2.COLOR_GRAY2BGR)

    # Resize to target size
    thumbnail = cv2.resize(square_bgr, (size, size), interpolation=cv2.INTER_LANCZOS4)

    # Encode as JPEG
    _, buffer = cv2.imencode('.jpg', thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"


def remove_faces_except(image, keep_face_id, all_faces):
    """
    Remove non-selected people by blanking maximum area while preserving the kept person.

    Algorithm (uses face centers, not padded body ranges):
    - If face centers are horizontally separated (X distance > avg face width) → side-by-side
      → Calculate midpoint between face centers on X axis
      → Remove from midpoint to edge, from TOP of unwanted face to bottom
    - If face centers are close in X (stacked/overlapping) → stacked
      → If unwanted is ABOVE kept: remove from y=0 to top of kept face (full width)
      → If unwanted is BELOW kept: remove from top of unwanted face to y=100% (full width)

    Args:
        image: BGRA numpy array (must have alpha channel)
        keep_face_id: ID of face to keep (0-indexed)
        all_faces: list of face dicts with x, y, width, height (percentages 0-100)

    Returns: image with non-selected people blanked out
    """
    if not all_faces or len(all_faces) <= 1:
        return image

    result = image.copy()
    h, w = image.shape[:2]

    # Ensure image has alpha channel
    if len(result.shape) == 2 or result.shape[2] == 3:
        result = cv2.cvtColor(result, cv2.COLOR_BGR2BGRA)

    # Get the kept face
    kept_face = next((f for f in all_faces if f['id'] == keep_face_id), None)
    if not kept_face:
        return image

    kept_x = kept_face['x']
    kept_y = kept_face['y']
    kept_top = kept_y - kept_face['height'] * 0.5  # Small padding above head

    print(f"   Kept face {keep_face_id}: x={kept_x:.1f}%, y={kept_y:.1f}%")

    for face in all_faces:
        if face['id'] == keep_face_id:
            continue

        face_x = face['x']
        face_y = face['y']
        unwanted_top = face_y - face['height'] * 0.5

        print(f"   Unwanted face {face['id']}: x={face_x:.1f}%, y={face_y:.1f}%")

        # Use face center distance to determine side-by-side vs stacked
        # Threshold: if X distance > average face width, treat as side-by-side
        avg_face_width = (kept_face['width'] + face['width']) / 2
        x_distance = abs(face_x - kept_x)

        is_side_by_side = x_distance > avg_face_width
        print(f"   X distance: {x_distance:.1f}%, avg face width: {avg_face_width:.1f}% → {'side-by-side' if is_side_by_side else 'stacked'}")

        if is_side_by_side:
            # SIDE BY SIDE: Use midpoint between face centers
            midpoint = (kept_x + face_x) / 2

            if face_x < kept_x:
                # Unwanted is to the LEFT of kept
                remove_x1 = 0
                remove_x2 = int(midpoint / 100 * w)
                remove_y1 = int(max(0, unwanted_top) / 100 * h)
                remove_y2 = h
                print(f"   Side-by-side LEFT: remove x=0-{midpoint:.1f}%, y={unwanted_top:.1f}%-100%")
            else:
                # Unwanted is to the RIGHT of kept
                remove_x1 = int(midpoint / 100 * w)
                remove_x2 = w
                remove_y1 = int(max(0, unwanted_top) / 100 * h)
                remove_y2 = h
                print(f"   Side-by-side RIGHT: remove x={midpoint:.1f}%-100%, y={unwanted_top:.1f}%-100%")

            # Blank out the region
            if remove_x2 > remove_x1 and remove_y2 > remove_y1:
                result[remove_y1:remove_y2, remove_x1:remove_x2, 0:3] = 255
                result[remove_y1:remove_y2, remove_x1:remove_x2, 3] = 0
                print(f"   Blanked region ({remove_x1},{remove_y1})-({remove_x2},{remove_y2})")

        else:
            # STACKED (faces close in X): Use vertical logic
            if face_y < kept_y:
                # Unwanted is ABOVE kept
                remove_y1 = 0
                remove_y2 = int(kept_top / 100 * h)
                remove_x1 = 0
                remove_x2 = w
                print(f"   Stacked ABOVE: remove y=0-{kept_top:.1f}% (full width)")
            else:
                # Unwanted is BELOW kept
                remove_y1 = int(unwanted_top / 100 * h)
                remove_y2 = h
                remove_x1 = 0
                remove_x2 = w
                print(f"   Stacked BELOW: remove y={unwanted_top:.1f}%-100% (full width)")

            # Blank out the region
            if remove_x2 > remove_x1 and remove_y2 > remove_y1:
                result[remove_y1:remove_y2, remove_x1:remove_x2, 0:3] = 255
                result[remove_y1:remove_y2, remove_x1:remove_x2, 3] = 0
                print(f"   Blanked region ({remove_x1},{remove_y1})-({remove_x2},{remove_y2})")

    return result



def remove_background(image):
    """
    Remove background from image using rembg (U2-Net) or MediaPipe fallback.
    Returns tuple: (image with transparent background (RGBA), binary mask)
    """
    # Try rembg first (better quality, includes heads properly).
    # get_rembg_session() builds U2-Net on first use and returns None if rembg
    # is missing or fails to load, in which case we fall through to MediaPipe.
    session = get_rembg_session()
    if session is not None:
        try:
            # Convert BGR to RGB for PIL
            rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            pil_image = Image.fromarray(rgb_image)

            # Remove background using rembg
            result_pil = rembg_remove(pil_image, session=session)

            # Convert back to numpy RGBA
            result_rgba = np.array(result_pil)

            # Convert RGBA to BGRA for OpenCV
            bgra = cv2.cvtColor(result_rgba, cv2.COLOR_RGBA2BGRA)

            # Extract binary mask from alpha channel
            binary_mask = bgra[:, :, 3]

            # Set RGB to white where background is removed (alpha < 128)
            bg_mask = binary_mask < 128
            bgra[bg_mask, 0:3] = 255  # BGR = white

            return bgra, binary_mask
        except Exception as e:
            print(f"[WARN] rembg failed: {e}, falling back to MediaPipe")

    # Fallback to MediaPipe
    if not MEDIAPIPE_AVAILABLE:
        return None, None

    with mp_selfie_segmentation.SelfieSegmentation(model_selection=1) as segmentation:
        # Convert BGR to RGB
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = segmentation.process(rgb_image)

        # Get segmentation mask (0-1 float values)
        mask = results.segmentation_mask

        # Create binary mask with threshold
        binary_mask = (mask > 0.5).astype(np.uint8) * 255

        # Optional: Smooth the mask edges
        binary_mask = cv2.GaussianBlur(binary_mask, (5, 5), 0)

        # Create 4-channel image (BGRA)
        bgra = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)

        # Apply mask to alpha channel
        bgra[:, :, 3] = binary_mask

        # Set RGB to white where background is removed (alpha < 128)
        # This ensures AI models don't "see through" transparency to original data
        bg_mask = binary_mask < 128
        bgra[bg_mask, 0:3] = 255  # BGR = white

        return bgra, binary_mask


def get_body_bounds_from_mask(mask, padding_percent=0.05):
    """
    Find bounding box of non-zero pixels in mask.
    Returns bounding box as percentage of image dimensions (0-100).
    """
    h, w = mask.shape[:2]

    # Find non-zero pixels (the person)
    non_zero = cv2.findNonZero(mask)

    if non_zero is None:
        return None

    # Get bounding rectangle
    x, y, bw, bh = cv2.boundingRect(non_zero)

    # Add small padding
    pad_x = int(bw * padding_percent)
    pad_y = int(bh * padding_percent)

    x = max(0, x - pad_x)
    y = max(0, y - pad_y)
    bw = min(w - x, bw + 2 * pad_x)
    bh = min(h - y, bh + 2 * pad_y)

    # Convert to percentage (0-100)
    return {
        'x': (x / w) * 100,
        'y': (y / h) * 100,
        'width': (bw / w) * 100,
        'height': (bh / h) * 100
    }


def add_padding_to_box(box, padding_percent=0.5):
    """
    Add padding around a bounding box.
    padding_percent: 0.5 means 50% extra on each side
    Box is in percentage 0-100 format.
    """
    pad_x = box['width'] * padding_percent
    pad_y = box['height'] * padding_percent

    return {
        'x': max(0, box['x'] - pad_x),
        'y': max(0, box['y'] - pad_y),
        'width': min(100 - max(0, box['x'] - pad_x), box['width'] + 2 * pad_x),
        'height': min(100 - max(0, box['y'] - pad_y), box['height'] + 2 * pad_y)
    }


def add_asymmetric_padding_to_box(box, top=0.5, bottom=0.5, left=0.3, right=0.3):
    """
    Add asymmetric padding around a bounding box.
    Padding values are percentages of the box's width/height.
    E.g., top=0.5 means add 50% of face height above the face.
    Box is in percentage 0-100 format.
    """
    pad_top = box['height'] * top
    pad_bottom = box['height'] * bottom
    pad_left = box['width'] * left
    pad_right = box['width'] * right

    new_x = max(0, box['x'] - pad_left)
    new_y = max(0, box['y'] - pad_top)
    new_width = min(100 - new_x, box['width'] + pad_left + pad_right)
    new_height = min(100 - new_y, box['height'] + pad_top + pad_bottom)

    return {
        'x': new_x,
        'y': new_y,
        'width': new_width,
        'height': new_height
    }


def crop_to_box(image, box, output_size=None):
    """
    Crop image to bounding box (box is in percentage 0-100)
    Returns cropped image
    """
    h, w = image.shape[:2]

    x = int((box['x'] / 100) * w)
    y = int((box['y'] / 100) * h)
    width = int((box['width'] / 100) * w)
    height = int((box['height'] / 100) * h)

    # Ensure bounds are valid
    x = max(0, x)
    y = max(0, y)
    x2 = min(w, x + width)
    y2 = min(h, y + height)

    cropped = image[y:y2, x:x2]

    if output_size and cropped.size > 0:
        cropped = cv2.resize(cropped, output_size)

    return cropped


def process_photo(image_data, is_base64=True, selected_face_id=None, cached_faces=None):
    """
    Process uploaded photo - FAST version with multi-face support:

    Two modes:
    1. Initial analysis (selected_face_id=None):
       - Detect ALL faces
       - If multiple valid faces (>=35% confidence), return thumbnails for selection
       - If single face, process normally

    2. After selection (selected_face_id=N, cached_faces=[...]):
       - Use cached_faces from first call (avoids re-detection ID instability)
       - Use the selected face
       - Remove non-selected faces from output

    Returns dict with face_thumbnail, body_no_bg, and bounding boxes
    """
    # No shared temp file. The old code wrote input_<pid>.jpg — shared by every
    # waitress worker thread in the single process — so concurrent /analyze
    # requests overwrote each other's photo (a cross-user leak), and the JPEG
    # save also crashed on RGBA PNGs. Decode base64 straight from memory.
    temp_input = None

    try:
        # 1. DECODE IMAGE
        if is_base64:
            # Remove data URL prefix if present
            if ',' in image_data:
                image_data = image_data.split(',')[1]

            # Decode base64 in memory (handles RGBA/PNG, no disk round-trip)
            image_bytes = base64.b64decode(image_data)
            img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        else:
            temp_input = image_data
            # Load image with OpenCV from the provided path
            img = cv2.imread(temp_input)

        if img is None:
            raise ValueError("Failed to load image")

        img_h, img_w = img.shape[:2]
        print(f"[PHOTO] Processing image: {img_w}x{img_h}")

        # 2. DETECT FACES - scale while maintaining aspect ratio
        # IMPORTANT: Never distort the image - faces become undetectable when squished
        print("[FACE] Detecting faces...")

        aspect_ratio = img_h / img_w
        detection_img = img

        # Scale to max dimension 1200px while maintaining aspect ratio
        max_dim = max(img_w, img_h)
        if max_dim > 1200:
            scale = 1200 / max_dim
            new_w = int(img_w * scale)
            new_h = int(img_h * scale)
            detection_img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
            print(f"[FACE] Scaled {img_w}x{img_h} -> {new_w}x{new_h} (aspect preserved: {aspect_ratio:.2f})")
        else:
            print(f"[FACE] Using original size {img_w}x{img_h} (aspect: {aspect_ratio:.2f})")

        # (Removed dev-only debug image write to TEMP_DIR; in production this
        # was overwriting a decoded copy of every uploaded photo on disk.)

        # Use cached faces if provided (from first call), otherwise detect
        # This prevents face ID instability between calls
        if cached_faces is not None and selected_face_id is not None:
            all_faces = cached_faces
            print(f"[FACE] Using {len(all_faces)} cached faces from previous detection")
        else:
            all_faces = detect_all_faces_mediapipe(detection_img, min_confidence=0.15)

            # Filter out tiny faces (likely false positives - hair tips, noise)
            # Real faces should be at least 3% of image width/height
            all_faces = [f for f in all_faces if f['width'] >= 3.0 and f['height'] >= 3.0]

        # DEBUG: Draw detected faces on image and save
        if len(all_faces) > 0:
            debug_img = detection_img.copy()
            det_h, det_w = debug_img.shape[:2]
            for f in all_faces:
                x1 = int(f['x'] * det_w / 100)
                y1 = int(f['y'] * det_h / 100)
                x2 = int((f['x'] + f['width']) * det_w / 100)
                y2 = int((f['y'] + f['height']) * det_h / 100)
                cv2.rectangle(debug_img, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(debug_img, f"{f['confidence']*100:.0f}%", (x1, y1-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
            debug_result_path = os.path.join(TEMP_DIR, 'debug_detection_result.jpg')
            cv2.imwrite(debug_result_path, debug_img)
            print(f"[DEBUG] Saved detection result to: {debug_result_path}")

        # Note: coordinates are percentages, so they map correctly to original image
        # Log each face with confidence AND position
        if len(all_faces) > 0:
            for f in all_faces:
                print(f"   Face {f['id']+1}: {f['confidence']*100:.0f}% at x={f['x']:.1f}%, y={f['y']:.1f}%, w={f['width']:.1f}%, h={f['height']:.1f}%")
            face_scores = ", ".join([f"face {f['id']+1}: {f['confidence']*100:.0f}%" for f in all_faces])
            print(f"   Faces detected: {len(all_faces)} ({face_scores})")
        else:
            print(f"   Faces detected: 0")

        # If no face detected, return error immediately
        if len(all_faces) == 0:
            print("[ERROR] No face detected in photo")
            # Clean up temp files
            if temp_input and os.path.exists(temp_input) and is_base64:
                os.remove(temp_input)
            return {
                "success": False,
                "error": "no_face_detected",
                "error_message": "No face was detected in the photo. Please upload a clear photo showing your face."
            }

        # 3. MULTI-FACE HANDLING
        # If multiple faces and no selection made yet, return face thumbnails for selection
        if len(all_faces) > 1 and selected_face_id is None:
            print(f"[MULTI] Multiple faces detected ({len(all_faces)}), returning thumbnails for selection")

            # Create thumbnails for each face (using original image for speed)
            face_thumbnails = []
            for face in all_faces:
                thumbnail = create_face_thumbnail(img, face, size=200)
                if thumbnail:
                    face_thumbnails.append({
                        'id': face['id'],
                        'confidence': round(face['confidence'], 2),
                        'faceBox': {
                            'x': face['x'],
                            'y': face['y'],
                            'width': face['width'],
                            'height': face['height']
                        },
                        'thumbnail': thumbnail
                    })

            # Clean up temp files
            if temp_input and os.path.exists(temp_input) and is_base64:
                os.remove(temp_input)

            return {
                "success": True,
                "multiple_faces_detected": True,
                "face_count": len(all_faces),
                "faces": face_thumbnails,
                # These are null until face is selected
                "face_thumbnail": None,
                "body_no_bg": None,
                "body_crop": None,
                "face_box": None,
                "body_box": None,
                "image_dimensions": {
                    "width": img_w,
                    "height": img_h
                }
            }

        # 4. SINGLE FACE OR FACE SELECTED - continue with normal processing
        # Determine which face to use
        if selected_face_id is not None and selected_face_id < len(all_faces):
            face_box = all_faces[selected_face_id]
            print(f"   Using face {selected_face_id + 1} (selected, {face_box['confidence']*100:.0f}%)")
        else:
            face_box = all_faces[0]  # Use highest confidence face
            print(f"   Using face 1 ({face_box['confidence']*100:.0f}%)")

        # 5. REMOVE BACKGROUND (fast - ~100ms)
        print("[BG] Removing background...")
        full_img_rgba = None
        body_mask = None
        try:
            full_img_rgba, body_mask = remove_background(img)
            if full_img_rgba is not None:
                h, w = full_img_rgba.shape[:2]
                visible = np.sum(full_img_rgba[:,:,3] > 128)
                print(f"   Background removed: {visible}/{h*w} pixels visible ({100*visible/(h*w):.1f}%)")
            else:
                print("   Background removal returned None")
        except Exception as bg_error:
            print(f"   Background removal failed: {bg_error}")

        # 6. REMOVE NON-SELECTED FACES (if multiple faces and one was selected)
        # Make them transparent so AI can't use them for avatar generation
        if len(all_faces) > 1 and selected_face_id is not None:
            print(f"[REMOVE] Removing {len(all_faces) - 1} non-selected faces, keeping ID {selected_face_id}")
            print(f"[REMOVE] all_faces: {[(f.get('id'), f.get('x'), f.get('y')) for f in all_faces]}")
            if full_img_rgba is not None:
                h, w = full_img_rgba.shape[:2]
                visible_before = np.sum(full_img_rgba[:,:,3] > 0)
                print(f"[REMOVE] Before: {visible_before}/{h*w} pixels visible ({100*visible_before/(h*w):.1f}%)")

                full_img_rgba = remove_faces_except(full_img_rgba, selected_face_id, all_faces)

                visible_after = np.sum(full_img_rgba[:,:,3] > 0)
                print(f"[REMOVE] After: {visible_after}/{h*w} pixels visible ({100*visible_after/(h*w):.1f}%)")
                print("   Face removal complete")

        # 7. GET BODY BOUNDS
        # For multi-face: use alpha channel (only selected person is visible after remove_faces_except)
        # For single-face: use the segmentation mask
        body_box = None
        if len(all_faces) > 1 and selected_face_id is not None and full_img_rgba is not None:
            # Multi-face: use alpha channel to find bounds of selected person
            alpha_mask = full_img_rgba[:, :, 3]
            body_box = get_body_bounds_from_mask(alpha_mask, padding_percent=0.05)
            if body_box:
                print(f"   Body box from alpha mask: x={body_box['x']:.1f}%, y={body_box['y']:.1f}%, w={body_box['width']:.1f}%, h={body_box['height']:.1f}%")

                # Extend body box upward to include the kept face (MediaPipe often misses heads)
                kept_face = next((f for f in all_faces if f['id'] == selected_face_id), None)
                if kept_face:
                    # Face top with padding for top of head (50% above face)
                    face_top = max(0, kept_face['y'] - kept_face['height'] * 0.5)
                    if face_top < body_box['y']:
                        # Extend body box upward to include head
                        height_to_add = body_box['y'] - face_top
                        body_box['y'] = face_top
                        body_box['height'] += height_to_add
                        print(f"   Extended body box to include head: y={body_box['y']:.1f}%, h={body_box['height']:.1f}%")
        elif len(all_faces) == 1 and body_mask is not None:
            # Single person - use segmentation mask bounds
            body_box = get_body_bounds_from_mask(body_mask, padding_percent=0.05)

        # 8. CREATE OUTPUTS
        face_thumbnail = None
        body_no_bg = None
        body_crop = None

        # Face thumbnail with background removed (768x768 for avatar generation)
        if face_box and full_img_rgba is not None:
            # Asymmetric padding: more top for hair, less bottom to avoid shoulders
            face_box_padded = add_asymmetric_padding_to_box(face_box, top=0.50, bottom=0.15, left=0.25, right=0.25)
            face_img = crop_to_box(full_img_rgba, face_box_padded)

            if face_img.size > 0:
                # Make it square with soft warm peach background
                size = max(face_img.shape[0], face_img.shape[1])
                # Create square with warm peach background (BGRA: B=230, G=240, R=255, A=255)
                square = np.full((size, size, 4), [230, 240, 255, 255], dtype=np.uint8)
                y_off = (size - face_img.shape[0]) // 2
                x_off = (size - face_img.shape[1]) // 2

                # Composite face onto background
                face_region = square[y_off:y_off+face_img.shape[0], x_off:x_off+face_img.shape[1]]
                alpha = face_img[:, :, 3:4] / 255.0
                face_region[:, :, :3] = (face_img[:, :, :3] * alpha + face_region[:, :, :3] * (1 - alpha)).astype(np.uint8)
                face_region[:, :, 3] = 255

                # Resize to 768x768 (high quality for avatar generation)
                face_thumb = cv2.resize(square, (768, 768), interpolation=cv2.INTER_LANCZOS4)
                face_thumb_bgr = cv2.cvtColor(face_thumb, cv2.COLOR_BGRA2BGR)
                _, buffer = cv2.imencode('.jpg', face_thumb_bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
                face_thumbnail = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"
                print("   Face thumbnail created (768x768)")

        # Max dimensions for body images (efficient for avatar generation)
        max_w, max_h = 512, 768

        # Body with transparent background
        if full_img_rgba is not None:
            # Crop to body_box (calculated from alpha mask for multi-face, or segmentation mask for single-face)
            if body_box:
                body_img_rgba = crop_to_box(full_img_rgba, body_box)
                print(f"   Cropped body_no_bg to bounds")
            else:
                body_img_rgba = full_img_rgba.copy()
                print(f"   Using full image for body_no_bg (no body_box)")

            if body_img_rgba.size > 0:
                bh, bw = body_img_rgba.shape[:2]
                if bw > max_w or bh > max_h:
                    scale = min(max_w/bw, max_h/bh)
                    new_w, new_h = int(bw*scale), int(bh*scale)
                    body_img_rgba = cv2.resize(body_img_rgba, (new_w, new_h), interpolation=cv2.INTER_AREA)
                    print(f"   Resized body_no_bg from {bw}x{bh} to {new_w}x{new_h}")

                # Encode as PNG with max compression (level 9) to preserve transparency
                _, buffer_png = cv2.imencode('.png', body_img_rgba, [cv2.IMWRITE_PNG_COMPRESSION, 9])
                body_no_bg = f"data:image/png;base64,{base64.b64encode(buffer_png).decode('utf-8')}"
                print(f"   Body no-bg created: {len(buffer_png)//1024}KB")

        # Also create body with background (for display)
        if body_box and img is not None:
            body_img = crop_to_box(img, body_box)
            if body_img.size > 0:
                bh, bw = body_img.shape[:2]
                if bw > max_w or bh > max_h:
                    scale = min(max_w/bw, max_h/bh)
                    body_img = cv2.resize(body_img, (int(bw*scale), int(bh*scale)), interpolation=cv2.INTER_AREA)
                _, buffer = cv2.imencode('.jpg', body_img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                body_crop = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        # Clean up temp files
        if temp_input and os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)

        print("[OK] Photo processing complete")

        return {
            "success": True,
            "multiple_faces_detected": False,
            "face_count": len(all_faces),
            "selected_face_id": selected_face_id,
            "attributes": {
                # Age/gender now come from Gemini, not Python
                "age": None,
                "gender": None,
                "height": None,
                "build": None
            },
            "face_box": face_box,
            "body_box": body_box,
            "face_thumbnail": face_thumbnail,
            "body_crop": body_crop,
            "body_no_bg": body_no_bg,
            "image_dimensions": {
                "width": img_w,
                "height": img_h
            }
        }

    except Exception as e:
        # Clean up on error
        if temp_input and os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)

        return {
            "success": False,
            "error": str(e)
        }


@app.route('/remove-bg', methods=['POST'])
def remove_bg_endpoint():
    """
    Remove background from an already-cropped image using rembg.
    No face detection, no resizing — just bg removal.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "max_size": 1024  // Optional: max dimension to resize to (default: no resize)
    }

    Returns:
    {
        "success": true,
        "image": "data:image/png;base64,..."  // PNG with transparent background
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"success": False, "error": "No image provided"}), 400

        image_data = data['image']
        max_size = data.get('max_size', None)

        # Decode base64 image
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        img_bytes = base64.b64decode(image_data)
        img_array = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)

        if img is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        h, w = img.shape[:2]
        print(f"[REMOVE-BG] Input: {w}x{h}")

        # Optional resize
        if max_size and (w > max_size or h > max_size):
            scale = max_size / max(w, h)
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            h, w = img.shape[:2]
            print(f"[REMOVE-BG] Resized to: {w}x{h}")

        # Remove background
        result_rgba, mask = remove_background(img)
        if result_rgba is None:
            return jsonify({"success": False, "error": "Background removal failed"}), 500

        # Encode as PNG (preserves transparency)
        _, buffer = cv2.imencode('.png', result_rgba, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        result_base64 = f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"
        print(f"[REMOVE-BG] Output: {len(buffer)//1024}KB PNG")

        return jsonify({
            "success": True,
            "image": result_base64
        })

    except Exception as e:
        print(f"[REMOVE-BG] Error: {e}")
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/silhouette-edge', methods=['POST'])
def silhouette_edge_endpoint():
    """
    Run rembg on the input crop, return a transparent PNG with the figure's
    silhouette filled in the requested colour. Used by the char-repair-
    inpaint pipeline to overlay a hard exact-shape signal on top of the
    magenta crosshatch — gives the image model an unambiguous fill region
    so it stops scaling the repainted figure up.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",  # crop of the scene where the figure sits
        "color": [0, 200, 255],                 # fill RGB; default bright blue (complementary to magenta)
        "alpha": 255                            # fill alpha 0–255 (default 255 = solid)
    }

    Returns:
    {
        "success": true,
        "image": "data:image/png;base64,..."     # transparent PNG, same dims as input, silhouette interior filled
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"success": False, "error": "No image provided"}), 400

        image_data = data['image']
        color_rgb = data.get('color', [0, 200, 255])
        if not (isinstance(color_rgb, list) and len(color_rgb) == 3):
            color_rgb = [0, 200, 255]
        # OpenCV is BGR
        color_bgr = (int(color_rgb[2]), int(color_rgb[1]), int(color_rgb[0]))
        alpha = max(0, min(255, int(data.get('alpha', 255))))

        if ',' in image_data:
            image_data = image_data.split(',')[1]
        img_bytes = base64.b64decode(image_data)
        img_array = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        h, w = img.shape[:2]
        result_rgba, mask = remove_background(img)
        if mask is None:
            return jsonify({"success": False, "error": "Background removal failed"}), 500

        # Binary silhouette mask
        binary = (mask > 128)

        # Build transparent BGRA: silhouette interior = solid color at requested alpha,
        # background = (0,0,0,0)
        out = np.zeros((h, w, 4), dtype=np.uint8)
        out[binary, 0] = color_bgr[0]
        out[binary, 1] = color_bgr[1]
        out[binary, 2] = color_bgr[2]
        out[binary, 3] = alpha

        _, buffer = cv2.imencode('.png', out, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        result_b64 = f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}"
        fill_pixels = int(binary.sum())
        print(f"[SILHOUETTE-EDGE] {w}x{h} crop, fill px={fill_pixels}, alpha={alpha}, out={len(buffer)//1024}KB")
        return jsonify({"success": True, "image": result_b64, "edge_pixels": fill_pixels, "fill_pixels": fill_pixels})

    except Exception as e:
        print(f"[SILHOUETTE-EDGE] Error: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


# ── Memory hygiene ──────────────────────────────────────────────────────────
# Long-running CPU inference process: torch/numpy free their objects but glibc
# does NOT return the freed pages to the OS, so RSS creeps up across hundreds of
# mask calls until an allocation fails and /figure-mask throws HTTP 500 (observed
# on staging: SAM works on a fresh deploy, 500s after many repairs). gc.collect()
# frees Python objects; malloc_trim(0) hands the freed arenas back to the OS so
# RSS actually drops. Both models STAY loaded — this is per-call cleanup, not an
# unload. Called after every heavy inference.
try:
    import ctypes
    _libc = ctypes.CDLL("libc.so.6")
except Exception:
    _libc = None


def _release_memory():
    try:
        gc.collect()
        if _libc is not None:
            _libc.malloc_trim(0)
    except Exception:
        pass


# ── Page cache: the other half of the bill ───────────────────────────────────
# Railway charges for the container's cgroup total, and that INCLUDES the OS
# page cache. Measured with mincore(2) on staging 21.4 h after a story: 1,361 MB
# of 1,603 MB resident was this ML stack's shared objects —
# libtensorflow_cc 378 MB, libtorch_cpu 185 MB, libllvmlite 154 MB, cv2 63 MB.
# Every spawned worker maps them in; when the worker exits its ANON memory comes
# back (that is what kill_workers achieves) but the file pages stay cached. The
# kernel has no reason to evict them — page cache is reclaimed under memory
# PRESSURE, and a 22 GB cgroup limit never supplies any — so they sit there
# being billed until the container is torn down.
#
# posix_fadvise(POSIX_FADV_DONTNEED) is the direct instruction to drop them. It
# only affects CLEAN, UNMAPPED pages, which is exactly our case once the workers
# are gone: read-only libraries nobody has open. It cannot corrupt anything —
# the next reader simply faults them back in from disk, costing a few seconds of
# cold start on the next story against a run that takes half an hour.
#
# Deliberately NOT a container restart: the analyzer is not user-facing but it
# IS on the critical path (character photo upload calls /remove-bg), so a
# restart window means a failed upload for whoever is mid-signup. This reaches
# the same end state with no availability gap.
def _cache_drop_roots():
    """Where the resident bytes actually are, resolved rather than hardcoded.

    A literal '/usr/local/lib/python3.11/dist-packages' silently stops matching
    the day the base image moves to 3.12 — and it would fail OPEN: the sweep
    would report success having advised nothing, and the cache would quietly
    come back. site.getsitepackages() asks the interpreter that is actually
    running.
    """
    roots = []
    try:
        import site
        roots.extend(site.getsitepackages() or [])
    except Exception:
        pass
    try:
        import sysconfig
        for key in ('purelib', 'platlib'):
            p = sysconfig.get_paths().get(key)
            if p:
                roots.append(p)
    except Exception:
        pass
    # The ML WEIGHT caches, not the whole of /app. Both Railway services build
    # the same root Dockerfile today (railway.json pins one dockerfilePath), so
    # /app is the entire monorepo — node_modules, the client bundle, docs, tests.
    # The analyzer never reads any of it, and walking it was what made this a
    # ~74,000-inode sweep instead of a few hundred.
    app = os.path.dirname(os.path.abspath(__file__))
    for sub in ('.hf_cache', '.deepface', 'mobile_sam.pt', 'yolo11n-pose.pt'):
        roots.append(os.path.join(app, sub))

    # De-duplicate, keeping the SHORTEST path when one contains another. The
    # previous version only rejected a new candidate nested under a kept root,
    # never the reverse, so a broader root arriving later kept both and walked
    # the child tree twice.
    cand = []
    for r in roots:
        if r and (os.path.isdir(r) or os.path.isfile(r)) and r not in cand:
            cand.append(r)
    cand.sort(key=len)
    out = []
    for r in cand:
        if any(r == k or r.startswith(k.rstrip('/') + '/') for k in out):
            continue
        # Floor: never accept a root shallow enough to sweep the system. A
        # misresolved PYTHONHOME returning '/' or '/usr' would otherwise walk
        # millions of inodes. The hardcoded list was bounded by inspection; a
        # derived one needs the rail written down.
        if len([p for p in r.split('/') if p]) < 3:
            print(f"[CACHE-DROP] refusing suspiciously broad root: {r}")
            continue
        out.append(r)
    return out


# One sweep at a time. Two overlapping walks of ~74k inodes would double the
# work to reach the same end state, and the reap path can fire from several
# request teardowns at once.
_cache_drop_lock = threading.Lock()


def drop_file_cache(roots=None):
    """Hand back the page cache of files nothing is using. Returns (files, ms)."""
    started = time.time()
    roots = roots or _cache_drop_roots()
    touched = 0

    def _advise(path):
        nonlocal touched
        try:
            fd = os.open(path, os.O_RDONLY)
        except OSError:
            return
        try:
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
            touched += 1
        except (OSError, AttributeError):
            pass  # not Linux, or the fd cannot be advised — fail safe
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    for root in roots:
        # Roots may be single files (mobile_sam.pt is 39 MB on its own).
        if os.path.isfile(root):
            _advise(root)
            continue
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, filenames in os.walk(root, onerror=lambda e: None):
            for fn in filenames:
                _advise(os.path.join(dirpath, fn))
    return touched, int((time.time() - started) * 1000)


def _proc_rss_mb(pid):
    """RSS of another process, in MB. None if it is gone or unreadable."""
    try:
        with open(f'/proc/{pid}/statm') as fh:
            pages = int(fh.read().split()[1])
        return round(pages * os.sysconf('SC_PAGE_SIZE') / 1048576.0, 1)
    except Exception:
        return None


def _cgroup_file_mb():
    """Cgroup page cache in MB, or None off-Linux. This is the number billed."""
    for path in ('/sys/fs/cgroup/memory.stat', '/sys/fs/cgroup/memory/memory.stat'):
        try:
            with open(path) as fh:
                for line in fh:
                    key, _, value = line.partition(' ')
                    if key in ('file', 'cache'):
                        return int(value) / 1048576.0
        except Exception:
            # Deliberately broad: a malformed line raising ValueError inside the
            # loop used to escape this handler and kill the reporting thread, so
            # the [CACHE-DROP] line never printed and a sweep that HAD run
            # looked like one that never fired.
            continue
    return None


# Minimum gap between sweeps. Sessionless work — a character photo upload, which
# spawns a worker and reaps it on its own teardown — would otherwise re-trigger a
# full sweep per upload. The single-flight lock stops two overlapping; it does
# not stop three in a row a few hundred ms apart, which is pure I/O for nothing
# since the first one already released the pages.
_CACHE_DROP_MIN_INTERVAL_S = int(os.environ.get('CACHE_DROP_MIN_INTERVAL_S', '120'))
_last_cache_drop_ts = 0.0


def _drop_file_cache_async(reason):
    """Run the sweep off the request path — it walks a few thousand inodes."""
    def _run():
        global _last_cache_drop_ts
        if not _cache_drop_lock.acquire(blocking=False):
            print(f"[CACHE-DROP] {reason}: skipped, a sweep is already running")
            return
        try:
            since = time.time() - _last_cache_drop_ts
            if since < _CACHE_DROP_MIN_INTERVAL_S:
                print(f"[CACHE-DROP] {reason}: skipped, last sweep {since:.0f}s ago")
                return
            _last_cache_drop_ts = time.time()
            before = _cgroup_file_mb()
            touched, ms = drop_file_cache()
            after = _cgroup_file_mb()
            # Report the cgroup delta, not RSS: RSS is this process's anonymous
            # memory and does not move here. Reporting RSS would make a working
            # sweep look like a no-op.
            delta = ('%.0f → %.0f MB' % (before, after)) if before is not None and after is not None else 'cgroup unreadable'
            print(f"[CACHE-DROP] {reason}: advised {touched} file(s) in {ms}ms — page cache {delta}")
        finally:
            _cache_drop_lock.release()
    threading.Thread(target=_run, daemon=True, name='cache-drop').start()


# _rss_mb() is defined at the top of this file, above the heavy imports, so the
# boot instrumentation can measure them. Do not redefine it here.


# MobileSAM for box-prompted figure masks (lazy loaded, ~570MB peak RSS).
# Lazy-loaded but, until now, never unloaded: once a single mask request landed,
# the model stayed resident for the life of the process. Railway bills resident
# memory per minute, so that was ~570MB charged 24/7 for a model used only
# during character repair. It now has the same idle reaper as rembg/GDINO.
_mobilesam_model = None
_mobilesam_last_used = 0.0
_MOBILESAM_IDLE_UNLOAD_S = int(os.environ.get('MOBILESAM_IDLE_UNLOAD_S', '900'))
# Serializes ALL access to the one shared MobileSAM model + its ultralytics
# predictor (load, inference, cache-clear, idle-unload). The predictor is NOT
# thread-safe — it stashes the current run's image / prompts / results on itself
# (see _free_sam_cache) — so concurrent /figure-mask calls under waitress's 24
# threads interleave and return a mask for the WRONG image. That is the root
# cause of "SAM mask entirely outside the DINO box" appearing story-wide when
# the repair phase fired masks in parallel. rembg and GroundingDINO are guarded
# the same way; MobileSAM was the one heavy model left unlocked.
_mobilesam_lock = threading.Lock()


def _free_sam_cache():
    """Drop the predictor's retained tensors WITHOUT unloading the model.

    Measured on staging: RSS climbed ~300 MB on every /figure-mask call with
    identical 416x710 input, and stayed up even after gc.collect() +
    malloc_trim(0). Fragmentation would have been released by the trim, so this
    is live references, not allocator slack — ultralytics' predictor holds the
    last run's results/batch and, for SAM, the cached image embeddings.

    Those are all dead once we've encoded the PNG:
      - results/batch : the masks we already turned into a PNG
      - features/im   : embeddings for THAT image, and every call is a new image,
                        so the next call recomputes them regardless

    Clearing them therefore costs nothing to recompute, which is why this runs
    per call. Unloading the model itself is a different trade — that would force
    a ~570 MB reload on the next page mid-story — so it stays warm and is only
    dropped by the idle reaper after MOBILESAM_IDLE_UNLOAD_S of no work.

    ONLY `features` and `results` are cleared, and each is reset to the type the
    library expects rather than to None:

      - features -> None : SAM's predictor explicitly guards with
                           `if self.features is None: ...recompute`, so None is
                           the documented "not cached" state. This is the big
                           one — the image embeddings.
      - results  -> []   : the masks we already encoded. A list, not None,
                           because callers iterate it.

    Do NOT null `batch`, `prompts` or `im`. A first version of this cleared them
    too and broke inference on the very next call: ultralytics unpacks
    `p, im0s, s = self.batch` ("'NoneType' object is not subscriptable") and
    calls `self.prompts.pop(...)` ("'NoneType' object has no attribute 'pop'").
    Both showed up in staging logs immediately. They are small anyway — the
    memory is in features/results — so clearing them bought nothing and cost
    correctness.

    Defensive: ultralytics' internals differ across versions, so only existing
    attributes are touched and any failure is logged rather than 500ing a repair.
    """
    m = _mobilesam_model
    if m is None:
        return
    try:
        p = getattr(m, 'predictor', None)
        if p is None:
            return
        if getattr(p, 'features', None) is not None:
            p.features = None
        if getattr(p, 'results', None):
            p.results = []
    except Exception as e:
        print(f"[FIGURE-MASK] predictor cache clear failed (non-fatal): {e}")


def get_mobilesam():
    global _mobilesam_model, _mobilesam_last_used
    _mobilesam_last_used = time.time()
    if _mobilesam_model is None:
        with _mobilesam_lock:
            if _mobilesam_model is None:  # double-checked: another thread may have loaded it
                from ultralytics import SAM  # optional dep — endpoint 503s if missing
                weights = os.environ.get('MOBILESAM_WEIGHTS', 'mobile_sam.pt')
                print(f"[FIGURE-MASK] Loading MobileSAM ({weights})...")
                _mobilesam_model = SAM(weights)
    return _mobilesam_model


@app.route('/figure-mask', methods=['POST'])
def figure_mask_endpoint():
    """
    Box-prompted MobileSAM figure mask. Same response contract as
    /silhouette-edge (transparent PNG, silhouette interior filled), but
    segments the single figure inside the prompt box instead of rembg's
    "every salient object in the crop". Chosen for char-repair after the
    2026-07-10 mask shootout (docs/research-log.html): selects one of two
    touching figures, includes feet rembg misses.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",  # crop of the scene
        "box": [x1, y1, x2, y2],                # figure bbox in crop pixel coords
        "points": [[x, y], ...],                # optional point prompts (pixel coords)
        "point_labels": [1, ...],               # optional per-point labels (1=fg, 0=bg)
        "color": [255, 255, 255],               # fill RGB (default white)
        "alpha": 255                            # fill alpha (default solid)
    }

    box and points may be combined (face-anchored figure mask) or either used
    alone; at least one is required.

    Returns: { "success": true, "image": "data:image/png;base64,...", "fill_pixels": N }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"success": False, "error": "No image provided"}), 400
        box = data.get('box')
        points = data.get('points')
        if box is not None and not (isinstance(box, list) and len(box) == 4):
            return jsonify({"success": False, "error": "box must be [x1,y1,x2,y2]"}), 400
        if points is not None and not (isinstance(points, list) and len(points) > 0
                                       and all(isinstance(p, list) and len(p) == 2 for p in points)):
            return jsonify({"success": False, "error": "points must be [[x,y],...]"}), 400
        if box is None and points is None:
            return jsonify({"success": False, "error": "box or points required"}), 400

        try:
            model = get_mobilesam()
        except Exception as load_err:
            print(f"[FIGURE-MASK] MobileSAM unavailable: {load_err}")
            return jsonify({"success": False, "error": f"mobilesam unavailable: {load_err}"}), 503

        color_rgb = data.get('color', [255, 255, 255])
        if not (isinstance(color_rgb, list) and len(color_rgb) == 3):
            color_rgb = [255, 255, 255]
        alpha = max(0, min(255, int(data.get('alpha', 255))))

        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        img_array = np.frombuffer(base64.b64decode(image_data), np.uint8)
        img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400
        h, w = img.shape[:2]

        # Build prompt kwargs — box and/or points, both clamped to image bounds.
        prompt_kwargs = {}
        box_str = 'none'
        if box is not None:
            x1 = max(0, min(w - 1, int(box[0]))); y1 = max(0, min(h - 1, int(box[1])))
            x2 = max(x1 + 1, min(w, int(box[2]))); y2 = max(y1 + 1, min(h, int(box[3])))
            prompt_kwargs['bboxes'] = [[x1, y1, x2, y2]]
            box_str = f"({x1},{y1},{x2},{y2})"
        if points is not None:
            pts = [[max(0, min(w - 1, int(p[0]))), max(0, min(h - 1, int(p[1])))] for p in points]
            raw_labels = data.get('point_labels')
            labels = [int(l) for l in raw_labels] if isinstance(raw_labels, list) and len(raw_labels) == len(pts) else [1] * len(pts)
            if 'bboxes' in prompt_kwargs:
                # A flat point list reads as N SEPARATE prompts (batch N), while
                # the box is batch 1. SAM's prompt encoder then concatenates
                # mismatched batches and dies with
                #   "Sizes of tensors must match except in dimension 1.
                #    Expected size N but got size 1 for tensor number 1"
                # — reproduced locally with 1 box + 3 points. Nesting gives the
                # points the same batch dimension as the box, which is also the
                # correct meaning here: these points REFINE that one figure, they
                # are not independent objects.
                prompt_kwargs['points'] = [pts]
                prompt_kwargs['labels'] = [labels]
            else:
                # Points-only keeps the flat form: each point is its own prompt,
                # and the caller unions the resulting masks below.
                prompt_kwargs['points'] = pts
                prompt_kwargs['labels'] = labels

        # imgsz 1024 keeps memory bounded (16GB rule); measured 573MB peak.
        # Held under _mobilesam_lock: the model + predictor are shared process
        # state, so inference and the cache-clear must be atomic (see the lock's
        # definition). Copy the mask off the predictor to a plain numpy array
        # inside the lock; everything below runs on that copy and needs no lock.
        with _mobilesam_lock:
            results = model(img, imgsz=1024, verbose=False, **prompt_kwargs)
            res = results[0]
            has_mask = res.masks is not None and len(res.masks.data) > 0
            m = res.masks.data.cpu().numpy() if has_mask else None  # [n, mh, mw] at inference scale
            del results, res
            _free_sam_cache()
        if not has_mask:
            _release_memory()
            return jsonify({"success": False, "error": "no mask returned"}), 200

        union = (m.max(axis=0) > 0.5).astype(np.uint8) * 255
        union = cv2.resize(union, (w, h), interpolation=cv2.INTER_NEAREST)
        binary = union > 128

        out = np.zeros((h, w, 4), dtype=np.uint8)
        out[binary, 0] = int(color_rgb[2])  # BGR
        out[binary, 1] = int(color_rgb[1])
        out[binary, 2] = int(color_rgb[0])
        out[binary, 3] = alpha

        _, buffer = cv2.imencode('.png', out, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        fill_pixels = int(binary.sum())
        pts_str = f", points={prompt_kwargs.get('points')}" if 'points' in prompt_kwargs else ''
        payload = jsonify({
            "success": True,
            "image": f"data:image/png;base64,{base64.b64encode(buffer).decode('utf-8')}",
            "fill_pixels": fill_pixels,
        })
        # Drop the big per-call intermediates, then hand freed RSS back to the OS
        # so this long-running process doesn't creep up into an OOM 500. The
        # predictor's retained tensors (features/results — the ~300MB/call
        # growth) were already cleared under the lock above via _free_sam_cache.
        del m, union, binary, out, buffer, img, img_array
        _release_memory()
        print(f"[FIGURE-MASK] {w}x{h} crop, box={box_str}{pts_str}, fill px={fill_pixels}, rss={_rss_mb()}MB")
        return payload

    except Exception as e:
        # The failing path leaked hardest on staging: repair retries the same
        # crop, so a run of 500s stacked ~300MB each. Clear here too.
        print(f"[FIGURE-MASK] Error: {e} (rss={_rss_mb()}MB)")
        traceback.print_exc()
        with _mobilesam_lock:
            _free_sam_cache()
        _release_memory()
        print(f"[FIGURE-MASK] after cleanup rss={_rss_mb()}MB")
        return jsonify({"success": False, "error": str(e)}), 500


# YOLO pose for HEAD-PRESENCE on the avatar 2×4 bottom (body) row (lazy loaded,
# ~6MB weights, <0.5GB RSS). The bodies structure eval used to ask Gemini "does
# each figure have a head"; a VLM hallucinates the head on a headless torso
# because head+body co-occur in training (POPE-adversarial object hallucination —
# see docs/research-log.html). Pose grounds the answer in geometry instead: the
# COCO-17 skeleton has 5 dedicated head keypoints (nose, eyes, ears), each with a
# visibility confidence. Head present ⇔ a head keypoint fires above the shoulders.
# Validated on set #2 (exp #419): headed cells score 0.86–1.00, headless 0.00–0.10
# — no overlap. Runs only on the realistic pass-1 sheet, where pose models are
# strongest; pass-2 styled sheets never lose heads so they don't hit this.
_pose_model = None
_pose_last_used = 0.0
_POSE_IDLE_UNLOAD_S = int(os.environ.get('POSE_IDLE_UNLOAD_S', '900'))
# Ultralytics' YOLO predictor stashes the last run's results/batch on itself, so
# it is NOT thread-safe — the same reason MobileSAM is locked. Serialize load +
# inference so concurrent /pose-heads calls under waitress don't interleave.
_pose_lock = threading.Lock()


def get_pose_model():
    global _pose_model, _pose_last_used
    _pose_last_used = time.time()
    if _pose_model is None:
        with _pose_lock:
            if _pose_model is None:  # double-checked
                from ultralytics import YOLO  # optional dep — endpoint 503s if missing
                weights = os.environ.get('POSE_WEIGHTS', 'yolo11n-pose.pt')
                print(f"[POSE-HEADS] Loading YOLO pose ({weights})...")
                _pose_model = YOLO(weights)
    return _pose_model


# COCO-17 head keypoints: nose, left/right eye, left/right ear.
_POSE_HEAD_KP = [0, 1, 2, 3, 4]


@app.route('/pose-heads', methods=['POST'])
def pose_heads():
    """Head-presence per cell of an avatar body row (the 2×4 sheet's bottom strip).

    Splits the strip into `cols` equal cells (the 4 facing angles) and, for each,
    runs YOLO pose and reports whether a head is present.

    Expected JSON: { "image": "<data uri or base64>", "cols": 4 }

    Returns:
    {
      "success": true,
      "cells": [ { "head": bool, "head_max": 0-1, "n_kp": int,
                   "head_y_frac": 0-1|null, "clipped": bool }, ... ],
      "all_heads": bool, "any_clipped": bool
    }

    head        : a head keypoint fired above 0.5 confidence.
    clipped     : a head WAS found but its topmost keypoint sits in the top 8% of
                  the cell — i.e. the row-splitter cut through the head (the
                  divider landed too low). Caller treats this as a failure.
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"success": False, "error": "Missing 'image'"}), 400
        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        img = cv2.imdecode(np.frombuffer(base64.b64decode(image_data), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400
        cols = int(data.get('cols', 4))
        conf_th = float(data.get('conf', 0.5))
        clip_frac = float(data.get('clip_frac', 0.08))
        H, W = img.shape[:2]
        cw = W // max(cols, 1)
        model = get_pose_model()
        cells = []
        with _pose_lock:  # predictor is shared + not thread-safe
            for c in range(cols):
                cell = img[:, c * cw:(c + 1) * cw]
                r = model.predict(cell, verbose=False, conf=0.10)[0]
                if (r.keypoints is None or len(r.keypoints) == 0
                        or r.boxes is None or len(r.boxes) == 0):
                    cells.append({"head": False, "head_max": 0.0, "n_kp": 0,
                                  "head_y_frac": None, "clipped": False})
                    continue
                bi = int(np.argmax(r.boxes.conf.cpu().numpy()))
                kxy = r.keypoints.xy.cpu().numpy()[bi]
                kcf = r.keypoints.conf.cpu().numpy()[bi]
                head_conf = [float(kcf[i]) for i in _POSE_HEAD_KP]
                head_max = max(head_conf)
                n_kp = sum(1 for x in head_conf if x > conf_th)
                head_ys = [kxy[i][1] for i in _POSE_HEAD_KP if kcf[i] > 0.3]
                head_y_frac = float(min(head_ys) / cell.shape[0]) if head_ys else None
                has_head = n_kp >= 1 and head_max > conf_th
                clipped = bool(has_head and head_y_frac is not None and head_y_frac < clip_frac)
                cells.append({"head": has_head, "head_max": round(head_max, 3),
                              "n_kp": n_kp,
                              "head_y_frac": round(head_y_frac, 3) if head_y_frac is not None else None,
                              "clipped": clipped})
        return jsonify({
            "success": True, "cols": cols, "cells": cells,
            "all_heads": all(c["head"] and not c["clipped"] for c in cells),
            "any_clipped": any(c["clipped"] for c in cells),
        })
    except Exception as e:
        print(f"[POSE-HEADS] Error: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


# GroundingDINO for text-prompted figure DETECTION (lazy loaded, ~1.9GB peak RSS).
# Stage 1 of the local Grounded-SAM detection path: a full-identity text prompt
# -> the loose box for WHICH character is where. The box then goes to
# /figure-mask (MobileSAM) for the tight silhouette. Validated 5/5 on a real
# 5-figure page incl. an occluded figure (grounding-dino-base) — see
# docs/research-log.html. base > tiny: tiny missed the occluded figure.
_gdino_model = None
_gdino_processor = None
_gdino_last_used = 0.0
# Serialize model load AND the transformers import. Per-page detection runs
# concurrently, so without this lock two threads race `from transformers
# import ...` on a half-initialised module → "cannot import name AutoProcessor"
# 503s on the first calls (observed on staging), plus a double 1.9GB load.
_gdino_lock = threading.Lock()
# Free the ~1.9GB model after this many idle seconds so we don't pay for RAM
# 24/7 when detection runs only occasionally (e.g. one story/week on staging).
# Railway bills actual RAM per minute, so an unloaded model costs nothing.
_GDINO_IDLE_UNLOAD_S = int(os.environ.get('GROUNDINGDINO_IDLE_UNLOAD_S', '600'))


def get_groundingdino():
    global _gdino_model, _gdino_processor, _gdino_last_used
    _gdino_last_used = time.time()
    if _gdino_model is not None:
        return _gdino_model, _gdino_processor
    with _gdino_lock:
        # Re-check under the lock — another thread may have loaded it while we waited.
        if _gdino_model is None:
            # transformers is an optional dep — endpoint 503s if missing so Node
            # falls back to the Gemini bbox.
            # ONE RETRY on the first-import race (2026-08-23): the first load
            # after a cold start or idle-unload can hit a concurrent-import
            # collision ("cannot import name 'ExportOptions' from
            # torch.onnx._internal.exporter" — another thread is mid-way through
            # initialising a torch submodule). The second attempt succeeds once
            # that import settles; without the retry a single refresh-bbox call
            # 503s and silently ships a Gemini fallback page.
            model_id = os.environ.get('GROUNDINGDINO_MODEL', 'IDEA-Research/grounding-dino-base')
            last_err = None
            for _attempt in range(2):
                try:
                    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection
                    print(f"[GDINO] Loading GroundingDINO ({model_id})...")
                    proc = AutoProcessor.from_pretrained(model_id)
                    model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id)
                    last_err = None
                    break
                except (ImportError, RuntimeError) as e:
                    last_err = e
                    print(f"[GDINO] load attempt {_attempt + 1} failed ({type(e).__name__}: {e!r}) — retrying in 3s")
                    time.sleep(3)
            if last_err is not None:
                raise last_err
            model.eval()
            _gdino_processor = proc
            _gdino_model = model
            _gdino_last_used = time.time()
            print("[GDINO] GroundingDINO loaded")
    return _gdino_model, _gdino_processor


# The per-model idle reaper that lived here was deleted 2026-08-23 along with
# the RSS-threshold recycler: models now live in worker PROCESSES whose death at
# session end returns everything — weights, fragmentation, allocator arenas —
# with no timers to tune and no warm-hold coupling. See the worker lifecycle
# block near the top of this file.


@app.route('/detect-figures-text', methods=['POST'])
def detect_figures_text_endpoint():
    """
    Text-prompted figure detection (GroundingDINO). For each character's
    full-identity prompt, returns the best box + score + all candidate boxes.
    The Node caller feeds each best box to /figure-mask for the tight
    silhouette, and uses the candidates + scores for the overlap guard /
    retry.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",       # full page
        "prompts": [{"name": "Emma", "text": "a preschooler girl with brown hair in a pink top"}],
        "box_threshold": 0.25,   # optional
        "text_threshold": 0.20   # optional
    }

    Returns:
    {
        "success": true,
        "width": W, "height": H,
        "figures": [
          {"name": "Emma", "box": [x1,y1,x2,y2], "score": 0.80,
           "candidates": [{"box":[...], "score":0.80}, ...]}   # box null if none found
        ]
    }
    Box coords are pixels in the input image. 503 if the model is unavailable.
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"success": False, "error": "No image provided"}), 400
        prompts = data.get('prompts')
        if not (isinstance(prompts, list) and len(prompts) > 0):
            return jsonify({"success": False, "error": "prompts [{name,text}] required"}), 400

        try:
            model, processor = get_groundingdino()
        except Exception as load_err:
            # repr + traceback, not str: the crash-loop of 2026-08-22 printed
            # "GroundingDINO unavailable: " with NOTHING after the colon
            # (str(MemoryError()) and several import errors are empty) and the
            # outage was undiagnosable from logs for hours.
            import traceback as _tb
            _tb.print_exc()
            _cache = os.environ.get('HF_HOME', '~/.cache/huggingface')
            _cached = os.path.isdir(os.path.join(_cache, 'hub', 'models--IDEA-Research--grounding-dino-base'))
            print(f"[GDINO] GroundingDINO unavailable: {type(load_err).__name__}: {load_err!r} (weights cached in image: {_cached})")
            return jsonify({"success": False, "error": f"groundingdino unavailable: {type(load_err).__name__}: {load_err!r}"}), 503

        import torch
        box_threshold = float(data.get('box_threshold', 0.25))
        text_threshold = float(data.get('text_threshold', 0.20))

        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        img_bgr = cv2.imdecode(np.frombuffer(base64.b64decode(image_data), np.uint8), cv2.IMREAD_COLOR)
        if img_bgr is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400
        h, w = img_bgr.shape[:2]
        pil = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))

        # PER-FIGURE — one forward pass per character (image re-encoded per
        # prompt). Batching all prompts into one query was tried and reverted:
        # multi-phrase attention dilution collapsed scores and missed figures on
        # non-photographic styles (near-zero on watercolour). GroundingDINO now
        # only runs for the realistic art style (gated Node-side), where
        # per-figure is reliable; one short prompt never hits the 256-token cap.
        figures = []
        for p in prompts:
            name = (p or {}).get('name')
            text = str((p or {}).get('text') or '').lower().strip()
            if not name or not text:
                figures.append({"name": name, "box": None, "score": None, "candidates": []})
                continue
            if not text.endswith('.'):
                text += '.'
            inputs = processor(images=pil, text=text, return_tensors="pt")
            with torch.no_grad():
                out = model(**inputs)
            # transformers renamed the box_threshold kwarg and made input_ids
            # optional across versions — handle both.
            try:
                res = processor.post_process_grounded_object_detection(
                    out, inputs["input_ids"], threshold=box_threshold,
                    text_threshold=text_threshold, target_sizes=[pil.size[::-1]])[0]
            except TypeError:
                # transformers 4.44-era API: the kwarg is box_threshold, not
                # threshold (renamed in a later release). Both branches passed
                # threshold= before 2026-08-22, so on the pinned 4.44.2 image
                # every call 500d AFTER the model finally loaded.
                res = processor.post_process_grounded_object_detection(
                    out, inputs["input_ids"], box_threshold=box_threshold,
                    text_threshold=text_threshold, target_sizes=[pil.size[::-1]])[0]
            boxes = res["boxes"].cpu().numpy() if len(res["boxes"]) else np.zeros((0, 4))
            scores = res["scores"].cpu().numpy() if len(res["scores"]) else np.zeros((0,))
            cand = []
            for b, s in sorted(zip(boxes.tolist(), scores.tolist()), key=lambda z: -z[1]):
                cand.append({"box": [int(round(v)) for v in b], "score": round(float(s), 3)})
            best = cand[0] if cand else {"box": None, "score": None}
            figures.append({"name": name, "box": best["box"], "score": best["score"], "candidates": cand})
            del inputs, out, res, boxes, scores
            print(f"[GDINO] {name}: {len(cand)} boxes, best score {best['score']}")

        # Detection runs many times per story (per page) — release the per-call
        # transients so RSS doesn't accumulate while both models stay loaded.
        _release_memory()
        return jsonify({"success": True, "width": w, "height": h, "figures": figures})

    except Exception as e:
        print(f"[GDINO] Error: {e}")
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


_warmup_thread = None


@app.route('/warmup', methods=['POST'])
def warmup_endpoint():
    """Preload every model this environment will need, ahead of time.

    Called when a user becomes active. The point is that model loading should
    happen while the user is still filling in the wizard or while the story's
    opening Claude calls run for minutes — not on the first mask call in the
    middle of character repair, where it costs ~570MB and several seconds of
    latency inside the repair loop.


    Returns immediately; loading happens on a background thread. Poll /health
    for the *_loaded flags. Idempotent — get_*() are no-ops when already loaded.

    Parent role: warmup means "spawn the workers this session will need and let
    each preload its own models" — the spawn happens now, during the wizard/text
    phase, so the story's repair phase never pays a cold start. No warm-hold
    timer: workers live until the session count hits zero, however long that is.
    """
    global _warmup_thread
    if _warmup_thread is not None and _warmup_thread.is_alive():
        return jsonify({"success": True, "status": "already warming"})

    # WHAT TO PRELOAD IS THE CALLER'S ANSWER (owner, 2026-08-17).
    #
    # This used to be read from the analyzer's own FIGURE_DETECTION_BACKEND env
    # var, defaulting to empty. So two places had to agree, and when the Node
    # default flipped to grounding-dino this copy still said "empty" and skipped
    # loading DINO — putting the ~90s load on the first real detection call,
    # which falls back to the Gemini bbox rather than wait for it. That defeats
    # the point of warmup, which exists so a load happens while the user is in
    # the wizard.
    #
    # The pipeline now keeps behaviour in server/config/runtime.js with no env
    # override, so this process cannot read the truth even in principle: it is
    # told. Body {"dino": true|false}; the env var remains only as a local-dev
    # override for running this service standalone, and defaults to loading.
    body = request.get_json(silent=True) or {}
    if 'dino' in body:
        want_dino = bool(body['dino'])
    else:
        want_dino = os.environ.get('FIGURE_DETECTION_BACKEND', 'grounding-dino') == 'grounding-dino'
    # ArcFace is OFF unless asked for: it is only needed when an avatar is about
    # to be created (roughly weekly), and TensorFlow's footprint should never be
    # paid by a page view, a login, or a story run that creates no avatar.
    # Callers that know an avatar is coming send {"arcface": true}.
    want_arcface = bool(body.get('arcface', False))

    def _warm():
        t0 = time.time()
        if ANALYZER_ROLE == 'parent':
            # Spawn the workers this session will need; forward the SAME warmup
            # body to each so it preloads its own models. face loads mediapipe
            # at boot; rembg/torch preload below; arcface only when asked.
            roles = ['face', 'torch'] + (['arcface'] if want_arcface else [])
            for role in roles:
                try:
                    base = ensure_worker(role)
                    req = _urlreq.Request(f"{base}/warmup", data=json.dumps(body).encode(),
                                          headers={'Content-Type': 'application/json'}, method='POST')
                    _urlreq.urlopen(req, timeout=10).read()
                except Exception as e:
                    print(f"[WARMUP] {role} worker warm failed: {e}")
            print(f"[WARMUP] workers up in {time.time() - t0:.1f}s")
            return
        # Worker roles preload only what they own.
        if ANALYZER_ROLE == 'face':
            # This worker owns the whole photo path, so it loads U2-Net itself.
            # Warming it in a separate rembg worker warmed the wrong process
            # (a "warmed" first upload still took 17.9s) AND loaded the model
            # twice once both existed — hence the merge.
            try:
                get_rembg_session()
            except Exception as e:
                print(f"[WARMUP] face/rembg failed: {e}")
        if ANALYZER_ROLE == 'torch':
            try:
                get_mobilesam()
            except Exception as e:
                print(f"[WARMUP] mobilesam failed: {e}")
            if want_dino:
                try:
                    get_groundingdino()
                except Exception as e:
                    print(f"[WARMUP] groundingdino failed: {e}")
        if ANALYZER_ROLE == 'arcface':
            try:
                from deepface import DeepFace
                DeepFace.build_model('ArcFace')
            except Exception as e:
                print(f"[WARMUP] arcface failed: {e}")
        print(f"[WARMUP] {ANALYZER_ROLE} done in {time.time() - t0:.1f}s — rss {_rss_mb()} MB")

    _warmup_thread = threading.Thread(target=_warm, daemon=True)
    _warmup_thread.start()
    return jsonify({"success": True, "status": "warming", "role": ANALYZER_ROLE, "groundingdino": want_dino})


@app.route('/release-memory', methods=['POST'])
def release_memory_endpoint():
    """Force a memory release NOW instead of waiting out the idle reapers.

    The reapers only fire after 10-15 minutes of no use, which is right for
    normal running but useless when you want to reclaim RAM on demand or verify
    that the release actually works. Railway bills resident memory per minute,
    so being able to hand pages back without restarting the container is an
    operational lever, not just a test hook.

    POST /release-memory            gc + malloc_trim, models stay loaded
    POST /release-memory?unload=true  also drop every lazily-loaded model

    Returns before/after RSS so the caller can see what was actually freed —
    the whole point is that gc.collect() alone does NOT lower RSS; only the
    malloc_trim(0) inside _release_memory() hands pages back to the OS.
    """
    global _mobilesam_model, _gdino_model, _gdino_processor, _rembg_session, rembg_remove
    before = _rss_mb()
    unloaded = []
    # Parent role: the models live in worker processes, so "unload" means
    # killing them — which, unlike every in-process scheme, returns 100%.
    if ANALYZER_ROLE == 'parent' and request.args.get('unload') == 'true':
        # REFUSE while work is in flight (2026-09-05). This is one shared service
        # for every concurrent story and Test Lab run, and `_active_sessions` is
        # a count, not a set of identities — so an admin reclaiming RAM here was
        # able to kill the workers out from under a DIFFERENT user's generation,
        # silently, with nothing in the response to say so. The idle reaper has
        # always had this guard; the on-demand path did not.
        with _request_lock:
            other_inflight = _inflight_requests > 1  # this request is counted
            sessions_open = _active_sessions
        if (sessions_open > 0 or other_inflight) and request.args.get('force') != 'true':
            return jsonify({
                "success": False,
                "refused": "work in flight",
                "active_sessions": sessions_open,
                "other_inflight_requests": other_inflight,
                "hint": "retry when idle, or pass &force=true to kill it anyway",
            }), 409
        if _workers:
            unloaded = [f"worker:{r}" for r in _workers]
            kill_workers('release-memory',
                         force=request.args.get('force') == 'true')
        # Synchronous here (not the async helper): a caller asking to reclaim on
        # demand wants the numbers in the response, not eventually.
        cache_files, cache_ms = drop_file_cache()
        unloaded.append(f'page-cache:{cache_files}files/{cache_ms}ms')
    elif request.args.get('unload') == 'true':
        if _mobilesam_model is not None:
            _mobilesam_model = None
            unloaded.append('mobilesam')
        if _gdino_model is not None:
            _gdino_model = None
            _gdino_processor = None
            unloaded.append('groundingdino')
        if _rembg_session is not None:
            with _rembg_lock:
                _rembg_session = None
                rembg_remove = None
            unloaded.append('rembg')
        # ArcFace: drop DeepFace's cached model objects (the cache is a module
        # global created lazily inside build_model, so it may not exist yet).
        #
        # MEASURED, so nobody has to guess: baseline 17MB -> 346MB on `import
        # deepface` (that is TensorFlow, before any model) -> 510MB once ArcFace
        # is built. Clearing the cache returns ~135MB of weights and leaves
        # ~358MB of TF runtime resident. Python cannot un-import a module and TF
        # keeps its own allocator arenas, so malloc_trim cannot hand that back.
        #
        # The ONLY way to return the TF runtime is to exit the process —
        # in the worker architecture that happens at session end, when the
        # arcface worker is killed.
        try:
            import sys as _sys
            if 'deepface' in _sys.modules:
                from deepface.modules import modeling as _dfm
                if getattr(_dfm, 'cached_models', None):
                    _dfm.cached_models.clear()
                    unloaded.append('arcface-weights')
        except Exception as e:
            print(f"[RELEASE-MEMORY] arcface unload skipped: {e}")
    _release_memory()
    after = _rss_mb()
    freed = None if (before is None or after is None) else round(before - after, 1)
    print(f"[RELEASE-MEMORY] {before} MB -> {after} MB (freed {freed} MB), unloaded={unloaded or 'none'}")

    # ?recycle=true — the only thing that reclaims fragmentation. Exits AFTER
    # responding so the caller still gets its numbers; the supervisor in
    # start.sh restarts us. Refused while other work is in flight.
    if request.args.get('recycle') == 'true':
        with _request_lock:
            others = max(0, _inflight_requests - 1)  # exclude this request
        if others > 0:
            print(f"[RELEASE-MEMORY] recycle refused — {others} request(s) still in flight")
            return jsonify({
                "success": True, "recycled": False,
                "reason": f"{others} request(s) in flight",
                "rss_before_mb": before, "rss_after_mb": after, "freed_mb": freed, "unloaded": unloaded,
            })

        def _exit_soon():
            time.sleep(1.0)  # let the response flush
            print("[RELEASE-MEMORY] recycling now — supervisor will restart")
            sys.stdout.flush()
            os._exit(0)

        threading.Thread(target=_exit_soon, daemon=True).start()
        return jsonify({
            "success": True, "recycled": True,
            "rss_before_mb": before, "rss_after_mb": after, "freed_mb": freed, "unloaded": unloaded,
            "note": "process exiting; supervisor restarts it in ~10s, models reload lazily",
        })

    return jsonify({
        "success": True,
        "recycled": False,
        "rss_before_mb": before,
        "rss_after_mb": after,
        "freed_mb": freed,
        "unloaded": unloaded,
    })



def _cpu_stats():
    """Cumulative process CPU + the container's real quota. Never raises."""
    out = {}
    try:
        import resource
        ru_self = resource.getrusage(resource.RUSAGE_SELF)
        ru_kids = resource.getrusage(resource.RUSAGE_CHILDREN)
        out["cpu_seconds"] = round(
            ru_self.ru_utime + ru_self.ru_stime + ru_kids.ru_utime + ru_kids.ru_stime, 2
        )
    except Exception:
        # Windows has no resource module; time.process_time is close enough.
        try:
            out["cpu_seconds"] = round(time.process_time(), 2)
        except Exception:
            out["cpu_seconds"] = None
    try:
        out["cpu_quota"] = _container_cpus()
        out["host_cpus"] = os.cpu_count()
        out["threads"] = int(os.environ.get('ANALYZER_THREADS') or out["cpu_quota"])
    except Exception:
        pass
    return out


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint.

    Reports process RSS and which heavy models are resident so the caller can
    see memory pressure (the SAM-500 root cause) without guessing. ?probe=sam
    runs a tiny box-prompt MobileSAM inference and reports whether it actually
    works right now — a real readiness check, not just 'process is up'."""
    lpips_available = False
    try:
        import lpips
        lpips_available = True
    except ImportError:
        pass
    body = {
        "status": "ok",
        "service": "photo-analyzer",
        "mediapipe_available": MEDIAPIPE_AVAILABLE,
        "rembg_available": REMBG_AVAILABLE,
        "rembg_loaded": _rembg_session is not None,
        # Per-import-block RSS at boot. This is how we attribute the idle floor
        # to a specific import instead of guessing — readable without log access.
        "boot_rss": BOOT_RSS_LOG,
        "lpips_available": lpips_available,
        "rss_mb": _rss_mb(),
        "mobilesam_loaded": _mobilesam_model is not None,
        "groundingdino_loaded": _gdino_model is not None,
        # CPU accounting. cpu_seconds is CUMULATIVE process CPU (user+sys) since
        # boot, so two reads around a story give the real CPU-seconds it burned
        # — wall-clock over-counts badly because most of the images stage is
        # network wait on the image model, not local compute. cpu_quota is what
        # the container may actually use (Railway bills per vCPU-minute), which
        # is also what the waitress thread pool is sized from.
        "cpu": _cpu_stats(),
        "role": ANALYZER_ROLE,
    }
    if ANALYZER_ROLE == 'parent':
        body["active_sessions"] = _active_sessions
        # Per-worker RSS, not just up/down. `rss_mb` above is the ROUTER only,
        # and the router is the small one: measured mid-story the router held
        # 89 MB while two workers held 1.43 GB and 985 MB. Anything reading this
        # endpoint to answer "how much is this container using" was understating
        # it by more than a gigabyte, which is how a 9.85 GB peak went unseen.
        # `python_total_rss_mb` is the number to compare against the cgroup.
        workers = {}
        worker_rss = 0.0
        for role in WORKER_PORTS:
            entry = {"port": WORKER_PORTS[role], "up": _worker_alive(role)}
            proc = _workers.get(role)
            if proc is not None and proc.poll() is None:
                rss = _proc_rss_mb(proc.pid)
                if rss is not None:
                    entry["rss_mb"] = rss
                    worker_rss += rss
            workers[role] = entry
        body["workers"] = workers
        body["workers_rss_mb"] = round(worker_rss, 1)
        body["python_total_rss_mb"] = round(body.get("rss_mb", 0) + worker_rss, 1)
    if request.args.get('probe') == 'sam' and ANALYZER_ROLE == 'parent':
        # SAM lives in the torch worker; loading it here would put 570MB into
        # the process that is supposed to stay at 53MB. Forward the probe.
        try:
            base = ensure_worker('torch')
            with _urlreq.urlopen(f"{base}/health?probe=sam", timeout=180) as r:
                worker_body = json.loads(r.read())
            body["sam_probe"] = worker_body.get("sam_probe", "no answer")
            if worker_body.get("status") == "degraded":
                body["status"] = "degraded"
        except Exception as e:
            body["sam_probe"] = f"fail: torch worker: {e}"
            body["status"] = "degraded"
        return jsonify(body)
    if request.args.get('probe') == 'sam':
        try:
            model = get_mobilesam()
            probe_img = np.full((64, 64, 3), 128, dtype=np.uint8)
            r = model(probe_img, imgsz=1024, verbose=False, bboxes=[[8, 8, 56, 56]])
            ok = r and r[0].masks is not None
            del r
            _free_sam_cache()
            _release_memory()
            body["sam_probe"] = "ok" if ok else "no_mask"
        except Exception as e:
            body["sam_probe"] = f"fail: {e}"
            body["status"] = "degraded"
            _free_sam_cache()
            _release_memory()
    return jsonify(body)


@app.route('/analyze', methods=['POST'])
def analyze_photo():
    """
    Analyze uploaded photo - returns face thumbnail and body with background removed.
    Supports multi-face detection and selection.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,..." or base64 string,
        "selected_face_id": null (for initial) or 0/1/2... (after selection)
    }

    Returns (if multiple faces and no selection):
    {
        "success": true,
        "multiple_faces_detected": true,
        "faces": [
            {"id": 0, "confidence": 0.95, "face_box": {...}, "thumbnail": "data:..."},
            {"id": 1, "confidence": 0.72, "face_box": {...}, "thumbnail": "data:..."}
        ]
    }

    Returns (single face or after selection):
    {
        "success": true,
        "multiple_faces_detected": false,
        "face_thumbnail": "data:image/jpeg;base64,...",
        "body_no_bg": "data:image/png;base64,...",
        "face_box": {...},
        "body_box": {...}
    }
    """
    try:
        data = request.get_json()

        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' field in request"
            }), 400

        image_data = data['image']
        selected_face_id = data.get('selected_face_id')  # None for initial, int after selection
        cached_faces = data.get('cached_faces')  # Face data from first call (prevents re-detection ID instability)

        result = process_photo(image_data, is_base64=True, selected_face_id=selected_face_id, cached_faces=cached_faces)

        if result['success']:
            return jsonify(result), 200
        else:
            return jsonify(result), 500

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/test', methods=['GET'])
def test():
    """Test endpoint to verify dependencies are working"""
    try:
        import cv2
        import mediapipe
        lpips_available = False
        try:
            import lpips
            lpips_available = True
        except ImportError:
            pass
        return jsonify({
            "success": True,
            "mediapipe_version": mediapipe.__version__,
            "opencv_installed": True,
            "lpips_available": lpips_available,
            "note": "DeepFace removed - age/gender from Gemini"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# LPIPS model (lazy loaded)
_lpips_model = None

def get_lpips_model():
    """Lazy load LPIPS model to avoid startup delay"""
    global _lpips_model
    if _lpips_model is None:
        try:
            import lpips
            print("[LPIPS] Loading LPIPS model (AlexNet)...")
            _lpips_model = lpips.LPIPS(net='alex')
            print("   LPIPS model loaded")
        except ImportError:
            print("[WARN] LPIPS not available - install with: pip install lpips")
            return None
    return _lpips_model


def decode_image_to_tensor(image_data):
    """Decode base64 image to normalized tensor for LPIPS"""
    import torch

    # Remove data URL prefix if present
    if ',' in image_data:
        image_data = image_data.split(',')[1]

    # Decode base64
    image_bytes = base64.b64decode(image_data)
    img_pil = Image.open(BytesIO(image_bytes)).convert('RGB')

    # Convert to numpy, then to tensor
    img_np = np.array(img_pil).astype(np.float32) / 255.0

    # Normalize to [-1, 1] range (LPIPS requirement)
    img_np = img_np * 2 - 1

    # Convert to tensor: [H, W, C] -> [1, C, H, W]
    img_tensor = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0)

    return img_tensor, img_pil.size


def crop_tensor_to_bbox(img_tensor, bbox, img_size):
    """
    Crop tensor to bounding box region
    bbox: [ymin, xmin, ymax, xmax] normalized 0.0-1.0
    img_size: (width, height)
    """
    import torch

    width, height = img_size
    ymin, xmin, ymax, xmax = bbox

    # Convert normalized coords to pixels
    y1 = int(ymin * height)
    x1 = int(xmin * width)
    y2 = int(ymax * height)
    x2 = int(xmax * width)

    # Ensure valid bounds
    y1 = max(0, y1)
    x1 = max(0, x1)
    y2 = min(height, y2)
    x2 = min(width, x2)

    # Crop: tensor is [1, C, H, W]
    cropped = img_tensor[:, :, y1:y2, x1:x2]

    # Ensure we have a valid crop (at least 1x1)
    if cropped.shape[2] == 0 or cropped.shape[3] == 0:
        print(f"[LPIPS] Warning: crop resulted in empty tensor, using original")
        return img_tensor

    return cropped


@app.route('/lpips', methods=['POST'])
def compare_lpips():
    """
    Compare two images using LPIPS perceptual similarity.

    Expected JSON:
    {
        "image1": "data:image/jpeg;base64,...",  # Original/reference image (face photo)
        "image2": "data:image/jpeg;base64,...",  # Generated/modified image (e.g., 2x2 grid)
        "bbox": [ymin, xmin, ymax, xmax],        # Optional: crop image2 to this region (0.0-1.0)
        "resize_to": 256                          # Optional: resize for faster comparison
    }

    Note: bbox only applies to image2. This is useful when comparing a face photo (image1)
    against a 2x2 grid avatar (image2) - use bbox=[0,0,0.5,0.5] to compare against top-left face.

    Returns:
    {
        "success": true,
        "lpips_score": 0.123,      # 0 = identical, 1 = very different
        "interpretation": "very_similar",
        "region": "full" or "cropped"
    }
    """
    try:
        model = get_lpips_model()
        if model is None:
            return jsonify({
                "success": False,
                "error": "LPIPS not available. Install with: pip install lpips torch torchvision"
            }), 503

        import torch

        data = request.get_json()
        if not data or 'image1' not in data or 'image2' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image1' or 'image2' in request"
            }), 400

        # Decode images
        img1_tensor, img1_size = decode_image_to_tensor(data['image1'])
        img2_tensor, img2_size = decode_image_to_tensor(data['image2'])

        region = "full"

        # Optional: crop to bounding box
        # bbox: crops only image2 (for comparing face photo vs 2x2 grid)
        # bbox_both: crops both images (for comparing two 2x2 grids against each other)
        bbox = data.get('bbox')
        bbox_both = data.get('bbox_both')

        if bbox_both and len(bbox_both) == 4:
            # Crop BOTH images to the same region (e.g., compare faces from two 2x2 grids)
            img1_tensor = crop_tensor_to_bbox(img1_tensor, bbox_both, img1_size)
            img2_tensor = crop_tensor_to_bbox(img2_tensor, bbox_both, img2_size)
            region = "cropped_both"
        elif bbox and len(bbox) == 4:
            # Crop only image2 (for comparing face photo vs 2x2 grid)
            img2_tensor = crop_tensor_to_bbox(img2_tensor, bbox, img2_size)
            region = "cropped_img2"

        # Optional: resize for faster comparison
        resize_to = data.get('resize_to')
        if resize_to:
            import torch.nn.functional as F
            img1_tensor = F.interpolate(img1_tensor, size=(resize_to, resize_to), mode='bilinear', align_corners=False)
            img2_tensor = F.interpolate(img2_tensor, size=(resize_to, resize_to), mode='bilinear', align_corners=False)

        # Ensure same size (resize img2 to match img1 if needed)
        if img1_tensor.shape != img2_tensor.shape:
            import torch.nn.functional as F
            img2_tensor = F.interpolate(img2_tensor, size=img1_tensor.shape[2:], mode='bilinear', align_corners=False)

        # (Removed dev-only debug image writes to test-results/; in production
        # the directory doesn't exist and the writes silently failed, but if
        # ever created they'd persist decoded comparison images on disk.)

        # Compute LPIPS
        with torch.no_grad():
            lpips_score = model(img1_tensor, img2_tensor).item()

        # Interpret score
        if lpips_score < 0.05:
            interpretation = "nearly_identical"
        elif lpips_score < 0.15:
            interpretation = "very_similar"
        elif lpips_score < 0.30:
            interpretation = "somewhat_similar"
        else:
            interpretation = "different"

        return jsonify({
            "success": True,
            "lpips_score": round(lpips_score, 4),
            "interpretation": interpretation,
            "region": region,
            "image1_size": list(img1_size),
            "image2_size": list(img2_size)
        }), 200

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/split-grid', methods=['POST'])
def split_grid():
    """
    Split a 2x2 grid image into 4 quadrants and extract face from top-left.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,..."  # 2x2 grid image from avatar generation
    }

    Returns:
    {
        "success": true,
        "quadrants": {
            "faceFront": "base64...",     # Top-left: face looking at camera
            "faceProfile": "base64...",   # Top-right: face 3/4 profile
            "bodyFront": "base64...",     # Bottom-left: full body front
            "bodyProfile": "base64..."    # Bottom-right: full body profile
        },
        "faceThumbnail": "base64..."      # Extracted face from faceFront
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' in request body"
            }), 400

        # Decode base64 image
        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({
                "success": False,
                "error": "Failed to decode image"
            }), 400

        height, width = image.shape[:2]

        # Detect the actual grid separator lines instead of assuming 50/50 split.
        # The 2x2 grid typically has a visible gap/line between cells.
        # Strategy: find the row/column with the most uniform color (= separator).
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # Find horizontal separator: row with lowest variance in the middle 60% of image
        search_h_start = int(height * 0.3)
        search_h_end = int(height * 0.7)
        row_variances = []
        for y in range(search_h_start, search_h_end):
            row_variances.append((np.var(gray[y, :].astype(float)), y))
        row_variances.sort()
        mid_h = row_variances[0][1] if row_variances else height // 2

        # Find vertical separator: column with lowest variance in the middle 60%
        search_w_start = int(width * 0.3)
        search_w_end = int(width * 0.7)
        col_variances = []
        for x in range(search_w_start, search_w_end):
            col_variances.append((np.var(gray[:, x].astype(float)), x))
        col_variances.sort()
        mid_w = col_variances[0][1] if col_variances else width // 2

        print(f"[SPLIT-GRID] {width}x{height}, detected grid at x={mid_w} y={mid_h}")

        # Split using detected grid lines
        quadrants = {
            'faceFront': image[0:mid_h, 0:mid_w],
            'faceProfile': image[0:mid_h, mid_w:width],
            'bodyFront': image[mid_h:height, 0:mid_w],
            'bodyProfile': image[mid_h:height, mid_w:width]
        }

        # Verify body quadrants have heads: detect faces in each body quadrant.
        # If head is cut off, expand upward to include it.
        for body_key in ['bodyFront', 'bodyProfile']:
            body_img = quadrants[body_key]
            face = detect_face_mediapipe(body_img)
            if face and face['y'] < 5:
                # Face is at very top edge — likely cut off. Expand upward.
                col_start = 0 if body_key == 'bodyFront' else mid_w
                col_end = mid_w if body_key == 'bodyFront' else width
                # Search above mid_h for the face in the original image
                expanded_top = max(0, mid_h - int(height * 0.15))
                quadrants[body_key] = image[expanded_top:height, col_start:col_end]
                print(f"[SPLIT-GRID] {body_key}: face at top edge, expanded from y={expanded_top}")
            elif not face:
                # No face detected at all — expand upward as fallback
                col_start = 0 if body_key == 'bodyFront' else mid_w
                col_end = mid_w if body_key == 'bodyFront' else width
                expanded_top = max(0, mid_h - int(height * 0.10))
                quadrants[body_key] = image[expanded_top:height, col_start:col_end]
                print(f"[SPLIT-GRID] {body_key}: no face detected, expanded from y={expanded_top}")

        # Encode each quadrant as base64 JPEG
        encoded_quadrants = {}
        for name, quad in quadrants.items():
            _, buffer = cv2.imencode('.jpg', quad, [cv2.IMWRITE_JPEG_QUALITY, 90])
            encoded_quadrants[name] = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        # Extract face from top-left quadrant (faceFront)
        face_thumbnail = None
        face_front = quadrants['faceFront']

        # Try MediaPipe first, fall back to OpenCV
        face_box = detect_face_mediapipe(face_front)

        if face_box:
            face_thumbnail = create_face_thumbnail(face_front, face_box, size=768)
        else:
            # If no face detected, use the whole faceFront quadrant resized to square
            h, w = face_front.shape[:2]
            max_dim = max(h, w)
            square = np.full((max_dim, max_dim, 3), [230, 240, 255], dtype=np.uint8)
            y_off = (max_dim - h) // 2
            x_off = (max_dim - w) // 2
            square[y_off:y_off+h, x_off:x_off+w] = face_front
            thumbnail = cv2.resize(square, (768, 768), interpolation=cv2.INTER_LANCZOS4)
            _, buffer = cv2.imencode('.jpg', thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 90])
            face_thumbnail = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        thumb_kb = round(len(face_thumbnail) / 1024) if face_thumbnail else 0
        face_info = f"detected at {face_box['x']:.0f}%,{face_box['y']:.0f}%" if face_box else "not detected"
        print(f"[SPLIT-GRID] Face: {face_info}, thumbnail: {thumb_kb}KB")

        return jsonify({
            "success": True,
            "quadrants": encoded_quadrants,
            "faceThumbnail": face_thumbnail
        }), 200

    except Exception as e:
        print(f"[SPLIT-GRID] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


def _detect_separators(gray, axis, num_separators, search_range=(0.15, 0.85)):
    """
    Detect the N strongest separator lines along the given axis using variance.

    A separator is a line of nearly-uniform color (low variance) that visually
    divides the grid cells. We pick the N rows/columns with the LOWEST variance
    inside the search range, then enforce a minimum spacing between them so we
    don't return adjacent rows that are part of the same separator gap.

    Args:
        gray: Grayscale 2D numpy array
        axis: 'horizontal' (find row separators) or 'vertical' (find column separators)
        num_separators: How many separator lines to find
        search_range: (start_frac, end_frac) of the dimension to search inside

    Returns:
        Sorted list of separator coordinates, length num_separators
    """
    if num_separators <= 0:
        return []

    if axis == 'horizontal':
        # Find rows
        dim = gray.shape[0]
        start = int(dim * search_range[0])
        end = int(dim * search_range[1])
        variances = [(np.var(gray[y, :].astype(float)), y) for y in range(start, end)]
    else:
        # Find columns
        dim = gray.shape[1]
        start = int(dim * search_range[0])
        end = int(dim * search_range[1])
        variances = [(np.var(gray[:, x].astype(float)), x) for x in range(start, end)]

    if not variances:
        return [dim // (num_separators + 1) * (i + 1) for i in range(num_separators)]

    # Sort by variance (ascending — lowest variance = most uniform = separator)
    variances.sort()

    # Greedy pick: take lowest-variance candidates that are at least
    # min_spacing apart from each other.
    min_spacing = int(dim * 0.15)  # at least 15% of dimension between separators
    picked = []
    for _, coord in variances:
        if all(abs(coord - p) >= min_spacing for p in picked):
            picked.append(coord)
            if len(picked) >= num_separators:
                break

    # Fall back to even-split if we couldn't find enough good candidates
    while len(picked) < num_separators:
        even = dim // (num_separators + 1) * (len(picked) + 1)
        picked.append(even)

    return sorted(picked)


@app.route('/split-reference-sheet', methods=['POST'])
def split_reference_sheet():
    """
    Split an N-cell reference sheet image into individual cell images.

    The image generator was asked to render N elements in a {cols}x{rows}
    grid. Variance analysis finds the actual cell boundaries (rather than
    blindly dividing the image into equal rectangles), so visible gaps,
    title bars, and uneven cell sizes don't break the split.

    Expected JSON:
    {
        "image": "data:image/...;base64,..." or raw base64,
        "count": <number of cells, 1-6>,
        "cols": <optional, hint about columns layout>,
        "rows": <optional, hint about rows layout>
    }

    Returns:
    {
        "success": true,
        "cells": ["base64...", "base64...", ...],   # row-major order
        "layout": { "cols": N, "rows": M },
        "separators": { "horizontal": [...], "vertical": [...] }
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data or 'count' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' or 'count' in request body"
            }), 400

        count = int(data['count'])
        if count < 1 or count > 12:
            return jsonify({
                "success": False,
                "error": f"count must be 1-12, got {count}"
            }), 400

        # Decode base64 image
        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({
                "success": False,
                "error": "Failed to decode image"
            }), 400

        height, width = image.shape[:2]

        # Determine grid layout
        if 'cols' in data and 'rows' in data:
            cols = int(data['cols'])
            rows = int(data['rows'])
        else:
            # Default layouts matching the JS-side prompt builder:
            # 2x2 only for exactly 4 elements, single column for everything else
            if count == 4:
                cols, rows = 2, 2
            else:
                cols, rows = 1, count

        if cols * rows < count:
            return jsonify({
                "success": False,
                "error": f"layout {cols}x{rows} too small for count={count}"
            }), 400

        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # Find (cols-1) vertical separators and (rows-1) horizontal separators
        v_seps = _detect_separators(gray, 'vertical', cols - 1) if cols > 1 else []
        h_seps = _detect_separators(gray, 'horizontal', rows - 1) if rows > 1 else []

        # Build cell boundaries: start, separator1, separator2, ..., end
        col_bounds = [0] + v_seps + [width]
        row_bounds = [0] + h_seps + [height]

        print(f"[SPLIT-REFSHEET] {width}x{height}, {cols}x{rows}, count={count}")
        print(f"[SPLIT-REFSHEET]   v_seps={v_seps} → col_bounds={col_bounds}")
        print(f"[SPLIT-REFSHEET]   h_seps={h_seps} → row_bounds={row_bounds}")

        # Extract cells in row-major order, only as many as count
        cells = []
        for row in range(rows):
            for col in range(cols):
                if len(cells) >= count:
                    break
                y1, y2 = row_bounds[row], row_bounds[row + 1]
                x1, x2 = col_bounds[col], col_bounds[col + 1]
                cell = image[y1:y2, x1:x2]

                # Encode cell as PNG base64 (PNG keeps the alpha-free crop pristine)
                ok, encoded = cv2.imencode('.png', cell)
                if not ok:
                    print(f"[SPLIT-REFSHEET] Cell {len(cells)} encode failed")
                    cells.append(None)
                    continue
                cells.append(base64.b64encode(encoded.tobytes()).decode('utf-8'))
            if len(cells) >= count:
                break

        return jsonify({
            "success": True,
            "cells": cells,
            "layout": {"cols": cols, "rows": rows},
            "separators": {
                "horizontal": h_seps,
                "vertical": v_seps
            },
            "image_size": {"width": width, "height": height}
        })

    except Exception as e:
        print(f"[SPLIT-REFSHEET] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/crop-front-column', methods=['POST'])
def crop_front_column():
    """
    Crop a 2x2 avatar grid to just the left (front-facing) column.
    Uses variance-based detection to find the actual vertical separator
    instead of assuming it's at width/2.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,..."  # 2x2 grid avatar image
    }

    Returns:
    {
        "success": true,
        "image": "data:image/jpeg;base64,...",  # Left column only
        "separator_x": 512                       # Detected separator position
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({"success": False, "error": "Missing 'image'"}), 400

        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        height, width = image.shape[:2]

        # Detect vertical separator using column variance (same as split-grid)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        search_w_start = int(width * 0.3)
        search_w_end = int(width * 0.7)
        col_variances = []
        for x in range(search_w_start, search_w_end):
            col_variances.append((np.var(gray[:, x].astype(float)), x))
        col_variances.sort()
        mid_w = col_variances[0][1] if col_variances else width // 2

        print(f"[CROP-FRONT] {width}x{height}, separator at x={mid_w} ({mid_w*100/width:.0f}%)")

        # Crop left column
        left_col = image[0:height, 0:mid_w]
        _, buffer = cv2.imencode('.jpg', left_col, [cv2.IMWRITE_JPEG_QUALITY, 92])
        result_b64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        return jsonify({
            "success": True,
            "image": result_b64,
            "separator_x": mid_w
        }), 200

    except Exception as e:
        print(f"[CROP-FRONT] Error: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/add-background', methods=['POST'])
def add_background():
    """
    Add a solid background to a transparent PNG image.

    Expected JSON:
    {
        "image": "data:image/png;base64,...",  # PNG with transparency
        "background_color": [R, G, B]          # Optional, default light gray [240, 240, 240]
    }

    Returns:
    {
        "success": true,
        "image": "data:image/jpeg;base64,..."  # Image with solid background
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' in request body"
            }), 400

        # Decode base64 image
        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        image_bytes = base64.b64decode(image_data)

        # Open with PIL to handle transparency
        pil_image = Image.open(BytesIO(image_bytes))

        # Get background color (default light gray)
        bg_color = tuple(data.get('background_color', [240, 240, 240]))

        # If image has alpha channel, composite on background
        if pil_image.mode == 'RGBA':
            # Create solid background
            background = Image.new('RGB', pil_image.size, bg_color)
            # Paste image using alpha as mask
            background.paste(pil_image, mask=pil_image.split()[3])
            pil_image = background
            print(f"[ADD-BACKGROUND] Added {bg_color} background to transparent image")
        elif pil_image.mode != 'RGB':
            pil_image = pil_image.convert('RGB')

        # Encode as JPEG
        buffer = BytesIO()
        pil_image.save(buffer, format='JPEG', quality=95)
        encoded = base64.b64encode(buffer.getvalue()).decode('utf-8')

        return jsonify({
            "success": True,
            "image": f"data:image/jpeg;base64,{encoded}"
        }), 200

    except Exception as e:
        print(f"[ADD-BACKGROUND] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/extract-face', methods=['POST'])
def extract_face():
    """
    Extract just the face from an image, optionally from a specific quadrant.
    This is useful for LPIPS comparison where we want to compare face-to-face only.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "quadrant": "top-left" | "top-right" | "bottom-left" | "bottom-right" | null,
        "size": 256  # Output size (default 256x256)
    }

    If quadrant is specified, the image is assumed to be a 2x2 grid and will be
    cropped to that quadrant first before face extraction.

    Returns:
    {
        "success": true,
        "face": "data:image/jpeg;base64,...",  # Extracted face image
        "faceBbox": [ymin, xmin, ymax, xmax],  # Face location (normalized 0-1)
        "faceDetected": true                    # Whether a face was found
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' in request body"
            }), 400

        # Decode base64 image
        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({
                "success": False,
                "error": "Failed to decode image"
            }), 400

        height, width = image.shape[:2]
        quadrant = data.get('quadrant')
        output_size = data.get('size', 256)

        print(f"[EXTRACT-FACE] Input: {width}x{height}, quadrant: {quadrant}")

        # Crop to quadrant if specified
        if quadrant:
            mid_h = height // 2
            mid_w = width // 2
            quadrant_map = {
                'top-left': (0, mid_h, 0, mid_w),
                'top-right': (0, mid_h, mid_w, width),
                'bottom-left': (mid_h, height, 0, mid_w),
                'bottom-right': (mid_h, height, mid_w, width)
            }
            if quadrant in quadrant_map:
                y1, y2, x1, x2 = quadrant_map[quadrant]
                image = image[y1:y2, x1:x2]
                height, width = image.shape[:2]
                print(f"[EXTRACT-FACE] Cropped to {quadrant}: {width}x{height}")

        # Detect face
        face_box = detect_face_mediapipe(image)

        if face_box:
            print(f"[EXTRACT-FACE] Face detected: x={face_box['x']:.1f}%, y={face_box['y']:.1f}%, w={face_box['width']:.1f}%, h={face_box['height']:.1f}%")

            # Convert face_box (percentage 0-100) to normalized (0-1) bbox
            face_bbox = [
                face_box['y'] / 100,          # ymin
                face_box['x'] / 100,          # xmin
                (face_box['y'] + face_box['height']) / 100,  # ymax
                (face_box['x'] + face_box['width']) / 100    # xmax
            ]

            # Asymmetric padding: more on top for hair/head, less on bottom to exclude shoulders
            padding_top = 0.40     # 40% above face for hair/forehead
            padding_bottom = 0.05  # 5% below face (minimal, exclude shoulders)
            padding_sides = 0.15   # 15% on sides for ears/hair

            face_height = face_bbox[2] - face_bbox[0]
            face_width = face_bbox[3] - face_bbox[1]

            face_bbox_padded = [
                max(0, face_bbox[0] - face_height * padding_top),     # ymin (top)
                max(0, face_bbox[1] - face_width * padding_sides),    # xmin (left)
                min(1, face_bbox[2] + face_height * padding_bottom),  # ymax (bottom)
                min(1, face_bbox[3] + face_width * padding_sides)     # xmax (right)
            ]

            # Crop to face
            y1 = int(face_bbox_padded[0] * height)
            x1 = int(face_bbox_padded[1] * width)
            y2 = int(face_bbox_padded[2] * height)
            x2 = int(face_bbox_padded[3] * width)

            face_img = image[y1:y2, x1:x2]

            # Make square and resize
            h, w = face_img.shape[:2]
            max_dim = max(h, w)
            square = np.full((max_dim, max_dim, 3), [230, 240, 255], dtype=np.uint8)  # Peach background
            y_off = (max_dim - h) // 2
            x_off = (max_dim - w) // 2
            square[y_off:y_off+h, x_off:x_off+w] = face_img

            face_resized = cv2.resize(square, (output_size, output_size), interpolation=cv2.INTER_LANCZOS4)

            # Encode as JPEG
            _, buffer = cv2.imencode('.jpg', face_resized, [cv2.IMWRITE_JPEG_QUALITY, 95])
            face_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

            print(f"[EXTRACT-FACE] Face extracted: {output_size}x{output_size}")

            return jsonify({
                "success": True,
                "face": face_base64,
                "faceBbox": face_bbox,
                "faceDetected": True
            }), 200

        else:
            # No face detected - return center crop as fallback
            print("[EXTRACT-FACE] No face detected, using center crop")

            # Center crop to square
            min_dim = min(height, width)
            y1 = (height - min_dim) // 2
            x1 = (width - min_dim) // 2
            center_crop = image[y1:y1+min_dim, x1:x1+min_dim]

            face_resized = cv2.resize(center_crop, (output_size, output_size), interpolation=cv2.INTER_LANCZOS4)

            _, buffer = cv2.imencode('.jpg', face_resized, [cv2.IMWRITE_JPEG_QUALITY, 95])
            face_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

            return jsonify({
                "success": True,
                "face": face_base64,
                "faceBbox": None,
                "faceDetected": False
            }), 200

    except Exception as e:
        print(f"[EXTRACT-FACE] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# DeepFace for ArcFace embeddings (lazy loaded)
_deepface_loaded = False

def get_arcface_embedding(image_path_or_array, assume_face_crop=False):
    """
    Extract 512-D ArcFace embedding using DeepFace.
    ArcFace is style-invariant - can match photo to cartoon.

    Args:
        image_path_or_array: Either a file path or numpy array (BGR)
        assume_face_crop: If True, skip face detection (input is already a face)

    Returns:
        tuple: (512-dimensional normalized embedding, face_detected boolean)
    """
    global _deepface_loaded

    # Stamp every use so the ArcFace reaper knows when this went quiet. Stamped
    # on entry, not on success: a failed call still imported TensorFlow, and it
    # is the import that costs the memory we are trying to give back.
    _note_arcface_used()

    try:
        from deepface import DeepFace

        if not _deepface_loaded:
            print("[ARCFACE] Loading ArcFace model via DeepFace...")
            _deepface_loaded = True

        face_detected = False

        # Strategy:
        # 1. If assume_face_crop=True, skip detection entirely
        # 2. Otherwise, try detection with opencv first
        # 3. If that fails, try with skip (assume input is face)

        if assume_face_crop:
            # Input is already a face crop - skip detection
            result = DeepFace.represent(
                img_path=image_path_or_array,
                model_name='ArcFace',
                enforce_detection=False,
                detector_backend='skip'  # No detection, assume input is face
            )
            face_detected = True  # We trust caller that this is a face
        else:
            # Try to detect face first
            try:
                result = DeepFace.represent(
                    img_path=image_path_or_array,
                    model_name='ArcFace',
                    enforce_detection=True,  # Require face detection
                    detector_backend='opencv'
                )
                face_detected = True
            except ValueError as e:
                # Face not detected - try with skip (assume input is already face)
                if "Face could not be detected" in str(e):
                    print("[ARCFACE] No face detected by opencv, assuming input is face crop")
                    result = DeepFace.represent(
                        img_path=image_path_or_array,
                        model_name='ArcFace',
                        enforce_detection=False,
                        detector_backend='skip'
                    )
                    face_detected = False  # Mark as not detected for transparency
                else:
                    raise

        if result and len(result) > 0:
            embedding = np.array(result[0]['embedding'])
            # Normalize for cosine similarity
            embedding = embedding / np.linalg.norm(embedding)
            return embedding, face_detected

        return None, False

    except Exception as e:
        print(f"[ARCFACE] Error: {e}")
        return None, False


def extract_embedding_from_image(image_data, assume_face_crop=False):
    """
    Extract face embedding from image data (base64, PIL Image, or numpy array).
    Returns tuple: (512-dimensional normalized ArcFace embedding, face_detected boolean)
    """
    # Handle base64 input
    if isinstance(image_data, str):
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        img_pil = Image.open(BytesIO(image_bytes)).convert('RGB')
        img_np = np.array(img_pil)
        # Convert RGB to BGR for OpenCV/DeepFace
        img_np = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
    elif hasattr(image_data, 'convert'):
        # PIL Image
        img_pil = image_data.convert('RGB')
        img_np = np.array(img_pil)
        img_np = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
    else:
        # Assume numpy array (BGR)
        img_np = image_data

    return get_arcface_embedding(img_np, assume_face_crop=assume_face_crop)


@app.route('/face-embedding', methods=['POST'])
def get_face_embedding():
    """
    Extract face embedding from an image.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "quadrant": "top-left" | null,  # Optional: crop to quadrant first
        "extract_face": true            # Optional: detect and crop to face first
    }

    Returns:
    {
        "success": true,
        "embedding": [0.123, 0.456, ...],  # 2048-D normalized vector
        "dimensions": 2048,
        "faceDetected": true/false          # If extract_face was requested
    }
    """
    try:
        import torch

        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' in request body"
            }), 400

        image_data = data['image']
        quadrant = data.get('quadrant')
        extract_face_flag = data.get('extract_face', True)

        face_detected = False

        # If we need to extract face first, use the /extract-face logic
        if extract_face_flag or quadrant:
            # Decode image
            if ',' in image_data:
                image_data_clean = image_data.split(',')[1]
            else:
                image_data_clean = image_data

            image_bytes = base64.b64decode(image_data_clean)
            nparr = np.frombuffer(image_bytes, np.uint8)
            image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if image is None:
                return jsonify({
                    "success": False,
                    "error": "Failed to decode image"
                }), 400

            height, width = image.shape[:2]

            # Crop to quadrant if specified (supports 2x2, 3x3, and 3x4 grids)
            if quadrant:
                grid_size = data.get('grid_size', 2)

                if grid_size == '3x4' or grid_size == 34:
                    # 3 rows, 4 columns
                    third_h = height // 3
                    fourth_w = width // 4
                    quadrant_map = {
                        'top-col1': (0, third_h, 0, fourth_w),
                        'top-col2': (0, third_h, fourth_w, 2*fourth_w),
                        'top-col3': (0, third_h, 2*fourth_w, 3*fourth_w),
                        'top-col4': (0, third_h, 3*fourth_w, width),
                        'middle-col1': (third_h, 2*third_h, 0, fourth_w),
                        'middle-col2': (third_h, 2*third_h, fourth_w, 2*fourth_w),
                        'middle-col3': (third_h, 2*third_h, 2*fourth_w, 3*fourth_w),
                        'middle-col4': (third_h, 2*third_h, 3*fourth_w, width),
                        'bottom-col1': (2*third_h, height, 0, fourth_w),
                        'bottom-col2': (2*third_h, height, fourth_w, 2*fourth_w),
                        'bottom-col3': (2*third_h, height, 2*fourth_w, 3*fourth_w),
                        'bottom-col4': (2*third_h, height, 3*fourth_w, width)
                    }
                elif grid_size == 3:
                    third_h = height // 3
                    third_w = width // 3
                    quadrant_map = {
                        'top-left': (0, third_h, 0, third_w),
                        'top-center': (0, third_h, third_w, 2*third_w),
                        'top-right': (0, third_h, 2*third_w, width),
                        'middle-left': (third_h, 2*third_h, 0, third_w),
                        'middle-center': (third_h, 2*third_h, third_w, 2*third_w),
                        'middle-right': (third_h, 2*third_h, 2*third_w, width),
                        'bottom-left': (2*third_h, height, 0, third_w),
                        'bottom-center': (2*third_h, height, third_w, 2*third_w),
                        'bottom-right': (2*third_h, height, 2*third_w, width)
                    }
                else:
                    mid_h = height // 2
                    mid_w = width // 2
                    quadrant_map = {
                        'top-left': (0, mid_h, 0, mid_w),
                        'top-right': (0, mid_h, mid_w, width),
                        'bottom-left': (mid_h, height, 0, mid_w),
                        'bottom-right': (mid_h, height, mid_w, width)
                    }
                    
                if quadrant in quadrant_map:
                    y1, y2, x1, x2 = quadrant_map[quadrant]
                    image = image[y1:y2, x1:x2]
                    height, width = image.shape[:2]

            # Detect and crop face
            if extract_face_flag:
                face_box = detect_face_mediapipe(image)
                if face_box:
                    face_detected = True
                    # Add padding and crop
                    padding = 0.15
                    x = face_box['x'] / 100
                    y = face_box['y'] / 100
                    w = face_box['width'] / 100
                    h = face_box['height'] / 100

                    y1 = int(max(0, y - h * padding) * height)
                    x1 = int(max(0, x - w * padding) * width)
                    y2 = int(min(1, y + h * (1 + padding)) * height)
                    x2 = int(min(1, x + w * (1 + padding)) * width)

                    image = image[y1:y2, x1:x2]

            # Convert to PIL for embedding extraction
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            img_pil = Image.fromarray(image_rgb)

            # If we extracted a face, tell ArcFace to skip detection
            embedding, arcface_detected = extract_embedding_from_image(img_pil, assume_face_crop=face_detected)
            face_detected = face_detected or arcface_detected
        else:
            embedding, arcface_detected = extract_embedding_from_image(image_data)
            face_detected = arcface_detected

        if embedding is None:
            return jsonify({
                "success": False,
                "error": "Failed to extract embedding"
            }), 500

        print(f"[FACE-EMBED] Extracted {len(embedding)}-D embedding, face_detected: {face_detected}")

        return jsonify({
            "success": True,
            "embedding": embedding.tolist(),
            "dimensions": len(embedding),
            "faceDetected": face_detected
        }), 200

    except Exception as e:
        print(f"[FACE-EMBED] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# ── ArcFace via onnxruntime ────────────────────────────────────────────────
# The DeepFace path needs TensorFlow, which cannot ship here: TF>=2.16 requires
# protobuf>=5.28 while the pinned mediapipe==0.10.9 requires protobuf<4, so
# adding it would break face detection in production. onnxruntime is already a
# dependency, so the same ArcFace maths runs with no framework and no conflict.
# Weights: buffalo_l recognition (w600k_r50), ~174MB, path via ARCFACE_ONNX_MODEL.
_arcface_onnx_session = None
_arcface_onnx_failed = False

def get_arcface_onnx_session():
    """Lazy-load the ONNX ArcFace session. Returns None if unavailable."""
    global _arcface_onnx_session, _arcface_onnx_failed
    if _arcface_onnx_session is not None or _arcface_onnx_failed:
        return _arcface_onnx_session
    try:
        import onnxruntime as ort
        model_path = os.environ.get('ARCFACE_ONNX_MODEL',
                                    os.path.join(os.path.dirname(__file__), 'arcface_w600k_r50.onnx'))
        if not os.path.exists(model_path):
            print(f"[ARCFACE-ONNX] weights not found at {model_path}")
            _arcface_onnx_failed = True
            return None
        _arcface_onnx_session = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
        print(f"[ARCFACE-ONNX] loaded {os.path.basename(model_path)}")
        return _arcface_onnx_session
    except Exception as e:
        print(f"[ARCFACE-ONNX] load failed: {e}")
        _arcface_onnx_failed = True
        return None


# ArcFace's canonical 5-point template for a 112x112 crop (insightface).
# Order: left eye, right eye, nose tip, left mouth corner, right mouth corner.
ARCFACE_TEMPLATE_5PT = np.array([
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
], dtype=np.float32)

# Face Mesh indices for those same five points.
_MESH_5PT = {'left_eye': 33, 'right_eye': 263, 'nose': 1, 'mouth_left': 61, 'mouth_right': 291}
_face_mesh = None

def get_face_mesh():
    """Lazy Face Mesh — needed for the 5 landmarks ArcFace aligns on."""
    global _face_mesh
    if _face_mesh is None and MEDIAPIPE_AVAILABLE:
        try:
            _face_mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=True, max_num_faces=1, refine_landmarks=False,
                min_detection_confidence=0.3)
        except Exception as e:
            print(f"[ARCFACE-ONNX] face mesh unavailable: {e}")
    return _face_mesh


def align_face_arcface(image_bgr):
    """
    Warp a face to ArcFace's canonical 112x112 using a 5-point similarity
    transform. Returns None when the landmarks cannot be found, so the caller
    can fall back explicitly rather than silently embedding a misaligned face.

    This step is not optional: ArcFace compares ALIGNED faces. Feeding it a
    plain resized bounding box scrambles the ranking — measured, an unaligned
    ONNX path correlated with the aligned DeepFace path at only 0.258 Spearman,
    scoring clean frontal portraits (0.789 aligned) as low as 0.240.
    """
    mesh = get_face_mesh()
    if mesh is None:
        return None
    h, w = image_bgr.shape[:2]
    res = mesh.process(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
    if not res.multi_face_landmarks:
        return None
    lm = res.multi_face_landmarks[0].landmark
    try:
        src = np.array([[lm[_MESH_5PT['left_eye']].x * w,   lm[_MESH_5PT['left_eye']].y * h],
                        [lm[_MESH_5PT['right_eye']].x * w,  lm[_MESH_5PT['right_eye']].y * h],
                        [lm[_MESH_5PT['nose']].x * w,       lm[_MESH_5PT['nose']].y * h],
                        [lm[_MESH_5PT['mouth_left']].x * w, lm[_MESH_5PT['mouth_left']].y * h],
                        [lm[_MESH_5PT['mouth_right']].x * w, lm[_MESH_5PT['mouth_right']].y * h]],
                       dtype=np.float32)
    except (IndexError, AttributeError):
        return None
    M, _ = cv2.estimateAffinePartial2D(src, ARCFACE_TEMPLATE_5PT, method=cv2.LMEDS)
    if M is None:
        return None
    return cv2.warpAffine(image_bgr, M, (112, 112), borderValue=0.0)


def arcface_onnx_embedding(face_bgr, aligned=False):
    """
    512-D embedding for a face (BGR numpy array).
    Preprocessing is the insightface contract: RGB, 112x112, (x-127.5)/127.5.
    Returns a normalised vector, or None when the model is unavailable.
    """
    # The ONNX path holds far less (no framework), but it still holds a session
    # and weights, and the same "idle means give it back" logic applies.
    _note_arcface_used()
    sess = get_arcface_onnx_session()
    if sess is None:
        return None
    img = face_bgr if aligned else cv2.resize(face_bgr, (112, 112))
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32)
    img = (img - 127.5) / 127.5
    blob = np.transpose(img, (2, 0, 1))[np.newaxis, ...]
    out = sess.run(None, {sess.get_inputs()[0].name: blob})[0][0]
    norm = np.linalg.norm(out)
    return (out / norm) if norm > 0 else out


@app.route('/face-embedding-onnx', methods=['POST'])
def face_embedding_onnx():
    """
    ArcFace embedding via onnxruntime — the deployable twin of /face-embedding.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "quadrant": "top-left" | null,   # Optional: crop to a 2x2 cell first
        "extract_face": true             # Optional: detect+crop the face first
    }

    Returns: { success, embedding: [...512], faceDetected: bool }

    faceDetected is reported honestly: when detection is requested and finds
    nothing, the whole frame is NOT embedded as a silent fallback — callers
    need to be able to tell "no face here" from "a face that scored low".
    """
    try:
        data = request.get_json() or {}
        if 'image' not in data:
            return jsonify({"success": False, "error": "Missing 'image'"}), 400

        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        nparr = np.frombuffer(base64.b64decode(image_data), np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if image is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        quadrant = data.get('quadrant')
        if quadrant:
            h, w = image.shape[:2]
            mid_h, mid_w = h // 2, w // 2
            qmap = {'top-left': (0, mid_h, 0, mid_w), 'top-right': (0, mid_h, mid_w, w),
                    'bottom-left': (mid_h, h, 0, mid_w), 'bottom-right': (mid_h, h, mid_w, w)}
            if quadrant in qmap:
                y1, y2, x1, x2 = qmap[quadrant]
                image = image[y1:y2, x1:x2]

        # Alignment needs LANDMARKS, not a pre-crop, so it runs on the full
        # frame. Pre-cropping first is actively harmful: /extract-face pads
        # asymmetrically (40% above the face, 5% below) to grab hair and drop
        # shoulders, which on some faces cuts off the mouth and chin — and the
        # mouth corners are two of the five points the warp needs. One toddler's
        # avatar came through as a half-face for exactly this reason and scored
        # low on both backends. Detect-and-crop is now only the fallback for
        # when landmarks cannot be found at all.
        warped = align_face_arcface(image)
        face_detected = warped is not None

        if warped is None and data.get('extract_face', True):
            box = detect_face_mediapipe(image)
            if not box:
                return jsonify({"success": True, "embedding": None,
                                "faceDetected": False, "aligned": False})
            face_detected = True
            h, w = image.shape[:2]
            pad = 0.25  # symmetric — no upward bias when we must fall back
            x, y = box['x'] / 100, box['y'] / 100
            fw, fh = box['width'] / 100, box['height'] / 100
            y1 = int(max(0, y - fh * pad) * h)
            x1 = int(max(0, x - fw * pad) * w)
            y2 = int(min(1, y + fh * (1 + pad)) * h)
            x2 = int(min(1, x + fw * (1 + pad)) * w)
            if y2 > y1 and x2 > x1:
                image = image[y1:y2, x1:x2]

        emb = arcface_onnx_embedding(warped if warped is not None else image,
                                     aligned=warped is not None)
        if emb is None:
            return jsonify({"success": False, "error": "ArcFace ONNX model unavailable"}), 503

        resp = {"success": True, "embedding": emb.tolist(),
                "dimensions": int(emb.shape[0]), "faceDetected": face_detected,
                "aligned": warped is not None}

        # Optionally hand back the exact 112x112 that was embedded, so a report
        # can show what was actually measured rather than a look-alike crop.
        if data.get('return_face') and warped is not None:
            ok, buf = cv2.imencode('.jpg', warped, [cv2.IMWRITE_JPEG_QUALITY, 95])
            if ok:
                resp["alignedFace"] = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode('utf-8')
        return jsonify(resp)
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


@app.route('/compare-identity', methods=['POST'])
def compare_identity():
    """
    Compare two face embeddings for identity match using cosine similarity.

    Expected JSON (option 1 - pre-computed embeddings):
    {
        "embedding1": [0.123, 0.456, ...],
        "embedding2": [0.123, 0.456, ...]
    }

    Expected JSON (option 2 - images):
    {
        "image1": "data:image/jpeg;base64,...",
        "image2": "data:image/jpeg;base64,...",
        "quadrant1": null,       # Optional: crop image1 to quadrant
        "quadrant2": "top-left"  # Optional: crop image2 to quadrant
    }

    Returns:
    {
        "success": true,
        "similarity": 0.85,           # Cosine similarity (-1 to 1)
        "same_person": true,          # similarity > threshold
        "confidence": "high",         # high/medium/low
        "interpretation": "very_similar"
    }
    """
    try:
        import torch

        data = request.get_json()
        if not data:
            return jsonify({
                "success": False,
                "error": "Missing request body"
            }), 400

        # Option 1: Pre-computed embeddings
        if 'embedding1' in data and 'embedding2' in data:
            emb1 = np.array(data['embedding1'])
            emb2 = np.array(data['embedding2'])

        # Option 2: Extract from images
        elif 'image1' in data and 'image2' in data:
            # Get embeddings using the /face-embedding logic
            emb1 = None
            emb2 = None

            # Process image1
            img1_data = data['image1']
            q1 = data.get('quadrant1')

            if ',' in img1_data:
                img1_clean = img1_data.split(',')[1]
            else:
                img1_clean = img1_data

            image_bytes = base64.b64decode(img1_clean)
            nparr = np.frombuffer(image_bytes, np.uint8)
            image1 = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if q1:
                h, w = image1.shape[:2]
                mid_h, mid_w = h // 2, w // 2
                qmap = {
                    'top-left': (0, mid_h, 0, mid_w),
                    'top-right': (0, mid_h, mid_w, w),
                    'bottom-left': (mid_h, h, 0, mid_w),
                    'bottom-right': (mid_h, h, mid_w, w)
                }
                if q1 in qmap:
                    y1, y2, x1, x2 = qmap[q1]
                    image1 = image1[y1:y2, x1:x2]

            # Detect face in image1
            face_box1 = detect_face_mediapipe(image1)
            face1_detected = False
            if face_box1:
                face1_detected = True
                h, w = image1.shape[:2]
                padding = 0.15
                x, y = face_box1['x'] / 100, face_box1['y'] / 100
                fw, fh = face_box1['width'] / 100, face_box1['height'] / 100
                y1 = int(max(0, y - fh * padding) * h)
                x1 = int(max(0, x - fw * padding) * w)
                y2 = int(min(1, y + fh * (1 + padding)) * h)
                x2 = int(min(1, x + fw * (1 + padding)) * w)
                image1 = image1[y1:y2, x1:x2]

            img1_rgb = cv2.cvtColor(image1, cv2.COLOR_BGR2RGB)
            img1_pil = Image.fromarray(img1_rgb)
            emb1, _ = extract_embedding_from_image(img1_pil, assume_face_crop=face1_detected)

            # Process image2 similarly
            img2_data = data['image2']
            q2 = data.get('quadrant2')

            if ',' in img2_data:
                img2_clean = img2_data.split(',')[1]
            else:
                img2_clean = img2_data

            image_bytes = base64.b64decode(img2_clean)
            nparr = np.frombuffer(image_bytes, np.uint8)
            image2 = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if q2:
                h, w = image2.shape[:2]
                mid_h, mid_w = h // 2, w // 2
                qmap = {
                    'top-left': (0, mid_h, 0, mid_w),
                    'top-right': (0, mid_h, mid_w, w),
                    'bottom-left': (mid_h, h, 0, mid_w),
                    'bottom-right': (mid_h, h, mid_w, w)
                }
                if q2 in qmap:
                    y1, y2, x1, x2 = qmap[q2]
                    image2 = image2[y1:y2, x1:x2]

            face_box2 = detect_face_mediapipe(image2)
            face2_detected = False
            if face_box2:
                face2_detected = True
                h, w = image2.shape[:2]
                padding = 0.15
                x, y = face_box2['x'] / 100, face_box2['y'] / 100
                fw, fh = face_box2['width'] / 100, face_box2['height'] / 100
                y1 = int(max(0, y - fh * padding) * h)
                x1 = int(max(0, x - fw * padding) * w)
                y2 = int(min(1, y + fh * (1 + padding)) * h)
                x2 = int(min(1, x + fw * (1 + padding)) * w)
                image2 = image2[y1:y2, x1:x2]

            img2_rgb = cv2.cvtColor(image2, cv2.COLOR_BGR2RGB)
            img2_pil = Image.fromarray(img2_rgb)
            emb2, _ = extract_embedding_from_image(img2_pil, assume_face_crop=face2_detected)

            if emb1 is None or emb2 is None:
                return jsonify({
                    "success": False,
                    "error": "Failed to extract embeddings from images"
                }), 500
        else:
            return jsonify({
                "success": False,
                "error": "Must provide either (embedding1, embedding2) or (image1, image2)"
            }), 400

        # Normalize embeddings (should already be normalized, but ensure)
        emb1 = emb1 / np.linalg.norm(emb1)
        emb2 = emb2 / np.linalg.norm(emb2)

        # Compute cosine similarity
        similarity = float(np.dot(emb1, emb2))

        # Determine if same person and confidence
        # Thresholds tuned for ArcFace 512-D embeddings
        # ArcFace is style-invariant: photo vs anime can still match!
        if similarity > 0.60:
            same_person = True
            confidence = "high"
            interpretation = "very_similar"
        elif similarity > 0.45:
            same_person = True
            confidence = "medium"
            interpretation = "similar"
        elif similarity > 0.30:
            same_person = False
            confidence = "low"
            interpretation = "somewhat_similar"
        else:
            same_person = False
            confidence = "high"
            interpretation = "different"

        print(f"[COMPARE-ID] Similarity: {similarity:.4f}, same_person: {same_person}, confidence: {confidence}")

        return jsonify({
            "success": True,
            "similarity": round(similarity, 4),
            "same_person": same_person,
            "confidence": confidence,
            "interpretation": interpretation
        }), 200

    except Exception as e:
        print(f"[COMPARE-ID] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/detect-all-faces', methods=['POST'])
def detect_all_faces():
    """
    Detect ALL faces in an image and optionally compare each to a reference.
    Uses DeepFace to find multiple faces.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "reference_image": "data:image/jpeg;base64,..."  # Optional: compare each face to this
    }

    Returns:
    {
        "success": true,
        "faces": [
            {
                "index": 0,
                "box": {"x": 100, "y": 50, "width": 80, "height": 100},
                "similarity": 0.72,  # Only if reference_image provided
                "same_person": true
            },
            ...
        ],
        "total_faces": 12
    }
    """
    try:
        data = request.get_json()
        image_data = data.get('image')
        reference_data = data.get('reference_image')

        if not image_data:
            return jsonify({"success": False, "error": "No image provided"}), 400

        # Decode main image
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        height, width = image.shape[:2]
        print(f"[DETECT-ALL] Image size: {width}x{height}")

        # Get reference embedding if provided
        ref_embedding = None
        if reference_data:
            if ',' in reference_data:
                reference_data = reference_data.split(',')[1]
            ref_bytes = base64.b64decode(reference_data)
            ref_arr = np.frombuffer(ref_bytes, np.uint8)
            ref_image = cv2.imdecode(ref_arr, cv2.IMREAD_COLOR)
            if ref_image is not None:
                ref_rgb = cv2.cvtColor(ref_image, cv2.COLOR_BGR2RGB)
                ref_pil = Image.fromarray(ref_rgb)
                ref_embedding, _ = extract_embedding_from_image(ref_pil, assume_face_crop=False)
                if ref_embedding is not None:
                    ref_embedding = ref_embedding / np.linalg.norm(ref_embedding)
                    print(f"[DETECT-ALL] Reference embedding extracted")

        # Use DeepFace to detect all faces
        from deepface import DeepFace

        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # Try multiple detectors - retinaface works on photos, opencv/mtcnn better on illustrations
        face_objs = []
        detectors = ['opencv', 'mtcnn', 'retinaface']

        for detector in detectors:
            try:
                print(f"[DETECT-ALL] Trying detector: {detector}")
                face_objs = DeepFace.extract_faces(
                    img_path=image_rgb,
                    detector_backend=detector,
                    enforce_detection=False,
                    align=True
                )
                if face_objs:
                    print(f"[DETECT-ALL] {detector} found {len(face_objs)} faces")
                    break
            except Exception as e:
                print(f"[DETECT-ALL] {detector} error: {e}")
                continue

        print(f"[DETECT-ALL] Found {len(face_objs)} faces")

        faces = []
        for i, face_obj in enumerate(face_objs):
            facial_area = face_obj.get('facial_area', {})
            face_img = face_obj.get('face')
            confidence = face_obj.get('confidence', 0)

            # Skip low confidence detections
            if confidence < 0.5:
                continue

            face_info = {
                "index": i,
                "box": {
                    "x": facial_area.get('x', 0),
                    "y": facial_area.get('y', 0),
                    "width": facial_area.get('w', 0),
                    "height": facial_area.get('h', 0)
                },
                "confidence": round(confidence, 3)
            }

            # If reference provided, compute similarity
            if ref_embedding is not None and face_img is not None:
                try:
                    # face_img is already a numpy array (RGB, float 0-1)
                    face_uint8 = (face_img * 255).astype(np.uint8)
                    face_pil = Image.fromarray(face_uint8)
                    face_emb, _ = extract_embedding_from_image(face_pil, assume_face_crop=True)

                    if face_emb is not None:
                        face_emb = face_emb / np.linalg.norm(face_emb)
                        similarity = float(np.dot(ref_embedding, face_emb))
                        face_info["similarity"] = round(similarity, 4)
                        face_info["same_person"] = similarity > 0.45
                        face_info["match_confidence"] = "high" if similarity > 0.6 else "medium" if similarity > 0.45 else "low"
                except Exception as e:
                    print(f"[DETECT-ALL] Error computing similarity for face {i}: {e}")

            faces.append(face_info)

        # Sort by similarity if available (highest first)
        if faces and 'similarity' in faces[0]:
            faces.sort(key=lambda f: f.get('similarity', 0), reverse=True)

        print(f"[DETECT-ALL] Returning {len(faces)} valid faces")

        return jsonify({
            "success": True,
            "faces": faces,
            "total_faces": len(faces),
            "image_size": {"width": width, "height": height}
        }), 200

    except Exception as e:
        print(f"[DETECT-ALL] Error: {e}")
        import traceback
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/detect-anime-faces', methods=['POST'])
def detect_anime_faces():
    """
    Detect faces in illustrated/anime images using lbpcascade_animeface.
    Better for cartoon/storybook illustrations than real-photo detectors.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "min_size": 30,          # Optional: minimum face size in pixels
        "scale_factor": 1.1,     # Optional: detection scale factor
        "min_neighbors": 5       # Optional: minimum neighbors for detection
    }

    Returns:
    {
        "success": true,
        "faces": [
            {
                "index": 0,
                "box": {"x": 100, "y": 50, "width": 80, "height": 100},
                "confidence": 0.8
            }
        ],
        "total_faces": 2,
        "image_size": {"width": 1024, "height": 1024}
    }
    """
    try:
        data = request.get_json()
        image_data = data.get('image')

        if not image_data:
            return jsonify({"success": False, "error": "No image provided"}), 400

        # Decode image
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        height, width = image.shape[:2]
        print(f"[DETECT-ANIME] Image size: {width}x{height}")

        # Get optional parameters
        min_size = data.get('min_size', 30)
        scale_factor = data.get('scale_factor', 1.1)
        min_neighbors = data.get('min_neighbors', 5)

        # Detect anime faces
        faces = detect_all_faces_anime(
            image,
            min_size=min_size,
            scale_factor=scale_factor,
            min_neighbors=min_neighbors
        )

        print(f"[DETECT-ANIME] Returning {len(faces)} faces")

        return jsonify({
            "success": True,
            "faces": faces,
            "total_faces": len(faces),
            "image_size": {"width": width, "height": height},
            "detector": "lbpcascade_animeface"
        }), 200

    except Exception as e:
        print(f"[DETECT-ANIME] Error: {e}")
        import traceback
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/detect-illustration-faces', methods=['POST'])
def detect_illustration_faces():
    """
    Combined face detection for illustrations using anime cascade + Haar cascade.
    Returns merged results with confidence levels:
    - "both": detected by both cascades (high confidence)
    - "anime": detected by anime cascade only (good confidence for illustrations)
    - "haar_only": detected by Haar only (needs validation — may be false positive)

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "pad_percent": 60  # Optional: padding around face crops as % (default 60)
    }
    """
    try:
        data = request.get_json()
        image_data = data.get('image')
        pad_percent = data.get('pad_percent', 60)

        if not image_data:
            return jsonify({"success": False, "error": "No image provided"}), 400

        if ',' in image_data:
            image_data = image_data.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        height, width = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        gray_eq = cv2.equalizeHist(gray)

        # Run anime cascade (best for illustrations)
        anime_faces = []
        if ANIME_CASCADE_AVAILABLE and anime_face_cascade is not None:
            detections = anime_face_cascade.detectMultiScale(
                gray_eq, scaleFactor=1.05, minNeighbors=2, minSize=(20, 20)
            )
            anime_faces = [(int(x), int(y), int(w), int(h)) for (x, y, w, h) in detections]

        # Run Haar cascade (catches some faces anime misses). Uses the
        # module-level cascade loaded once at startup; no per-request reload.
        haar_cascade = _FRONTAL_FACE_CASCADE
        haar_faces = []
        if haar_cascade is not None:
            haar_faces_raw = haar_cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=3, minSize=(30, 30)
            )
            haar_faces = [(int(x), int(y), int(w), int(h)) for (x, y, w, h) in haar_faces_raw]

        # Compute IoU for matching
        def iou(a, b):
            ax1, ay1, ax2, ay2 = a[0], a[1], a[0]+a[2], a[1]+a[3]
            bx1, by1, bx2, by2 = b[0], b[1], b[0]+b[2], b[1]+b[3]
            ix1, iy1 = max(ax1, bx1), max(ay1, by1)
            ix2, iy2 = min(ax2, bx2), min(ay2, by2)
            if ix2 <= ix1 or iy2 <= iy1:
                return 0
            inter = (ix2-ix1) * (iy2-iy1)
            union = a[2]*a[3] + b[2]*b[3] - inter
            return inter / union if union > 0 else 0

        # Merge: match anime to haar, find overlaps
        matched_haar = set()
        results = []

        for af in anime_faces:
            best_iou, best_j = 0, -1
            for j, hf in enumerate(haar_faces):
                s = iou(af, hf)
                if s > best_iou:
                    best_iou, best_j = s, j
            if best_iou > 0.3 and best_j >= 0:
                matched_haar.add(best_j)
                results.append({"source": "both", "box_px": af, "confidence": 0.95})
            else:
                results.append({"source": "anime", "box_px": af, "confidence": 0.85})

        for j, hf in enumerate(haar_faces):
            if j not in matched_haar:
                results.append({"source": "haar_only", "box_px": hf, "confidence": 0.5})

        # Build response with pixel coordinates and padded crops
        # JS merger (entityConsistency.js) normalizes to 0-1 by dividing by image dimensions
        faces = []
        for r in results:
            x, y, fw, fh = r["box_px"]
            # Apply padding
            pad_w = int(fw * pad_percent / 100)
            pad_h = int(fh * pad_percent / 100)
            px = max(0, x - pad_w)
            py = max(0, y - pad_h)
            pw = min(width - px, fw + 2 * pad_w)
            ph = min(height - py, fh + 2 * pad_h)

            # Crop the padded face region
            crop = image[py:py+ph, px:px+pw]
            _, crop_jpg = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
            crop_b64 = base64.b64encode(crop_jpg.tobytes()).decode('utf-8')

            faces.append({
                "source": r["source"],
                "confidence": r["confidence"],
                "faceBox": {
                    "x": x,
                    "y": y,
                    "width": fw,
                    "height": fh
                },
                "paddedBox": {
                    "x": px,
                    "y": py,
                    "width": pw,
                    "height": ph
                },
                "cropData": "data:image/jpeg;base64," + crop_b64,
                "cropSize": {"width": pw, "height": ph}
            })

        print(f"[DETECT-ILLUSTRATION] {len(anime_faces)} anime + {len(haar_faces)} haar = {len(faces)} merged ({sum(1 for f in faces if f['source']=='both')} both, {sum(1 for f in faces if f['source']=='anime')} anime-only, {sum(1 for f in faces if f['source']=='haar_only')} haar-only)")

        return jsonify({
            "success": True,
            "faces": faces,
            "total_faces": len(faces),
            "image_size": {"width": width, "height": height},
            "detectors": {
                "anime": len(anime_faces),
                "haar": len(haar_faces)
            }
        }), 200

    except Exception as e:
        print(f"[DETECT-ILLUSTRATION] Error: {e}")
        import traceback
        return jsonify({"success": False, "error": str(e)}), 500



def _container_cpus():
    """CPUs this CONTAINER may use, not the host's core count.

    os.cpu_count() reports the host: on a shared Railway host that is dozens of
    cores, so a container capped at ~2 vCPU started dozens of waitress threads.
    MobileSAM/GroundingDINO are CPU-bound torch inference, so oversubscribing
    that far past the quota made every request slower and produced dropped
    segmentations and empty detections under a full multi-page story.

    Reads the cgroup quota (v2 then v1) and falls back to os.cpu_count().
    """
    host = os.cpu_count() or 6
    try:
        # cgroup v2: "<quota> <period>", or "max <period>" when unlimited.
        with open('/sys/fs/cgroup/cpu.max') as fh:
            quota_s, period_s = fh.read().split()
        if quota_s != 'max':
            n = int(quota_s) // int(period_s)
            if n >= 1:
                return min(host, n)
    except Exception:
        pass
    try:
        # cgroup v1: quota of -1 means unlimited.
        with open('/sys/fs/cgroup/cpu/cpu.cfs_quota_us') as fh:
            quota = int(fh.read().strip())
        with open('/sys/fs/cgroup/cpu/cpu.cfs_period_us') as fh:
            period = int(fh.read().strip())
        if quota > 0 and period > 0:
            n = quota // period
            if n >= 1:
                return min(host, n)
    except Exception:
        pass
    return host


if __name__ == '__main__':
    _default_port = WORKER_PORTS.get(ANALYZER_ROLE, 5000)
    port = int(os.environ.get('PHOTO_ANALYZER_PORT', _default_port))
    print(f"[START] Photo Analyzer API starting on port {port} (role={ANALYZER_ROLE})")
    print(f"   MediaPipe available: {MEDIAPIPE_AVAILABLE}")
    print(f"   Anime cascade available: {ANIME_CASCADE_AVAILABLE}")
    print("   LPIPS: checking on first request")
    print("   Face embeddings: ArcFace via DeepFace (512-D, style-invariant)")
    # Serve via waitress (production WSGI). Flask's dev server dropped large
    # POST bodies (the base64 page image on /detect-figures-text) under load,
    # arriving empty at request.get_json() -> 400/500 -> spurious Gemini
    # fallback. Waitress handles large/chunked bodies and multiple threads
    # (model load blocks one thread; others keep serving). Falls back to the
    # dev server only if waitress is missing.
    try:
        from waitress import serve
        # Match worker threads to the container's vCPUs so mask/detect inference
        # (MobileSAM/GDINO via torch — releases the GIL during compute) actually
        # runs in PARALLEL across the cores instead of ≤6 at a time while the rest
        # queue past the 150s client timeout. Tune via ANALYZER_THREADS. Was
        # hard-coded 6 → left most vCPUs idle under a full multi-page story.
        _cores = _container_cpus()
        _threads = int(os.environ.get('ANALYZER_THREADS') or _cores)
        print(f"   Serving via waitress ({_threads} threads, {_cores} vCPUs available) on port {port}")
        # `listen='*:port'` binds IPv4 AND IPv6; plain host='0.0.0.0' is IPv4-only.
        # That distinction is load-bearing once this runs as its own Railway
        # service (2026-09-04): Railway's private network is IPv6-ONLY, so
        # `analyzer.railway.internal` resolves to an AAAA record and an IPv4-only
        # listener accepts nothing — the web service would see connection
        # refused, and figureDetection.js turns that into a SILENT Gemini
        # fallback rather than an error. Harmless in a single container, where
        # callers use 127.0.0.1 either way.
        serve(app, listen=f'*:{port}', threads=_threads, channel_timeout=600)
    except ImportError:
        print("   waitress unavailable — falling back to Flask dev server")
        # '::' accepts IPv6 and, via IPv4-mapped addresses, IPv4 too.
        app.run(host='::', port=port, debug=False)
