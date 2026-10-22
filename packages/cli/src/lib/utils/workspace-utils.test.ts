import { describe, expect, it } from 'vitest'
import * as path from 'path'
import {
    findRepoRoot,
    buildWorkspaceVersionMap,
    resolveWorkspaceDependencies,
    isExactVersion,
    stripSemverRanges,
} from './workspace-utils'

describe('workspace-utils', () => {
    const root = findRepoRoot(process.cwd())

    it('findRepoRoot walks up to locate the monorepo root package.json', () => {
        const fromNested = path.join(root, 'packages', 'cli', 'src', 'lib', 'utils')
        expect(findRepoRoot(fromNested)).toBe(root)
    })

    it('findRepoRoot throws when no workspace root exists above path', () => {
        expect(() => findRepoRoot(path.parse(process.cwd()).root)).toThrow(
            /\[findRepoRoot\] no workspace root found above/
        )
    })

    it('buildWorkspaceVersionMap returns mapped versions for workspace packages', () => {
        const versionMap = buildWorkspaceVersionMap(root)
        expect(versionMap.size).toBeGreaterThan(0)
        expect(versionMap.has('@inboxfm-connect/cli')).toBe(true)
        expect(versionMap.has('@inboxfm-connect/core-utils')).toBe(true)
    })

    it('isExactVersion validates semver exactness correctly', () => {
        expect(isExactVersion('1.0.0')).toBe(true)
        expect(isExactVersion('0.36.1')).toBe(true)
        expect(isExactVersion('1.0.0-beta.1')).toBe(true)
        expect(isExactVersion('^1.0.0')).toBe(false)
        expect(isExactVersion('~1.0.0')).toBe(false)
        expect(isExactVersion('>=1.0.0')).toBe(false)
        expect(isExactVersion('*')).toBe(false)
    })

    it('stripSemverRanges strips caret and tilde prefixes from exact versions', () => {
        const input = {
            lodash: '^4.17.21',
            dayjs: '~1.11.10',
            chalk: '4.1.2',
        }
        const stripped = stripSemverRanges(input)
        expect(stripped).toEqual({
            lodash: '4.17.21',
            dayjs: '1.11.10',
            chalk: '4.1.2',
        })
    })

    it('stripSemverRanges throws for unsupported non-pinned semver ranges', () => {
        expect(() => stripSemverRanges({ foo: '>=1.0.0' })).toThrow(
            /\[stripSemverRanges\] unsupported version range for foo/
        )
    })

    it('stripSemverRanges handles undefined dependencies gracefully', () => {
        expect(stripSemverRanges(undefined)).toBeUndefined()
    })

    it('resolveWorkspaceDependencies replaces workspace: references with exact versions', () => {
        const map = new Map<string, string>([
            ['@inboxfm-connect/core-utils', '0.36.1'],
            ['@inboxfm-connect/shared', '0.36.1'],
        ])
        const resolved = resolveWorkspaceDependencies(
            {
                '@inboxfm-connect/core-utils': 'workspace:*',
                '@inboxfm-connect/shared': 'workspace:^0.36.0',
                chalk: '4.1.2',
            },
            map
        )
        expect(resolved).toEqual({
            '@inboxfm-connect/core-utils': '0.36.1',
            '@inboxfm-connect/shared': '0.36.1',
            chalk: '4.1.2',
        })
    })

    it('resolveWorkspaceDependencies throws when workspace package is not found in map', () => {
        const map = new Map<string, string>()
        expect(() =>
            resolveWorkspaceDependencies(
                { '@inboxfm-connect/unknown': 'workspace:*' },
                map
            )
        ).toThrow(/Failed to resolve workspace dependency @inboxfm-connect\/unknown/)
    })

    it('resolveWorkspaceDependencies handles undefined dependencies gracefully', () => {
        const map = new Map<string, string>()
        expect(resolveWorkspaceDependencies(undefined, map)).toBeUndefined()
    })
})
