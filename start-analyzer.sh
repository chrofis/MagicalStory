#!/bin/bash
set -e

# Entrypoint for the standalone photo-analyzer service.
#
# Lifted from start.sh's run_analyzer loop when the analyzer moved out of the web
# container (2026-09-04). The supervision and the memory hygiene below are the
# whole reason this is a script rather than a bare CMD.

# ── Memory hygiene (Railway bills resident MB per MINUTE, 24/7) ──────────────
# glibc gives each malloc arena its own free-list and never returns those pages
# to the OS. This process is a heavy multi-threaded allocator (torch/opencv), so
# the default cap of 8 arenas per core lets RSS ratchet upward across requests
# and stay there — we pay for the high-water mark around the clock even while
# idle. Capping arenas at 2 trades a little allocator contention for a much
# flatter RSS curve.
export MALLOC_ARENA_MAX=2

echo "================================"
echo "MagicalStory photo analyzer"
echo "MALLOC_ARENA_MAX=${MALLOC_ARENA_MAX}"
echo "================================"

# Supervised: the analyzer deliberately EXITS itself once it is idle and bloated,
# and this loop brings it straight back.
#
# Why exiting is the only option: after heavy SAM/GDINO/rembg inference the
# process holds ~1GB that a forced malloc_trim(0) reclaims *nothing* of
# (measured on staging: 1192.2MB -> 1192.9MB with every model already unloaded).
# It is fragmentation and torch's own pools — freed blocks interleaved with live
# ones, which glibc can only return when a whole page is free. Unloading models
# gets their weights back; it cannot defragment what remains. Ending the process
# is what returns 100% to the OS, and Railway bills that RSS every minute.
#
# The exit is idle-gated inside photo_analyzer.py (no in-flight inference, no
# recent requests) so it can never land mid-story. The Node side tolerates the
# few seconds of downtime: analyzer calls have timeouts and fall back.
#
# NOTE: the exit/restart cycle is now MORE visible than it was in the shared
# container — this process is the whole service, so while it restarts the service
# is briefly unreachable rather than merely one endpoint being down. Node's
# retries and the /warmup call before real work are what cover that gap.
while true; do
  python3 -u photo_analyzer.py 2>&1 | tee /tmp/python-service.log
  code=$?
  echo "[SUPERVISOR] photo_analyzer exited (code $code) — restarting in 1s"
  sleep 1
done
