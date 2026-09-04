# Split the Python photo analyzer into its own Railway service

**Status:** PLAN — not started. Owner chose this direction 2026-09-04.
**Why:** measured, see `docs/decisions.md` 2026-09-04 (both entries).

## The problem this solves

The web container runs a Python ML stack in-process. Every analyzer worker spawn
maps its shared objects in, and those pages stay in the cgroup's page cache after
the worker exits — measured with `mincore(2)` on staging 21.4 h after a story:

```
  378.4 MB  tensorflow/libtensorflow_cc.so.2      (deepface/ArcFace only)
  185.1 MB  torch/lib/libtorch_cpu.so
  153.6 MB  llvmlite/binding/libllvmlite.so       (transitive, not in requirements.txt)
   62.8 MB  cv2/cv2.abi3.so
   38.8 MB  mobile_sam.pt
  ~180 MB   mediapipe, onnxruntime, 3x openblas, libvips, Qt5Gui
 1,361 MB   attributed of 1,603 MB resident
```

Railway bills page cache as used memory. It is bounded, not a leak — but it is
~1.3 GB of permanent cost, and `anon` additionally peaked at **9.85 GB** during
the parallel illustration burst, inside the container that serves users.

Splitting means: web container stays ~200 MB with no Python at all; the ML
service holds the libraries and can sleep between stories.

## What makes this tractable

- **One seam.** Every Node call site resolves the analyzer through
  `PHOTO_ANALYZER_URL` (default `http://127.0.0.1:5000`). Pointing Node at
  another host is CONFIG, not code.
- **The in-flight cap self-sizes.** `photoAnalyzerClient.js` probes the
  analyzer's own `/health` → `cpu.cpu_quota` and builds `pLimit` from it, so a
  differently-sized analyzer service is handled automatically.
- **Workers are internal.** `WORKER_PORTS = {face:5001, torch:5003, arcface:5004}`
  are addressed as `127.0.0.1` *inside* the analyzer. The whole parent/worker
  arrangement moves as a unit; no cross-service change.
- **Warmup already exists.** Node calls `/warmup` during the wizard/text phase
  and brackets real work with refcounted `/session/begin` + `/session/end`. That
  is exactly the pre-wake hook a sleeping ML service needs.

## Steps

- [ ] 1. `Dockerfile.analyzer` — python + torch CPU + requirements + model
      prefetches + `photo_analyzer.py`. Move the pip layers VERBATIM, including
      their ordering comments (numpy co-pin, typing_extensions before the DINO
      prefetch, torch pinned `2.1.2+cpu`); that order encodes fixed bugs.
- [ ] 2. `Dockerfile` (web) — drop python, torch, all model prefetches, and the
      analyzer supervision from `start.sh`. Node only. Expect ~8 GB → ~700 MB.
- [ ] 3. Railway: create the `analyzer` service (same repo, `Dockerfile.analyzer`),
      staging environment first. Give it its own vCPU/memory sizing.
- [ ] 4. Set `PHOTO_ANALYZER_URL=http://analyzer.railway.internal:5000` on the web
      service. Railway private networking is free and not billed as egress;
      internal DNS is IPv6 — verify the Node fetch resolves it (`http://` +
      `.railway.internal`).
- [ ] 5. Fix the two inline URL copies in `character2x4Sheet.js:994,1013` to use
      `photoAnalyzerClient.photoAnalyzerUrl()` — one definition, which is the
      stated purpose of that module.
- [ ] 6. Verify on staging with a full beats story: `dino_calls` / `sam_calls`
      present in `story_metrics`, avatars generated, `/detect-illustration-faces`
      and `/figure-mask` working, no `detection_fallback` spike.
- [ ] 7. Measure both containers' cgroups after that run. Expected: web ~200 MB
      flat, analyzer holding the ~1.3 GB.
- [ ] 8. Enable sleeping on the analyzer service ONLY (never the web service).
      Confirm `/warmup` wakes it early enough that the first real call does not
      time out into the Gemini fallback.
- [ ] 9. Production rollout — needs its own owner approval.

## Risks, and what each costs if wrong

1. **Cold start into a silent fallback.** If the analyzer sleeps and the first
   real call arrives before it is up, `/detect-figures-text` fails and
   `figureDetection.js:897` returns null → silent Gemini fallback. This is the
   same silent-degradation shape as the torch bug: stories still generate, so
   nobody notices. MITIGATION: `/warmup` fires during the text phase, minutes
   ahead; add an explicit readiness wait before the first image stage, and alert
   on a `dino_detect_fail` spike rather than trusting silence.
2. **Payload cost.** ~90 analyzer calls per story, each carrying a base64 image
   over the network instead of loopback. Private networking is free, but latency
   and serialisation are not. MEASURE before/after story duration (baseline:
   2,617 s for 16 pages).
3. **Two deploy targets from one repo.** A push rebuilds both unless watch paths
   are configured. Slower deploys; a web-only change should not rebuild an 8 GB
   ML image.
4. **Session refcounting across the network.** `/session/begin` and `/session/end`
   are refcounted in the analyzer's memory. If the analyzer sleeps or restarts
   mid-story the count resets; check nothing depends on it surviving.

## Follow-ups this makes cheaper (not in scope here)

- Drop TensorFlow: 415 MB resident, 1.3 GB image, and it exists ONLY for
  `deepface`'s ArcFace gate (`photo_analyzer.py:3500`). Note `/face-embedding-onnx`
  ALREADY EXISTS at `photo_analyzer.py:3858`, and `onnxruntime` is installed — so
  the replacement may be mostly built. Needs `arcfaceGate: 0.45` re-validated
  against known pairs, since a different implementation moves the scores.
- Trace `llvmlite` (153.6 MB, transitive, not in requirements.txt).
