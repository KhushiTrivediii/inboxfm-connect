#!/usr/bin/env bash
set -euo pipefail

# GKE benchmark of the headless API. Deploys benchmark/k8s-sandbox.yaml to OUR cluster, provisions a
# Text Helper connection + API key via benchmark/setup.sh, and drives `POST /v1/execute` through the
# app LoadBalancer with the regression gate's load runner (benchmark/gate, PR #98). Reports cold-boot
# latency, warm latency/throughput, and app vs worker CPU. Leaves the cluster up — teardown commands
# are printed at the end.
#
# Usage: benchmark/run-gke.sh [requests_per_round] [concurrency] [rounds]
#   CLUSTER (default ap-sandbox-bench)  ZONE (default us-central1-a)  APP_REPLICAS  APP_IMAGE
#
# Each app replica executes through a single engine sandbox, so keep concurrency at or below
# APP_REPLICAS to measure service time rather than queueing on that sandbox.

REQUESTS_PER_ROUND=${1:-500}
APP_REPLICAS=${APP_REPLICAS:-2}
CONCURRENCY=${2:-$APP_REPLICAS}
ROUNDS=${3:-3}
WARMUP_REQUESTS=${WARMUP_REQUESTS:-100}
WORKER_CPU=${WORKER_CPU:-500m}
WORKER_REPLICAS=${WORKER_REPLICAS:-1}
REUSE_SANDBOX=${REUSE_SANDBOX:-false}
APP_CPU=${APP_CPU:-1500m}
APP_IMAGE=${APP_IMAGE:-europe-west1-docker.pkg.dev/activepieces-b3803/poolserver/ap-app:latest}
CLUSTER=${CLUSTER:-ap-sandbox-bench}
ZONE=${ZONE:-us-central1-a}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export USE_GKE_GCLOUD_AUTH_PLUGIN=True

if [ ! -f "$ROOT/benchmark/gate/cli.mjs" ]; then
  echo "ERROR: benchmark/gate/cli.mjs not found — the load runner lives in benchmark/gate (PR #98)." >&2
  exit 1
fi

echo "=== Getting cluster credentials ($CLUSTER / $ZONE) ==="
gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE" --quiet

echo "=== Preparing manifest ==="
# The JWT secret must match the cluster's AP_JWT_SECRET. Override via env for a
# non-default secret; the fallback is a throwaway value for this ephemeral, torn-down cluster.
JWT_SECRET="${AP_JWT_SECRET:-benchmark-$(openssl rand -hex 12)}"
MANIFEST=$(mktemp)
sed -e "s|__WORKER_CPU__|${WORKER_CPU}|g" -e "s|__WORKER_REPLICAS__|${WORKER_REPLICAS}|" \
    -e "s|__AP_JWT_SECRET__|${JWT_SECRET}|" \
    -e "s|__REUSE_SANDBOX__|${REUSE_SANDBOX}|" \
    -e "s|__APP_REPLICAS__|${APP_REPLICAS}|" -e "s|__APP_CPU__|${APP_CPU}|" \
    -e "s|__APP_IMAGE__|${APP_IMAGE}|" "$ROOT/benchmark/k8s-sandbox.yaml" > "$MANIFEST"
echo "Worker: ${WORKER_REPLICAS}x @ ${WORKER_CPU} | App: ${APP_REPLICAS}x @ ${APP_CPU} | REUSE=${REUSE_SANDBOX}"

echo "=== Applying manifest ==="
kubectl apply -f "$MANIFEST"
rm -f "$MANIFEST"

# Force fresh WORKER pods so the (same-tag) image is re-pulled — imagePullPolicy:Always gets the new
# digest. Only the worker image changes between runs; restarting the app would destabilize signup.
echo "=== Forcing fresh worker rollout (re-pull image) ==="
kubectl rollout restart deployment/worker

echo "=== Waiting for app + worker rollouts ==="
kubectl rollout status deployment/app --timeout=600s
kubectl rollout status deployment/worker --timeout=600s

echo "=== Waiting for app LoadBalancer IP ==="
LB_IP=""
for _ in $(seq 1 60); do
  LB_IP=$(kubectl get svc app -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  [ -n "$LB_IP" ] && break
  sleep 5
done
[ -z "$LB_IP" ] && { echo "No LB IP"; exit 1; }
echo "App LB: http://$LB_IP"

echo "=== Cluster snapshot ==="
kubectl get pods -o wide | awk 'NR==1 || (/app|worker|minio|postgres|redis/ && ++c<=29)'
WORKERS_READY=$(kubectl get deployment worker -o jsonpath='{.status.readyReplicas}')
WORKERS_READY=${WORKERS_READY:-0}
echo "Workers ready: ${WORKERS_READY:-0}"

echo "=== Provisioning project, connection, and API key ==="
BENCH_ENV=$(BASE_URL="http://$LB_IP/api" "$ROOT/benchmark/setup.sh")
set -a
eval "$BENCH_ENV"
set +a

EXECUTE_BODY=$(jq -n --arg projectId "$BENCH_PROJECT_ID" --arg connectionId "$BENCH_CONNECTION_ID"   '{projectId: $projectId, integration: "@inboxfm-connect/piece-text-helper", tool: "concat", connectionId: $connectionId, input: {texts: ["cold", "ok"], separator: "-"}}')

echo "=== COLD BOOT: first execute (cold engine + cold piece cache) ==="
COLD_MS=$(curl -s -o /dev/null -w '%{time_total}' -m 120 -X POST   -H 'Content-Type: application/json' -H "Authorization: Bearer $BENCH_API_KEY"   -d "$EXECUTE_BODY" "$BENCH_BASE_URL/v1/execute" | awk '{printf "%.0f", $1 * 1000}')
echo "Cold boot latency: ${COLD_MS} ms"

echo "=== WARM THROUGHPUT: $ROUNDS x $REQUESTS_PER_ROUND requests @ concurrency $CONCURRENCY ==="
# Sample app vs worker CPU during the load test. /v1/execute runs in the app's own engine
# child, so the app tier is what this benchmark loads; workers should stay near idle.
( for _ in $(seq 1 40); do
    kubectl top pods --no-headers 2>/dev/null | awk '{role=($1 ~ /^app-/)?"app":($1 ~ /^worker-/)?"worker":($1 ~ /^postgres-/)?"postgres":($1 ~ /^redis-/)?"redis":"other"; cpu=$2+0; print role, cpu}'
    sleep 3
  done > /tmp/topsamples.txt ) &
SAMPLER=$!
node "$ROOT/benchmark/gate/cli.mjs" run   --scenario execute-text-helper   --tier fleet   --environment "gke-$CLUSTER"   --concurrency "$CONCURRENCY"   --requests "$REQUESTS_PER_ROUND"   --rounds "$ROUNDS"   --warmup "$WARMUP_REQUESTS"   --apps "$APP_REPLICAS"   --workers "$WORKERS_READY"   --timeout-ms 120000   --out /tmp/bench-gke.json
kill "$SAMPLER" 2>/dev/null || true

echo ""
echo "=== RESOURCE USAGE during load (app vs worker) ==="
awk '$1=="app"{as+=$2;an++} $1=="worker"{ws+=$2;wn++} $1=="postgres"{ps+=$2;pn++} $1=="redis"{rs+=$2;rn++}
     END{
       printf "  app      : %d samples, avg %.0f m/pod (limit %s)
", an, (an?as/an:0), "'"$APP_CPU"'"
       printf "  worker   : %d samples, avg %.0f m/pod (limit %s)
", wn, (wn?ws/wn:0), "'"$WORKER_CPU"'"
       printf "  postgres : %d samples, avg %.0f m   (single pod, the shared singleton)
", pn, (pn?ps/pn:0)
       printf "  redis    : %d samples, avg %.0f m   (single pod, the shared singleton)
", rn, (rn?rs/rn:0)
     }' /tmp/topsamples.txt 2>/dev/null || echo "  (no samples)"

echo ""
echo "=== SUMMARY ==="
echo "Headless /v1/execute on GKE | $CLUSTER | apps=$APP_REPLICAS @ $APP_CPU | concurrency=$CONCURRENCY | SANDBOX_CODE_ONLY"
echo "Cold boot latency : ${COLD_MS} ms"
node -e "const r=require('/tmp/bench-gke.json');console.log('Warm (median of rounds):', JSON.stringify(r.aggregate))"
echo "Results: /tmp/bench-gke.json (compare with: node benchmark/gate/cli.mjs compare --baseline <file> --results /tmp/bench-gke.json)"
echo ""
echo "Teardown when done:  kubectl delete -f benchmark/k8s-sandbox.yaml   (workload)"
echo "                     gcloud container clusters delete $CLUSTER --zone $ZONE   (cluster)"
