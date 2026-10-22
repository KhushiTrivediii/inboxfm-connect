# Credential-Aware Connect API Proxy Design

## Overview

The Connect API Proxy provides consuming backends with a secure, credential-aware HTTP gateway to third-party provider APIs on behalf of an authenticated end-customer.

Developers often need to call arbitrary provider endpoints that are not yet modeled as prebuilt actions in an integration piece (for example, raw Slack webhook administration, niche GitHub GraphQL queries, or custom Notion database filters). Rather than requesting raw customer credentials or exposing tenant project keys, consuming applications dispatch requests through the Connect API Proxy. The proxy verifies tenant and customer identity, resolves and refreshes decrypted OAuth/secret credentials, injects authentication headers, and executes the outbound request through an SSRF-hardened HTTP client (`safeHttp`).

---

## Architectural Comparison: Direct Piece Execution vs. API Proxy

| Dimension | Prebuilt Piece Action (`POST /v1/execute`) | Credential-Aware API Proxy (`POST /v1/connect-proxy/request`) |
|---|---|---|
| **Invocation Model** | Fixed input properties predefined by TypeScript piece schema | Raw HTTP method, relative path, headers, query, and payload |
| **API Coverage** | Capped to actions implemented in the piece package | Uncapped access to any endpoint on the provider's official API |
| **Authentication** | Headless runtime decrypts connection and passes to action function | Proxy decrypts and injects `Authorization: Bearer <token>` automatically |
| **Outbound Security** | Sandboxed Node/isolated-vm execution | `safeHttp` with private IP / DNS rebinding filtering |
| **Credential Safety** | Model and caller receive only action output | Secrets never enter caller request, response headers, or error traces |
| **Target URL** | Determined by piece implementation | Strictly vetted against `ALLOWED_PROXY_PROVIDERS` domain registry |

---

## Threat Matrix & Security Invariants

### 1. Zero Arbitrary Outbound Targets (SSRF Prevention)
- **Vulnerability**: An attacker supplies `path: "http://169.254.169.254/latest/meta-data"` or `path: "https://evil.com/capture"` to steal credentials or pivot into internal infrastructure.
- **Enforcement**:
  - The caller can only specify a relative sub-path. Any path beginning with `http://`, `https://`, `//`, or containing directory traversal (`..`) is rejected immediately with `INVALID_PATH`.
  - The proxy strictly resolves targets against `ALLOWED_PROXY_PROVIDERS`. Base URLs are hardcoded constants (e.g. `https://slack.com/api`, `https://api.github.com`).
  - For providers requiring tenant subdomains (e.g. Zendesk), the subdomain must strictly match `^[a-zA-Z0-9-]+$`.
  - All outbound requests are executed via `safeHttp` (built on `request-filtering-agent`), which blocks:
    - Loopback addresses (`127.0.0.0/8`, `::1`)
    - RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
    - Cloud metadata IP (`169.254.169.254`)
    - Link-local and IPv6 unicast addresses

### 2. Multi-Tenant Identity & Customer Bounding
- **Vulnerability**: Tenant Alice attempts to proxy calls using Tenant Bob's connection, or Customer 1 attempts to call Slack using Customer 2's connection ID.
- **Enforcement**:
  - Endpoint requires `WRITE_APP_CONNECTION` permission on the target `projectId` (via Project API Key `cak-...` or authenticated user JWT).
  - Database lookup enforces `projectIds @> [request.projectId]` AND `externalId = request.externalUserId`.
  - If a caller supplies an explicit `connectionId`:
    - The server verifies `connection.projectIds.includes(projectId)` (`CROSS_PROJECT_FORBIDDEN`).
    - The server verifies `connection.externalId === externalUserId` (`CROSS_CUSTOMER_FORBIDDEN`).
    - The server verifies `connection.pieceName === provider` (`PROVIDER_MISMATCH`).

### 3. Credential Injection & Header Hygiene
- **Vulnerability**: Caller passes an `Authorization` header in the request to override or steal tokens, or downstream servers return `Set-Cookie` headers.
- **Enforcement**:
  - The caller's headers are sanitized: all hop-by-hop headers (`Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Transfer-Encoding`, etc.) and `Host`, `Authorization`, and `Cookie` headers are stripped.
  - The proxy injects the decrypted connection secret as `Authorization: Bearer <token>` (or provider-configured header).
  - Upstream response headers are sanitized before returning to the caller (`set-cookie`, `authorization`, and hop-by-hop headers are removed).

### 4. Payload & Timeout Bounds
- **Limits**:
  - Request body size: Max 5 MB (`maxBodyLength: 5 * 1024 * 1024`).
  - Response body size: Max 10 MB (`maxContentLength: 10 * 1024 * 1024`).
  - Request timeout: Clamped to `[500ms, 60000ms]`, default 30,000ms.

### 5. Idempotency & Retry Semantics
- **Non-idempotent methods** (`POST`, `PATCH`): Never automatically retried by the proxy on network or 5xx errors to prevent duplicate side effects (e.g. charging a card, posting duplicate messages).
- **Idempotent methods** (`GET`, `PUT`, `DELETE`): If caller supplies an `idempotencyKey`, the proxy allows safe retry on transient network failures.

### 6. Immediate Account Revocation
- Connections are re-validated in PostgreSQL in real time during each proxy call. When a user disconnects an integration in Connect, all subsequent proxy calls fail immediately with `404 CONNECTION_NOT_FOUND`.

---

## Allowed Provider Registry

| Provider Key | Provider Name | Base URL | Auth Scheme | Special Headers |
|---|---|---|---|---|
| `slack` | Slack | `https://slack.com/api` | Bearer Token | - |
| `github` | GitHub | `https://api.github.com` | Bearer Token | `Accept: application/vnd.github+json`, `User-Agent: InboxFM-Connect-Proxy/1.0` |
| `notion` | Notion | `https://api.notion.com/v1` | Bearer Token | `Notion-Version: 2022-06-28` |
| `hubspot` | HubSpot | `https://api.hubapi.com` | Bearer Token | - |
| `google` | Google APIs | `https://www.googleapis.com` | Bearer Token | - |
| `stripe` | Stripe | `https://api.stripe.com/v1` | Bearer Token | - |
| `zendesk` | Zendesk | `https://{subdomain}.zendesk.com/api/v2` | Bearer Token | Subdomain regex: `^[a-zA-Z0-9-]+$` |

---

## Public Contract Specification

### Request Schema (`POST /v1/connect-proxy/request`)

```json
{
  "projectId": "proj_12345",
  "externalUserId": "cust_user_999",
  "provider": "slack",
  "connectionId": "conn_abc_optional",
  "method": "GET",
  "path": "/users.info",
  "query": {
    "user": "U12345678"
  },
  "headers": {
    "X-Custom-Context": "support-ticket-42"
  },
  "body": null,
  "timeoutMs": 15000,
  "idempotencyKey": "req_unique_key_123"
}
```

### Response Schema

```json
{
  "status": 200,
  "statusText": "OK",
  "headers": {
    "content-type": "application/json; charset=utf-8",
    "x-oauth-scopes": "users:read,channels:read"
  },
  "data": {
    "ok": true,
    "user": {
      "id": "U12345678",
      "name": "alice"
    }
  },
  "provider": "slack",
  "rateLimit": {
    "limit": 100,
    "remaining": 99,
    "reset": 1600000000
  }
}
```

---

## Consuming SDK Example

```ts
import { InboxFM } from '@inboxfm-connect/sdk'

const client = new InboxFM({
    baseUrl: 'https://connect.yourdomain.com/api',
    apiKey: process.env.INBOXFM_PROJECT_API_KEY!,
    projectId: 'proj_enterprise_01',
})

// Call any Slack endpoint on behalf of customer "cust_42"
const response = await client.proxy({
    externalUserId: 'cust_42',
    provider: 'slack',
    method: 'GET',
    path: '/conversations.list',
    query: {
        types: 'public_channel,private_channel',
        limit: 50,
    },
})

console.log('Channels:', response.data)
```
