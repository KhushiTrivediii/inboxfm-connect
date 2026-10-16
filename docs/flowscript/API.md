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

Project-scoped routes require x-project-id. It must be injected by a trusted gateway after authenticating the caller; caller-controlled headers are not authentication.

### POST /v1/flows/publish

Request: JSON with source. Compiles and persists an immutable version. Response includes ID, project, flow name, version and hash.

### POST /v1/flows/:name/deploy

Request: versionId UUID and optional environment (defaults to production). Activates the chosen version for that flow/environment.

### POST /v1/flows/:name/run

Request: input object and optional environment. Resolves active deployment, persists a queued run and returns HTTP 202 with run ID. Integration-bearing flows are refused until the trusted adapter is wired.

## Triggers

### POST /v1/flows/:name/triggers

Schedule request includes kind=schedule, cron, timezone and optional environment. Webhook request includes kind=webhook and optional environment. Webhook creation returns a secret token once; store securely and never log it. Provider signature verification is not implemented.

### POST /v1/hooks/:token

Accepts JSON payload and queues a run for the registered webhook trigger. Public exposure requires gateway controls and provider verification.

## Run inspection

- GET /v1/runs?flow=<name>&limit=50
- GET /v1/runs/:id

Project ID is used in queries. Add cursor pagination before run history grows significantly.

## Error handling

Current behavior uses 400 for malformed requests, 401 for missing trusted identity, 404 for missing deployment/run/webhook, 422 for compile/deploy/flow errors, 501 for unsupported integration execution and 202 for queued runs. Standardize an error envelope with stable code, request ID, details and retryability before production.
