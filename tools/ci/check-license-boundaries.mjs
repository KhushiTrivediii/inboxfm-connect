import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const policyPath = 'tools/ci/license-policy.json'
const files = execFileSync('git', ['ls-files', '-z', 'packages'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean)
const eeRoots = ['packages/ee/', 'packages/server/api/src/app/ee/']
const eePackages = files.filter((file) => eeRoots.some((root) => file.startsWith(root)) && file.endsWith('/package.json')).map((file) => JSON.parse(readFileSync(file, 'utf8')).name)
const imports = files.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file) && !eeRoots.some((root) => file.startsWith(root)) && !/(^|\/)(test|tests|__mocks__|__tests__)\/|\.(test|spec)\./.test(file)).flatMap((file) => findEnterpriseImports({ file })).sort()
const notices = execFileSync('git', ['ls-files', '*LICENSE*'], { encoding: 'utf8' }).trim().split('\n')

if (process.argv.includes('--write-baseline')) {
    writeFileSync(policyPath, JSON.stringify({
        description: 'Existing Enterprise imports are technical debt, not authorization to use Enterprise code in production. Changes to this policy require licensing review.',
        notices: Object.fromEntries(notices.map((file) => [file, noticeHash(file)])),
        existingEnterpriseImports: imports,
    }, null, 2) + '\n')
    console.log(`Recorded ${notices.length} license notices and ${imports.length} existing Enterprise imports.`)
} else {
    const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
    const failures = [
        ...Object.entries(policy.notices).filter(([file, hash]) => noticeHash(file) !== hash).map(([file]) => `License notice changed or removed: ${file}`),
        ...imports.filter((entry) => !policy.existingEnterpriseImports.includes(entry)).map((entry) => `New Enterprise dependency outside Enterprise directories: ${entry}`),
    ]
    if (failures.length) {
        console.error(failures.join('\n'))
        process.exitCode = 1
    } else {
        console.log(`License notices intact. No new Enterprise imports. Existing debt: ${imports.length} imports; see LICENSING.md.`)
    }
}

function noticeHash(file) {
    try {
        return createHash('sha256').update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).digest('hex')
    } catch {
        return null
    }
}

function findEnterpriseImports({ file }) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const result = new Set()
    function visit(node) {
        let specifier
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifier = node.moduleSpecifier.text
        } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
            specifier = node.arguments[0].text
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
            specifier = node.argument.literal.text
        }
        if (specifier) {
            const resolved = specifier.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)) : specifier
            if (eeRoots.some((root) => resolved === root.slice(0, -1) || resolved.startsWith(root)) || eePackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
                result.add(`${file} -> ${specifier}`)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    return [...result]
}
