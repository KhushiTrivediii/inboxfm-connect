import path from 'path'
import { defineConfig } from 'vitest/config'

// Change CWD to repo root for compatibility with piece-loader path resolution
const repoRoot = path.resolve(__dirname, '../../..')
process.chdir(repoRoot)

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        // ci.yml runs three heavy processes concurrently for this job's whole duration (engine+shared
        // unit tests, api's entire test-ce/test-ee/test-cloud/check-migrations run, and a separate
        // migration-rollback script — see the "Run all tests and migration checks in parallel" step),
        // on top of vitest's own fork pool below. Locally, every api test file completes in seconds
        // flat with no hang; in CI even a single Redis DELETE in a beforeEach has intermittently
        // exceeded 120s under that three-way contention. tool-search.test.ts already found this and
        // bumped its own beforeAll to 300_000 for the same reason — raise the shared default to match
        // instead of scattering more per-file overrides.
        testTimeout: 300000,
        hookTimeout: 300000,
        pool: 'forks',
        // Turbo already runs several packages' test suites concurrently in CI, so vitest's own
        // fork pool (which otherwise defaults to the detected CPU count) stacks a second layer of
        // parallelism on top and oversubscribes the runner — each api test file boots a full app +
        // 700+-piece sync. Capping to 2 concurrent forks still left two files (app-connection.test.ts,
        // tool-search.test.ts) blowing through the 120s hook/test timeout, so go down to one file
        // running at a time. maxForks: 1 (NOT singleFork — that collapses every file into one shared
        // OS process, and test-setup.ts's setupTestEnvironment() caches the booted app on `globalThis`
        // across files assuming each file gets a fresh process/fresh globalThis; under singleFork a
        // later file's fresh `job-handlers` module import never re-registers system job handlers
        // because the reused app's registration lives in the first file's module instances instead —
        // this broke tool-search-backfill.test.ts/tool-search-reindex-job.test.ts with "No handler for
        // job tool-search-reindex" when tried locally) still gives each file its own process, just one
        // at a time, so per-file isolation is preserved and every file still gets the full CPU share.
        poolOptions: {
            forks: {
                maxForks: 1,
            },
        },
        setupFiles: [path.resolve(__dirname, 'vitest.setup.ts').replaceAll('\\', '/')],
        include: [path.resolve(__dirname, 'test/**/*.test.ts').replaceAll('\\', '/')],
    },
    resolve: {
        alias: {
            'isolated-vm': path.resolve(__dirname, '__mocks__/isolated-vm.js'),
            '@inboxfm-connect/core-utils': path.resolve(__dirname, '../../../packages/core/utils/src/index.ts'),
            '@inboxfm-connect/core-execution': path.resolve(__dirname, '../../../packages/core/execution/src/index.ts'),
            '@inboxfm-connect/core-piece-types': path.resolve(__dirname, '../../../packages/core/piece-types/src/index.ts'),
            '@inboxfm-connect/shared': path.resolve(__dirname, '../../../packages/core/shared/src/index.ts'),
            '@inboxfm-connect/pieces-framework': path.resolve(__dirname, '../../../packages/integrations/framework/src/index.ts'),
            '@inboxfm-connect/pieces-common': path.resolve(__dirname, '../../../packages/integrations/common/src/index.ts'),
            '@inboxfm-connect/server-utils': path.resolve(__dirname, '../../../packages/server/utils/src/index.ts'),
            '@inboxfm-connect/scheduler': path.resolve(__dirname, '../../../packages/scheduler/src/index.ts'),
            '@inboxfm-connect/sandbox': path.resolve(__dirname, '../../../packages/server/sandbox/src/index.ts'),
            '@inboxfm-connect/runtime': path.resolve(__dirname, '../../../packages/runtime/src/index.ts'),

        },
    },
})
