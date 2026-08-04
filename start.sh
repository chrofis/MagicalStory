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

# Start Python with unbuffered output so logs appear immediately
python3 -u photo_analyzer.py 2>&1 | tee /tmp/python-service.log &
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
