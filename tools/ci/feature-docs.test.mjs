import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FEATURES_DIR = path.join(REPO_ROOT, '.agents', 'features')

// Ratchet baseline: count of unresolved `packages/**.ts` file references across
// `.agents/features/*.md`. This count must only decrease over time.
// Baseline before cleanup: 185 missing of 372 references (Issue #346).
// After pruning removed flow/worker docs and repairing known paths: 137.
const MAX_UNRESOLVED_REFS = 137

describe('feature documentation reference integrity (Issue #346)', () => {
    it('does not retain documentation for removed upstream modules', () => {
        const removedDocs = ['workers.md', 'flows.md', 'flow-runs.md', 'triggers.md']
        const presentRemovedDocs = removedDocs.filter((doc) => fs.existsSync(path.join(FEATURES_DIR, doc)))

        assert.deepEqual(
            presentRemovedDocs,
            [],
            `Found feature documentation for removed upstream modules: ${presentRemovedDocs.join(', ')}`,
        )
    })

    it('reports unresolved file references and enforces the ratchet threshold', () => {
        const docFiles = fs.readdirSync(FEATURES_DIR).filter((file) => file.endsWith('.md'))
        const pathRegex = /`(packages\/[^\s`*]+\.ts)`/g

        let totalRefs = 0
        const missingRefs = []

        for (const file of docFiles) {
            const content = fs.readFileSync(path.join(FEATURES_DIR, file), 'utf8')
            let match
            while ((match = pathRegex.exec(content)) !== null) {
                totalRefs++
                const ref = match[1].replace(/#.*$/, '').replace(/[:;,]$/, '')
                const resolved = path.join(REPO_ROOT, ref)
                if (!fs.existsSync(resolved)) {
                    missingRefs.push({ file, ref })
                }
            }
        }

        const missingCount = missingRefs.length
        console.log(`[feature-docs ratchet] Total references: ${totalRefs}, Resolved: ${totalRefs - missingCount}, Unresolved: ${missingCount}, Ceiling: ${MAX_UNRESOLVED_REFS}`)

        assert.ok(
            missingCount <= MAX_UNRESOLVED_REFS,
            `Unresolved file references in .agents/features/*.md increased from ${MAX_UNRESOLVED_REFS} to ${missingCount}. Fix or prune new broken references:\n` +
                missingRefs.map((m) => `  ${m.file}: ${m.ref}`).join('\n'),
        )
    })
})
