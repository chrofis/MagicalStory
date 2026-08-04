#!/bin/bash
set -e

# ── Memory hygiene (Railway bills resident MB per MINUTE, 24/7) ──────────────
# glibc gives each malloc arena its own free-list and never returns those pages
# to the OS. Both processes here are heavy multi-threaded allocators (Node's
# libuv threadpool; Python's torch/opencv), so the default cap of 8 arenas per
# core lets RSS ratchet upward across requests and stay there — we pay for the
# high-water mark around the clock even while idle. Capping arenas at 2 trades a
# little allocator contention for a much flatter RSS curve.
export MALLOC_ARENA_MAX=2

echo "================================"
echo "Starting MagicalStory Services"
echo "================================"

echo ""
echo "[1/2] Starting Python photo analyzer service on port 5000..."
echo "Python version: $(python3 --version)"

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
# recent requests) so it can never land mid-story. Node tolerates the few
# seconds of downtime: analyzer calls have timeouts and fall back.
run_analyzer() {
  while true; do
    python3 -u photo_analyzer.py 2>&1 | tee /tmp/python-service.log
    code=$?
    echo "[SUPERVISOR] photo_analyzer exited (code $code) — restarting in 1s"
    sleep 1
  done
}
run_analyzer &
PYTHON_PID=$!

echo "Python service PID: $PYTHON_PID"
echo "Waiting for Python service to initialize (3 seconds)..."
sleep 3

# Check if Python service is still running
if kill -0 $PYTHON_PID 2>/dev/null; then
    echo "✓ Python service process is running"
    # Try to hit the health endpoint
    echo "Testing health endpoint..."
    curl -s http://127.0.0.1:5000/health || echo "Health endpoint not responding yet"
else
    echo "✗ Python service failed to start"
    echo "=== Python service log ==="
    cat /tmp/python-service.log || echo "No log file found"
    echo "==========================="
    echo "WARNING: Continuing without photo analysis service"
fi

echo ""
echo "[2/2] Starting Node.js server..."
# NOTE: this is the real production entrypoint (Dockerfile CMD is `bash start.sh`),
# NOT `npm start` — any node flag must be set HERE to take effect in the container.
#
# Without an explicit cap, Node sizes its old-space from the container's memory
# allowance, which on Railway is far larger than this app's working set. V8 only
# collects under heap pressure and never hands grown pages back to the OS, so the
# heap ratchets up to that ceiling and stays. Measured effect: production sat at
# p50 4.44 GB / p90 4.57 GB while using ~234 vCPU-min for the whole month —
# memory retained, not used. Staging showed p50 1.23 GB purely because it
# redeploys often enough to keep resetting the heap.
#
# 3072 is ~2.5x the observed idle working set of the whole container (~1.2 GB),
# so it leaves ample headroom for a story run while removing the runway the
# ratchet was filling. Raise it if a generation ever OOMs — do NOT lower it
# without re-measuring, an OOM here kills in-flight story generation.
NODE_HEAP_MB="${NODE_HEAP_MB:-3072}"
echo "Node heap cap: ${NODE_HEAP_MB}MB | MALLOC_ARENA_MAX=${MALLOC_ARENA_MAX}"
node --max-old-space-size="${NODE_HEAP_MB}" server.js

# If Node.js exits, kill Python service
kill $PYTHON_PID 2>/dev/null || true
