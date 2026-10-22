import { describe, expect, it } from 'vitest'
import * as path from 'path'
import {
    piecesPath,
    customPiecePath,
    communityPiecePath,
    findPieces,
    findPiece,
    removeStartingSlashes,
} from './piece-utils'
import { findRepoRoot } from './workspace-utils'

describe('piece-utils paths and discovery', () => {
    const root = findRepoRoot(process.cwd())

    it('points piecesPath to packages/integrations', () => {
        const p = piecesPath()
        expect(p).toBe(path.join(root, 'packages', 'integrations'))
    })

    it('points customPiecePath to packages/integrations/custom', () => {
        const cp = customPiecePath()
        expect(cp).toBe(path.join(root, 'packages', 'integrations', 'custom'))
    })

    it('points communityPiecePath to packages/integrations/community', () => {
        const cp = communityPiecePath()
        expect(cp).toBe(path.join(root, 'packages', 'integrations', 'community'))
    })

    it('resolves piece paths identically when cwd is a repository subdirectory', () => {
        const originalCwd = process.cwd()
        try {
            process.chdir(path.join(root, 'packages', 'cli'))
            expect(piecesPath()).toBe(path.join(root, 'packages', 'integrations'))
            expect(customPiecePath()).toBe(path.join(root, 'packages', 'integrations', 'custom'))
            expect(communityPiecePath()).toBe(path.join(root, 'packages', 'integrations', 'community'))
        } finally {
            process.chdir(originalCwd)
        }
    })

    it('finds existing integration pieces under packages/integrations', async () => {
        const pieces = await findPieces(piecesPath())
        expect(pieces.length).toBeGreaterThan(0)

        // Negative assertion: framework and common foundation packages must not be returned
        expect(pieces.some((p) => /[\\/]framework|[\\/]common$/.test(p))).toBe(false)

        // Pin known pieces to guarantee real integration pieces are discovered
        expect(pieces.some((p) => p.endsWith('slack') || p.endsWith('http'))).toBe(true)
    }, 30000)

    it('findPiece discovers existing pieces by name', async () => {
        const piece = await findPiece('http')
        expect(piece).not.toBeNull()
        expect(piece?.endsWith(path.join('integrations', 'core', 'http'))).toBe(true)
    }, 30000)

    it('findPiece does not resolve foundation packages', async () => {
        const [framework, common] = await Promise.all([
            findPiece('framework'),
            findPiece('common'),
        ])
        expect(framework).toBeNull()
        expect(common).toBeNull()
    }, 30000)

    it('findPieces returns empty list when pointed directly at foundation packages', async () => {
        const [frameworkPieces, commonPieces] = await Promise.all([
            findPieces(path.join(piecesPath(), 'framework')),
            findPieces(path.join(piecesPath(), 'common')),
        ])
        expect(frameworkPieces).toEqual([])
        expect(commonPieces).toEqual([])
    }, 30000)

    it('removeStartingSlashes trims leading forward and backward slashes', () => {
        expect(removeStartingSlashes('///foo/bar')).toBe('foo/bar')
        expect(removeStartingSlashes('\\\\\\foo\\bar')).toBe('foo\\bar')
        expect(removeStartingSlashes('foo/bar')).toBe('foo/bar')
    })
})
