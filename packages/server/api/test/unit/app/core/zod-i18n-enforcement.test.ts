import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

export type AllowlistEntry = {
    file: string
    msg: string
    rationale: string
}

/**
 * Allowlist for internal-only, developer-facing, or LLM-prompt validation messages.
 * Every entry MUST provide a concrete rationale explaining why the message is
 * not rendered in the end-user dashboard and does not require translation.
 */
export const I18N_ALLOWLIST: readonly AllowlistEntry[] = [
    {
        file: 'packages/core/shared/src/lib/management/project/project-replace.ts',
        msg: 'Archive base64 payload exceeds 15MB limit',
        rationale: 'CLI project replacement snapshot validation error payload returned to operators.',
    },
    {
        file: 'packages/core/shared/src/lib/connect-proxy/index.ts',
        msg: 'Path must be a relative path and cannot contain an absolute URL scheme',
        rationale: 'Connect proxy REST API validation error message returned to developer clients calling the proxy endpoint.',
    },
    {
        file: 'packages/core/shared/src/lib/connect-proxy/index.ts',
        msg: 'Path cannot contain backslashes',
        rationale: 'Connect proxy REST API validation error message returned to developer clients calling the proxy endpoint.',
    },
    {
        file: 'packages/core/shared/src/lib/connect-proxy/index.ts',
        msg: 'Path cannot contain control characters',
        rationale: 'Connect proxy REST API validation error message returned to developer clients calling the proxy endpoint.',
    },
    {
        file: 'packages/core/shared/src/lib/connect-proxy/index.ts',
        msg: 'Path cannot contain directory traversal elements ("..")',
        rationale: 'Connect proxy REST API validation error message returned to developer clients calling the proxy endpoint.',
    },
    {
        file: 'packages/server/api/src/app/mcp/oauth/client/mcp-oauth-register.controller.ts',
        msg: 'Only https, loopback http (RFC 8252), or private-use URI schemes are allowed',
        rationale: 'RFC 8252 OAuth client redirect URI validation message returned in developer API error response.',
    },
    {
        file: 'packages/server/api/src/app/mcp/tools/mcp-utils.ts',
        msg: "firstValue must be a non-empty string or template expression (e.g. {{trigger['output'].field}})",
        rationale: 'MCP tool execution prompt instruction provided to external LLM clients.',
    },
    {
        file: 'packages/server/api/src/app/mcp/tools/mcp-utils.ts',
        msg: 'secondValue must be a non-empty string when provided',
        rationale: 'MCP tool execution prompt instruction provided to external LLM clients.',
    },
    {
        file: 'packages/server/api/src/app/mcp/tools/mcp-utils.ts',
        msg: 'operator is required when secondValue is provided — pick a comparison operator (e.g. TEXT_CONTAINS, TEXT_EXACTLY_MATCHES, NUMBER_IS_EQUAL_TO).',
        rationale: 'MCP tool execution prompt instruction provided to external LLM clients.',
    },
]

export type ZodMessageViolation = {
    file: string
    line: number
    method: string
    msg: string
}

export function isAllowlisted({ file, msg }: { file: string, msg: string }): boolean {
    const normalizedFile = file.replace(/\\/g, '/')
    return I18N_ALLOWLIST.some((entry) => {
        const normalizedEntryFile = entry.file.replace(/\\/g, '/')
        return normalizedFile.includes(normalizedEntryFile) && entry.msg === msg && entry.rationale.trim().length > 0
    })
}

export function scanSourceForZodMessages({
    filePath,
    content,
    validTranslationKeys,
}: {
    filePath: string
    content: string
    validTranslationKeys: Set<string>
}): ZodMessageViolation[] {
    const violations: ZodMessageViolation[] = []
    if (!content.includes('z.') && !content.includes('refine') && !content.includes('addIssue')) {
        return violations
    }

    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)

    function recordIfViolation(msgStr: string, node: ts.Node, method: string) {
        if (!validTranslationKeys.has(msgStr) && !isAllowlisted({ file: filePath, msg: msgStr })) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            violations.push({
                file: filePath,
                line: line + 1,
                method,
                msg: msgStr,
            })
        }
    }

    function checkCall(node: ts.CallExpression) {
        if (!ts.isPropertyAccessExpression(node.expression)) {
            return
        }

        const methodName = node.expression.name.text
        if (['min', 'max', 'length', 'refine', 'superRefine', 'regex', 'email', 'url'].includes(methodName)) {
            for (const arg of node.arguments) {
                if (ts.isStringLiteral(arg)) {
                    recordIfViolation(arg.text, arg, methodName)
                } else if (ts.isObjectLiteralExpression(arg)) {
                    for (const prop of arg.properties) {
                        if (
                            ts.isPropertyAssignment(prop) &&
                            ts.isIdentifier(prop.name) &&
                            ['message', 'required_error', 'invalid_type_error'].includes(prop.name.text) &&
                            ts.isStringLiteral(prop.initializer)
                        ) {
                            recordIfViolation(prop.initializer.text, prop.initializer, methodName)
                        }
                    }
                }
            }
        } else if (methodName === 'addIssue') {
            for (const arg of node.arguments) {
                if (ts.isObjectLiteralExpression(arg)) {
                    for (const prop of arg.properties) {
                        if (
                            ts.isPropertyAssignment(prop) &&
                            ts.isIdentifier(prop.name) &&
                            prop.name.text === 'message' &&
                            ts.isStringLiteral(prop.initializer)
                        ) {
                            recordIfViolation(prop.initializer.text, prop.initializer, 'addIssue')
                        }
                    }
                }
            }
        }
    }

    function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
            checkCall(node)
        }
        ts.forEachChild(node, visit)
    }

    visit(sourceFile)
    return violations
}

function findSourceFiles(dir: string): string[] {
    const results: string[] = []
    if (!fs.existsSync(dir)) {
        return results
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (!['node_modules', 'dist', '.turbo', 'test', 'tests'].includes(entry.name)) {
                results.push(...findSourceFiles(full))
            }
        } else if (
            entry.name.endsWith('.ts') &&
            !entry.name.endsWith('.test.ts') &&
            !entry.name.endsWith('.spec.ts') &&
            !entry.name.endsWith('.d.ts') &&
            !full.includes('migration')
        ) {
            results.push(full)
        }
    }
    return results
}

function findRepoRoot(startDir: string): string {
    let current = startDir
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'packages'))) {
            return current
        }
        current = path.dirname(current)
    }
    return process.cwd()
}

describe('Zod i18n message contract (AGENTS.md enforcement)', () => {
    const repoRoot = findRepoRoot(__dirname)
    const translationPath = path.join(repoRoot, 'packages/web/public/locales/en/translation.json')
    const translationJson = JSON.parse(fs.readFileSync(translationPath, 'utf-8'))
    const validKeys = new Set<string>(Object.keys(translationJson))

    it('enforces that all user-facing Zod error messages in packages/{core,server} are translation keys or allowlisted', () => {
        const coreFiles = findSourceFiles(path.join(repoRoot, 'packages/core'))
        const serverFiles = findSourceFiles(path.join(repoRoot, 'packages/server'))
        const allFiles = [...coreFiles, ...serverFiles]

        expect(allFiles.length).toBeGreaterThan(100)

        const allViolations: ZodMessageViolation[] = []

        for (const file of allFiles) {
            const content = fs.readFileSync(file, 'utf-8')
            const violations = scanSourceForZodMessages({
                filePath: file,
                content,
                validTranslationKeys: validKeys,
            })
            allViolations.push(...violations)
        }

        if (allViolations.length > 0) {
            const formatted = allViolations
                .map((v) => `  - ${path.relative(repoRoot, v.file)}:${v.line} [${v.method}] -> "${v.msg}"`)
                .join('\n')

            const diagnostic = [
                `Found ${allViolations.length} Zod error messages that are not translation keys in packages/web/public/locales/en/translation.json:`,
                formatted,
                '',
                'Fix:',
                '  1. If this message is shown to users, add its key to packages/web/public/locales/en/translation.json and formErrors in @inboxfm-connect/shared.',
                '  2. If this message is internal-only or developer-facing, add it to I18N_ALLOWLIST in zod-i18n-enforcement.test.ts with a documented rationale.',
            ].join('\n')

            expect.fail(diagnostic)
        }

        expect(allViolations).toHaveLength(0)
    })

    describe('scanner logic unit tests', () => {
        it('allows known translation keys and formErrors constants', () => {
            const snippet = `
                import { z } from 'zod'
                export const testSchema = z.string().min(1, 'required')
            `
            const violations = scanSourceForZodMessages({
                filePath: 'packages/server/api/src/app/sample.ts',
                content: snippet,
                validTranslationKeys: validKeys,
            })
            expect(violations).toHaveLength(0)
        })

        it('detects un-translated raw English strings in .refine and .min', () => {
            const snippet = `
                import { z } from 'zod'
                export const schemaA = z.string().min(1, 'Must not be empty raw english')
                export const schemaB = z.string().refine(() => true, { message: 'Raw un-translated message' })
            `
            const violations = scanSourceForZodMessages({
                filePath: 'packages/server/api/src/app/sample.ts',
                content: snippet,
                validTranslationKeys: validKeys,
            })
            expect(violations).toHaveLength(2)
            expect(violations[0].msg).toBe('Must not be empty raw english')
            expect(violations[1].msg).toBe('Raw un-translated message')
        })

        it('permits allowlisted entries with valid rationale', () => {
            const entry = I18N_ALLOWLIST[0]
            expect(entry.rationale.trim().length).toBeGreaterThan(10)

            const snippet = `
                import { z } from 'zod'
                export const s = z.string().max(100, '${entry.msg}')
            `
            const violations = scanSourceForZodMessages({
                filePath: path.join(repoRoot, entry.file),
                content: snippet,
                validTranslationKeys: validKeys,
            })
            expect(violations).toHaveLength(0)
        })
    })
})
