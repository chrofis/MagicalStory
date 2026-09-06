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
- [ ] **F12 (LOW) `_worker_ready` not cleared on every not-alive path.**
- [ ] **F13 (LOW) `_maybe_reap_workers` reads `_workers` outside the lock.**

## Waste

- [x] **W1 `jobs.js` spawns torch for the whole story** (~430MB for the 20-25
      idle minutes before the repair phase, which force-warms anyway).
      `photos.js` already reasons this argument; it was not carried over.
- [x] **W2 Avatar jobs spawn torch they never use** (`{arcface:true}` with no
      `workers` -> face+torch+arcface).
- [x] **W3 The cache-drop guard refuses all three model-cache roots.** The `>=3`
      path-segment floor rejects `/app/.hf_cache`, `/app/.deepface` and the
      single FILE `/app/mobile_sam.pt`, so model weights are never dropped.
- [x] **W4 U2-Net downloads from GitHub at runtime** while MobileSAM, DINO and
      ArcFace are baked into the image. 27.6s vs 0.9s, and an external dependency
      in the user's upload path.

## Doc / comment contradictions

- [x] C1 `photo_analyzer.py` "same idle reaper as rembg/GDINO" — no reaper exists.
- [x] C2 `/release-memory` docstring "reapers only fire after 10-15 minutes".
- [ ] C3 `storyJobPipeline.js` "MobileSAM and GDINO idle-unload after ~15 min".
- [x] C4 `server.js` "belt-and-suspenders — start.sh dies with Node" — false since
      the analyzer became its own service; `sessionReset` is load-bearing now.
- [x] C5 `analyzerClient.js` header "the analyzer exits itself when idle".
- [x] C6 `photo_analyzer.py` "one sweep at a time" vs `/release-memory` (F8).
- [x] C7 `kill_workers` docstring vs its own `_workers_lock` hold (F9).
- [ ] C8 `docs/decisions.md` "a wedged worker fails fast" — never recovers (F2).
- [ ] C9 `/warmup` "callers that know an avatar is coming send arcface" — dropped
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

### Deliberately NOT done in this pass
- **F12/F13** — cosmetic; `_worker_ready` is only read alongside a liveness check
  and the unsynchronised `_workers` read is a CPython-atomic dict truthiness.
- **C3** (`storyJobPipeline.js` "idle-unload after ~15 min") and the
  `docs/decisions.md` entries for this work: both files had UNCOMMITTED changes
  from a parallel session in this shared tree, and committing them by explicit
  path would have swept that session's work into this commit. Do them once that
  session has pushed.
- **The face worker's ~1,445MB** (94% of the warm footprint, 483MB of it
  mediapipe at import). Measurement job, not a cleanup — see the open item in
  BACKLOG.
