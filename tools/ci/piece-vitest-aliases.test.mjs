import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

// Every piece's `vitest.config.ts` aliases `@inboxfm-connect/pieces-framework` and
// `@inboxfm-connect/pieces-common` at the framework's *source* so a suite can run
// without a build step. Eighteen of those configs pointed at `packages/pieces/...`,
// which does not exist — the framework lives at `packages/integrations/framework` and
// the shared piece helpers at `packages/integrations/common`.
//
// The failure was total and silent-by-omission: those suites are not in any CI job, so
// nothing ran them. In `piece-text-helper` the result was `Test Files 11 failed (11)`
// with `Tests no tests` — every file died at import on
// `Cannot find module '@inboxfm-connect/pieces-framework'`, before a single assertion ran.
//
// This asserts the alias targets exist on disk. It is filesystem-based rather than
// GitHub-API-based so it runs in the licensing job with no network.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PIECES_DIR = path.join(REPO_ROOT, 'packages', 'integrations')

/** Every `vitest.config.ts` under packages/integrations. */
function pieceConfigs(dir = PIECES_DIR, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            pieceConfigs(entryPath, found)
        }
        else if (entry.name === 'vitest.config.ts') {
            found.push(entryPath)
        }
    }
    return found
}

describe('piece vitest configs', () => {
    const configs = pieceConfigs()

    it('finds the piece configs', () => {
        assert.ok(configs.length >= 18, `only found ${configs.length} vitest configs`)
    })

    it('aliases only paths that exist', () => {
        const broken = []
        for (const configPath of configs) {
            const source = fs.readFileSync(configPath, 'utf8')
            // Match `path.resolve(repoRoot, '<some/path>')` targets.
            for (const match of source.matchAll(/path\.resolve\(\s*repoRoot\s*,\s*'([^']+)'\s*\)/g)) {
                const target = path.join(REPO_ROOT, match[1])
                if (!fs.existsSync(target)) {
                    broken.push(`${path.relative(REPO_ROOT, configPath)} -> ${match[1]}`)
                }
            }
        }
        assert.deepEqual(broken, [],
            `vitest configs alias paths that do not exist:\n  ${broken.join('\n  ')}`)
    })

    it('does not reference the removed packages/pieces tree', () => {
        const stale = []
        for (const configPath of configs) {
            const source = fs.readFileSync(configPath, 'utf8')
            if (source.includes('packages/pieces/')) {
                stale.push(path.relative(REPO_ROOT, configPath))
            }
        }
        assert.deepEqual(stale, [],
            `configs still point at packages/pieces/, which was moved to packages/integrations/:\n  ${stale.join('\n  ')}`)
    })
})