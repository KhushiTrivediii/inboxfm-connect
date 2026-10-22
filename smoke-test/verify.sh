#!/usr/bin/env bash
set -euo pipefail

# Basic headless API smoke: health, then N synchronous `POST /v1/execute` calls running
# Text Helper `concat` through the in-app sandbox, each asserting the exact output. Also
# checks that an invalid API key is rejected, so a broken auth layer can't pass as healthy.

NUM_REQUESTS="${1:-5}"
source "$(dirname "$0")/common.sh"
require_bench_env

PASS=0
FAIL=0

echo "=== Smoke Test ==="
echo "Base URL: $BENCH_BASE_URL"
echo "Requests: $NUM_REQUESTS"
echo ""

echo "--- Health check ---"
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$BENCH_BASE_URL/v1/flags")
if [ "$HTTP_CODE" = "200" ]; then
  echo "PASS: /v1/flags returned 200"
else
  echo "FAIL: /v1/flags returned $HTTP_CODE (expected 200)"
  exit 1
fi
echo ""

echo "--- Execute requests ---"
for i in $(seq 1 "$NUM_REQUESTS"); do
  RESPONSE=$(execute_concat "[\"smoke\",\"$i\"]" "-")
  BODY=$(echo "$RESPONSE" | sed '$d')
  STATUS=$(echo "$RESPONSE" | tail -n 1)
  EXPECTED_BODY="\"smoke-$i\""

  if [ "$STATUS" = "200" ] && [ "$BODY" = "$EXPECTED_BODY" ]; then
    echo "PASS [$i/$NUM_REQUESTS]: HTTP $STATUS, body=$BODY"
    PASS=$((PASS + 1))
  else
    echo "FAIL [$i/$NUM_REQUESTS]: HTTP $STATUS, body=$BODY (expected 200, $EXPECTED_BODY)"
    FAIL=$((FAIL + 1))
  fi
done
echo ""

echo "--- Invalid API key is rejected ---"
HTTP_CODE=$(BENCH_API_KEY="cak-not-a-real-key" execute_concat '["a","b"]' "-" | tail -n 1)
if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
  echo "PASS: invalid key returned HTTP $HTTP_CODE"
  PASS=$((PASS + 1))
else
  echo "FAIL: invalid key returned HTTP $HTTP_CODE (expected 401 or 403)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
