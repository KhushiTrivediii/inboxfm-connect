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

Current registration stores cron, timezone and next-fire time. Worker dispatch checks due triggers and enqueues runs. Before production:
- Validate cron/timezone at registration and return actionable diagnostics.
- Define missed-tick policy: skip, run-once or bounded catch-up.
- Add deterministic dedupe key per trigger and scheduled instant.
- Ensure multiple worker replicas cannot dispatch one tick twice.
- Test DST transitions and timezone changes.
- Add pause/resume/delete and next-run visibility.
- Handle invalid stored cron safely and surface trigger health.

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
