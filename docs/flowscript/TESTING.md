# FlowScript testing strategy

## Local checks

    bun install
    bun run --cwd services/flowscript build
    bun run --cwd services/flowscript test
    bun run --cwd services/flowscript lint
    docker compose config
    docker compose build flowscript flowscript-worker

The root workspace lockfile must be current before frozen CI can run.

## Unit tests

Compiler:
- Valid source compiles to IR v1.
- Hash is stable for normalized source.
- Malformed YAML and duplicate keys return diagnostics.
- Invalid schema, duplicate IDs, unknown dependencies, self-reference and cycles are rejected.
- Unsupported trigger/step/IR versions fail closed.
- Limits prevent oversized source and excessive step count.

Runtime:
- Input/trigger/step/env references resolve correctly.
- Missing references/env variables fail with actionable errors.
- Integration steps refuse execution without trusted adapter.
- Timeouts clear timers and classify failures.
- Dependencies execute in valid order.
- Failed steps stop downstream execution.
- Sensitive fields are redacted.

Store/API:
- Publish creates immutable versions and rejects invalid source.
- Project A cannot access Project B artifacts.
- Deploy only accepts versions in the same project.
- Manual run persists before acknowledging.
- Concurrent workers do not double-claim jobs.
- Schedule registration validates cron/timezone.
- Webhook token is returned once, hashed at rest and revocable.
- Run queries are paginated and project-scoped.

## Integration tests

Use isolated Postgres and a test Connect runtime adapter. Verify publish -> deploy -> manual run -> worker -> result query; worker restart; two worker replicas; schedule DST/missed-tick behavior; duplicate webhook delivery; revoked/expired connections; provider rate limits; gateway identity; tenant isolation; Compose health and graceful shutdown.

## CI pipeline

Add a dedicated FlowScript job that uses the pinned Bun version, runs frozen install, service build, unit tests, lint, Compose validation and image build. Run Postgres-backed lifecycle tests when available.

The latest observed CI failure occurs at frozen install because the lockfile is stale. Do not mark tests green until they actually run.
