import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findMonorepoRoot, findSourceFiles, scanFile, type Violation } from '../../../../../utils/test/ssrf-scanner-helper'

/**
 * SSRF Guard Enforcement Test Suite
 *
 * Scope: Outbound HTTP network requests across host server packages (packages/server/{api,utils}/src).
 * Note: packages/server/engine and packages/server/sandbox execute worker tasks and piece/registry operations
 * which are tracked for worker-level migration in follow-up issues (#123-#146 range).
 */
describe('SSRF Guard Enforcement (packages/server/{api,utils})', () => {
    const rootDir = findMonorepoRoot(__dirname)
    const targetDirs = [
        path.join(rootDir, 'packages/server/api/src'),
        path.join(rootDir, 'packages/server/utils/src'),
    ]

    it('scans all server package source files and finds non-empty set', () => {
        const allFiles = targetDirs.flatMap(findSourceFiles)
        expect(allFiles.length).toBeGreaterThan(50)
    })

    it('enforces zero raw fetch or raw axios calls across server packages', () => {
        const allFiles = targetDirs.flatMap(findSourceFiles)
        const allViolations: Violation[] = []

        for (const file of allFiles) {
            const violations = scanFile(file)
            allViolations.push(...violations)
        }

        if (allViolations.length > 0) {
            const formatted = allViolations
                .map((v) => `  - [${v.rule}] ${v.file}:${v.line} -> ${v.codeSnippet}`)
                .join('\n')
            expect.fail(
                `SSRF security rule violated: found ${allViolations.length} raw outbound call(s) bypassing safeHttp SSRF filtering.\n` +
                `Use safeHttp.axios or safeHttp.createAxios({ ... }) from @inboxfm-connect/server-utils instead.\n\n` +
                `Violations:\n${formatted}`,
            )
        }

        expect(allViolations).toHaveLength(0)
    })
})
