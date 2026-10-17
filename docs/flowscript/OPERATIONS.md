# FlowScript operations runbook

## Health checks

- GET /health checks process liveness.
- GET /ready currently reports readiness without proving DB/schema health. Improve before production.
- Worker health is currently inferred from container logs and queued/running run age. Add explicit health/heartbeat metrics.

## Local Compose

    docker compose config
    docker compose build flowscript flowscript-worker
    docker compose up -d postgres flowscript flowscript-worker
    docker compose logs -f flowscript-worker
    docker compose logs -f flowscript

The API uses expose on port 8081. Do not add a public port mapping without gateway authentication and request controls.

## Troubleshooting

### Frozen lockfile install fails

Cause: workspace/dependency changes are not reflected in bun.lock.

Fix: use Bun 1.3.3, run bun install without frozen mode in a clean checkout, inspect the lockfile diff, commit it, then verify bun install --frozen-lockfile. Do not delete the lockfile or weaken CI.

### API cannot connect to Postgres

Check Compose service DNS (postgres), AP_POSTGRES_* variables, credentials and Postgres health. Avoid logging connection strings. Verify the DB user has only required schema permissions.

### Run remains queued

Check worker health/logs, DB connectivity, queue claim errors and locks. Inspect oldest queued timestamp. Production needs queue-lag alerts and stuck-job recovery.

### Run remains running

The prototype does not fully recover stale running rows. Do not reset production rows until side-effect outcome and idempotency are understood. Add leases/heartbeat and recovery before production.

### Schedule did not fire

1. Query `GET /v1/flows/:name/triggers` to check trigger state: inspect `enabled`, `nextFireAt`, `lastFiredAt`, `dispatchLagMs`, and `lastError`.
2. If `lastError` is populated, the trigger was automatically paused due to a runtime parse or calculation error; review the error message and re-register or patch the trigger.
3. Check worker container logs for structured telemetry: search for `schedule_dispatched` (contains `triggerId`, `lagMs`, `nextFireAt`, `runId`) or `schedule_dispatch_failed`.
4. Inspect `flowscript_schedule_occurrences` table to verify whether a particular scheduled instant was already claimed by another worker replica.
5. Review `missedTickPolicy` (`run-once`, `skip`, or `catch-up`): note that under `run-once` (default), downtime will advance to the next scheduled fire time relative to current time rather than queueing past occurrences.

### Webhook returns 404

Token may be wrong, trigger disabled or deployment missing. Tokens are bearer secrets; never paste them into issues or logs.

### Integration step fails

The trusted existing-runtime adapter is not implemented. The service intentionally refuses integration execution. Do not bypass this guard or execute arbitrary code to make a demo appear functional.

## Incident response

1. Disable affected deployment/trigger once controls exist; otherwise block ingress at gateway.
2. Preserve run IDs, request IDs and redacted worker logs.
3. Determine whether a provider side effect occurred before retrying.
4. Avoid blind replay for non-idempotent actions.
5. Restore previous immutable deployment version if a release caused the incident.
6. Add regression tests and record a postmortem.
