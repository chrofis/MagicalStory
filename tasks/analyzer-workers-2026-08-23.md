# Analyzer worker architecture — deterministic memory, no recycling

Owner direction (2026-08-23): "processes that finish when they are done and free up
everything … if a story is done everything should be freed again. No arbitrary
300/500/700MB recycling that might fire or not. Pure clean design."
Rollout choice: all at once. Lifecycle: story-end AND avatar-job-end.

## A. Principle

Python cannot un-import a module, so every in-process scheme (thresholds, idle
reapers, trim) is guesswork by construction. A process that exits returns all of
its memory to the OS, always. Therefore: models live in child processes that are
killed at explicit lifecycle boundaries. No RSS thresholds anywhere.

## B. Measured inventory (Windows venv, import cost)

| component | MB | today |
|---|---|---|
| python+flask+cv2+PIL (parent) | 53 | resident always |
| mediapipe | 299 | imported AT BOOT (unconditional) |
| rembg | 79 | lazy + idle reaper |
| torch runtime | 148 | lazy via SAM/pose/lpips |
| transformers+DINO weights | ~1900 | lazy, reaper |
| onnxruntime | 13 | lazy |
| tensorflow+deepface (gate off) | ~490 | not imported |

Idle today: 551MB. Idle after: **~53MB**.

## C. Endpoint → worker map

**Parent (53MB, pure cv2/PIL/numpy — no model):** /split-grid,
/split-reference-sheet, /crop-front-column, /add-background, /detect-all-faces,
/detect-anime-faces, /detect-illustration-faces (Haar/anime cascades are cv2),
/health, /warmup, /release-memory, /test.

**worker-face (mediapipe, 299MB):** /analyze, /extract-face, face boxes for
/figure-mask pairing, selfie segmentation, face mesh (ArcFace alignment).

**worker-rembg (79MB):** /remove-bg, /silhouette-edge, body-occluder cutouts.

**worker-torch (148MB + models; SAM ~570MB, pose, lpips, DINO ~1.9GB):**
/figure-mask, /pose-heads, /lpips, /detect-figures-text. One worker, not four:
these are used in the same story phase, share the torch runtime, and killing one
process frees them all. SAM's per-image embedding cache stays valid because the
worker lives for the whole story.

**worker-arcface (TF+deepface, ~490MB):** /face-embedding, /compare-identity.
This is what re-enables the ArcFace gate safely — TF confined to a process that
dies at avatar-job end can never starve DINO again. /face-embedding-onnx stays
in parent (13MB onnxruntime) as the light alternative.

## D. Architecture

- Parent keeps port 5000 and every existing path — Node callers unchanged.
- Workers listen on 5001-5004 (localhost only). Parent proxies request bodies
  verbatim; contracts identical. Spawn-on-first-use per worker; a spawned
  worker stays until session end.
- Worker crash → parent notes exit, next request respawns. Parent crash →
  start.sh supervisor restarts parent (unchanged); orphaned workers die with it
  (process group / job object).
- Windows dev: subprocess.Popen, same code path.

## E. Lifecycle protocol

- `POST /session/begin` (idempotent, counted) and `POST /session/end`.
- Node calls begin at: story job start (jobs.js:79 already calls ensureWarm —
  same site), avatar job start (avatars.js:1507), repair phase
  (storyJobPipeline.js:4520), Test Lab experiment start (testlab.js:1319 warm
  site), photo upload (photos.js:46).
- Node calls end at: story completion AND failure paths (storyJobPipeline
  ~:3020 text-only, ~:5666 full; the failure/cancel paths too), avatar job
  complete/failed (avatars.js:1937, :2570, :2676), Test Lab experiment end.
- Parent kills ALL workers when: active sessions == 0 AND no request in flight.
  Refcount, not booleans — two concurrent stories don't kill each other's
  workers (health/busy shows concurrent runs are real).
- Photo-upload orphan: an upload that never becomes an avatar job leaves its
  session open. Resolution: photo-upload does NOT open a session; its request
  spawns workers, and they are reaped at the next any-session end. Residual
  risk (documented): on a totally quiet day one upload can hold ~378MB until
  the next story/avatar. Owner declined timer-based safety nets; accepted.

## F. What gets DELETED

_recycle_watchdog, RECYCLE_RSS_MB/RECYCLE_IDLE_S/RECYCLE_WARM_HOLD_S,
_idle_model_reaper, _REMBG/_MOBILESAM/_POSE_IDLE_UNLOAD_S, the ArcFace idle
reaper (built 2026-08-22 — its idle condition never occurs in practice),
_recycle_hold_until plumbing. /release-memory becomes "kill workers now"
(admin), keeping its response shape. This is the payoff: one lifecycle rule
instead of six timers.

## G. Preserved behaviours

- /warmup contract unchanged for Node: it opens a session and pre-loads the
  named models in their workers (DINO's ~90s load still happens during the
  wizard/text phase, not mid-repair).
- ARCFACE_GATE_ENABLED can default true again once worker-arcface lands
  (separate decision + smoke test; not flipped in this change).
- TF/deepface STAY in the image (stashed removal is dropped) — needed by
  worker-arcface; the typing_extensions ordering fix from the other session
  protects torch.

## H. Rollout (all-at-once build, staged verification)

1. Build parent+4 workers locally; run local story smoke (test-scene.js on a
   stored page) + photo-upload + avatar flow against local analyzer; assert
   RSS: parent ~53MB idle, workers die at session end (Windows).
2. Push staging. Verify: (a) photo upload works, (b) 4-page smoke story on
   demo-b-hnecf completes with DINO detection, (c) analyzer RSS ~53MB after,
   (d) a Lab experiment passes. Coordinate with the in-flight DINO
   verification session before deploying.
3. Prod only with explicit per-push approval.

## I. Cost outcome

Idle analyzer 551→53MB per env ≈ 500MB × 2 envs ≈ **$10/month saved**; more
when DINO would otherwise linger. During a story, peak is unchanged.

## J. Risks

- Proxy copy: request+response bodies traverse two local sockets (~ms per MB);
  worst case /figure-mask with large images — measure in step 1, budget <100ms.
- Two sessions racing end/begin: refcount + in-flight check covers it.
- A missed session-end (Node crash mid-story): workers persist until the next
  session ends. Accepted per owner (no timers). start.sh restart of Node does
  not restart Python — document that /session/end resilience depends on the
  finally blocks, which also survive job failure.
- This is the subsystem broken twice this week; the pre-push gate + staged
  verification above is the mitigation.

## Progress

- [x] (2026-09-06, 7257a4777) Parent/worker split in photo_analyzer.py (+ worker entrypoints)
- [x] (2026-09-06, 828c7cf07) Session refcount + kill-at-zero
- [x] (2026-09-06, a5fbcedf3) Node: session begin/end at the sites in §E
- [x] (2026-09-06, c5603ebf0) Delete recycler/reaper machinery (§F)
- [x] (2026-09-06, 77ef830e2 + 31ece1059) Local verification (§H.1)
- [ ] Staging + smoke (§H.2) — **production is NOT wired** (the analyzer runs as its own Railway
      service on staging only; see memory `project_analyzer_service_split`)
- [ ] decisions.md entry; BACKLOG tick
