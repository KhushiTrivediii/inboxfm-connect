# FlowScript

FlowScript is a source-first workflow language and a standalone service inside the InboxFM Connect monorepo.

## Implemented in this slice

- YAML-based `.flow` source parser with schema diagnostics.
- Deterministic canonical IR output and SHA-256 artifact hash.
- Validation for duplicate step IDs, missing/self dependencies, and dependency cycles.
- Bounded local runner for pure transform/filter steps, reference resolution, env references, step limits, and per-step timeouts.
- CLI commands: `lint`, `compile`, `test`, and `run` for local non-integration flows.
- Fastify endpoints for health/readiness, source compilation, IR validation, safe local execution, publish/deploy, manual run, and run inspection.
- Postgres-backed immutable flow versions, deployment records, and run history.
- Docker service registered in the root Compose network.

## Important boundaries

This is an executable first slice, not yet the complete hosted platform.

- The parser currently uses YAML syntax for `.flow` files. A custom grammar can be introduced later without changing the IR/runtime contract.
- Integration actions are intentionally refused unless a trusted InboxFM Connect executor is injected. This service does not execute arbitrary user code and does not yet bridge to the existing connection/runtime APIs.
- Filter evaluation currently supports a literal boolean `config.when`; a richer expression language must use a dedicated safe evaluator, never `eval`.
- API compile/run endpoints are internal service endpoints and are not a substitute for tenant authentication/authorization. Do not expose them publicly until authenticated API gateway integration is implemented.
- The worker polls durable queued runs and dispatches persisted cron triggers. The public webhook gateway is not exposed by Nginx yet; the endpoint is internal until gateway authentication/rate limiting is added.
- Integration-app webhook handshakes, polling/cursors, trigger disable/rotation APIs, retry/dead-letter handling, cancellation, quotas, deployment reconciliation, authenticated API gateway integration, and the trusted existing-runtime adapter are still pending.
- A successful `flow run` for a pure transform does not mean hosted schedules/webhooks or integration execution are implemented.

## Source format

```yaml
flow: hello-world
version: 1
description: Minimal manual flow
trigger:
  kind: manual
inputSchema:
  name:
    type: string
steps:
  - id: greeting
    kind: transform
    config:
      value:
        message: Hello
        name:
          $ref: input.name
    dependsOn: []
output:
  greeting:
    $ref: steps.greeting
```

References use explicit objects such as `{$ref: input.name}`, `{$ref: trigger.body.id}`, `{$ref: steps.fetch.output.id}`, or `{$env: MY_VARIABLE}`. These are resolved by the runtime and are not JavaScript expressions.

## Local development

From the monorepo root:

```sh
bun install
bun run --cwd services/flowscript build
bun run --cwd services/flowscript test
bun run --cwd services/flowscript dev
```

## CLI

After building:

```sh
node services/flowscript/dist/cli.js init my-flow [--out custom.flow] [--force]
node services/flowscript/dist/cli.js fmt services/flowscript/examples/manual.flow [--check]
node services/flowscript/dist/cli.js lint services/flowscript/examples/manual.flow
node services/flowscript/dist/cli.js compile services/flowscript/examples/manual.flow
node services/flowscript/dist/cli.js test services/flowscript/examples/manual.flow
node services/flowscript/dist/cli.js run services/flowscript/examples/manual.flow --input input.json
node services/flowscript/dist/cli.js publish services/flowscript/examples/manual.flow
node services/flowscript/dist/cli.js deploy my-flow <versionId>
node services/flowscript/dist/cli.js runs [--flow my-flow]
node services/flowscript/dist/cli.js logs <runId>
node services/flowscript/dist/cli.js cancel <runId>
```

Use `--input path.json` to pass structured input. Integration steps require either the hosted Connect runtime adapter or local --mock / --mock-integrations <file.json>.

## HTTP API

- `GET /health`
- `GET /ready`
- `POST /v1/source/compile` with `{"source":"..."}`
- `POST /v1/ir/validate`
- `POST /v1/ir/execute-local` for pure local flows only
- `POST /v1/flows/publish` with a trusted `x-project-id` header
- `POST /v1/flows/:name/deploy`
- `POST /v1/flows/:name/run` (queues pure flows for the worker)
- `POST /v1/flows/:name/triggers` to register a cron schedule or secret-token webhook
- `POST /v1/hooks/:token` to durably enqueue a webhook-triggered run
- `GET /v1/runs` and `GET /v1/runs/:id`

Default internal port: 8081.
