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

Current code creates a high-entropy token, stores its SHA-256 hash and returns a token URL at registration. Incoming JSON is accepted and enqueued by token. This is a foundation, not a complete provider webhook implementation.

Before public exposure:
- Add payload size limits, timeouts, rate limits and abuse controls.
- Implement provider signature verification and challenge/handshake protocols.
- Add idempotency by provider event ID and replay protection.
- Avoid logging tokens or request bodies.
- Add token rotation/revocation and trigger disable operations.
- Use constant-time token comparison if comparing secret values in application code.
- Acknowledge only after durable enqueue.
- Keep ingress separate from long-running execution.

## Integration event and polling triggers

Reuse existing Connect trigger definitions and trigger-binding infrastructure where semantics fit. Store provider cursors/checkpoints durably. Respect rate limits and connection refresh lifecycle. On reauthorization, reconcile subscriptions and surface failures. Avoid a second trigger registry without a reuse/migration decision.

## Control plane vs data plane

Control plane: compile, publish, deploy, desired trigger state, permissions, environments and version management.

Data plane: webhook ingress, schedule dispatch, queueing, workers, step execution, logs and retry state.

Keep these logical boundaries first. Split into more microservices only when scaling/isolation requirements justify the operational cost.
