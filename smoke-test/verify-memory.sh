#!/usr/bin/env bash
set -euo pipefail

# Engine memory stability: the headless API runs every `POST /v1/execute` in a long-lived
# engine child of the APP process (reused across calls in SANDBOX_CODE_ONLY / UNSANDBOXED),
# so a per-call leak accumulates there. Fires many executes and fails if the engine's RSS
# keeps climbing after it has warmed up.

TOTAL_ITERATIONS="${1:-5000}"
SAMPLE_INTERVAL="${2:-500}"
WARMUP_REQUESTS=100

source "$(dirname "$0")/common.sh"
require_bench_env

echo "=== Engine Memory Stability Test ==="
echo "Base URL:         $BENCH_BASE_URL"
echo "Total iterations: $TOTAL_ITERATIONS"
echo "Sample interval:  $SAMPLE_INTERVAL"
echo "Warmup requests:  $WARMUP_REQUESTS"
echo ""

APP_CONTAINER=$(find_app_container)
echo "App container: $APP_CONTAINER"

# The engine sets process.title = sandbox-<id>, which is what ps reports as its command.
get_sandbox_rss_kb() {
  local rss
  rss=$(docker exec "$APP_CONTAINER" sh -c "ps -eo pid,rss,comm 2>/dev/null | awk '/sandbox-/ {sum+=\$2} END {print sum+0}'")
  echo "${rss}" | tr -d '[:space:]'
}

to_mb() {
  awk -v kb="$1" 'BEGIN {printf "%.1f", kb / 1024}'
}

growth_mb() {
  awk -v current="$1" -v baseline="$2" 'BEGIN {printf "%.1f", (current - baseline) / 1024}'
}

growth_int() {
  awk -v current="$1" -v baseline="$2" 'BEGIN {printf "%d", (current - baseline) / 1024}'
}

fire_request() {
  execute_concat '["mem","ok"]' "-" | tail -n 1
}

echo ""
echo "--- Warmup ($WARMUP_REQUESTS requests) ---"
for i in $(seq 1 "$WARMUP_REQUESTS"); do
  STATUS=$(fire_request)
  if [ "$STATUS" != "200" ]; then
    echo "FAIL: Warmup request $i returned HTTP $STATUS"
    exit 1
  fi
  if [ "$((i % 25))" -eq 0 ]; then
    echo "  Warmup $i/$WARMUP_REQUESTS: HTTP $STATUS"
  fi
done

echo "Sleeping 10s for GC to settle..."
sleep 10

BASELINE_KB=$(get_sandbox_rss_kb)
if [ "$BASELINE_KB" -eq 0 ]; then
  # No sandbox process means the sample would read 0 forever and the growth check would
  # pass vacuously — exactly the case this gate must not hide.
  echo "FAIL: no sandbox-* engine process found in $APP_CONTAINER after warmup"
  exit 1
fi
BASELINE_MB=$(to_mb "$BASELINE_KB")
echo ""
echo "--- Baseline RSS: ${BASELINE_MB} MB ---"
echo ""

SAMPLES_FILE=$(mktemp)
trap 'rm -f "$SAMPLES_FILE"' EXIT
echo "0 $BASELINE_KB" > "$SAMPLES_FILE"

echo "--- Running $TOTAL_ITERATIONS requests ---"
for i in $(seq 1 "$TOTAL_ITERATIONS"); do
  STATUS=$(fire_request)
  if [ "$STATUS" != "200" ]; then
    echo "FAIL: Request $i returned HTTP $STATUS"
    exit 1
  fi

  if [ "$((i % SAMPLE_INTERVAL))" -eq 0 ]; then
    CURRENT_KB=$(get_sandbox_rss_kb)
    CURRENT_MB=$(to_mb "$CURRENT_KB")
    CURRENT_GROWTH=$(growth_mb "$CURRENT_KB" "$BASELINE_KB")
    echo "  [$i/$TOTAL_ITERATIONS] RSS: ${CURRENT_MB} MB (growth: ${CURRENT_GROWTH} MB)"
    echo "$i $CURRENT_KB" >> "$SAMPLES_FILE"
  fi
done

echo ""
echo "=== Memory Samples ==="
printf "%-12s | %-10s | %-10s\n" "Iteration" "RSS (MB)" "Growth (MB)"
printf "%-12s-+-%-10s-+-%-10s\n" "------------" "----------" "----------"

while read -r iter rss_kb; do
  rss_mb=$(to_mb "$rss_kb")
  g_mb=$(growth_mb "$rss_kb" "$BASELINE_KB")
  printf "%-12s | %-10s | %-10s\n" "$iter" "$rss_mb" "$g_mb"
done < "$SAMPLES_FILE"

# Stability assertion: compare the average of the last 3 samples to the sample taken at
# the first interval (warm steady-state baseline). This avoids false positives from V8's
# initial heap expansion.
SAMPLE_COUNT=$(wc -l < "$SAMPLES_FILE" | tr -d '[:space:]')

if [ "$SAMPLE_COUNT" -ge 5 ]; then
  WARM_KB=$(awk 'NR==3 {print $2}' "$SAMPLES_FILE")
  LAST3_AVG_KB=$(tail -3 "$SAMPLES_FILE" | awk '{sum+=$2; n++} END {printf "%d", sum/n}')

  STEADY_GROWTH_MB=$(growth_mb "$LAST3_AVG_KB" "$WARM_KB")
  STEADY_GROWTH_INT=$(growth_int "$LAST3_AVG_KB" "$WARM_KB")
  WARM_MB=$(to_mb "$WARM_KB")
  LAST3_MB=$(to_mb "$LAST3_AVG_KB")

  echo ""
  echo "--- Stability Check ---"
  echo "Warm baseline (iter $((SAMPLE_INTERVAL * 2))):   ${WARM_MB} MB"
  echo "Avg last 3 samples:                       ${LAST3_MB} MB"
  echo "Steady-state growth:                      ${STEADY_GROWTH_MB} MB"

  if [ "$STEADY_GROWTH_INT" -ge 100 ]; then
    echo ""
    echo "FAIL: Steady-state memory growth ${STEADY_GROWTH_MB} MB exceeds 100 MB threshold"
    exit 1
  fi
else
  echo ""
  echo "WARNING: Not enough samples ($SAMPLE_COUNT) for stability check, skipping assertion"
fi

echo ""
echo "=== Memory Stability Test PASSED (steady-state growth: ${STEADY_GROWTH_MB:-N/A} MB < 100 MB) ==="
