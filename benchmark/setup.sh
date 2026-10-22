#!/usr/bin/env bash
set -euo pipefail

# Provisions a fresh stack for the headless Connect API smoke tests and benchmarks:
# a bench user/project, a Text Helper (no-auth) connection, and a project-scoped Connect
# API key. Prints KEY=VALUE lines on stdout (logs go to stderr) using the same BENCH_*
# names benchmark/gate/scenarios.mjs reads, so the output can be appended to $GITHUB_ENV
# or `eval`-ed locally:
#
#   set -a; eval "$(benchmark/setup.sh)"; set +a
#
# BASE_URL is the API root including /api (the same value the Connect SDK takes as baseUrl).

BASE_URL="${BASE_URL:-http://localhost:8080/api}"
API="$BASE_URL/v1"
MAX_RETRIES=60
RETRY_INTERVAL=5
TEXT_HELPER_PIECE="@inboxfm-connect/piece-text-helper"

echo "Waiting for app to be ready..." >&2
for i in $(seq 1 $MAX_RETRIES); do
  if curl -sf "$API/flags" > /dev/null 2>&1; then
    echo "App is ready after $((i * RETRY_INTERVAL))s" >&2
    break
  fi
  if [ "$i" -eq "$MAX_RETRIES" ]; then
    echo "ERROR: App did not become ready in time" >&2
    exit 1
  fi
  sleep $RETRY_INTERVAL
done

echo "Authenticating..." >&2
BENCH_EMAIL="${BENCH_EMAIL:-bench@inboxfm-connect.com}"
BENCH_PASSWORD="${BENCH_PASSWORD:-BenchmarkPass1}"
# Try sign-up (first run creates the platform). On repeat runs public sign-up is disabled once a
# platform exists, so fall back to sign-in with the same fixed credentials. No --fail-with-body here:
# under `set -e` a rejected sign-up would abort the script before we can fall back.
SIGNUP_RESPONSE=$(curl -s "$API/authentication/sign-up" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg email "$BENCH_EMAIL" --arg password "$BENCH_PASSWORD" \
    '{email: $email, password: $password, firstName: "Bench", lastName: "Mark", trackEvents: false, newsLetter: false}')")
TOKEN=$(echo "$SIGNUP_RESPONSE" | jq -r '.token // empty')
PROJECT_ID=$(echo "$SIGNUP_RESPONSE" | jq -r '.projectId // empty')

if [ -z "$TOKEN" ]; then
  echo "Sign-up unavailable (platform exists); signing in..." >&2
  SIGNIN_RESPONSE=$(curl -s "$API/authentication/sign-in" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg email "$BENCH_EMAIL" --arg password "$BENCH_PASSWORD" '{email: $email, password: $password}')")
  TOKEN=$(echo "$SIGNIN_RESPONSE" | jq -r '.token // empty')
  PROJECT_ID=$(echo "$SIGNIN_RESPONSE" | jq -r '.projectId // empty')
fi

if [ -z "$TOKEN" ]; then
  echo "ERROR: could not authenticate (sign-up and sign-in both failed)" >&2
  echo "$SIGNUP_RESPONSE" >&2
  exit 1
fi

# Cloud edition returns an ONBOARDING token with projectId=null.
# Complete onboarding by creating a platform + project, which returns a fresh USER token.
if [ "$PROJECT_ID" = "null" ] || [ -z "$PROJECT_ID" ]; then
  echo "Completing onboarding (creating platform + project)..." >&2
  PLATFORM_RESPONSE=$(curl -s "$API/platforms" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"name":"Benchmark"}')
  TOKEN=$(echo "$PLATFORM_RESPONSE" | jq -r '.token // empty')
  PROJECT_ID=$(echo "$PLATFORM_RESPONSE" | jq -r '.projectId // empty')
  if [ -z "$TOKEN" ] || [ -z "$PROJECT_ID" ]; then
    echo "ERROR: Failed to complete onboarding" >&2
    echo "$PLATFORM_RESPONSE" >&2
    exit 1
  fi
fi
echo "Authenticated. Project: $PROJECT_ID" >&2

AUTH="Authorization: Bearer $TOKEN"

# The piece catalog is seeded asynchronously on boot, and creating a connection needs the
# piece's metadata to resolve its latest version.
echo "Waiting for $TEXT_HELPER_PIECE to be in the catalog..." >&2
for i in $(seq 1 300); do
  HAS_PIECE=$(curl -sf "$API/integrations" -H "$AUTH" 2>/dev/null \
    | jq --arg name "$TEXT_HELPER_PIECE" '[.[].name] | any(. == $name)' 2>/dev/null || echo "false")
  if [ "$HAS_PIECE" = "true" ]; then
    echo "$TEXT_HELPER_PIECE is available (took ${i}s)" >&2
    break
  fi
  if [ "$i" -eq 300 ]; then
    echo "ERROR: $TEXT_HELPER_PIECE not available after 300s" >&2
    exit 1
  fi
  sleep 1
done

# Upsert keyed on externalId, so re-running against the same stack reuses the connection.
echo "Creating Text Helper connection..." >&2
CONNECTION_RESPONSE=$(curl -s "$API/connections" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "$(jq -n --arg projectId "$PROJECT_ID" --arg pieceName "$TEXT_HELPER_PIECE" '{
    projectId: $projectId,
    externalId: "bench-text-helper",
    displayName: "Bench Text Helper",
    pieceName: $pieceName,
    type: "NO_AUTH",
    value: { type: "NO_AUTH" }
  }')")
CONNECTION_ID=$(echo "$CONNECTION_RESPONSE" | jq -r '.id // empty')
if [ -z "$CONNECTION_ID" ]; then
  echo "ERROR: Failed to create Text Helper connection" >&2
  echo "$CONNECTION_RESPONSE" >&2
  exit 1
fi
echo "Connection: $CONNECTION_ID" >&2

# Callers of the headless API authenticate with a Connect API key, not a user session,
# so the smoke tests and benchmarks exercise that path.
echo "Creating Connect API key..." >&2
API_KEY_RESPONSE=$(curl -s "$API/connect-api-keys" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "$(jq -n --arg projectId "$PROJECT_ID" '{projectId: $projectId, displayName: "Bench"}')")
API_KEY=$(echo "$API_KEY_RESPONSE" | jq -r '.value // empty')
if [ -z "$API_KEY" ]; then
  echo "ERROR: Failed to create Connect API key" >&2
  echo "$API_KEY_RESPONSE" >&2
  exit 1
fi

echo "Setup complete." >&2

echo "BENCH_BASE_URL=$BASE_URL"
echo "BENCH_PROJECT_ID=$PROJECT_ID"
echo "BENCH_CONNECTION_ID=$CONNECTION_ID"
echo "BENCH_API_KEY=$API_KEY"
