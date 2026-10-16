# FlowScript Service

Standalone FlowScript control-plane microservice scaffold inside the InboxFM Connect monorepo.

## Current scope

- Independent HTTP service and container boundary.
- Health/readiness endpoints.
- Versioned Flow IR validation endpoint: `POST /v1/ir/validate`.
- Validation for trigger shape, step IDs, and dependency references.

## Not implemented yet

This is the first service slice, not the complete product. It does not yet parse `.flow` source, execute integration steps, persist deployments/runs, or register schedules/webhooks. Those capabilities must be added behind this service boundary in later slices and must reuse the repository's existing execution, connection, trigger, and queue contracts.

## Local development

From the repository root:

```sh
bun install
bun run --cwd services/flowscript dev
```

Default port: 8081.

## API

- `GET /health`
- `GET /ready`
- `POST /v1/ir/validate`

The IR schema is versioned. Unsupported IR versions are rejected rather than silently interpreted.
