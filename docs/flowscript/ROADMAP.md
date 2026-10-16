# FlowScript implementation roadmap

Use each milestone as a team deliverable. Close it with tests, updated docs and a demo; code presence alone is not completion.

## Phase 0: unblock repository CI

- Regenerate and commit bun.lock using Bun 1.3.3 after workspace/dependency changes.
- Run frozen install, service build/test/lint, root CI and Compose validation.
- Fix TypeScript, Docker image and policy failures.
- Add a dedicated FlowScript CI job.

Acceptance: frozen install succeeds; CI executes build/tests; service image builds.

## Phase 1: language/IR hardening

- Decide whether YAML remains v1 syntax; document .flow as YAML until grammar changes are approved.
- Define canonical serialization and stable artifact hash.
- Record compiler version, IR version and source hash.
- Validate inputSchema and type-check references/outputs.
- Resolve integration/action schemas from existing piece metadata.
- Add formatter, init command, fixtures, diagnostic codes and golden tests.

Acceptance: invalid flows fail with stable diagnostics; valid source produces reproducible artifact hash.

## Phase 2: existing runtime integration

- Inspect exact HeadlessRuntime, API execution service, connection resolver and worker job contracts.
- Define a typed integration adapter with project/platform/connection scope, metadata validation, idempotency and run/step context.
- Execute through existing runtime/engine/sandbox; do not instantiate a guessed duplicate runtime.
- Persist step start/success/failure and attempt history.
- Add redaction and input/output limits.

Acceptance: test flow invokes a real test integration through existing runtime without credentials in source/artifacts/logs.

## Phase 3: durable orchestration

- Move CREATE TABLE IF NOT EXISTS into versioned migrations.
- Evaluate existing Connect queue abstractions against the current Postgres polling queue.
- Add leases/visibility timeout, stale-running recovery, bounded retries, dead-lettering and cancellation.
- Add dedupe keys for manual requests, webhook event IDs and scheduled instants.
- Add worker concurrency and backpressure.

Acceptance: concurrent workers do not double-claim; restart/retry tests prove safe behavior; side-effect semantics documented.

## Phase 4: triggers and deployment reconciliation

- Add trigger list/get/pause/resume/delete/rotate APIs.
- Validate cron/timezone and define missed-tick/DST policy.
- Add webhook signature verification/challenge handling, payload limits, rate limits and replay prevention.
- Integrate existing Connect trigger-binding and scheduled-task services where semantics fit.
- Add polling cursors/checkpoints and event subscription lifecycle.
- Add a reconciler for desired vs actual trigger registrations.

Acceptance: schedules/webhooks survive restart and replica scaling; duplicate delivery is idempotent; disabled trigger cannot enqueue.

## Phase 5: secure platform APIs

- Authenticate callers through existing gateway/session/service identity.
- Strip untrusted x-project-id and inject verified project identity.
- Enforce membership, environment/connection permissions, quotas and audit logs.
- Standardize errors and request IDs.
- Add per-project rate/concurrency limits and retention.

Acceptance: cross-project tests pass; unauthenticated requests fail; service is not exposed without gateway controls.

## Phase 6: developer and operations UX

- Finish CLI: init, fmt, lint, test, run, publish, deploy, rollback, triggers, runs and logs.
- Add local mocked adapter using same IR contract as hosted workers.
- Add dashboard operations for deployments, triggers, run timeline, logs and failed-run replay.
- Add metrics/traces for queue lag, trigger lag, run latency, error rates and usage.

Acceptance: developer can build, test, deploy, inspect and roll back from CLI; operator can diagnose failures.

## Phase 7: production rollout

- Load test queue, Postgres and worker throughput.
- Add quotas, usage model, retention and incident runbooks.
- Roll out internally, then limited beta behind feature flag.
- Define SLOs and alerts.

Acceptance: documented capacity, recovery, security review and rollback plan.

## Definition of done

- Frozen lockfile CI green.
- Integration action executes through existing runtime.
- Project isolation and secret handling tests pass.
- Durable schedule/webhook and worker recovery tests pass.
- Migration/rollback strategy exists.
- Operators can inspect every run and diagnose failures.
- No unsupported capability is described as complete.
