# Continuous integration

The primary [CI workflow](../.github/workflows/ci.yml) runs on every PR without a branch or path filter, including drafts, and on pushes to `dev`/`main`, merge groups, and manual dispatch. GitHub may require approval before running workflows from a first-time fork contributor.

## Required suites

| Check | Purpose | Reproduce locally |
| --- | --- | --- |
| Repository policy | PR base, workflow syntax, license notices/new Enterprise imports, benchmark gate self-tests | `npm run check-licenses`, `npm run test-bench-gate` |
| Checks (quality) | Lint non-integration packages, web/SDK types, generated SDK contracts, app build, clean-consumer SDK verification | `node tools/ci/run-check.mjs quality` |
| Checks (unit) | Engine unit tests, shared, thin execution library, SDK, web, and API unit tests | `node tools/ci/run-check.mjs unit` |
| Checks (engine-integration) | Engine code sandbox integration tests | `node tools/ci/run-check.mjs engine-integration` |
| Checks (ce/ee/cloud) | An independent API integration job for each edition | `node tools/ci/run-check.mjs ce` (or `ee`/`cloud`) |
| Checks (migrations) | Apply migrations, detect schema drift, inspect new rollback metadata | `node tools/ci/run-check.mjs migrations` |
| Checks (integrations) | Lint changed integration packages; build all integrations when thin shared libraries, framework/common, compiler configuration, or dependencies change | `node tools/ci/run-check.mjs integrations` |
| tool-search (postgres) | Real PostgreSQL+pgvector driver behavior and database-only tests | Requires a PostgreSQL service with pgvector |
| Browser journey | Real sign-in, persisted scheduled automation, and Text Helper execution in Chromium, Firefox, and WebKit | `npm run test:e2e` |
| main | Aggregate gate; fails when any required job fails or is cancelled | Inspect the jobs above |

Every suite runs with Node 24 and Bun 1.3.3. Installs use `--frozen-lockfile`. Action versions in the primary workflow and setup action are pinned to commits. Only the Bun download cache is shared; built workspace output is not reused across concurrent suites.

Integration formatting checks cover changed packages. A change to the root lint/Prettier configuration expands lint to every integration. Root script changes and the thick application-level shared package do not expand integration builds; integrations depend on the thin libraries and framework. Existing untouched integration formatting debt needs its own cleanup; it is not rewritten during a CI or documentation change.

The jobs do not require publishing, cloud deployment, or paid cache credentials. Repository content permission is read-only, checkout credentials are not persisted, and untrusted PR code does not run through `pull_request_target` with deployment secrets.

PR edits validate the title and contribution destination using metadata only. A bot updating a PR description does not restart the full test matrix. Code changes, reopening, and marking a PR ready for review trigger content validation.

## Diagnostics and reproduction

Test and quality jobs save their console output as artifacts even on failure, together with any generated coverage/JUnit files. The PostgreSQL job saves its driver-test log. Artifacts are retained for seven days.

Set `CI_BASE_SHA` to the comparison commit when reproducing an integration/rollback check. CI chooses the PR's actual base commit, merge-group base, or push's previous commit. Local commands default to `origin/dev`; fetch that ref before running them.

```bash
git fetch origin dev
npm run lint-dev
node tools/ci/run-check.mjs quality
node tools/ci/run-check.mjs unit
node tools/ci/run-check.mjs migrations
```

API test configuration provides PGlite and memory Redis. Redis-memory-server is pinned to Redis 7.4.0 in CI so its install does not pull Redis 8's additional Rust-based modules. On Linux/macOS/WSL2, set `REDISMS_VERSION=7.4.0` before installation to reproduce the toolchain.

The migration checker applies migrations to a fresh temporary PGlite database, checks the resulting schema in a second CLI process, and removes its temporary data afterward. It does not use the developer's normal application database or ambient PostgreSQL credentials.

## Branch policy

Contributions target `dev`. A PR into `main` must originate from this repository's `dev` branch. Promote using a reviewed merge PR so commit history and attribution remain available.

The aggregate `main` check is suitable as a required branch-protection check, together with `Validate PR title`. Adding new suites automatically makes them part of the aggregate when they are included in its dependencies.

## Optional and inherited workflows

Publishing, previews, translations, and external monitoring have separate credentials and infrastructure. They are not prerequisites for a fork contributor's checks. A skipped deployment is not a test pass or a production-readiness statement.

Upstream-specific preview, browser-E2E, release, translation, and monitoring automations are archived as inactive templates in [`.github/legacy-workflows/`](../.github/legacy-workflows). These templates are not discovered by GitHub Actions. Do not enable them against Activepieces' domains, registries, or service accounts. Configure infrastructure owned by this fork and review their remaining source paths before reuse.

The public SDK release workflow has its own environment, smoke target, tag, and publishing gates; see [the SDK release documentation](../packages/connect-sdk/README.md). Benchmark self-tests run in primary CI; a configured performance environment is required for live regression runs.

## Browser checks

Install browser engines once, then run the journey from the repository root:

```bash
bun x playwright install --with-deps chromium firefox webkit
npm run test:e2e
# Focus one engine while debugging:
npm run test:e2e -- --project=chromium
```

The command builds the API and Text Helper, starts the compiled CE API and Vite frontend, and runs Playwright against loopback addresses. Each run owns a fresh temporary PGlite database, integration workspace, and runtime cache; it seeds the development user and removes the temporary directory on exit. The temporary workspace contains the actual compiled Text Helper and engine, so discovery stays limited to the integration being exercised. Vite's test mode disables the development auto-login shortcut. It does not reuse a running developer server or the normal development database. Both ports 3000 and 4200 must be free.

The journey uses actual authentication, automation persistence, a project-scoped no-auth connection, and the integration runtime. The scheduled automation is disabled to prevent background AI requests. The action runs locally and needs no provider credentials. Authentication and service responses are not mocked. This covers the current headless platform rather than the removed visual flow builder.

CI runs all three engines on every PR and requires the browser job through the aggregate `main` gate. Failure artifacts include the HTML report, screenshots, videos, and Playwright traces. Inspect a trace with `bun x playwright show-trace PATH_TO_TRACE.zip`. Traces can contain the temporary test user's token, so retain them only for the configured seven-day diagnostic window.
