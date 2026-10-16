# FlowScript development documentation

FlowScript is the source-first workflow language and hosted execution service being developed inside InboxFM Connect. This documentation distinguishes current implementation from intended architecture.

## Read in this order

1. [Architecture and service boundaries](./ARCHITECTURE.md)
2. [Developer setup and contribution guide](./DEVELOPMENT.md)
3. [Language, source format and IR contract](./LANGUAGE_AND_IR.md)
4. [Execution lifecycle and worker semantics](./EXECUTION.md)
5. [Hosting, triggers and deployment model](./HOSTING_AND_TRIGGERS.md)
6. [API contract](./API.md)
7. [Security model and threat checklist](./SECURITY.md)
8. [Testing and CI strategy](./TESTING.md)
9. [Implementation roadmap and acceptance criteria](./ROADMAP.md)
10. [Operations and troubleshooting](./OPERATIONS.md)

## Implemented in the current branch

- Fastify service, health/readiness and IR validation.
- YAML-based source compiler, versioned IR and SHA-256 artifact hash.
- Static checks for duplicate step IDs, unknown/self dependencies and cycles.
- CLI commands for lint, compile, test and local run.
- Pure transform/filter runner with explicit reference resolution.
- Postgres persistence for flow versions, deployments, runs and trigger registrations.
- Manual run enqueueing and worker process for queued pure flows.
- Cron schedule registration/dispatch and token-based webhook registration/ingress.
- Docker Compose service and worker definitions.

## Explicitly incomplete

- Verified integration adapter into the existing HeadlessRuntime, connection resolver, piece metadata and engine contracts.
- Authentication middleware/gateway identity propagation. The x-project-id header is a trusted-network contract, not authentication.
- Provider webhook verification, polling cursors and integration-event subscriptions.
- Robust retries, dead-lettering, cancellation, per-tenant quotas, deployment reconciliation, trigger rotation/disable APIs and usage metering.
- Production verification of Compose, migrations, tests and build. The latest known CI failed at bun install --frozen-lockfile because the lockfile was not updated after adding the workspace.

Do not expose the service directly to the public internet or run untrusted integration flows until the security and adapter milestones are complete.
