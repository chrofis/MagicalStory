#!/usr/bin/env bash
# Wait for staging to serve a NEW commit, then run the ArcFace gate smoke test.
#
# Exists because the deploy and the verification were separated by a Railway
# builder problem: pushes succeeded, no build was scheduled, and staging kept
# serving 8f0f66ce for hours. Rather than re-checking by hand, this watches for
# the cutover and fires the smoke test itself.
#
# The smoke test costs real money (paid Grok generations), so it runs ONLY after
# the commit actually changes — never against the stale image, where it would
# prove nothing.
#
#   bash scripts/admin/await-deploy-then-smoke.sh [old_commit] [max_wait_seconds]

set -u
OLD_COMMIT="${1:-8f0f66ce}"
MAX_WAIT="${2:-5400}"
BASE="https://staging.magicalstory.ch"
START=$(date +%s)

echo "Watching ${BASE} for a commit other than ${OLD_COMMIT} (max ${MAX_WAIT}s)…"

while true; do
  NOW=$(date +%s)
  if [ $((NOW - START)) -ge "$MAX_WAIT" ]; then
    echo "TIMEOUT after ${MAX_WAIT}s — still on ${OLD_COMMIT}. Deploy never landed."
    exit 2
  fi

  CFG=$(curl -s -m 20 "${BASE}/api/health/config?cb=${RANDOM}" 2>/dev/null)
  COMMIT=$(printf '%s' "$CFG" | python -c "import sys,json;print(json.load(sys.stdin).get('commit',''))" 2>/dev/null)
  GATE=$(printf '%s' "$CFG" | python -c "import sys,json;print(json.load(sys.stdin).get('arcfaceGate','absent'))" 2>/dev/null)

  if [ -n "$COMMIT" ] && [ "$COMMIT" != "$OLD_COMMIT" ]; then
    echo "DEPLOYED: commit ${COMMIT} | arcfaceGate: ${GATE}"
    if [ "$GATE" = "absent" ] || [ -z "$GATE" ]; then
      # A new commit that predates the gate would waste a paid run.
      echo "…but arcfaceGate is absent — this build does not carry the gate. Still waiting."
      OLD_COMMIT="$COMMIT"
      continue
    fi
    echo "Running smoke test…"
    node scripts/admin/smoke-arcface-gate.js --chars=2 --family=miller
    exit $?
  fi
  sleep 30
done
