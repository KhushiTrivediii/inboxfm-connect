#!/usr/bin/env bash
# Shared helpers for the headless smoke tests. Run after `set -a; eval "$(benchmark/setup.sh)"; set +a`
# (or with the BENCH_* variables exported some other way, e.g. from $GITHUB_ENV).

require_bench_env() {
  local missing=()
  for key in BENCH_BASE_URL BENCH_API_KEY BENCH_PROJECT_ID BENCH_CONNECTION_ID; do
    if [ -z "${!key:-}" ]; then
      missing+=("$key")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "FAIL: missing ${missing[*]} — run \`set -a; eval \"\$(benchmark/setup.sh)\"; set +a\` first"
    exit 1
  fi
}

# POST /v1/execute for Text Helper `concat`. Prints the response body followed by a final
# line holding the HTTP status, so callers can split them with `sed '$d'` / `tail -n 1`.
execute_concat() {
  local texts_json="$1"
  local separator="$2"
  jq -n \
    --arg projectId "$BENCH_PROJECT_ID" \
    --arg connectionId "$BENCH_CONNECTION_ID" \
    --argjson texts "$texts_json" \
    --arg separator "$separator" \
    '{projectId: $projectId, integration: "@inboxfm-connect/piece-text-helper", tool: "concat", connectionId: $connectionId, input: {texts: $texts, separator: $separator}}' \
    | curl -s -w '\n%{http_code}' --max-time "${EXECUTE_TIMEOUT_SECONDS:-90}" \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $BENCH_API_KEY" \
      --data-binary @- \
      "$BENCH_BASE_URL/v1/execute"
}

find_app_container() {
  local container
  container=$(docker ps --format '{{.Names}}' | grep -E -- '-app-[0-9]+$' | head -n 1)
  if [ -z "$container" ]; then
    echo "FAIL: could not find the app container" >&2
    exit 1
  fi
  echo "$container"
}
