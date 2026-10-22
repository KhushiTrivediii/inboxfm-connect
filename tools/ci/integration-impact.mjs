import { existsSync } from 'node:fs'
import path from 'node:path'

function select({ changed, packages, manifest, previousManifest }) {
    const dependenciesChanged = ['dependencies', 'overrides', 'resolutions'].some((field) => JSON.stringify(manifest[field]) !== JSON.stringify(previousManifest[field]))
    const sharedChanged = dependenciesChanged || changed.some((file) => /^(packages\/core\/(utils|formula|piece-types|execution)\/|packages\/integrations\/(framework|common)\/)/.test(file) || ['bun.lock', 'tsconfig.base.json'].includes(file))
    const lintConfigChanged = changed.includes('.eslintrc.json') || changed.some((file) => /^\.prettier/.test(file))
    const directlyAffected = packages.filter((file) => changed.some((change) => change.startsWith(`${path.posix.dirname(file)}/`)))
    return {
        build: sharedChanged ? packages : directlyAffected,
        lint: lintConfigChanged ? packages : directlyAffected,
        // Issue #379 follow-up (PR review): pieces with a `test` script were
        // never executed by CI - the unit suite filters to core packages and
        // `check-integrations` only ran build+lint. Affected pieces now run
        // their vitest suites in Checks (integrations) too. The selector is
        // the impact set, not every piece: only packages that declare a test
        // task keep a `test` entry, so pieces without suites are unaffected.
        // Only pieces that actually ship a vitest suite declare a `test` entry:
        // `vitest run` exits non-zero on "no test files found", so a piece with
        // a test script but no test/ directory must not be selected (a change
        // to it would otherwise fail unrelated PRs). Existence of the
        // directory is the gate, matching the vitest include glob
        // (test/**/*.test.ts) in every piece config.
        test: directlyAffected.filter((file) => existsSync(`${path.posix.dirname(file)}/test`)),
    }
}

export const integrationImpact = { select }
