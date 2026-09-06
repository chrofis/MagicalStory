# Analyzer load/unload lifecycle — review findings and fixes (2026-09-06)

Full review of the worker/model load-unload machinery after the analyzer service
split. Measured evidence in this session; review of every kill/unload path.

**Verdict going in:** the mechanism (process-per-role, kill at session zero) is
right — only `exit()` returns torch/TF arena memory. The *bracketing* is one
notch too coarse, and four soundness bugs defeat the memory saving the split
exists to produce.

## Measured baseline (staging, 2026-09-06)

| path | cold | warm |
|---|---|---|
| face worker boot (mediapipe +483MB) | 2.5-3.1s | — |
| U2-Net load | 27.6s (downloads from GitHub) | 0.9s |
| `/remove-bg` end to end | 31.4s | 5.7s -> 1.2s |
| torch (MobileSAM + DINO) | 4.1-10.8s | — |
| page-cache sweep on reap | 378-673ms | — |

| state | RSS |
|---|---|
| parent idle | ~91MB |
| face worker booted | ~574MB (483 of it mediapipe) |
| face + U2-Net | ~1137-1450MB |
| torch (MobileSAM + DINO) | ~1155MB |
| container after reap | ~168MB page cache + 91MB parent |

## Soundness

- [x] **F1 (CRITICAL) Sessions are a bare refcount, so one job's end can kill another job's workers.**
      `session_end` clamps `max(0, n-1)`. A lost `sessionBegin` (fire-and-forget,
      connection-retry only) turns a lost increment into a stolen decrement.
      Fix: session IDENTITIES — begin registers an id, end removes that id,
      unknown id is a no-op. Same class as the `/release-memory` 409 guard added
      2026-09-05, which was applied to the admin path only.
- [x] **F2 (HIGH) A wedged worker is never terminated or respawned.** Absorbing
      state: alive, not ready, nobody starting it -> every request re-fails at
      `WEDGED_WORKER_TIMEOUT_S` forever while the process keeps full RSS.
      Introduced by the same-day fix that made it fail fast. Fix: terminate and
      respawn on the wedge branch.
- [x] **F3 (HIGH) The leaked-session reclaim can never fire under real traffic.**
      Requires 1800s of GLOBAL request silence, but `_last_request_ts` is stamped
      by every activity request including `/warmup`, which any wizard visitor
      triggers. One crashed story + daytime traffic = full fleet + ~1.3GB page
      cache billed 24/7. Fix: age each SESSION (composes with F1), and take
      `/warmup` out of the activity stamp.
- [x] **F4 (HIGH) `/warmup` single-flight DROPS the second caller's role set.**
      Returns "already warming" and discards `workers`/`dino`/`arcface`. So a
      presence beat's `['face']` can swallow the repair-phase `force` warm, and
      DINO's ~90s load then lands on the first detection -> Gemini fallback.
      Fix: merge the requested roles into the in-flight warm.
- [x] **F5 (MED-HIGH) An adopted worker is invisible to every kill path.**
      Added to `_worker_ready` with no `_workers` entry: never killed, missing
      from `/health` accounting, and it defeats the readiness cache so every
      request re-probes.
- [x] **F6 (MED) Leaked-session reclaim zeroes the count even when the kill is refused.**
      Leaves count=idle while workers run -> next teardown reaps mid-work.
- [x] **F7 (MED) `?recycle=true` ignores `_active_sessions`** while the strictly
      less destructive `?unload=true` checks it.
- [x] **F8 (MED) `/release-memory` bypasses the cache-sweep single-flight and
      misreports what it unloaded** (list built before a kill that can refuse).
- [x] **F9 (MED) `_workers_lock` held across `terminate()` + `wait(5)`** — the
      function's own docstring rejects doing this with `_request_lock`.
- [x] **F10 (MED) Four `*_IDLE_UNLOAD_S` env vars and four `*_last_used` stamps
      are dead code.** Setting `GROUNDINGDINO_IDLE_UNLOAD_S` silently does nothing.
- [x] **F12 (LOW) `_worker_ready` not cleared on every not-alive path.**
- [x] **F13 (LOW) `_maybe_reap_workers` reads `_workers` outside the lock.**

## Waste

- [x] **W1 `jobs.js` spawns torch for the whole story** (~430MB for the 20-25
      idle minutes before the repair phase, which force-warms anyway).
      `photos.js` already reasons this argument; it was not carried over.
- [x] **W2 Avatar jobs spawn torch they never use** (`{arcface:true}` with no
      `workers` -> face+torch+arcface).
- [x] **W3 The cache-drop guard refuses all three model-cache roots.** The `>=3`
      path-segment floor rejects `/app/.hf_cache`, `/app/.deepface` and the
      single FILE `/app/mobile_sam.pt`, so model weights are never dropped.
- [x] **W4 U2-Net downloaded from GitHub at runtime — FIXED on the third attempt.**
      27.6s vs 0.9s cached, with an external host inside the user's upload path.
      Attempt 1 baked to `/app/.u2net` + `ENV U2NET_HOME`: this rembg version
      ignores that variable. Attempt 2 baked to `/root/.u2net` (the path the log
      names) but put it in **`Dockerfile.analyzer`, which is never built** —
      `railway.json` pins `dockerfilePath: "Dockerfile"`, so the analyzer service
      builds the MAIN image and only starts it differently. The giveaway was vite
      client output in the analyzer's own build log, which Dockerfile.analyzer
      cannot produce. Now in `Dockerfile` beside MobileSAM/DINO/ArcFace, with a
      size assertion so a truncated download cannot pass silently.
- [x] **W5 U2-Net session built for RSS, not throughput.** 176MB on disk loaded as
      526-877MB; the SPREAD pointed at ONNX Runtime's CPU memory arena plus
      intra-op threads defaulting to the cgroup quota of 24.
      `enable_cpu_mem_arena=False`, `intra_op_num_threads=4`, both overridable.
      NEEDS A LATENCY CHECK before prod.

## Doc / comment contradictions

- [x] C1 `photo_analyzer.py` "same idle reaper as rembg/GDINO" — no reaper exists.
- [x] C2 `/release-memory` docstring "reapers only fire after 10-15 minutes".
- [ ] C3 `storyJobPipeline.js` "MobileSAM and GDINO idle-unload after ~15 min".
- [x] C4 `server.js` "belt-and-suspenders — start.sh dies with Node" — false since
      the analyzer became its own service; `sessionReset` is load-bearing now.
- [x] C5 `analyzerClient.js` header "the analyzer exits itself when idle".
- [x] C6 `photo_analyzer.py` "one sweep at a time" vs `/release-memory` (F8).
- [x] C7 `kill_workers` docstring vs its own `_workers_lock` hold (F9).
- [x] C8 `docs/decisions.md` "a wedged worker fails fast" — never recovers (F2).
- [x] C9 `/warmup` "callers that know an avatar is coming send arcface" — dropped
      by the single-flight (F4).

## Review

**Landed 2026-09-06** (photo_analyzer.py, analyzerClient.js, presenceSessions.js,
jobs.js, faceIdentity.js, photos.js, server.js, Dockerfile.analyzer).

Verified by `tests/manual/test_worker_bringup_race.py`, now six cases and run by
pre-push gate 6c: bring-up guard, alive-is-not-ready, force override, ready-cache
(0 probes on the hot path), wedge terminate+respawn, and session identities
(ending an unknown id does not close someone else's session).

`WORKER_START_TIMEOUT_S` was extracted from a hardcoded 120 so the wedge test can
bound itself instead of waiting two minutes.

### Second pass, 2026-09-06

F12/F13 closed, the U2-Net bake finally landed in the file that is actually
built, and the face worker was measured rather than guessed at:

- **mediapipe's 483MB is legitimate and role-gated.** The parent raises
  ImportError on purpose so only the face/arcface workers pay it. Not waste.
- **The reducible part was the U2-Net session** — see W5.

### STILL BLOCKED by the shared tree
- **C3** (`storyJobPipeline.js` comment) and the **BACKLOG index lines**.
  `storyJobPipeline.js` and `tasks/BACKLOG.md` still carry another session's
  uncommitted work. Staging just my hunk via `git apply --cached` was attempted
  and refused (the patch context comes from the working tree, the index is at
  HEAD), so the edit was reverted rather than left to ride along in their commit.
  Both are one-line jobs the moment that session pushes.
