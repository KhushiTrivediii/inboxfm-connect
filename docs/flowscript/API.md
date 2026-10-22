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

- **Schedule trigger**: `{ kind: "schedule", cron: string, timezone?: string, missedTickPolicy?: "run-once" | "skip" | "catch-up", environment?: string }`.
  - Cron syntax and IANA timezone identifiers are strictly validated; invalid syntax returns HTTP 400 with `path: "cron"` or `path: "timezone"`.
  - `missedTickPolicy` defaults to `"run-once"`, preventing runaway tick cascades following worker downtime.
- **Webhook trigger**: `{ kind: "webhook", environment?: string }`.
  - Returns a high-entropy secret token once (`{ id, kind, flowName, token, webhookUrl }`); store securely and never log it. The raw token is hashed with SHA-256 and only the hash is persisted.

### GET /v1/flows/:name/triggers

Returns active and disabled triggers configured for this flow in the project. Includes `enabled`, `nextFireAt`, `lastFiredAt`, `dispatchLagMs`, `lastError`, and `config`. Secret hashes and raw tokens are omitted from the response.

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

## Request IDs and trace correlation
- Every request accepts an optional `x-request-id` header from the client or edge gateway.
- If omitted, the service generates a standard UUIDv4 request ID.
- The `x-request-id` is returned on every HTTP response header and embedded inside all error responses as `requestId`.

## Global request limits
- Request body size is capped at 1 MB (1,048,576 bytes) across all endpoints.
- Payloads exceeding this limit receive an HTTP 413 response with `code: 'PAYLOAD_TOO_LARGE'`.

## Error handling

All error responses return a standardized JSON error envelope:

```json
{
  "statusCode": 400,
  "code": "BAD_REQUEST",
  "error": "Detailed error message",
  "message": "Detailed error message",
  "requestId": "92f767a4-3a98-4c8d-8fd6-218080f558e8",
  "issues": [...]
}
```

### Standardized error codes:
- `400 BAD_REQUEST`: Malformed request syntax or invalid Zod parameters.
- `400 FLOW_NAME_MISMATCH`: Deploying a version where the version's internal flow name does not match the URL `:name`.
- `401 UNAUTHORIZED`: Missing or invalid gateway signature / bearer token.
- `401 UNVERIFIED_PROJECT_IDENTITY`: `x-project-id` present without HMAC signature.
- `401 INVALID_PROJECT_SIGNATURE`: HMAC signature does not match project ID.
- `401 FORGED_PROJECT_HEADER`: Bearer token project does not match `x-project-id` header.
- `401 INVALID_PROJECT_ID_FORMAT`: Project ID does not match `/^[a-zA-Z0-9_-]{1,128}$/`.
- `401 GATEWAY_SECRET_MISSING`: Gateway secret environment variable is not configured.
- `404 NOT_FOUND`: Resource not found.
- `404 DEPLOYMENT_NOT_FOUND`: Active deployment does not exist for the specified flow and environment.
- `404 VERSION_NOT_FOUND`: Flow version does not exist in the caller's project.
- `404 TRIGGER_NOT_FOUND`: Flow trigger does not exist in the caller's project.
- `404 RUN_NOT_FOUND`: Run does not exist in the caller's project.
- `413 PAYLOAD_TOO_LARGE`: Request body exceeded 1 MB limit.
- `422 UNPROCESSABLE_ENTITY`: Semantic or execution error (e.g., compile errors, trigger creation failure, deployment failure).
- `501 NOT_IMPLEMENTED`: Operation is not implemented for the target trigger kind or configuration.
- `500 INTERNAL_SERVER_ERROR`: Unhandled internal exception.
