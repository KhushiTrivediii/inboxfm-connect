import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

function createRuntime({ execute }) {
    const source = readFileSync(new URL('../../packages/runtime/src/index.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const exports = {}
    runInNewContext(compiled, {
        exports,
        require: (name) => {
            if (name === '@inboxfm-connect/sandbox') return { createSandboxRuntime: () => ({ execute }) }
            if (name === '@inboxfm-connect/pieces-framework') return { PieceMetadata: { parse: (metadata) => metadata } }
            if (name === '@inboxfm-connect/shared') return { EngineOperationType: { EXECUTE_TOOL: 'EXECUTE_TOOL', EXTRACT_PIECE_METADATA: 'EXTRACT_PIECE_METADATA' }, PackageType: { REGISTRY: 'REGISTRY' }, PieceType: { OFFICIAL: 'OFFICIAL' } }
            throw new Error(`Unexpected runtime import: ${name}`)
        },
    })
    return new exports.HeadlessRuntime({
        basePath: '.',
        log: {},
        getSettings: () => ({}),
        database: { getConnection: async () => ({ pieceVersion: '1.0.0' }) },
        decryptAndRefresh: async () => ({ value: 'test' }),
    })
}

const discovery = { integration: 'test', platformId: 'platform' }
const action = { ...discovery, projectId: 'project', tool: 'action', connectionId: 'connection', input: {} }

test('discovery and action requests share the single sandbox without overlapping', async () => {
    let active = 0
    let maximum = 0
    const runtime = createRuntime({
        execute: async () => {
            active++
            maximum = Math.max(maximum, active)
            await new Promise((resolve) => setTimeout(resolve, 20))
            active--
            return { status: 'OK', response: { actions: {} } }
        },
    })
    await Promise.all([runtime.listTools(discovery), runtime.execute(action), runtime.listTools(discovery)])
    assert.equal(maximum, 1)
})

test('a failed sandbox operation does not poison queued requests', async () => {
    let calls = 0
    const runtime = createRuntime({
        execute: async () => {
            calls++
            if (calls === 1) throw new Error('First operation failed')
            return { status: 'OK', response: { actions: {} } }
        },
    })
    const results = await Promise.allSettled([runtime.listTools(discovery), runtime.execute(action)])
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled'])
    assert.equal(calls, 2)
})
