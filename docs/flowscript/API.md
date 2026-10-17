# FlowScript HTTP API

Base URL: internal service network, port 8081. These endpoints are not safe to expose publicly without gateway authentication, authorization, rate limits and request limits.

## Health

- GET /health: process liveness and advertised capabilities.
- GET /ready: currently reports readiness without proving DB/schema health. Improve before production.

## Compile and validate

### POST /v1/source/compile

Request is a JSON object with a source string. Returns valid=true, hash, IR and diagnostics, or HTTP 422 with path-addressed diagnostics. Source limit is 1 MB.

### POST /v1/ir/validate

Accepts IR JSON and returns a validated representation. Use for internal tooling only; publishing should compile source server-side.

### POST /v1/ir/execute-local

Runs pure flows synchronously for development. Integration steps return HTTP 501 until the trusted adapter exists. Do not use for production long-running work.

## Publish and deploy

Project-scoped routes require verified project identity. Callers must provide either an HMAC-SHA256 signature (`x-project-signature: <sig>` matching `x-project-id`) or a signed Bearer token (`Authorization: Bearer <projectId>.<signature>`) authenticated against `FLOWSCRIPT_GATEWAY_SECRET` / `FLOWSCRIPT_AUTH_SECRET`. Unsigned or forged requests are rejected with HTTP 401.

### POST /v1/flows/publish

Request: JSON with source. Compiles and persists an immutable version. Response includes ID, project, flow name, version and hash.

### POST /v1/flows/:name/deploy

Request: versionId UUID and optional environment (defaults to production). Activates the chosen version for that flow/environment.

### POST /v1/flows/:name/run

Request: input object and optional environment. Resolves active deployment, persists a queued run and returns HTTP 202 with run ID. Integration-bearing flows are refused until the trusted adapter is wired.

## Triggers

Project-scoped trigger management routes require verified project identity (HMAC signature or Bearer token).

### POST /v1/flows/:name/triggers

Schedule request includes kind=schedule, cron, timezone and optional environment. Webhook request includes kind=webhook and optional environment. Webhook creation returns a secret token once; store securely and never log it. The raw token is hashed with SHA-256 and only the hash is persisted.

### GET /v1/flows/:name/triggers

Returns active and disabled triggers configured for this flow in the project. Secret hashes are omitted from the response.

### PATCH /v1/flows/:name/triggers/:triggerId

Enables or disables an existing trigger (`{ enabled: boolean }`). Disabling a webhook trigger causes ingress requests to return generic HTTP 404 immediately.

### DELETE /v1/flows/:name/triggers/:triggerId

Permanently deletes the trigger and cascades removal of associated idempotency records. Returns HTTP 204.

### POST /v1/flows/:name/triggers/:triggerId/rotate

Rotates the webhook secret token. Generates a new cryptographically secure token, updates the persisted SHA-256 hash, immediately invalidates the previous token, and returns the new token and URL once.

### POST /v1/hooks/:token

Ingress endpoint for registered webhook triggers.
- Accepts JSON object payloads up to 1 MB. Malformed or non-object bodies return HTTP 400.
- URL tokens are sanitized in server logs (`/v1/hooks/[REDACTED]`).
- Unknown, disabled, or undeployed webhook tokens return a generic HTTP 404 (`{ error: 'Webhook endpoint not found' }`) without disclosing whether the trigger exists.
- Supports durable idempotency via `x-idempotency-key` or `idempotency-key` header, or body fields `idempotency_key`, `event_id`, or `id`. Duplicate deliveries return HTTP 200 with `x-idempotent-replay: true` header without creating duplicate runs.
- Returns HTTP 202 (`{ accepted: true, runId: <uuid>, status: 'queued' }`) on initial enqueue. Public exposure requires gateway rate limits and provider verification.

## Run inspection

- GET /v1/runs?flow=<name>&limit=50
- GET /v1/runs/:id

Project ID is used in queries. Add cursor pagination before run history grows significantly.

## Error handling

Current behavior uses 400 for malformed requests, 401 for missing trusted identity, 404 for missing deployment/run/webhook, 422 for compile/deploy/flow errors, 501 for unsupported integration execution and 202 for queued runs. Standardize an error envelope with stable code, request ID, details and retryability before production.
