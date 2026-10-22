import assert from 'node:assert/strict'
import { test } from 'node:test'
import { integrationImpact } from './integration-impact.mjs'

const packages = ['packages/integrations/core/text-helper/package.json', 'packages/integrations/community/slack/package.json']
const previousManifest = { dependencies: { zod: '4.0.0' }, scripts: { lint: 'old' } }

function select({ changed, manifest = previousManifest }) {
    return integrationImpact.select({ changed, packages, manifest, previousManifest })
}

test('a changed integration is linted and built', () => {
    const result = select({ changed: ['packages/integrations/community/slack/src/index.ts'] })
    // slack ships no test/ directory, so no test task is selected for it
    assert.deepEqual(result, { lint: [packages[1]], build: [packages[1]], test: [] })
})

test('an integration manifest change is linted and built', () => {
    assert.deepEqual(select({ changed: [packages[0]] }), { lint: [packages[0]], build: [packages[0]], test: [packages[0]] })
})

for (const file of ['packages/core/utils/src/index.ts', 'packages/core/execution/src/index.ts', 'packages/integrations/framework/src/index.ts', 'packages/integrations/common/src/index.ts', 'bun.lock', 'tsconfig.base.json']) {
    test(`shared dependency change builds all integrations: ${file}`, () => {
        assert.deepEqual(select({ changed: [file] }), { lint: [], build: packages, test: [] })
    })
}

test('root script changes do not change integration dependencies', () => {
    assert.deepEqual(select({ changed: ['package.json'], manifest: { ...previousManifest, scripts: { lint: 'new' } } }), { lint: [], build: [], test: [] })
})

test('runtime dependency changes build all integrations', () => {
    assert.deepEqual(select({ changed: ['package.json'], manifest: { ...previousManifest, dependencies: { zod: '4.1.0' } } }), { lint: [], build: packages, test: [] })
})

test('application schemas do not expand integration checks', () => {
    assert.deepEqual(select({ changed: ['packages/core/shared/src/index.ts'] }), { lint: [], build: [], test: [] })
})

test('root lint configuration lints every integration', () => {
    assert.deepEqual(select({ changed: ['.eslintrc.json'] }), { lint: packages, build: [], test: [] })
})
