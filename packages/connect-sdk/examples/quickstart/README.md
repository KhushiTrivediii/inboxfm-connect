# Connect SDK quickstart

A command-line run of the full Connect cycle with `@inboxfm-connect/sdk`:

1. Authenticate with a project-scoped Connect API key (`cak-...`).
2. Look up the end-user's active connection for the integration. If there isn't one, create a connect session, print its `connectUrl`, and poll until the user finishes connecting in their browser.
3. List the integration's tools and check that the input you passed covers the chosen tool's required fields.
4. Run the tool and print its output. On failure, print a readable message for each `ConnectError` category.

`agent-cycle.ts` holds the SDK calls. `main.ts` reads the configuration and reports errors.

## Run

From the repository root:

```bash
INBOXFM_BASE_URL=https://connect.example.com/api \
INBOXFM_API_KEY=cak-... \
INBOXFM_PROJECT_ID=... \
INBOXFM_INTEGRATION=@inboxfm-connect/piece-slack \
INBOXFM_TOOL=send_channel_message \
INBOXFM_TOOL_INPUT='{"channel":"C123","text":"hi","sendAsBot":true}' \
npm run example:quickstart --workspace=@inboxfm-connect/sdk
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `INBOXFM_BASE_URL` | yes | | API root including `/api` |
| `INBOXFM_API_KEY` | yes | | Connect API key for the project |
| `INBOXFM_PROJECT_ID` | yes | | Project the key belongs to |
| `INBOXFM_INTEGRATION` | yes | | Integration name, e.g. `@inboxfm-connect/piece-slack` |
| `INBOXFM_TOOL` | yes | | Tool name as returned by `listTools` |
| `INBOXFM_TOOL_INPUT` | no | `{}` | JSON object of tool inputs |
| `INBOXFM_EXTERNAL_USER_ID` | no | `quickstart-user` | Your identifier for the end-user |
| `INBOXFM_CONNECT_TIMEOUT_SECONDS` | no | `300` | How long to wait for the user to connect |

The example imports the SDK source directly through `tsconfig.test.json` path mapping, so it needs no build step. `test/example-quickstart.test.ts` runs `runAgentCycle` against a local HTTP fixture of the Connect API on every SDK test run.
