# FlowScript architecture

## Goals

- Keep FlowScript in the existing InboxFM Connect monorepo.
- Give the API service and worker independent process/container boundaries.
- Reuse Connect's integration catalog, connection/auth systems, execution runtime and queue/database infrastructure.
- Make published artifacts immutable and pin every run to a version.
- Keep flow definitions declarative. Never execute arbitrary JavaScript, Python, shell commands or dynamic imports from flow source.

## Logical architecture

    Developer / CI
      .flow source + tests
             |
             v
      Flow CLI -> FlowScript API (private service)
                       |
                       v
                PostgreSQL state
                versions / deployments /
                triggers / runs / steps
                       |
             +---------+---------+
             |                   |
             v                   v
       Trigger dispatcher    Manual/API ingress
       schedules/webhooks    validates and enqueues
             |                   |
             +---------+---------+
                       |
                       v
                durable run queue
              (currently Postgres rows)
                       |
                       v
                FlowScript worker
                       |
                       v
              trusted execution adapter
                       |
                       v
              InboxFM Connect runtime
              connections / pieces / sandbox

The current worker uses Postgres rows as a queue and FOR UPDATE SKIP LOCKED for claims. Treat this as an MVP mechanism, not a substitute for an explicit durable queue if throughput, visibility timeout, backpressure and redrive requirements demand one. Evaluate the existing Connect queue/worker abstractions before adding another queue technology.

## Service boundaries

### FlowScript API / control plane

Owns source compilation, immutable artifact publication, environment deployment records, trigger definitions, run queries and request validation. It should not execute long-running work inline. Run requests persist/enqueue first and return a run ID.

### FlowScript worker / data plane

Claims jobs, loads the pinned artifact, builds a typed run context, executes steps through a trusted adapter and records step transitions and final status. It must be horizontally scalable and safe under duplicate delivery.

### Existing Connect infrastructure

Remains authoritative for integrations/pieces, connection ownership, credential decryption/refresh, action metadata, sandbox execution and project authorization. FlowScript must not store plaintext credentials or implement a second connection database.

## Current data model

Tables are created by initializeStore() in services/flowscript/src/store.ts:

- flowscript_versions: source text, compiled IR, version/hash and project namespace.
- flowscript_deployments: active version per project/flow/environment.
- flowscript_triggers: schedule/webhook config and dispatch state.
- flowscript_runs: version-pinned execution, input, outputs, steps, status and timestamps.

This is a first-pass schema. Move schema changes into versioned migrations compatible with repository conventions before production. Add tenant foreign keys or existing project identifiers where available. Define retention/indexes and avoid storing sensitive inputs/outputs unredacted.

## Request identity

Current routes read x-project-id. That header is trustworthy only when an authenticated gateway strips caller-supplied copies and injects verified identity. Direct public access is unsafe. Add gateway integration or signed service-to-service identity, project membership/permissions, rate limits and audit events before launch.

## Reliability model

- Assume at-least-once execution.
- Every trigger delivery and run needs an idempotency key.
- Exactly-once external side effects generally cannot be guaranteed.
- Persist transitions and retry attempts so restarts cannot erase execution history.
- Pin each run to an immutable artifact hash/version.
- Deployment updates affect new runs; existing runs retain their artifact.
- A worker can crash after a side effect but before recording success. Define idempotency/reconciliation per integration action.

## Scaling

Start with a modular service and worker process, not a fleet of tiny services. Scale workers horizontally after load testing. Add queue visibility timeouts, bounded concurrency, per-project quotas, backpressure, DB pool limits and metrics before optimizing for high throughput.
