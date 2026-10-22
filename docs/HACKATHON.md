# Hackathon and first contribution guide

Build a local demo with the headless API, SDK, MCP, or integration framework. This is a development preview with inherited Enterprise material; read [LICENSING.md](../LICENSING.md), work outside the restricted directories, and use development/test accounts and data.

## Set up development

Use Node 24, Bun 1.3.3, Git, and Python plus a C/C++ toolchain for native dependencies. Linux/macOS or WSL2 is recommended. CI uses Linux; API scripts contain shell commands that do not run directly in PowerShell.

Create your branch from this repository's latest `dev`, following [CONTRIBUTING.md](../CONTRIBUTING.md). Configure these settings in your local `.env.dev`:

```dotenv
AP_EDITION=ce
AP_ENVIRONMENT=dev
AP_DB_TYPE=PGLITE
AP_REDIS_TYPE=MEMORY
AP_EXECUTION_MODE=UNSANDBOXED
AP_DEV_PIECES=text-helper,store
AP_PIECES_SYNC_MODE=NONE
AP_TELEMETRY_ENABLED=false
AP_FRONTEND_URL=http://localhost:4200
```

These settings use embedded PostgreSQL and memory Redis for the demo. Native dependencies still need to build. For standalone services, configure your own matching PostgreSQL/Redis settings instead.

```bash
# Terminal 1: initial installation, development integrations, API and engine
npm start

# Terminal 2: dashboard
bun x turbo run serve --filter=@inboxfm-connect/web
```

Open `http://localhost:4200`; the backend listens on port 3000. Keep both processes running. After initial setup, `npm run dev` starts the backend again.

The checked-in development credentials are for local work only. Keep changes to `.env.dev` out of your PR and never commit real provider tokens.

## First demo

1. Create a local account/project in the dashboard.
2. Create a project-scoped Connect API key and keep it in a server-side environment variable.
3. Try Text Helper tool discovery and an action using the [SDK quickstart](../packages/connect-sdk/README.md) or [runnable example](../packages/connect-sdk/examples/quickstart).
4. For an external integration, use a sandbox account and a connection session.
5. For MCP, configure a server in the dashboard and follow the client connection instructions.

API-key or basic-auth integrations are the simplest starting point. OAuth credentials need a callback URL configured for your local instance. A local frontend pointed at the hosted cloud backend redirects OAuth back to that cloud instance.

## Small project ideas

| Idea | Starting point | Demo outcome |
| --- | --- | --- |
| Discover integration tools | `packages/connect-sdk` | List tools and required inputs |
| Table-backed assistant | API `tables` module and MCP | Read/write your project's demo records |
| Add an integration action | `packages/integrations/community` | Execute an action with a sandbox credential |
| Improve onboarding or errors | `packages/web` | Make a failure understandable and recoverable |
| Add a regression test | API unit/integration tests | Demonstrate a bug and its tested fix |

Check the [issue tracker](https://github.com/Mihir-Rabari/inboxfm-connect/issues) and open PRs before starting. Avoid broad Enterprise removal or production billing work during a short event.

## Submit your work

- Use your own accounts and disposable data; keep keys off slides, screenshots, logs, and browser bundles.
- Explain the user problem, show a complete working path, and describe limitations.
- Include reproducible setup steps.
- Run `npm run lint-dev` and the relevant tests; inspect your full Git diff.
- Open the PR against **`dev`**, reference its issue, and include validation results.
- Retain attribution and notices. A demo or passing CI does not clear Enterprise material for production.

## Troubleshooting

- **Integration missing:** add its folder name to `AP_DEV_PIECES`, rerun `npm start`, and restart.
- **Port 4200 closed:** start the separate web terminal. Backend commands do not start Vite.
- **Redis connection refused:** set `AP_REDIS_TYPE=MEMORY` for the demo or run the configured standalone service.
- **Native install failed:** install compiler/Python prerequisites and retry with the pinned toolchain on Linux/WSL2.
- **Tests differ from the app:** tests use `packages/server/api/.env.tests`; see [docs/CI.md](CI.md).
- **Security issue:** use the private channel in [SECURITY.md](../SECURITY.md).
