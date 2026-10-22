#!/usr/bin/env bash
set -euo pipefail

# Local benchmark of the headless API: builds the image, starts the compose stack, provisions
# a Text Helper connection + API key, then drives `POST /v1/execute` with the regression
# gate's load runner (benchmark/gate) and samples the app container's CPU/memory meanwhile.
#
# Usage: ./benchmark/run-local.sh [execution_mode] [requests_per_round] [rounds]
#   execution_mode: SANDBOX_CODE_ONLY | UNSANDBOXED | SANDBOX_PROCESS | SANDBOX_CODE_AND_PROCESS
#   CONCURRENCY (default 1), WARMUP (default 50), APP_REPLICAS (default 1)
#
# Compare against a baseline afterwards with:
#   node benchmark/gate/cli.mjs compare --baseline <baseline.json> --results /tmp/bench-results.json

EXECUTION_MODE=${1:-SANDBOX_CODE_ONLY}
REQUESTS=${2:-200}
ROUNDS=${3:-3}
# Each app process runs executes through one sandbox, so concurrency above the number of
# app replicas measures queueing on that sandbox rather than service time.
CONCURRENCY=${CONCURRENCY:-1}
WARMUP=${WARMUP:-50}
APP_REPLICAS=${APP_REPLICAS:-1}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/benchmark/gate/cli.mjs"
RESULTS=/tmp/bench-results.json
STATS=/tmp/bench-app-stats.txt

if [ ! -f "$GATE" ]; then
  echo "ERROR: $GATE not found — the load runner lives in benchmark/gate (PR #98)." >&2
  exit 1
fi

COMPOSE="docker compose -f $ROOT/benchmark/docker-compose.yml"

cleanup() {
  echo "Tearing down..."
  $COMPOSE down -v
}
trap cleanup EXIT

echo "=== Building image ==="
docker build -t activepieces-benchmark:local "$ROOT"

echo "=== Starting stack (mode=$EXECUTION_MODE, apps=$APP_REPLICAS) ==="
AP_EXECUTION_MODE=$EXECUTION_MODE \
APP_REPLICAS=$APP_REPLICAS \
WORKER_REPLICAS=1 \
  $COMPOSE up -d

echo "Waiting for containers to settle..."
sleep 5
$COMPOSE ps

echo "=== Provisioning ==="
BENCH_ENV=$("$ROOT/benchmark/setup.sh")
set -a
eval "$BENCH_ENV"
set +a

APP_CONTAINERS=$($COMPOSE ps --format '{{.Name}}' app)
: > "$STATS"
( while true; do
    # shellcheck disable=SC2086
    docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' $APP_CONTAINERS >> "$STATS" 2>/dev/null || true
  done ) &
SAMPLER=$!
trap 'kill "$SAMPLER" 2>/dev/null || true; cleanup' EXIT

echo "=== Benchmark ($ROUNDS x $REQUESTS requests, concurrency $CONCURRENCY) ==="
node "$GATE" run \
  --scenario execute-text-helper \
  --tier local \
  --environment "local-$EXECUTION_MODE" \
  --concurrency "$CONCURRENCY" \
  --requests "$REQUESTS" \
  --rounds "$ROUNDS" \
  --warmup "$WARMUP" \
  --apps "$APP_REPLICAS" \
  --workers 0 \
  --out "$RESULTS"
kill "$SAMPLER" 2>/dev/null || true

echo ""
echo "=== App container usage during the run ==="
# MemUsage is "<used> / <limit>"; parse only the used value and its own unit.
awk '
  {
    cpu = $2; gsub(/%/, "", cpu); cpuSum += cpu; n++
    used = $3
    unit = used; gsub(/[0-9.]/, "", unit)
    val = used;  gsub(/[A-Za-z]/, "", val); val = val + 0
    if (unit == "GiB") mb = val * 1024
    else if (unit == "MiB") mb = val
    else if (unit == "KiB") mb = val / 1024
    else mb = val / (1024 * 1024)
    if (mb > maxMem) maxMem = mb
  }
  END {
    if (n == 0) { print "  (no docker stats samples)"; exit }
    printf "  app CPU (avg per sample): %.1f%%\n", cpuSum / n
    printf "  app mem (peak):           %.0f MB\n", maxMem
  }
' "$STATS"

echo ""
echo "Results saved to $RESULTS"
node -e "const r=require('$RESULTS');console.log(JSON.stringify(r.aggregate,null,2))"
