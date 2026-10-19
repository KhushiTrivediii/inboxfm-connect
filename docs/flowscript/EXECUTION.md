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

Persisted statuses are `queued`, `running`, `succeeded`, `failed`, `cancelled`, `dead_letter`, and `uncertain`.
- `queued`: Enqueued and waiting to be claimed by an available worker. Supports deduplication via client `idempotency-key`.
- `running`: Actively claimed by a worker holding a renewable lease (`worker_id`, `lease_expires_at`).
- `succeeded`: All steps completed successfully.
- `failed`: Terminal failure due to non-retryable validation, authentication, or unrecoverable error, or retryable attempts exhausted during runtime execution.
- `cancelled`: Explicitly cancelled before or during execution via API (`POST /v1/runs/:id/cancel`). Workers propagate cancellation to in-flight jobs via active `AbortController` / `AbortSignal`.
- `dead_letter`: Stale lease recovery quarantine for runs whose maximum retry attempts are exhausted or which were abandoned repeatedly. Safe for operator triage without automated loop churn.
- `uncertain`: A worker crashed or lost its lease after initiating or executing a non-idempotent integration step (without an idempotency key). Stale recovery deliberately quarantines the run as `uncertain` to prevent duplicate side effects (e.g. duplicate payment or email delivery).

## Step execution & durable attempt tracking

- Steps are evaluated in declared topological order with full dependency validation.
- Every step attempt is recorded in `flowscript_step_attempts` with `attempt`, `status` (`running`, `succeeded`, `failed`, `skipped`), `started_at`, `finished_at`, `duration_ms`, structured `error_code`, and sanitized/redacted `error_message`.
- Step attempts history is queryable via `GET /v1/runs/:id/attempts`.
- Timeouts and cancellations propagate via standard `AbortSignal`. Worker heartbeat monitors run status; if cancellation or lease loss is detected, the run aborts immediately.

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


## Failure semantics & retry policy

- **Validation / Configuration errors**: fail immediately (`failed`). No retries are scheduled.
- **Authentication / Permission errors**: (`AUTHENTICATION_EXPIRED`, `CONNECTION_NOT_FOUND`) fail fast without retry, preserving third-party rate budgets and preventing account lockouts.
- **Rate limits / Transient network timeouts**: (`RATE_LIMITED`, `PROVIDER_ERROR`, `TIMEOUT`) retried up to `maxStepAttempts` (default 3) using exponential backoff with jitter bounded strictly by `maxDelay`:
  $$\text{delay} = \min(\text{maxDelay}, \lfloor \text{baseDelay} \times 2^{\text{attempt} - 1} \times (0.8 + 0.4 \times \text{random}()) \rfloor)$$
- **Non-idempotent side effects & crash recovery**: If a step lacks an idempotency key and worker crash or lease expiry occurs, the run transitions to `uncertain` with an operator diagnostic: `worker lease expired after non-idempotent step execution`. Blind replay is strictly prohibited.
- **Dead-letter quarantine**: Runs that fail due to retry exhaustion transition to `dead_letter`, alerting on-call operators without infinite polling.
- **Safe replay & deduplication**: Calls with `x-idempotent-replay: true` and a matching `Idempotency-Key` return the existing run with HTTP 200 without enqueuing duplicate execution.
