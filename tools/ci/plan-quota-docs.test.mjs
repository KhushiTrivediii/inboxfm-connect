import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

// AGENTS.md tells every agent to read `.agents/features/<name>.md` before changing a
// module and to trust it for "entities, services, and integration details". A doc that
// claims a guard is wired to a call path it does not have sends the next agent looking for
// an enforcement that does not exist — that is how #20's `checkActiveFlowsExceededLimit`
// came to be documented as "called when enabling/publishing flows" with zero call sites.
//
// This guards the platform-plan quota surface specifically. The scan is not repo-wide on
// purpose: `.agents/features/workers.md` makes a similar unverified claim about
// `primeFullContainerMemory`, which is a separate defect and is tracked on its own issue.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FEATURE_DOC = '.agents/features/ee-platform.md'

function collectSourceFiles(dir, collected = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // `dist` too: tsc emits declarations into `dist/src/**/*.d.ts` (tsconfig.app.json has
        // rootDir ".", outDir "./dist", declaration: true), and a `.d.ts` name passes the
        // `.ts`/`.tsx` filter below with `src` still in its path. After any local build,
        // platform-plan.service.d.ts would sit next to the real source and double-count the
        // identifier, flipping the "wired vs vestigial" branch below purely on build state.
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
        const entryPath = path.join(dir, entry.name)
        if (entry.isDirectory()) collectSourceFiles(entryPath, collected)
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) collected.push(entryPath)
    }
    return collected
}

function filesMentioning(identifier, sources) {
    // No `g` flag: with it, `.test` is stateful across files (lastIndex persists after a
    // match), so a file whose mention sits before the previous file's match end is missed
    // and the identifier is undercounted — the wrong branch below can then pass.
    const pattern = new RegExp(`\\b${identifier}\\b`)
    return sources.filter((file) => pattern.test(fs.readFileSync(file, 'utf8')))
}

describe('platform-plan feature documentation', () => {
    const doc = fs.readFileSync(path.join(REPO_ROOT, FEATURE_DOC), 'utf8')
    const sources = collectSourceFiles(path.join(REPO_ROOT, 'packages')).filter((file) => file.includes(`${path.sep}src${path.sep}`))

    it('documents checkActiveFlowsExceededLimit as unwired, or wires it', () => {
        const claimLine = doc.split('\n').find((line) => line.includes('`checkActiveFlowsExceededLimit()`'))
        assert.ok(claimLine, 'expected ee-platform.md to describe checkActiveFlowsExceededLimit')

        // "Wired" means referenced from a file other than the one that defines it. Counting
        // occurrences instead would be fooled by the identifier appearing in its own comments.
        const declaringFiles = filesMentioning('checkActiveFlowsExceededLimit', sources)
        const claimsItIsCalled = /\bis called\b|\b-called\b|called when/.test(claimLine)

        if (declaringFiles.length > 1) {
            assert.ok(
                claimsItIsCalled,
                `checkActiveFlowsExceededLimit is now referenced from ${declaringFiles.length} source files, so ee-platform.md should say where it is called instead of describing it as vestigial`,
            )
            return
        }

        assert.ok(
            /not called from anywhere/i.test(claimLine),
            `ee-platform.md claims checkActiveFlowsExceededLimit is wired, but it appears in only one source file (its own definition), so it has no call site. Update the doc to say it is not called, or add the call site.`,
        )
    })

    it('does not claim the active-flows quota is enforced anywhere', () => {
        const enforcementClaims = doc
            .split('\n')
            .filter((line) => /activeFlows/i.test(line))
            .filter((line) => /\benforce[ds]?\b|\bcount(s|ed)? against\b/i.test(line))
            .filter((line) => !/not enforced|never enforced|nothing counts/i.test(line))

        assert.deepEqual(
            enforcementClaims,
            [],
            `ee-platform.md still asserts active-flows quota enforcement, which does not exist (#20):\n  ${enforcementClaims.join('\n  ')}`,
        )
    })
})
