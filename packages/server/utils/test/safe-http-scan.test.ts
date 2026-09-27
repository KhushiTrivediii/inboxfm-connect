import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

type Violation = {
    file: string
    line: number
    rule: string
    codeSnippet: string
}

function scanFile(filePath: string): Violation[] {
    const content = fs.readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
    const violations: Violation[] = []

    const normalizedPath = filePath.replace(/\\/g, '/')
    const isSafeHttpSource = normalizedPath.endsWith('/safe-http.ts')

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            const expr = node.expression

            // 1. Direct fetch(...) call
            if (ts.isIdentifier(expr) && expr.text === 'fetch') {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
                violations.push({
                    file: filePath,
                    line: line + 1,
                    rule: 'NO_RAW_FETCH',
                    codeSnippet: node.getText(sourceFile).slice(0, 100),
                })
            }

            // 2. Direct axios calls: axios.create, axios.get, axios.post, etc.
            if (ts.isPropertyAccessExpression(expr)) {
                const targetObj = expr.expression
                const method = expr.name.text

                if (ts.isIdentifier(targetObj) && targetObj.text === 'axios') {
                    if (method === 'create' && !isSafeHttpSource) {
                        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
                        violations.push({
                            file: filePath,
                            line: line + 1,
                            rule: 'NO_RAW_AXIOS_CREATE',
                            codeSnippet: node.getText(sourceFile).slice(0, 100),
                        })
                    }
                    else if (['get', 'post', 'put', 'patch', 'delete', 'request', 'head'].includes(method)) {
                        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
                        violations.push({
                            file: filePath,
                            line: line + 1,
                            rule: 'NO_RAW_AXIOS_HTTP_CALL',
                            codeSnippet: node.getText(sourceFile).slice(0, 100),
                        })
                    }
                }
            }
        }

        ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return violations
}

function findSourceFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const results: string[] = []
    const entries = fs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== 'test' && entry.name !== 'tests') {
                results.push(...findSourceFiles(fullPath))
            }
        }
        else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
            if (!entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts')) {
                results.push(fullPath)
            }
        }
    }
    return results
}

function findMonorepoRoot(startDir: string): string {
    let current = startDir
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'packages'))) {
            return current
        }
        current = path.dirname(current)
    }
    throw new Error('Monorepo root not found')
}

describe('SSRF Guard: Repo-wide no-raw-fetch & no-raw-axios scan', () => {
    const rootDir = findMonorepoRoot(__dirname)
    const targetDirs = [
        path.join(rootDir, 'packages/server/api/src'),
        path.join(rootDir, 'packages/server/utils/src'),
    ]

    it('finds and scans all server package source files', () => {
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
