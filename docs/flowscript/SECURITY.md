# FlowScript security model

## Trust boundaries

1. Developer source is untrusted input.
2. API request bodies and webhook payloads are untrusted.
3. x-project-id is trusted only if an authenticated gateway strips caller values and injects verified identity.
4. Integration connections and secrets are privileged resources owned by Connect.
5. Workers execute side effects and require strict isolation, quotas and auditability.

## Non-negotiable rules

- Never execute arbitrary user code or evaluate source with eval/Function.
- Never accept credentials in FlowScript source or flow inputs.
- Resolve secrets only inside trusted server-side adapters.
- Verify project membership and connection ownership on every operation.
- Do not trust project IDs from public request headers.
- Apply source, IR, input/output size, step count, time and concurrency limits.
- Do not log webhook tokens, authorization headers, secret values or unredacted payloads.
- Validate integration/action names against installed metadata.
- Enforce network egress restrictions for any future plugin execution.
- Pin runs to immutable artifacts and audit publish/deploy/trigger changes.
- Keep lockfile and dependency vulnerability checks enabled.

## Current blockers

- The service trusts x-project-id as an internal gateway contract; authentication middleware is not implemented here.
- Webhook tokens are bearer capabilities. Do not expose publicly without rate limits, payload limits, provider verification where applicable, revocation and audit logging.
- The runner is not a hardened sandbox for arbitrary user code. Keep it limited to declarative IR and trusted adapters.
- Input/output redaction and retention controls are incomplete.
- Database schema currently uses CREATE TABLE IF NOT EXISTS. Production requires versioned migrations and least-privilege DB credentials.

## Required threat tests

- Cross-project version/deployment/run access is rejected.
- Forged x-project-id cannot grant access through the public gateway.
- Webhook tokens never appear in logs or database plaintext.
- Oversized source, nested payloads and excessive steps are rejected.
- Malformed YAML, duplicate keys, aliases and dependency cycles fail safely.
- Unknown integration/action/connection is rejected before execution.
- Secret references never appear in artifacts, logs, outputs or errors.
- Duplicate webhook deliveries do not duplicate non-idempotent actions.
- Worker concurrency/timeouts cannot exhaust the service.
