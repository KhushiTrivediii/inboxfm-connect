import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const checker = fileURLToPath(new URL('./check-license-boundaries.mjs', import.meta.url))

function fixture({ t, source = '' }) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'connect-license-'))
    const env = { ...process.env, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined }
    t.after(() => rmSync(root, { recursive: true, force: true }))
    function write({ file, text }) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
        writeFileSync(path.join(root, file), text)
    }
    write({ file: 'LICENSE', text: 'Original upstream license\n' })
    write({ file: 'packages/ee/LICENSE', text: 'Restricted Enterprise notice\n' })
    write({ file: 'packages/ee/package.json', text: JSON.stringify({ name: '@fixture/enterprise' }) })
    write({ file: 'packages/app/index.ts', text: source })
    write({ file: 'tools/ci/.gitkeep', text: '' })
    execFileSync('git', ['init', '--quiet'], { cwd: root, env })
    execFileSync('git', ['add', '.'], { cwd: root, env })
    const baseline = spawnSync(process.execPath, [checker, '--write-baseline'], { cwd: root, env, encoding: 'utf8' })
    assert.equal(baseline.status, 0, baseline.stderr)
    return {
        write,
        check: () => spawnSync(process.execPath, [checker], { cwd: root, env, encoding: 'utf8' }),
    }
}

test('unchanged upstream notices and existing dependencies pass', (t) => {
    const repo = fixture({ t, source: "import { old } from '../ee/old'" })
    assert.equal(repo.check().status, 0)
})

test('a changed license notice fails', (t) => {
    const repo = fixture({ t })
    repo.write({ file: 'LICENSE', text: 'Replacement license' })
    const result = repo.check()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /License notice changed or removed/)
})

test('line ending changes do not alter license content', (t) => {
    const repo = fixture({ t })
    repo.write({ file: 'LICENSE', text: 'Original upstream license\r\n' })
    assert.equal(repo.check().status, 0)
})

for (const source of [
    "import { restricted } from '../ee/new'",
    "export { restricted } from '../ee'",
    "const restricted = require('@fixture/enterprise/module')",
    "const restricted = import('../ee/new')",
    "type Restricted = import('../ee/new').Restricted",
]) {
    test(`new Enterprise dependency fails: ${source}`, (t) => {
        const repo = fixture({ t })
        repo.write({ file: 'packages/app/index.ts', text: source })
        const result = repo.check()
        assert.equal(result.status, 1)
        assert.match(result.stderr, /New Enterprise dependency/)
    })
}

test('removing an existing Enterprise dependency passes', (t) => {
    const repo = fixture({ t, source: "import { old } from '../ee/old'" })
    repo.write({ file: 'packages/app/index.ts', text: '' })
    assert.equal(repo.check().status, 0)
})
