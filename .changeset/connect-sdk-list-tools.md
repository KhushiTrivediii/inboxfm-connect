---
"@inboxfm-connect/sdk": minor
---

Add `listTools({ integration, version? })`, which returns an integration's tools and their inputs. The types are generated from the integration metadata schemas. Add `cursor` and `limit` pagination to `listConnections`. Export the `ConnectionsPage` and `ServerErrorCode` types. Aborting a request while it waits between retries now rejects with a `ConnectError` of category `aborted` instead of the raw abort reason.
