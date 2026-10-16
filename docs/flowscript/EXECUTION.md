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

## Connect integration adapter contract

The FlowScript service integrates with existing Connect piece actions through `ConnectFlowIntegrationExecutor` implementing `FlowIntegrationExecutor` (`services/flowscript/src/adapter.ts`):

```typescript
export interface FlowIntegrationExecutor {
  execute(input: {
    projectId: string
    platformId: string
    integrationName: string
    actionName: string
    connectionId: string
    input: Record<string, unknown>
    runId: string
    stepId: string
    idempotencyKey?: string
  }): Promise<unknown>
}
```

### Execution pipeline & security checks:

1. **Parameter presence check**: Requires `projectId`, `platformId`, `integrationName`, `actionName`, and `connectionId`.
2. **Credential isolation**: Strictly forbids raw credential keys in step input (`auth`, `apiKey`, `accessToken`, `token`, `secret`, `password`, `credentials`). All authentication must resolve via a managed connection.
3. **Pre-flight metadata verification**: Validates that `integrationName` exists in installed piece metadata and that `actionName` is declared in its actions map.
4. **Connection authorization & scoping**: Checks connection ownership by matching `connectionId`, `platformId`, `pieceName`, and `projectId`. Rejects missing or cross-project connection access with `CONNECTION_NOT_FOUND`.
5. **Action input schema validation**: Asserts that required properties declared in piece action props are provided.
6. **Sandboxed runtime execution**: Dispatches to Connect's existing `HeadlessRuntime.execute` using `EngineOperationType.EXECUTE_TOOL`.
7. **Secret redaction**: Recursively redacts sensitive keys (`token`, `secret`, `password`, `credential`, `apiKey`, `auth`, `bearer`, etc.) from step outputs, logs, and error messages (`redactSensitiveData`).
8. **Provider error classification**: Maps provider and runtime exceptions into structured error classes (`FlowIntegrationError`):
   - `RATE_LIMITED` (HTTP 429, retryable: true)
   - `AUTHENTICATION_EXPIRED` (HTTP 401/403, retryable: false)
   - `PROVIDER_ERROR` (HTTP 502/503/504, retryable: true)
   - `TIMEOUT` (HTTP 408/ETIMEDOUT, retryable: true)
   - `CONNECTION_NOT_FOUND` (HTTP 404/entity_not_found, retryable: false)
   - `ENGINE_OPERATION_FAILURE` (default/unclassified, retryable: false)


## Failure semantics

- Validation/configuration errors: do not retry until configuration changes.
- Authentication/permission errors: surface actionable error; avoid rapid retries.
- Rate limits/transient errors: bounded exponential backoff with jitter and Retry-After support.
- Ambiguous external side effects: mark outcome uncertain when appropriate; do not blindly repeat non-idempotent operations.
- Worker crash: recover stale leases only with an explicit idempotency policy.

## Required production work

Durable queue/lease semantics, stale-running recovery, step attempt records, bounded retries, dead-letter queue, cancellation, input/output limits, redaction, idempotency keys, safe replay, per-project concurrency limits and trace IDs across API/worker/runtime.
