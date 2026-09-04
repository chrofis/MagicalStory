#!/bin/bash
set -e

# Web service entrypoint: Node ONLY.
#
# The Python photo analyzer used to be supervised from here, in this same
# container. It moved to its own Railway service on 2026-09-04 (see
# docs/decisions.md and Dockerfile.analyzer / start-analyzer.sh); Node now reaches
# it over private networking via PHOTO_ANALYZER_URL.
#
# WHY IT LEFT, measured: Railway bills a container's page cache as used memory,
# and every analyzer worker spawn mapped the ML stack's shared objects in — they
# stayed resident after the worker exited. mincore(2) on staging 21.4 h after a
# story found 1,361 MB attributable of 1,603 MB, led by libtensorflow_cc 378 MB
# and libtorch_cpu 185 MB, plus a 9.85 GB `anon` peak during the parallel
# illustration burst. All of it inside the container serving the website.
#
# Note what does NOT matter here: the image still CONTAINS torch and TensorFlow
# (one image, two start commands — railway.json forces a single dockerfilePath).
# That costs disk, not memory. Page cache is driven by what is READ, and a
# container that never imports them never pays for them — a fresh container on
# the same image idles at 26-90 MB of cache.

# ── Memory hygiene (Railway bills resident MB per MINUTE, 24/7) ──────────────
# glibc gives each malloc arena its own free-list and never returns those pages
# to the OS. Node's libuv threadpool is a multi-threaded allocator, so the
# default cap of 8 arenas per core lets RSS ratchet upward across requests and
# stay there — we pay for the high-water mark around the clock even while idle.
# Capping arenas at 2 trades a little allocator contention for a much flatter RSS
# curve. (start-analyzer.sh sets the same cap for the analyzer's own process.)
export MALLOC_ARENA_MAX=2

echo "================================"
echo "Starting MagicalStory web service"
echo "================================"
echo "Photo analyzer: ${PHOTO_ANALYZER_URL:-http://127.0.0.1:5000 (default — expected to be set to the analyzer service)}"

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
exec node --max-old-space-size="${NODE_HEAP_MB}" server.js
