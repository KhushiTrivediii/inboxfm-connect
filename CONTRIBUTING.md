# Contributing to Inboxfm Connect

Contributions to documentation, tests, integration actions, and the headless platform are welcome! Inboxfm Connect is an independent, community-driven fork building a headless AI integration platform. Please read [LICENSING.md](LICENSING.md) and adhere to the [Code of Conduct](.github/CODE_OF_CONDUCT.md).

---

## 🛠️ Prerequisites

Before getting started, ensure your local development environment meets the following requirements (for full system setup instructions and Docker Compose installation options, see [README.md](README.md)):

- **Node.js**: `v18.x`, `v22.x`, or `v24.x` (enforced by `tools/setup-dev.js`; Node 20 is strictly not supported by the build toolchain).
- **Bun**: `1.3.3` (required package manager pinned in `package.json`; auto-installed globally by `tools/setup-dev.js` if not found).
- **npm**: `>=9.0.0`
- **Database**: Zero-setup embedded PostgreSQL powered by **PGlite** (`AP_DB_TYPE=PGLITE` in `.env.dev`). External PostgreSQL `>=14` can be used via `AP_DB_TYPE=POSTGRES`. SQLite3 is deprecated and automatically migrated to PGLite.
- **Queue & Cache**: In-memory Redis queue by default (`AP_QUEUE_MODE=MEMORY`, `AP_REDIS_TYPE=MEMORY`). External Redis `>=6.0` is supported.
- **Operating System**: Linux, macOS, or WSL2 on Windows is strongly recommended for native module builds and shell-based scripts. Native modules may require Python and a C/C++ toolchain.

---

## 📖 Architecture & Standards

Before writing code or opening pull requests, consult the authoritative documentation on platform design, guidelines, and rules:
- [ARCHITECTURE.md](ARCHITECTURE.md): Platform architecture, module boundaries, tenant isolation, and service designs.
- [AGENTS.md](AGENTS.md): Development workflows, code review standards, and the regression-testing mandate.
- [.claude/rules/](.claude/rules/): Granular coding and architectural rules across backend, frontend, security, and integrations.
- [.agents/features/](.agents/features/): Feature specifications, domain playbooks, and subsystem guides.

---

## 🚀 Local Development Setup

### 1. Fork and Clone

Always branch from `upstream/dev`:

```bash
git clone https://github.com/YOUR_USERNAME/inboxfm-connect.git
cd inboxfm-connect
git remote add upstream https://github.com/Mihir-Rabari/inboxfm-connect.git
git fetch upstream
git switch -c fix/issue-123-short-description upstream/dev
```

### 2. First-Time Setup & Start

Run `npm start` to run the onboarding script `tools/setup-dev.js`, which verifies Node.js compatibility, ensures Bun is available, installs dependencies via `bun install --frozen-lockfile`, pre-builds development integrations specified in `AP_DEV_PIECES`, and launches the backend API and execution engine:

```bash
npm start
```

### 3. Start the Web Dashboard

In a separate terminal, start the React-based frontend dashboard:

```bash
bun x turbo run serve --filter=@inboxfm-connect/web
```

Open [http://localhost:4200](http://localhost:4200) in your browser. The backend REST API listens on port 3000 ([http://localhost:3000](http://localhost:3000)).

### 4. Subsequent Development Runs

Once dependencies and dev pieces are initialized, you can start the backend and engine directly without re-running full setup:

```bash
npm run dev
```

### 5. Environment Configuration

Configuration is controlled via `.env.dev`. Key settings:
- `AP_DEV_PIECES="google-sheets,store"`: Comma-separated piece folders to pre-build for faster local startup.
- `AP_DB_TYPE=PGLITE`: Default zero-setup embedded database stored at `./dev/config`.
- `AP_QUEUE_MODE=MEMORY` and `AP_REDIS_TYPE=MEMORY`: In-memory job execution for rapid local iteration.

---

## 🧩 Piece Development Quickstart

Integrations in Inboxfm Connect live under `packages/integrations/community/<piece-name>` (or `packages/integrations/core/<piece-name>`). For step-by-step guidance on piece architecture and action/trigger implementations, see [docs/build-pieces/building-pieces/development-setup.mdx](docs/build-pieces/building-pieces/development-setup.mdx) and [docs/build-pieces/building-pieces/start-building.mdx](docs/build-pieces/building-pieces/start-building.mdx).

### Creating a New Piece

1. Create a new directory under `packages/integrations/community/<piece-name>`.
2. Mirror the standard piece layout from an established piece (such as `packages/integrations/community/bexio` or `coupa`), providing:
   - `package.json` scoped as `@inboxfm-connect/piece-<name>`, importing `@inboxfm-connect/pieces-framework` and `@inboxfm-connect/pieces-common`, with scripts for `build`, `bundle`, `lint`, and `"test": "vitest run"`.
   - `tsconfig.json` and `tsconfig.lib.json`.
   - `src/index.ts` defining the piece via `createPiece(...)`.
   - `src/lib/actions/` and `src/lib/triggers/` defining piece operations.

> **Note on CLI Scaffolding**: The historical scaffolding script (`npm run create-piece`) targets the legacy `packages/pieces` folder rather than the active `packages/integrations` tree. Until the CLI is rewired, create new piece directories directly under `packages/integrations/community/` or `packages/integrations/core/` to ensure Turborepo, workspace resolution, and CI integration checks recognize them.

### Building & Testing Pieces

To build and bundle a piece:

```bash
bun x turbo run build bundle --filter=@inboxfm-connect/piece-<piece-name>
```

To run unit tests for a specific piece:

```bash
# Via turbo filter:
bun --filter=@inboxfm-connect/piece-<piece-name> test

# Or directly with vitest:
npx vitest run packages/integrations/community/<piece-name>
```

---

## 📐 Code & Security Guidelines

- **Tenant Isolation**: Every database query and business operation must strictly scope data access to `projectId` or `platformId`.
- **SSRF Guard**: All outbound server-side HTTP requests must use `safeHttp.axios` or `safeHttp.createAxios()` to prevent SSRF vulnerabilities.
- **TLS Verification**: Outbound integration HTTP requests strictly verify TLS certificates by default. Do not set `process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'`. For integrations against self-signed or private-CA endpoints, operators should set `NODE_EXTRA_CA_CERTS` or configure a custom undici `dispatcher` on `SendRequestOptions` with appropriate TLS options scoped strictly to the request.
- **Translation Keys**: User-facing validation messages must be translation keys.
- **Package Boundaries**: Keep integration pieces and the engine runtime decoupled from `@inboxfm-connect/shared`. Pieces must only import from `@inboxfm-connect/pieces-framework` and `@inboxfm-connect/pieces-common`.
- **Database Migrations**: Register every new TypeORM entity in `getEntities()` and provide matching TypeORM migration scripts. Consult [docs/handbook/engineering/playbooks/database-migration.mdx](docs/handbook/engineering/playbooks/database-migration.mdx).
- **Enterprise Boundary**: Never introduce new imports from `packages/ee/` into MIT-licensed packages (`packages/core`, `packages/integrations`, `packages/runtime`, `packages/server/engine`). See [LICENSING.md](LICENSING.md).
- **Credentials & Secrets**: Never commit real credentials, sensitive API keys, or private tokens.

---

## 🧪 Verification & Pre-PR Checks

This monorepo uses **Turborepo**. Before opening a pull request, run the following validation suite locally to guarantee a clean CI run:

```bash
# 1. Linting & formatting check
npm run lint-dev

# 2. Unit test suites
npm run test-unit

# 3. API integration tests (PGlite & memory Redis; runs check-migrations automatically)
npm run test-api

# 4. Standalone database migration integrity check
npm run check-migrations

# 5. Licensing boundary audit
npm run check-licenses
```

To run linting and typechecking specifically on the web dashboard:

```bash
bun x turbo run lint typecheck --filter=@inboxfm-connect/web
```

> **Testing Mandate**: Always include meaningful regression tests for behavior changes. Cover the edition and plan paths affected by a change, including CE, EE, and Cloud where applicable. Tests inside the PR provide the authoritative evidence for review and must pass cleanly in CI.

---

## 📝 Commit & PR Conventions

- **One Issue per PR**: Ensure every PR corresponds to a single tracked issue (`Resolves #123`). Check existing open issues and pull requests first to avoid duplicate efforts.
- **Branch Policy**: Always branch from `upstream/dev` and open pull requests targeting the **`dev`** branch. `main` is reserved for maintainer-reviewed promotion releases.
- **Commit Message Convention**: Commit messages are strictly validated by Commitlint and must follow the Conventional Commits specification under 100 characters:
  ```text
  <type>(<scope>): <subject> (#<issue>)
  ```
  Allowed types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `perf`, `ci`, `build`, `style`, `revert`. Including the issue trailer (`(#<issue>)`) is recommended.
  Example:
  ```text
  fix(infra): update setup-dev and crowdin to packages/integrations path (#179)
  ```
- **PR Description**: Include a clear summary of changes, problem addressed, resolution details, and reference the associated issue (`Resolves #123`).
- **PR Labels**: Pull requests are categorized by maintainers. These are the labels that
  actually exist in this repository — a label not listed here will not be applied.
  - Types: `bug`, `documentation`, `enhancement`, `feature`, `testing`, `skip-changelog`
  - Areas (`area:` prefix, note the colon): `area:server`, `area:web`, `area:engine`,
    `area:integrations`, `area:infra`, `area:docs`, `area:security`, `area:product`
  - Categories (`category:` prefix): `category:feature`, `category:engine`,
    `category:infra`, `category:docs`, `category:tests`, `category:security`,
    `category:i18n`, `category:rebrand`
  - Size: `size:XS` … `size:XXL` · Depth: `depth:trivial`, `depth:moderate`,
    `depth:substantial`, `depth:deep`
  - Process: `in-review`, `changes-requested`, `mergeable`

  Check the current list with `gh label list --repo Mihir-Rabari/inboxfm-connect` before
  assuming a label is available.

---

## 🔒 Security Reporting

Report security vulnerabilities privately as detailed in [SECURITY.md](SECURITY.md). Do not file public GitHub issues for security vulnerabilities.
