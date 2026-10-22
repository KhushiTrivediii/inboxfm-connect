# Connect acceptance journey

Issue #212 assembles the Connect contracts (owned by #135 and #133) into a
consumer-facing journey: a developer embeds Inboxfm Connect, its customers
connect their own accounts, and an integration action runs on their behalf.

## Reproducing the journey

The journey runs as an ordinary CE integration test. It needs no Postgres, no
Redis and no provider credentials — `.env.tests` points the suite at an embedded
PGLITE database and an in-memory Redis.

```bash
cd packages/server/api
set -a && . ./.env.tests && set +a   # on Windows, import each KEY=value into the process env
AP_EDITION=ce npx vitest run test/integration/ce/connect
```

Expected: 12 passing tests in `connect-acceptance-journey.test.ts`.

The suite drives the API exactly the way an embedded app does — a bare
`cak-` Connect API key held on the consumer's backend for session creation, and
the session token for everything the end-user's browser does. No platform user
session is ever used to create a connection.

## What the suite proves

| Journey step | Covered by | Endpoint |
| --- | --- | --- |
| Consumer project authenticates with its Connect API key | `mints a connect session from a Connect API key held on the consumer backend` | `POST /v1/connect-sessions` |
| Session restricts which integrations may be connected | `restricts the session to the integrations the consumer allowed` | `POST /v1/connect-sessions/:token/connections` |
| Operator configures an OAuth app and callback | `builds the provider authorization URL from the operator-configured OAuth app` | `POST /v1/connect-sessions/:token/oauth2/authorization-url` |
| Operator has not configured that piece | `refuses to authorize a piece the operator has not configured an OAuth app for` | `POST /v1/connect-sessions/:token/oauth2/authorization-url` |
| Two projects cannot substitute connection ids | `refuses to execute against a connection owned by another project` | `POST /v1/execute` |
| Two customers cannot substitute connection ids | `refuses an explicit connectionId paired with a different customer id` | `POST /v1/execute` |
| A connection cannot be reused across pieces | `refuses an explicit connectionId minted for a different piece` | `POST /v1/execute` |
| `externalUserId` resolution stays within the customer | `refuses to resolve another customer connection through externalUserId` | `POST /v1/execute` |
| Session token cannot be re-scoped by the caller | `ignores projectId and externalUserId supplied in the redemption body — the session wins` | `POST /v1/connect-sessions/:token/connections` |
| Session expiry, repeated redemption, concurrent redemption | `expires a session once its TTL has passed`, `refuses to redeem a session twice`, `ends the journey with the session consumed exactly once when two redemptions race` | `POST /v1/connect-sessions/:token/connections` |
| Credentials stay out of responses | `never returns the Connect API key hash, the session token hash, or the connection secret` | session create/get, redemption |

### Resolution rules the isolation tests pin down

`POST /v1/execute` accepts a `connectionId` **or** a `pieceName` +
`externalUserId`:

- An explicit `connectionId` is re-resolved against the authorized project,
  platform, and `pieceName` before use. It is an opaque handle, not proof of
  ownership, so a connection id from another project — or minted for a
  different integration in the same project — resolves to `ENTITY_NOT_FOUND`
  (404) and never reaches the runtime.
- When both `connectionId` and `externalUserId` are supplied, the connection's
  `externalId` must match, so a connection id for one customer cannot be redeemed
  on behalf of another.
- The `externalUserId` path already filters on `projectIds` + `pieceName` +
  `externalId`, so an unknown customer resolves to 404 rather than leaking
  existence.
- Redemption derives `projectId` and `externalUserId` from the session. Values
  posted in the redemption body are validated against the request schema but are
  never used to place the connection.

Both paths return the same `ENTITY_NOT_FOUND` shape, so a cross-tenant probe is
indistinguishable from a connection that does not exist.

## Not covered in CI

CI must stay deterministic and must not need provider secrets, so the following
are deliberately out of scope here (acceptance criterion: *"a separate controlled
provider smoke environment supplies live OAuth evidence"*):

- Live provider authorization-code exchange, token refresh failures, and
  provider-side errors.
- Live tool discovery and execution against a real provider account.
- Reconnect/revocation against a live provider token.

Live and consumer-side evidence for those lives in the Connect SDK smoke
scripts, which are run separately with real credentials and are never part of the
fork PR path:

- `packages/connect-sdk/test/consumer-smoke.mjs`
- `packages/connect-sdk/test/live-smoke.mjs`

The deterministic suite also uses a synthetic `CUSTOM` piece row for
`pieceMetadata` rather than a published integration: the piece registry only
resolves `OFFICIAL` pieces with no platform, or `CUSTOM` pieces bound to the
platform, so this is the shape that actually resolves in-process.

## Provider and tool versions

The journey does not pin a specific provider. `pieceVersion` is whatever the
consumer passes on the redemption body, and the authorization URL is derived from
the operator's `connect_oauth_app` row for that `pieceName` on that platform. Live
provider/tool version evidence belongs to the smoke environment above.
