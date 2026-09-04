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

- [x] 1. `Dockerfile.analyzer` written, pip layers verbatim. **NOT the deployed
      build path** — see "What actually shipped" below.
- [x] 2. `start.sh` is Node-only; analyzer supervision moved to
      `start-analyzer.sh`. The web image still CONTAINS python (one Dockerfile),
      which costs disk, not memory.
- [x] 3. Railway `analyzer` service created in staging
      (`3ac947b5-def9-4027-bbe6-34da77d4babf`), repo trigger repointed
      `master` → `staging`, `PORT=5000` pinned so the healthcheck passes.
- [x] 3b. **`photo_analyzer.py` binds `*:port` (IPv4+IPv6).** Railway's private
      network is IPv6-only; the old `host='0.0.0.0'` accepted nothing over
      `analyzer.railway.internal`.
- [x] 4a. Verified reachable from the web container: `/health` 200, 747 bytes,
      0.28 s, `"service":"photo-analyzer"`, `cpu_quota: 24`.
- [x] 4b. Verified the HEAVY path: `/warmup` over the private network spawned
      workers inside the analyzer container — router 94 MB, workers 1.47 GB and
      1.22 GB, cgroup `anon` 1,879 MB. That is the memory that used to sit in the
      web container.
- [x] 5. `character2x4Sheet.js` uses `photoAnalyzerClient.photoAnalyzerUrl()`.
      (Ten other files still inline the same pattern; all honour the env var.)
- [ ] 6. Set `PHOTO_ANALYZER_URL=http://analyzer.railway.internal:5000` on the
      web service. Deliberately done BEFORE removing anything, so unsetting it
      is an instant rollback to the in-container analyzer.
- [ ] 7. Verify with a full beats story: `dino_calls` / `sam_calls` present in
      `story_metrics`, avatars generated, no `dino_detect_fail` spike.
- [ ] 8. Measure both containers' cgroups after that run. Expected: web flat and
      low, analyzer holding the ~1.3-1.9 GB.
- [ ] 9. Enable sleeping on the analyzer service ONLY (never the web service).
      Confirm `/warmup` wakes it early enough that the first real call does not
      time out into the Gemini fallback.
- [ ] 10. Production rollout — needs its own owner approval.

## What actually shipped, and why it differs from the plan

`railway.json` at the repo root is config-as-code and hardcodes
`dockerfilePath: "Dockerfile"` and `healthcheckPath: "/api/health"` for every
service in the project. Pointing the analyzer service at its own config file is
refused by the API: *"Config as Code (railway.json / railway.toml) is deprecated.
Use Infrastructure as Code (.railway/railway.ts) instead."*

So both services build the SAME image and differ by start command
(`startCommand: bash start-analyzer.sh` + `PORT=5000` on the analyzer). This
achieves the memory goal in full — page cache follows what a container READS, and
the web container will no longer import torch/TensorFlow at all. It does not
achieve a smaller analyzer image or faster deploys.

**Follow-up:** migrate to `.railway/railway.ts` so `Dockerfile.analyzer` becomes
live. Until then that file is the documented target, not the running config.

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
