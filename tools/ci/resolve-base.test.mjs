import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ciBase } from './resolve-base.mjs'

function fixture({ t }) {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'connect-ci-base-'))
    t.after(() => rmSync(cwd, { recursive: true, force: true }))
    const env = { ...process.env, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_AUTHOR_NAME: 'CI test', GIT_AUTHOR_EMAIL: 'ci@example.invalid', GIT_COMMITTER_NAME: 'CI test', GIT_COMMITTER_EMAIL: 'ci@example.invalid' }
    function git(args) {
        return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
    }
    git(['init', '--quiet'])
    writeFileSync(path.join(cwd, 'README.md'), 'Initial snapshot\n')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'Initial snapshot'])
    const initial = git(['rev-parse', 'HEAD'])
    return { cwd, env, git, initial }
}

test('a valid event base is preserved', (t) => {
    const repo = fixture({ t })
    assert.equal(ciBase.resolve({ ...repo, candidate: repo.initial }), repo.initial)
})

test('an all-zero push base falls back to the stable branch', (t) => {
    const repo = fixture({ t })
    repo.git(['update-ref', 'refs/remotes/origin/main', repo.initial])
    repo.git(['commit', '--quiet', '--allow-empty', '-m', 'Next commit'])
    assert.equal(ciBase.resolve({ ...repo, candidate: '0'.repeat(40) }), repo.initial)
})

test('an unavailable base falls back to the previous commit', (t) => {
    const repo = fixture({ t })
    repo.git(['commit', '--quiet', '--allow-empty', '-m', 'Next commit'])
    assert.equal(ciBase.resolve({ ...repo, candidate: 'missing-ref' }), repo.initial)
})

test('the initial repository snapshot is explicitly identified', (t) => {
    const repo = fixture({ t })
    assert.equal(ciBase.resolve({ ...repo, candidate: '0'.repeat(40) }), null)
})
