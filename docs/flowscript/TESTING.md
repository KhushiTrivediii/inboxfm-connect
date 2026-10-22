# FlowScript testing strategy

## Local checks

    bun install --frozen-lockfile
    bun run --cwd services/flowscript build
    bun run --cwd services/flowscript typecheck
    bun run --cwd services/flowscript lint
    bun run --cwd services/flowscript test-unit
    docker compose config

To run Postgres-backed integration tests locally:

    docker compose up -d postgres
    FLOWSCRIPT_POSTGRES_URL=postgres://postgres:postgres@localhost:5432/flowscript_test bun run --cwd services/flowscript test-integration

The root workspace lockfile must be current before frozen CI can run.

## Unit tests

Compiler (`compiler.test.ts`):
- Valid source compiles to IR v1 with pinned metadata.
- Canonical JSON artifact hash is deterministic regardless of key order.
- Malformed YAML, aliases, and duplicate keys return diagnostics.
- Invalid schema, duplicate IDs, unknown dependencies, self-reference, forward reference, and dependency cycles are rejected.
- Unsupported trigger/step/IR versions fail closed.
- Limits prevent oversized source and excessive step count.

Runtime (`runtime.test.ts`, `adapter.test.ts`):
- Input/trigger/step/env references resolve correctly.
- Missing references or environment variables fail with actionable errors.
- Integration steps strictly refuse execution without a trusted Connect adapter.
- Connect runtime executor validates piece metadata, credentials, and action schemas.
- Provider errors are sanitized and classified (rate limits, timeouts, auth expired).
- Secret fields (`auth`, `token`, `password`, `apiKey`) are recursively redacted from outputs and error messages.
- Timeouts clear timers and dependencies execute in topological DAG order.
- Failed steps stop downstream execution while preserving completed step history.

Store, Webhook, Schedule & Tenant Boundaries:
- `webhook.test.ts`: Webhook tokens are returned once, SHA-256 hashed at rest, sanitized in logs (`/v1/hooks/[REDACTED]`), and revoked when triggers are disabled or deleted. Supports durable idempotency keys and event IDs.
- `schedule.test.ts`: Scheduled trigger validation (cron syntax, IANA timezone, missedTickPolicy: run-once, skip, catch-up). Atomic occurrence deduplication in `flowscript_schedule_occurrences` prevents double-dispatch under concurrent workers. Monotonic UTC instants handle DST transitions safely.
- `retries_and_cancellation.test.ts`: Exponential backoff with capped jitter. Worker lease heartbeat monitoring with automatic cancellation propagation (`AbortSignal`). Stale worker crash recovery with `uncertain` quarantine for non-idempotent steps without idempotency keys. Run cancellation API (`POST /v1/runs/:id/cancel`) and attempt history inspection (`GET /v1/runs/:id/attempts`).
- `tenant_isolation.test.ts`: Cryptographic HMAC signatures and signed Bearer tokens against `FLOWSCRIPT_GATEWAY_SECRET` / `FLOWSCRIPT_AUTH_SECRET`. Edge header stripping via `stripUntrustedProjectHeaders`. Strict project isolation for versions, deployments, triggers, and runs. Flow name verification on deploy. Global 1MB payload limits and `x-request-id` correlation.

## Integration tests (`src/e2e_lifecycle.integration.test.ts`)

Executes against an isolated PostgreSQL database:
1. **Full Lifecycle**: Source YAML publish -> environment deploy -> manual run enqueue -> worker lease claim (`FOR UPDATE SKIP LOCKED`) -> FlowIR execution -> result persistence (`finishRun`) -> API run & attempts inspection.
2. **Cross-Project Isolation**: Proves Project B cannot deploy Project A's version, read Project A's run, list Project A's runs, cancel Project A's run, or manage Project A's triggers in the real database.
3. **Worker Concurrency & Lease Recovery**: Proves concurrent workers never double-claim queued runs, and verifies that runs abandoned by crashed workers whose leases expire are safely recovered by active workers.
4. **Webhook Security & Deduplication**: Proves raw tokens are never written to database tables in plaintext, and verifies that repeated deliveries with identical idempotency keys return HTTP 200 replay headers without duplicating execution.
5. **Schedule Concurrency**: Proves concurrent workers polling due schedules execute atomically via `flowscript_schedule_occurrences`.

## CI pipeline

The dedicated `flowscript` job runs in `.github/workflows/ci.yml`:
- Uses the repository-pinned Bun version (`1.3.3`) via `.github/actions/setup-ci`.
- Executes frozen dependency installation (`bun install --frozen-lockfile`).
- Spins up a real PostgreSQL 16 container (`postgres:16-alpine`) with automated health checks.
- Runs service build (`tsc -p tsconfig.json`), ESLint, TypeScript typecheck (`tsc --noEmit`), and in-memory unit tests (`test-unit`).
- Validates Docker Compose service topology (`docker compose -f docker-compose.yml config -q`).
- Executes Postgres-backed end-to-end integration tests (`test-integration`). Fails closed in CI if PostgreSQL is unavailable.
- Automatically captures and uploads diagnostics (`flowscript-unit.log`, `flowscript-e2e.log`) upon failure with a 7-day retention period.
- Gates the top-level `main` CI aggregator job before any promotion or merge.
