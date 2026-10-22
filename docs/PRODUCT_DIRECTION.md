# Product direction: integration infrastructure for other products

Research snapshot: September 27, 2026. Reviewed the repository's `dev` source, SDK, public API controllers, architecture guide, open issue index, and official Pipedream documentation. This is a product and documentation assessment, not a live-provider integration test or a security certification. Issue status and source should be rechecked before starting implementation.

## The product we are building

**Inboxfm Connect aims to be a self-hostable integration layer for AI agents and SaaS products: your customers connect their accounts, and your application's backend discovers and executes tools on their behalf.**

The consuming developer builds the product, authenticates its customers, and chooses what the agent may do. Connect provides connection sessions, credential infrastructure, integration metadata, execution, and MCP access. The dashboard is an operator console for those resources. Scheduled automations, triggers, tables, and knowledge features support that platform; the end-user connection and execution experience should drive its roadmap.

This is the same product category as Pipedream Connect. It is a direction for this fork, not a claim of compatibility, endorsement, or feature parity.

Self-hosting changes the operating model: the operator owns provider app registration, encryption keys, databases, refresh reliability, runtime isolation, upgrades, and integration maintenance. Deployment control is a reason to build this platform; it does not remove those responsibilities or demonstrate production readiness.

## What the Pipedream research establishes

[Pipedream's Connect overview](https://pipedream.com/docs/connect) describes a developer toolkit for adding integrations to another product, with end users identified by `external_user_id`, managed authorization, connection links, tools, and triggers. That fits the supplied product vision.

[Its product page](https://pipedream.com/connect) currently advertises managed authentication and more than 10,000 tools across more than 3,000 APIs. Those are Pipedream's catalog claims; they are not numbers for Inboxfm Connect.

[Its API proxy](https://pipedream.com/docs/connect/api-proxy) can call upstream APIs using the specified user's connected account, inserting the appropriate credentials. It applies app/domain constraints; this is more than executing an existing prebuilt action.

[Its MCP documentation](https://pipedream.com/docs/connect/mcp) describes developer integration on behalf of users, credential isolation, and revocable access. It is a useful reference for the intended customer-facing agent experience. Provider OAuth registration, verification, and security controls still need their own implementation and operational evidence in our deployment.

## How the current repository lines up

### Account connection is a real product foundation

[Connect sessions](../packages/server/api/src/app/connect-sessions/connect-session.controller.ts) accept an external user ID and allowed integrations, return a connection URL, and let the end-user browser create a connection through a temporary token. The [session service](../packages/server/api/src/app/connect-sessions/connect-session.service.ts) stores a token hash, expiry, and consumed state. That proves a connection flow exists; concurrent redemption and lifecycle guarantees still need regression evidence.

[Connect API keys](../packages/server/api/src/app/connect-api-keys/connect-api-key.service.ts) provide project-scoped developer access. [Connect OAuth apps](../packages/server/api/src/app/connect-oauth-apps/connect-oauth-app.controller.ts) let an operator configure provider client credentials. The external-user connection flow supports selected credential types and platform-configured OAuth; it does not confer Activepieces' or Pipedream's OAuth app approvals.

### Tool discovery and action execution exist

The [SDK client](../packages/connect-sdk/src/index.ts) implements session creation, connection listing, tool discovery, execution, and deletion. The [execute controller](../packages/server/api/src/app/execute/execute.controller.ts) invokes the [headless runtime](../packages/runtime/src/index.ts) and can resolve a connection using an external user ID within a project.

The catalog is inherited from Activepieces. The latest readiness build covered 747 integration packages successfully, but package count is not a count of verified provider accounts or working OAuth deployments. Select a small, maintained launch catalog and prove its complete journeys before expanding a coverage claim.

### The SDK is implemented, but distribution is a remaining delivery gate

There are generated contracts, typed errors, timeout/retry behavior, examples, package validation, and release workflow configuration. The old description in [#32](https://github.com/Mihir-Rabari/inboxfm-connect/issues/32) calling the SDK an empty stub no longer matches source.

A public registry lookup for `@inboxfm-connect/sdk` returned 404 during this review. This establishes that the public installation path was not available to that lookup, not that the SDK source is missing. Use the [workspace/tarball instructions](../packages/connect-sdk/README.md) until the package's public release, trusted publishing configuration, and external consumer smoke journey are confirmed.

### MCP exists; per-user delegation needs its own proof

The [MCP module](../packages/server/api/src/app/mcp) exposes project resources and tools. That is useful infrastructure. It is not evidence that each external customer automatically receives only their own connected accounts and authorized tools. Define and verify external-user authentication, tool filtering, execution ownership, and revocation before claiming the same developer experience as Pipedream's user-delegated MCP access.

### General API proxy parity is not established

The reviewed public SDK wraps prebuilt action execution; it does not expose a general credential-injecting provider API proxy. HTTP integration actions and MCP transport proxies should not be marketed as that capability. A future proxy needs account ownership checks, provider/domain restrictions, safe outbound HTTP, request limits, redaction, and a contract that does not return credentials to the application or model.

## Are the issues and docs conveying this?

**Before this update: partly.** The README already mentioned headless integrations, and the Connect API/SDK source followed the desired account → tool → action pattern. However, the roadmap's broad automation/production framing, stale SDK issue context, and scattered dashboard and engine work made the primary consuming developer and external-user journey harder to see. The documentation welcome page also advertised an enterprise-ready no-code builder, which does not describe this fork's current UI.

This update puts the consuming developer and their customers first in the README, architecture guide, SDK onboarding, repository description, and docs welcome page. The docs navigation prioritizes SDK/MCP guidance and labels inherited workflow references. Roadmap #63 and SDK issue #32 have refreshed descriptions, with their original context retained; #212–#214 provide focused acceptance/design tracks for the missing Connect experience.

Several existing tickets are directly relevant: [#135](https://github.com/Mihir-Rabari/inboxfm-connect/issues/135) for Connect API regression coverage, [#133](https://github.com/Mihir-Rabari/inboxfm-connect/issues/133) for tenant isolation, [#188](https://github.com/Mihir-Rabari/inboxfm-connect/issues/188) for connection health, [#164](https://github.com/Mihir-Rabari/inboxfm-connect/issues/164) for execution/API limits, and [#32](https://github.com/Mihir-Rabari/inboxfm-connect/issues/32) for SDK delivery. They should converge on one explicit customer-facing acceptance journey.

The required browser CI added in [#195](https://github.com/Mihir-Rabari/inboxfm-connect/pull/195) verifies operator sign-in, persisted scheduled automation, and real Text Helper execution. It does not exercise external-user Connect sessions or a provider's OAuth consent/refresh/revocation flow. A green build and an internal dashboard journey are valuable evidence, but neither completes the embedded integration product.

## Recommended delivery order

### 1. Make one external-customer journey dependable

Build a small example SaaS application that authenticates two customers, creates restricted Connect sessions from its backend, connects a real sandbox provider account, discovers a tool, executes it, and handles reconnect/revocation. Verify that customer and project boundaries hold even when IDs or session tokens are substituted. Cover expiry, reused/concurrent sessions, provider errors, refresh failures, and secret redaction. Track the acceptance journey in [#212](https://github.com/Mihir-Rabari/inboxfm-connect/issues/212), building on #135 and #133 instead of duplicating their unit/API coverage.

### 2. Make the developer onboarding reproducible

Confirm public SDK publication and complete a clean external-app install → connect → discover → execute journey. Document OAuth app setup, callbacks, supported scopes, permissions, pagination, safe retry behavior, and returned execution errors. The SDK's `Idempotency-Key` header is not currently a promise of server-side deduplication. Keep the runnable example and the API contracts in sync.

### 3. Complete launch safeguards and the licensing decision

Prioritize connection health (#188), API/rate limits (#164), execution isolation (#170), and the CE-only dependency removal decision (#25). Existing security and deployment tickets belong ahead of a production-ready claim. Passing CI is not a substitute for provider coverage, backup/restore, tenant isolation, resource budgets, or operational readiness.

### 4. Extend access modes after the core journey is proven

Design user-delegated MCP so discovery and execution use the same customer/account authorization rules ([#214](https://github.com/Mihir-Rabari/inboxfm-connect/issues/214)). Then add a credential-aware API proxy if broader provider endpoint coverage is required ([#213](https://github.com/Mihir-Rabari/inboxfm-connect/issues/213)). Preserve configured provider/domain boundaries and do not allow arbitrary URLs to receive a customer's credentials.

### 5. Expand the platform without diluting the product

Add more verified providers, triggers and schedules, scale improvements, observability, and billing as they support the developer integration experience. Dashboard polish and broader automation features should improve that experience without becoming the primary product definition.

The working roadmap remains [#63](https://github.com/Mihir-Rabari/inboxfm-connect/issues/63). Issue descriptions and old checklist states are administrative records, not proof of current capability; code, acceptance tests, provider evidence, and release availability determine readiness.

## Licensing and positioning

Self-hostability is the product direction. The current source retains MIT and restricted Enterprise material; it is not an entirely MIT, unrestricted-production distribution. Preserve upstream notices, credits, and commit history. Follow [LICENSING.md](../LICENSING.md) and complete provenance/dependency review under [#25](https://github.com/Mihir-Rabari/inboxfm-connect/issues/25) before changing that statement. Credits or edition flags do not grant additional rights.

## Definition of the first credible product milestone

A developer outside this repository can install the supported SDK, configure a provider OAuth app, connect an authenticated customer's account, discover and execute an action, and handle refresh, errors, and revocation. Two customers and two projects remain isolated; credentials stay out of browser bundles, model prompts, and diagnostics. This journey is documented, repeatable, and backed by automated contract/security coverage plus controlled provider smoke evidence.

That is the milestone that would make the intended Connect product convincing. The current repository has substantial building blocks for it; the remaining work is reliable end-user onboarding, authorization proof, public distribution, and operations.
