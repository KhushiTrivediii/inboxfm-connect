import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export type Violation = {
    file: string
    line: number
    rule: string
    codeSnippet: string
}

export function scanFile(filePath: string): Violation[] {
    const content = fs.readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true)
    const violations: Violation[] = []

    const normalizedPath = filePath.replace(/\\/g, '/')
    const isSafeHttpSource = normalizedPath.endsWith('/safe-http.ts')

    // Track axios alias identifiers (default: 'axios')
    const axiosAliases = new Set<string>(['axios'])

    // First pass: identify any alias imports or require bindings of 'axios'
    function findImports(node: ts.Node): void {
        if (ts.isImportDeclaration(node)) {
            const moduleSpecifier = node.moduleSpecifier
            if (ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === 'axios') {
                const importClause = node.importClause
                if (importClause) {
                    if (importClause.name) {
                        axiosAliases.add(importClause.name.text)
                    }
                    if (importClause.namedBindings) {
                        if (ts.isNamespaceImport(importClause.namedBindings)) {
                            axiosAliases.add(importClause.namedBindings.name.text)
                        }
                    }
                }
            }
        }
        else if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
            const call = node.initializer
            if (ts.isIdentifier(call.expression) && call.expression.text === 'require' && call.arguments.length > 0) {
                const arg = call.arguments[0]
                if (ts.isStringLiteral(arg) && arg.text === 'axios' && ts.isIdentifier(node.name)) {
                    axiosAliases.add(node.name.text)
                }
            }
        }
        ts.forEachChild(node, findImports)
    }

    findImports(sourceFile)

    // Second pass: scan AST for prohibited raw fetch and axios calls
    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
            const expr = node.expression

            // 1. Direct fetch(...) or property access (globalThis.fetch(...), window.fetch(...))
            if (ts.isIdentifier(expr) && expr.text === 'fetch') {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
                violations.push({
                    file: filePath,
                    line: line + 1,
                    rule: 'NO_RAW_FETCH',
                    codeSnippet: node.getText(sourceFile).slice(0, 100),
                })
            }
            else if (ts.isPropertyAccessExpression(expr) && expr.name.text === 'fetch') {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
                violations.push({
                    file: filePath,
                    line: line + 1,
                    rule: 'NO_RAW_FETCH',
                    codeSnippet: node.getText(sourceFile).slice(0, 100),
                })
            }

            // 2. Direct call of an axios alias, e.g. ax('http://...')
            if (ts.isIdentifier(expr) && axiosAliases.has(expr.text) && !isSafeHttpSource) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart())
                violations.push({
                    file: filePath,
                    line: line + 1,
                    rule: 'NO_RAW_AXIOS_HTTP_CALL',
                    codeSnippet: node.getText(sourceFile).slice(0, 100),
                })
            }

            // 3. Axios method calls: axios.create, ax.get, ax.post, etc.
            if (ts.isPropertyAccessExpression(expr)) {
                const targetObj = expr.expression
                const method = expr.name.text

                if (ts.isIdentifier(targetObj) && axiosAliases.has(targetObj.text)) {
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

export function findSourceFiles(dir: string): string[] {
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

export function findMonorepoRoot(startDir: string): string {
    let current = startDir
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'package.json')) && fs.existsSync(path.join(current, 'packages'))) {
            return current
        }
        current = path.dirname(current)
    }
    throw new Error('Monorepo root not found')
}
