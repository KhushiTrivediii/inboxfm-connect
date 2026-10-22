#!/usr/bin/env bash
set -euo pipefail

# Sandbox memory-limit detection for the headless API. Each run sends Text Helper `concat`
# a small request (~NUM_TEXTS one-char texts joined by a SEPARATOR_CHARS-long separator)
# whose output is ~NUM_TEXTS * SEPARATOR_CHARS chars, far above the engine heap, so the
# engine child dies on --max-old-space-size. The API must turn that into a clean
# ENGINE_OPERATION_FAILURE carrying SANDBOX_MEMORY_ISSUE, and the next ordinary execute must
# succeed on a fresh sandbox: an engine OOM must never take the app process down with it.
#
# Needs a stack started with a sandbox memory limit well below the output size, e.g.
# AP_SANDBOX_MEMORY_LIMIT=262144 (256 MB) with the defaults below (~450 MB output). Keep the
# output under V8's max string length (~536M chars) or join() throws a RangeError instead
# of exhausting the heap.

NUM_RUNS="${1:-3}"
NUM_TEXTS="${OOM_NUM_TEXTS:-4501}"
SEPARATOR_CHARS="${OOM_SEPARATOR_CHARS:-100000}"

source "$(dirname "$0")/common.sh"
require_bench_env

echo "=== Memory Limit Exceeded Detection Test ==="
echo "Base URL: $BENCH_BASE_URL"
echo "Runs:     $NUM_RUNS"
echo "Output:   ~$(( (NUM_TEXTS - 1) * SEPARATOR_CHARS / 1000000 ))M chars"
echo ""

OOM_BODY=$(mktemp)
trap 'rm -f "$OOM_BODY"' EXIT
jq -n \
  --arg projectId "$BENCH_PROJECT_ID" \
  --arg connectionId "$BENCH_CONNECTION_ID" \
  --argjson numTexts "$NUM_TEXTS" \
  --argjson separatorChars "$SEPARATOR_CHARS" \
  '{projectId: $projectId, integration: "@inboxfm-connect/piece-text-helper", tool: "concat", connectionId: $connectionId, input: {texts: [range($numTexts) | "a"], separator: ("x" * $separatorChars)}}' \
  > "$OOM_BODY"

PASS=0
FAIL=0

for i in $(seq 1 "$NUM_RUNS"); do
  echo "--- Run $i/$NUM_RUNS ---"

  RESPONSE=$(curl -s -w '\n%{http_code}' --max-time 180 \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $BENCH_API_KEY" \
    --data-binary "@$OOM_BODY" \
    "$BENCH_BASE_URL/v1/execute")
  BODY=$(echo "$RESPONSE" | sed '$d')
  STATUS=$(echo "$RESPONSE" | tail -n 1)

  if [ "$STATUS" != "200" ] && echo "$BODY" | jq -e '.code == "ENGINE_OPERATION_FAILURE" and (.params.message | tostring | contains("SANDBOX_MEMORY_ISSUE"))' > /dev/null 2>&1; then
    echo "  PASS: HTTP $STATUS with SANDBOX_MEMORY_ISSUE"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: HTTP $STATUS, body=$(echo "$BODY" | head -c 500) (expected ENGINE_OPERATION_FAILURE / SANDBOX_MEMORY_ISSUE)"
    FAIL=$((FAIL + 1))
  fi

  RECOVERY=$(execute_concat "[\"recovered\",\"$i\"]" "-")
  RECOVERY_BODY=$(echo "$RECOVERY" | sed '$d')
  RECOVERY_STATUS=$(echo "$RECOVERY" | tail -n 1)
  if [ "$RECOVERY_STATUS" = "200" ] && [ "$RECOVERY_BODY" = "\"recovered-$i\"" ]; then
    echo "  PASS: next execute succeeded on a fresh sandbox"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: next execute returned HTTP $RECOVERY_STATUS, body=$RECOVERY_BODY"
    FAIL=$((FAIL + 1))
  fi
  echo ""
done

echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
