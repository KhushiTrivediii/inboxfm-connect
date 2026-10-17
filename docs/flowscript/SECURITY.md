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

## Current security status and controls

- Gateway authentication is enforced via HMAC-SHA256 signatures (`x-project-signature` or `x-gateway-signature`) and signed Bearer tokens against `FLOWSCRIPT_GATEWAY_SECRET` / `FLOWSCRIPT_AUTH_SECRET`. Fails closed (`GATEWAY_SECRET_MISSING`) if secrets are unset.
- Untrusted edge proxies must strip inbound client `x-project-id`, `x-project-signature`, and `x-gateway-signature` headers before authenticating callers using the `stripUntrustedProjectHeaders` helper.
- Project IDs are strictly validated to `/^[a-zA-Z0-9_-]{1,128}$/` to prevent injection or header spoofing.
- Conflicting identities (Bearer token project differing from `x-project-id`) are strictly rejected with 401 `FORGED_PROJECT_HEADER`.
- Strict project-scoped query isolation is enforced across versions, deployments, triggers, and runs. Cross-project version deployment is rejected with 404 `VERSION_NOT_FOUND`, and flow name mismatch is rejected with 400 `FLOW_NAME_MISMATCH`.
- Global payload limit of 1MB (`bodyLimit: 1_048_576`) is enforced with 413 `PAYLOAD_TOO_LARGE`.
- Webhook tokens are bearer capabilities. Raw tokens are SHA-256 hashed; only the hash is persisted in the database. Ingress logs sanitize the raw token (`/v1/hooks/[REDACTED]`).
- The runner is limited to declarative IR and trusted adapters; arbitrary user code execution (`eval`/`Function`) is strictly disallowed.
- Database schema currently uses CREATE TABLE IF NOT EXISTS with idempotent column upgrades. Production requires versioned migrations and least-privilege DB credentials.

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
