# Hosting and trigger design

## Deployment lifecycle

1. Compile and validate source.
2. Publish immutable version with source hash, IR hash, compiler version and IR version.
3. Deploy selected version into development/staging/production.
4. Reconcile desired trigger registrations with active registrations.
5. Route manual/schedule/webhook events to a durable run queue.
6. Execute the pinned artifact on workers.
7. Inspect status/logs and roll back by deploying a previous immutable version.

Current API supports publish, deploy, manual run enqueue, run inspection and schedule/webhook registration foundations. Rollback, desired-state reconciliation and full trigger lifecycle operations remain.

## Environments

Deployment is scoped to project, flow name and environment. Resolve secrets and integration connections in the selected project/environment at execution time. Promote an artifact hash, not mutable source that is silently recompiled.

## Schedule triggers

Schedule triggers execute flow deployments automatically on recurring cron expressions in a specified IANA timezone. The scheduler guarantees transactional enqueue idempotency under concurrent worker replicas and horizontal scaling.

Implemented scheduling guarantees:
- **Registration validation**: Cron expressions and IANA timezone identifiers are validated upon registration via `POST /v1/flows/:name/triggers`. Malformed cron syntax or unknown timezone identifiers return path-specific HTTP 400 validation errors (`path: "cron"` or `path: "timezone"`).
- **Concurrency & occurrence deduplication**: Enforced durably in PostgreSQL via `flowscript_schedule_occurrences` with a unique constraint on `(trigger_id, scheduled_instant)`. Workers claim due triggers using `FOR UPDATE SKIP LOCKED`, atomically reserve the occurrence instant with `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, enqueue the run, and advance `next_fire_at` within a single transaction. Two or more concurrent worker replicas can never double-enqueue the same scheduled occurrence.
- **Missed-tick recovery policy**: Configurable via `missedTickPolicy` with default `run-once`:
  - `run-once` (default): If workers or the system experience downtime, the trigger fires at most once upon recovery, and `next_fire_at` advances relative to `now()`, preventing a catastrophic cascade or queue flood of historical ticks.
  - `skip`: Omits missed ticks and advances from `now()`.
  - `catch-up`: Step-by-step catches up historical intervals from the missed scheduled instant.
- **Daylight saving (DST) transitions**: Standard IANA timezones (e.g. `America/New_York`) handle spring-forward jumps and fall-back repeated hours monotonically using UTC instants for deduplication keys, preventing infinite loops or duplicate execution.
- **Diagnostics & telemetry**: Scheduled triggers track `dispatch_lag_ms` (time delta between scheduled fire instant and actual dispatch) and `last_error`. Structured JSON telemetry logs `schedule_dispatched` and `schedule_dispatch_failed` events without leaking sensitive data. Triggers with corrupted configurations fail safe, record `last_error`, and automatically disable to prevent crash loops.
- **Lifecycle management**: Scheduled triggers can be paused and resumed (`PATCH /v1/flows/:name/triggers/:id` with `{ enabled: false | true }`), deleted (`DELETE`), and inspected with full lag and health status via `GET /v1/flows/:name/triggers`.

## Webhook triggers

Webhook triggers use a cryptographically high-entropy token (`randomBytes(32)` base64url). At creation, the token is hashed using SHA-256 and stored in `flowscript_triggers.secret_hash`. The raw token is returned once to the caller and never stored in plaintext or logged.

Implemented ingress protections:
- Payload validation: Enforces 1 MB body limits and rejects non-object or malformed JSON payloads with HTTP 400.
- Telemetry & log hygiene: Webhook URL tokens are sanitized in server request logs (`/v1/hooks/[REDACTED]`).
- Generic rejection: Missing, invalid, or revoked/disabled tokens return generic HTTP 404 without disclosing whether the trigger exists.
- Durable idempotency: Supports deduplication via `x-idempotency-key` / `idempotency-key` headers or body event IDs (`event_id`, `idempotency_key`, `id`). Enforced durably in `flowscript_webhook_idempotency` with transactional conflict resolution to eliminate race conditions. Duplicate requests return HTTP 200 (`x-idempotent-replay: true`) with the existing run ID.
- Lifecycle management: Full project-authenticated APIs exist for trigger listing, disabling/enabling (`PATCH`), deletion (`DELETE`), and token rotation (`POST /rotate`).
- Acknowledgement: HTTP 202 is returned only after the run has been durably committed to the database.

Remaining before public internet exposure:
- Edge gateway rate limits and abuse controls.
- Provider-specific signature verification and challenge/handshake protocols.

## Integration event and polling triggers

Reuse existing Connect trigger definitions and trigger-binding infrastructure where semantics fit. Store provider cursors/checkpoints durably. Respect rate limits and connection refresh lifecycle. On reauthorization, reconcile subscriptions and surface failures. Avoid a second trigger registry without a reuse/migration decision.

## Control plane vs data plane

Control plane: compile, publish, deploy, desired trigger state, permissions, environments and version management.

Data plane: webhook ingress, schedule dispatch, queueing, workers, step execution, logs and retry state.

Keep these logical boundaries first. Split into more microservices only when scaling/isolation requirements justify the operational cost.
