# FlowScript: developer-first flows for Inboxfm Connect

> Status: implementation blueprint, not an implemented runtime. Target branch: `feat/flowscript-runtime-blueprint`.
>
> Grounded in the current repository architecture on `dev`: headless integration infrastructure, the inherited flow/run model vocabulary, trigger strategies (`POLLING`, `WEBHOOK`, `APP_WEBHOOK`, `MANUAL`), a process-local scheduler, and API-side scheduled-task/trigger-binding areas.

## 1. Product objective

FlowScript is the source-first way to define, validate, test, publish, and operate flows in Inboxfm Connect. It should feel like writing a small declarative program, not rebuilding a visual automation builder in text form.

A developer keeps a `.flow` file in Git, lints and tests it in CI, publishes an immutable version to Connect, and runs it manually or through a durable trigger. The CLI is the developer experience; the existing engine, integration catalog, connection/auth infrastructure, queue, and API remain the execution foundation.

**Core principle:** FlowScript compiles into a versioned, typed flow definition that the current engine can execute. It does not introduce a parallel integration runtime or expose credentials to user scripts.

## 2. Proposed developer experience

```sh
bunx inboxfm-flow init incident-triage
cd incident-triage

flow lint
flow test
flow test --watch
flow run ./flows/triage.flow --input fixtures/incident.json
flow publish ./flows/triage.flow --env staging
flow triggers list
flow triggers enable incident-triage
flow runs list --flow incident-triage
flow runs inspect <run-id>
```

Suggested packages:
- `@inboxfm-connect/flowscript`: language types, parser, compiler, diagnostics, formatter and schema.
- `@inboxfm-connect/flow-runtime`: orchestration through existing Connect execution services; trigger adapters and run context.
- `@inboxfm-connect/flow-cli`: the `flow` command.
- API additions remain inside the existing API application, not a new server.

The binary name `flow` may conflict with other tools. Publish `inboxfm-flow` as the unambiguous binary, with `flow` as an optional alias.

## 3. Language design

Use a declarative, typed DSL with a JSON-compatible data model. Do not allow arbitrary JavaScript, dynamic imports, filesystem access, shell commands, or direct database access in FlowScript. That avoids turning every flow definition into a remote-code-execution surface.

### Example: scheduled flow

```flowscript
flow "daily-inbox-briefing" {
  version = 1
  description = "Summarize the user's important email each morning."

  input {
    userId: string
  }

  trigger schedule {
    cron = "0 8 * * 1-5"
    timezone = "Asia/Kolkata"
  }

  step emails = integration "@inboxfm-connect/piece-gmail" {
    action = "search_emails"
    connection = connection.ref("gmail", input.userId)
    input = {
      query: "is:unread newer_than:1d"
      maxResults: 25
    }
  }

  step digest = transform {
    using = "email.digest"
    input = { messages: emails.output }
  }

  step notify = integration "@inboxfm-connect/piece-slack" {
    action = "send_channel_message"
    connection = connection.ref("slack", input.userId)
    input = {
      channel: env("INBOX_DIGEST_CHANNEL")
      text: digest.output.text
    }
  }

  output = { sent: true, count: digest.output.count }
}
```

### Example: webhook flow

```flowscript
flow "github-pr-notifier" {
  version = 1

  trigger webhook {
    method = "POST"
    path = "/github/pull-request"
    auth = webhook.secret("GITHUB_WEBHOOK_SECRET")
    verify = "github.signature"
  }

  step accepted = filter {
    when = trigger.body.action in ["opened", "ready_for_review"]
  }

  step message = integration "@inboxfm-connect/piece-slack" {
    action = "send_channel_message"
    connection = connection.ref("slack", env("SLACK_CONNECTION_REF"))
    input = {
      channel: env("ENGINEERING_CHANNEL")
      text: "PR opened: " + trigger.body.pull_request.html_url
    }
    run_if = accepted.output
  }

  output = { delivered: message.output != null }
}
```

### Example: manual invocation

```flowscript
flow "summarize-ticket" {
  version = 1

  input {
    ticketId: string
    requester: string
  }

  trigger manual {}

  step ticket = integration "@inboxfm-connect/piece-linear" {
    action = "get_issue"
    connection = connection.ref("linear", input.requester)
    input = { id: input.ticketId }
  }

  output = { title: ticket.output.title, url: ticket.output.url }
}
```

These snippets are syntax proposals. Provider action names and input schemas must be resolved from installed integration metadata during compilation; the examples do not claim those exact actions are currently installed or verified.

### Language rules

- Every flow has a stable name and explicit language version.
- Exactly one trigger per flow in v1: `manual`, `schedule`, `webhook`, and integration-backed event/polling triggers when that integration declares support.
- Steps have stable identifiers, typed outputs, explicit dependencies, and deterministic declaration order unless dependency edges imply parallel execution.
- References such as `emails.output` are statically checked. Unknown step/output/action/trigger references are compile errors.
- `run_if` is a typed boolean expression. `filter` and `transform` use a small audited expression language, never `eval`.
- Provider action names, connection requirements, and input/output shapes come from piece metadata. Compilation fails with actionable diagnostics on mismatches.
- Secrets are references to server-side environment/secret-manager entries. Resolved values never enter compiled artifacts, logs, test snapshots, or LLM context by default.
- Expressions are pure. Side effects only happen through declared integration/actions or explicit runtime primitives.
- A flow compiles to canonical, versioned Flow IR JSON. The IR is the only format accepted by the production runtime.

## 4. Trigger and execution model

A trigger is a durable registration plus an execution adapter. Do not keep long-lived flow trigger state only in memory.

### Trigger kinds

1. **Manual / command:** `flow run <file-or-name> --input <json>`; API invocation is also available through a project-scoped authenticated endpoint.
2. **Schedule:** cron expression + IANA timezone. Persist schedule config and next-fire time; workers enqueue due triggers with a transactional claim or lock. The current local scheduler can calculate ticks but is not the source of truth.
3. **Webhook:** create a high-entropy endpoint ID/secret, persist the binding, validate method/signature/size/rate limits, and enqueue execution. Support idempotency keys, constant-time secret comparison, and redaction.
4. **Integration app event:** subscribe using the integration's declared webhook trigger, reuse its handshake/signature logic, and route accepted provider events to execution.
5. **Polling trigger:** persist cursor/checkpoint and next-poll time; prevent overlapping polls per trigger; enqueue meaningful changes; define dedupe keys and backoff.

### Execution lifecycle

```text
source .flow
    |
    v
parse -> schema/typecheck -> resolve integration metadata -> lint
    |
    v
canonical Flow IR
    |
publish immutable version (hash + compiler/IR version)
    |
    +--> manual invocation
    +--> schedule dispatcher
    +--> webhook / app-event adapter
    +--> polling dispatcher
             |
             v
       durable queue / worker
             |
             v
       existing runtime -> engine/sandbox -> integrations
             |
             v
       persisted run + step results + redacted logs + metrics
```

Runs record flow version/hash, trigger source, input reference, step outcomes, attempt counts, retry decisions, timestamps, and trace/correlation IDs. A published version is immutable: publish a new version rather than mutating a running flow.

### Reliability contract for v1

- At-least-once trigger delivery; idempotency/deduplication keys are explicit. Do not promise exactly-once external side effects.
- Each trigger has tenant/project scope and ownership checks at registration and invocation.
- Scheduled dispatch survives API restarts and uses a DB claim or distributed lock to avoid multi-replica double dispatch.
- Retry only classified transient errors, with capped exponential backoff and jitter. Do not blindly retry non-idempotent actions.
- Enforce per-flow concurrency, per-project quotas, step timeout, total run deadline, maximum step count, payload limits, and queue lease/visibility handling.
- Cancellation is cooperative between steps; external requests have bounded timeouts.
- Pause/resume, human waitpoints, branches, loops, and subflows come later unless current engine contracts already support them with adequate tests.

## 5. CLI command contract

| Command | Expected behavior |
|---|---|
| `flow init [name]` | Scaffold project, example flow, config, test fixture, README |
| `flow lint [path]` | Parse, schema/type check, resolve references, check piece/action schemas, security and reliability rules |
| `flow fmt [path]` | Stable formatting; check mode for CI |
| `flow test [path]` | Deterministic tests with mocked triggers, integrations and clock; no real side effects by default |
| `flow test --integration` | Opt-in tests against explicitly configured sandbox connections |
| `flow run [path-or-name]` | Execute with input and environment; production side effects require explicit policy/confirmation |
| `flow compile [path]` | Emit canonical IR and source map |
| `flow publish [path]` | Compile, lint, upload source + IR + hashes, create immutable version and optionally promote |
| `flow deploy [path]` | Publish and reconcile triggers; show a plan/diff before apply |
| `flow triggers list/enable/disable` | Inspect/change durable trigger registrations |
| `flow runs list/inspect/logs` | Query persisted history by flow/environment/status |
| `flow doctor` | Check API, CLI/API/IR compatibility, permissions and environment configuration |

Exit codes: 0 success; 1 lint/test failures; 2 invalid command/config; 3 auth/permission; 4 API/network failure; 5 runtime failure; 6 version incompatibility. Support `--json` for CI.

## 6. Lint and test design

### Static diagnostics

- Syntax/schema errors with filename, line and column.
- Unknown step/output/action/trigger/connection references.
- Integration input schema mismatch and missing required connection.
- Invalid timezone/cron or unsafe webhook configuration.
- Unused steps and unreachable action warnings.
- Secret literals, credential-looking strings, unsafe URL construction, overly broad HTTP destinations.
- Non-idempotent action under retry policy.
- Missing timeout, unbounded payload, missing failure behavior for required actions.
- Potential PII in logs/output.
- Contradictory run conditions and output type mismatches.
- Unpinned/unavailable piece version in reproducible publishing mode.

### Illustrative test authoring

```flowscript
test "new PR sends Slack notification" {
  input = {}
  trigger.webhook = {
    action: "opened"
    pull_request: { html_url: "https://github.com/acme/repo/pull/42" }
  }

  mock integration "@inboxfm-connect/piece-slack" action "send_channel_message" {
    returns = { ok: true, ts: "123.456" }
  }

  expect step("message").to_run()
  expect output.delivered == true
}
```

This test syntax is illustrative. Tests compile to a deterministic harness with fake clock, seeded IDs, mock integration adapters, redacted fixtures, and assertions over step inputs/outputs/status. Add contract tests for IR accepted by the existing runtime, and API integration tests for publish/run/trigger persistence.

Test layers: lexer/parser; type and metadata validation; IR snapshots/compatibility; mocked runtime execution; PGlite and PostgreSQL API tests where practical; restart/multi-worker/idempotency tests; provider sandbox E2E flows in opt-in CI.

## 7. Integration with the existing codebase

Before implementation, verify live files on the target branch and reuse current contracts. The `dev` architecture describes:

- `packages/runtime` as the headless runtime boundary.
- `packages/server/engine` and `packages/server/sandbox` as execution/isolation layers.
- `packages/core/shared` as a source of automation, trigger, and run schemas.
- `packages/scheduler` as cron and local scheduling utilities.
- API trigger binding and scheduled-task services under `packages/server/api/src/app/execution/`.
- Trigger strategies `POLLING`, `WEBHOOK`, `APP_WEBHOOK`, and `MANUAL`.

Recommended layering:

```text
packages/flowscript/          # parser, AST, typechecker, compiler, diagnostics
packages/flow-runtime/        # IR runner and trigger adapter contracts
packages/flow-cli/            # developer CLI
packages/server/api/...       # auth, persisted versions, trigger lifecycle, runs
packages/runtime/             # reuse existing headless execute service
packages/server/engine/       # integration step execution
```

Names and dependencies can be adjusted to monorepo conventions. Keep compiler dependencies on light schemas/metadata interfaces, not API/DB entities. The API translates authenticated project-scoped requests into compile/publish/run service calls.

Do not conflate this with `packages/cli` if its role remains integration-piece authoring. A separate FlowScript CLI keeps the product contract clear, while selected utilities can be shared.

## 8. Persistence and API changes

Prefer existing flow/version/run/trigger entities and services if they exist in the current target branch. Do not create duplicate tables before mapping the current entities and migrations.

If the current schema cannot represent source-first flows, add only what's missing. Candidate fields/entities:

- `sourceFormat` and `sourceText` on a flow version, or a separate versioned source artifact with checksum.
- `compilerVersion`, `irVersion`, `irHash`, and `lockfileHash` on a published version.
- Environment-specific trigger deployment state with persisted enabled/disabled state and last/next dispatch times.
- Trigger delivery/idempotency record keyed by tenant + trigger + provider event ID.
- Run reference to source version hash and an input-file/reference for large or sensitive inputs, rather than inline payloads.

Candidate API surface, with project-level authorization:

- `POST /v1/flow-definitions/compile` — compile/lint without persisting.
- `POST /v1/flow-definitions` — create/update draft source.
- `POST /v1/flow-definitions/:id/publish` — validate and create immutable version.
- `POST /v1/flow-definitions/:id/run` — manually enqueue a published version.
- `GET /v1/flow-definitions/:id/runs` and `GET /v1/flow-runs/:runId`.
- `GET /v1/flow-triggers`, `POST /v1/flow-triggers/:id/enable`, `POST /v1/flow-triggers/:id/disable`.

These route names are proposals, not existing endpoints. Align them with repository conventions before implementation.

## 9. Security and tenancy requirements

- Never execute generated JavaScript or user-supplied scripts through `eval`, `new Function`, or unrestricted Node workers.
- Compile to a restricted IR and use an audited pure expression evaluator with depth/step limits.
- Resolve secrets and connections in trusted runtime callbacks; never bake tokens into source/IR or return secrets to the application/model.
- Validate flow, trigger, environment, input and connection ownership against the authenticated project/user scope.
- Webhook endpoints need secret rotation/revocation, signature verification when available, size limits, replay protection, rate limits, and uniform error responses.
- Use existing outbound HTTP protections; disallow arbitrary user-controlled destinations by default to reduce SSRF risk.
- Apply log redaction and payload retention controls. Do not log full email bodies, tokens, authorization headers, or raw webhook payloads by default.
- Treat compiled artifacts as untrusted until server-side validation succeeds too; CLI lint is not an authorization boundary.
- Check compiler/IR compatibility server-side and reject unsupported IR versions.
- Production deployments must use supported sandbox isolation; `UNSANDBOXED` local mode is not production isolation.

## 10. Delivery plan

### Phase 0: repository reconnaissance and contract proof
- Map current flow/version/run schemas and services on `dev`; enumerate trigger binding and scheduled-task lifecycle APIs.
- Write an architecture ADR and IR compatibility spike against the current engine.
- Prove one manual example and one scheduled example through compile -> publish -> run -> persisted result.
**Exit gate:** no duplicate execution model; compiled IR is accepted by existing engine contracts.

### Phase 1: FlowScript MVP authoring
- Implement parser, AST, canonical formatter, schema validation and compiler to IR.
- Ship `init`, `lint`, `fmt`, `compile` and useful diagnostics.
- Support one trigger, linear dependencies, integration steps, transform/filter, output, and secret/env references.
- Implement deterministic `flow test` with mocked integrations.
**Exit gate:** contract tests pass and fixture flows compile reproducibly.

### Phase 2: trusted runtime and manual runs
- Connect IR to existing runtime through a narrow adapter.
- Publish immutable version metadata and source/IR hashes.
- Add authenticated manual run, persisted step results, redacted logs, status inspection and cancellation.
- Provide local `flow run` with explicit test-versus-live policy.
**Exit gate:** same artifact yields the same graph on CLI and server; cross-project authorization tests pass.

### Phase 3: durable schedules and webhooks
- Persist trigger registrations and reconcile on startup and after deploy.
- Use queue dispatch and idempotency/deduplication for scheduled and webhook delivery.
- Add timezone, missed tick, restart, two-worker, duplicate webhook and secret rotation tests.
- Add trigger enable/disable/reconcile CLI commands.
**Exit gate:** restart/multi-replica tests show no lost schedule registrations and bounded duplicate handling.

### Phase 4: app events, polling, deploy and ecosystem
- Reuse integration webhook handshake/signature and polling/cursor contracts.
- Add environment config and lockfile, deployment diff, run inspector, OpenTelemetry-compatible traces and quotas.
- Add branches/retry/wait/loops only with explicit semantics and runtime guardrails.

## 11. MVP acceptance checklist

- [ ] A `.flow` source parses and formats deterministically.
- [ ] Lint resolves provider actions against real integration metadata.
- [ ] Test mode uses mocked actions and cannot accidentally perform real side effects.
- [ ] Compiled IR is versioned, deterministic and validated server-side.
- [ ] Publish makes an immutable version with source and IR hashes.
- [ ] Manual execution accepts structured input and persists a run record.
- [ ] Schedule registration survives service restart and is safe with multiple API replicas.
- [ ] Webhooks authenticate/verify, enforce limits, deduplicate replay and queue work.
- [ ] Secrets never appear in compiled output, CLI output or logs.
- [ ] Tenancy, authorization, rate limits, timeouts and cancellation have tests.
- [ ] Docs state at-least-once delivery and explain external side-effect idempotency.
- [ ] Existing integration, Connect session, SDK, MCP, and headless execution paths do not regress.

## 12. Recommended first vertical slice

Build this path before implementing the whole language:

1. `flow init` creates one scheduled source file and one mock fixture.
2. `flow lint` type-checks the trigger and two integration steps against real piece metadata.
3. `flow test` runs against mocked integration adapters.
4. `flow compile` emits versioned canonical IR.
5. API accepts source/IR, validates it again, stores a draft, and creates an immutable published version.
6. `flow run` executes the published version manually and returns run ID/status.
7. A DB-backed dispatcher enqueues a due schedule; the same runtime executes it and persists output.
8. Only then add webhook binding and provider-specific app-event triggers.

This yields a usable end-to-end slice while keeping scope debuggable. A parser without an executable vertical slice is a syntax hobby; a runtime without persistence is one service restart away from forgetting everyone's automations.
