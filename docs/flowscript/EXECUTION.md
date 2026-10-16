# FlowScript execution lifecycle

## Current hosted manual path

1. Caller requests a manual run.
2. API resolves active deployment for project, flow and environment.
3. API refuses integration steps until a trusted Connect runtime adapter exists.
4. API creates a queued run row and returns 202 with a run ID.
5. Worker claims a queued row with a transaction and FOR UPDATE SKIP LOCKED.
6. Worker changes status to running and executes supported pure steps.
7. Worker persists output, step results, status and completion timestamp.
8. Caller inspects the run through run query endpoints.

## Status model

Persisted statuses are queued, running, succeeded, failed and cancelled. Complete cancellation and retry attempt history are not yet implemented. Production should add step attempt records, attempt number, retry decision, timestamps, structured error code, redacted details and correlation ID.

## Step execution

- Steps are evaluated in declared order.
- Every dependency must already be completed.
- Config values resolve from explicit references.
- Transform and filter behavior is deliberately limited.
- Integration steps must use a trusted adapter mapping declarations to existing Connect piece metadata and runtime execution.
- Timeouts do not necessarily cancel underlying side effects. Propagate cancellation only where the executor supports it.

## Proposed integration adapter contract

    interface FlowIntegrationExecutor {
      execute(input: {
        projectId: string
        platformId: string
        integrationName: string
        actionName: string
        connectionId: string
        input: Record<string, unknown>
        runId: string
        stepId: string
        idempotencyKey: string
      }): Promise<unknown>
    }

This is a proposed boundary, not an existing exported interface. Before implementing, inspect the exact HeadlessRuntime constructor, API execution service, worker job contracts and connection lookup contracts. Avoid instantiating a second runtime with guessed configuration.

The adapter must validate integration/action metadata, verify connection ownership, use existing connection resolver/runtime, reject raw credentials, validate action inputs, enforce limits, redact secrets, classify provider errors and pass idempotency keys where supported.

## Failure semantics

- Validation/configuration errors: do not retry until configuration changes.
- Authentication/permission errors: surface actionable error; avoid rapid retries.
- Rate limits/transient errors: bounded exponential backoff with jitter and Retry-After support.
- Ambiguous external side effects: mark outcome uncertain when appropriate; do not blindly repeat non-idempotent operations.
- Worker crash: recover stale leases only with an explicit idempotency policy.

## Required production work

Durable queue/lease semantics, stale-running recovery, step attempt records, bounded retries, dead-letter queue, cancellation, input/output limits, redaction, idempotency keys, safe replay, per-project concurrency limits and trace IDs across API/worker/runtime.
