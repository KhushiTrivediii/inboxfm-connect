# FlowScript developer setup

## Prerequisites

- Bun 1.3.3, matching the repository package manager.
- Node.js 22 for the production service image.
- Docker Compose and access to Postgres for hosted API work.
- Root repository environment variables and dependencies.

## Workspace commands

Run from the repository root:

    bun install
    bun run --cwd services/flowscript build
    bun run --cwd services/flowscript test
    bun run --cwd services/flowscript lint
    bun run --cwd services/flowscript dev

After a successful build, exercise the CLI:

    node services/flowscript/dist/cli.js lint services/flowscript/examples/manual.flow
    node services/flowscript/dist/cli.js compile services/flowscript/examples/manual.flow
    node services/flowscript/dist/cli.js test services/flowscript/examples/manual.flow
    node services/flowscript/dist/cli.js run services/flowscript/examples/manual.flow

The source currently uses YAML syntax despite the .flow extension. That is deliberate for the initial compiler slice. Do not introduce a custom parser until the IR contract and diagnostics are stable.

## Service containers

    docker compose config
    docker compose build flowscript flowscript-worker
    docker compose up -d postgres flowscript flowscript-worker
    docker compose logs -f flowscript-worker

The API uses expose on port 8081, not a host-published ports mapping. Do not publish it directly to the internet in production.

## Contribution rules

1. Add or update tests with every language/runtime behavior change.
2. Keep the IR version explicit. Incompatible changes require a new version and migration plan.
3. Never use eval, Function, dynamic import of user source, shell execution or arbitrary code execution.
4. Resolve integrations only through existing Connect metadata/runtime/connection interfaces.
5. Do not log secrets or unredacted sensitive payloads.
6. Add DB schema changes as migrations once moving beyond prototype schema bootstrap.
7. Document API behavior and update acceptance criteria.
8. Run service build/test and relevant root CI checks before review.
9. Do not claim an integration, trigger or deployment works until tested end-to-end.
10. Keep service dependencies minimal and pinned under repository lockfile policy.

## Current CI blocker

The latest known CI failed before project checks because bun install --frozen-lockfile reported that the lockfile changed. Regenerate bun.lock with Bun 1.3.3, inspect the diff, commit it, then verify frozen install. Do not bypass frozen-lockfile CI.
