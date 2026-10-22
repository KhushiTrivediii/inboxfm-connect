import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const build = spawnSync('bun', ['x', 'turbo', 'run', 'build', '--concurrency=2', '--filter=api', '--filter=@inboxfm-connect/piece-text-helper'], { stdio: 'inherit' })
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config=packages/tests-e2e/playwright.config.ts', ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
