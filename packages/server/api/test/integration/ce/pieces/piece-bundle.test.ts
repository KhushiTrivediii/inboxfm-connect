import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { apId } from '@inboxfm-connect/core-utils'
import { FileCompression, FileLocation, FileType, PackageType, PieceType, Principal, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { vi } from 'vitest'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockFile, createMockPieceMetadata, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'
import * as s3HelperModule from '../../../../src/app/file/s3-helper'
import { pieceBundleCache } from '../../../../src/app/pieces/piece-bundle-controller'

const localDistState = vi.hoisted(() => ({ distPath: '' }))

vi.mock('../../../../src/app/pieces/metadata/utils/file-pieces-utils', () => ({
    filePiecesUtils: () => ({
        findDistPiecePathByPackageName: async (packageName: string) =>
            packageName === '@inboxfm-connect/piece-local-dist' ? localDistState.distPath || null : null,
    }),
}))

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
    localDistState.distPath = await mkdtemp(join(tmpdir(), 'piece-bundle-dist-'))
    await mkdir(join(localDistState.distPath, 'src'), { recursive: true })
    await writeFile(join(localDistState.distPath, 'package.json'), JSON.stringify({
        name: '@inboxfm-connect/piece-local-dist',
        version: '1.0.0',
        main: './dist/src/index.js',
        dependencies: {
            '@inboxfm-connect/pieces-framework': 'workspace:*',
            '@inboxfm-connect/pieces-common': 'workspace:*',
            lodash: '^4.17.21',
        },
        devDependencies: {
            vitest: '3.2.6',
        },
    }))
    await writeFile(join(localDistState.distPath, 'src', 'index.js'), 'module.exports = {}\n')
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function engineToken(projectId: string, platformId: string): Promise<string> {
    const principal: Principal = {
        id: apId(),
        type: PrincipalType.ENGINE,
        projectId,
        platform: { id: platformId },
    }
    return generateMockToken(principal)
}

function bundleRequest(name: string, version: string, token: string) {
    return {
        method: 'GET' as const,
        url: `/api/v1/engine/pieces/bundle?name=${encodeURIComponent(name)}&version=${version}`,
        headers: { authorization: `Bearer ${token}` },
    }
}

describe('Piece Bundle Endpoint', () => {
    it('rejects an invalid engine token with 401', async () => {
        const response = await app!.inject(bundleRequest('@inboxfm-connect/piece-anything', '1.0.0', 'not-a-real-token'))
        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
    })

    it('redirects an official piece to the npm tarball when S3 is not configured', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        await db.save('integration_metadata', createMockPieceMetadata({
            name: '@inboxfm-connect/piece-bundle-official',
            version: '1.2.3',
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
            platformId: undefined,
        }))
        const token = await engineToken(mockProject.id, mockPlatform.id)

        const response = await app!.inject(bundleRequest('@inboxfm-connect/piece-bundle-official', '1.2.3', token))

        expect(response.statusCode).toBe(StatusCodes.TEMPORARY_REDIRECT)
        expect(response.headers.location).toContain('registry.npmjs.org')
        expect(response.headers.location).toContain('piece-bundle-official-1.2.3.tgz')
    })

    it('serves a locally built dist as a tarball before falling back to npm', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        await db.save('integration_metadata', createMockPieceMetadata({
            name: '@inboxfm-connect/piece-local-dist',
            version: '1.0.0',
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
            platformId: undefined,
        }))
        const token = await engineToken(mockProject.id, mockPlatform.id)

        const response = await app!.inject(bundleRequest('@inboxfm-connect/piece-local-dist', '1.0.0', token))

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(response.headers['content-type']).toContain('application/gzip')
        const tar = gunzipSync(response.rawPayload)
        expect(tar.includes('package/package.json')).toBe(true)
        expect(tar.includes('package/src/index.js')).toBe(true)

        const manifestContent = extractFileFromTar(tar, 'package/package.json')
        expect(manifestContent).not.toBeNull()
        const manifest = JSON.parse(manifestContent ?? '{}') as {
            main?: string
            dependencies?: Record<string, string>
            devDependencies?: unknown
        }
        expect(manifest.main).toBe('./src/index.js')
        expect(manifest.dependencies).toEqual({ lodash: '4.17.21' })
        expect(manifest.devDependencies).toBeUndefined()
        expect(manifestContent).not.toContain('workspace:')
        expect(manifestContent).not.toContain('@inboxfm-connect/pieces-framework')
        expect(manifestContent).not.toContain('@inboxfm-connect/pieces-common')
    })

    it('falls back to the npm tarball when the local dist version does not match', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        await db.save('integration_metadata', createMockPieceMetadata({
            name: '@inboxfm-connect/piece-local-dist',
            version: '9.9.9',
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
            platformId: undefined,
        }))
        const token = await engineToken(mockProject.id, mockPlatform.id)

        const response = await app!.inject(bundleRequest('@inboxfm-connect/piece-local-dist', '9.9.9', token))

        expect(response.statusCode).toBe(StatusCodes.TEMPORARY_REDIRECT)
        expect(response.headers.location).toContain('registry.npmjs.org')
        expect(response.headers.location).toContain('piece-local-dist-9.9.9.tgz')
    })

    it('scopes custom pieces by the token platform: owner can fetch, other platform gets 404', async () => {
        const platformA = await mockAndSaveBasicSetup()
        const platformB = await mockAndSaveBasicSetup()

        const archiveId = apId()
        await db.save('file', createMockFile({
            id: archiveId,
            platformId: platformA.mockPlatform.id,
            projectId: null,
            type: FileType.PACKAGE_ARCHIVE,
            location: FileLocation.DB,
            compression: FileCompression.NONE,
            data: Buffer.from('fake-tgz-bytes'),
        }))
        await db.save('integration_metadata', createMockPieceMetadata({
            name: '@acme/piece-private',
            version: '0.0.1',
            packageType: PackageType.ARCHIVE,
            pieceType: PieceType.CUSTOM,
            platformId: platformA.mockPlatform.id,
            archiveId,
        }))

        const tokenA = await engineToken(platformA.mockProject.id, platformA.mockPlatform.id)
        const tokenB = await engineToken(platformB.mockProject.id, platformB.mockPlatform.id)

        const ownerResponse = await app!.inject(bundleRequest('@acme/piece-private', '0.0.1', tokenA))
        expect(ownerResponse.statusCode).toBe(StatusCodes.OK)
        expect(ownerResponse.rawPayload.toString()).toBe('fake-tgz-bytes')

        const otherPlatformResponse = await app!.inject(bundleRequest('@acme/piece-private', '0.0.1', tokenB))
        expect(otherPlatformResponse.statusCode).toBe(StatusCodes.NOT_FOUND)
    })

    it('streams an archive by archiveId for the owning platform and 404s for others', async () => {
        const platformA = await mockAndSaveBasicSetup()
        const platformB = await mockAndSaveBasicSetup()

        const archiveId = apId()
        await db.save('file', createMockFile({
            id: archiveId,
            platformId: platformA.mockPlatform.id,
            projectId: null,
            type: FileType.PACKAGE_ARCHIVE,
            location: FileLocation.DB,
            compression: FileCompression.NONE,
            data: Buffer.from('archive-bytes'),
        }))

        const tokenA = await engineToken(platformA.mockProject.id, platformA.mockPlatform.id)
        const tokenB = await engineToken(platformB.mockProject.id, platformB.mockPlatform.id)
        const byArchive = (token: string) => ({
            method: 'GET' as const,
            url: `/api/v1/engine/pieces/bundle?archiveId=${archiveId}`,
            headers: { authorization: `Bearer ${token}` },
        })

        const ownerResponse = await app!.inject(byArchive(tokenA))
        expect(ownerResponse.statusCode).toBe(StatusCodes.OK)
        expect(ownerResponse.rawPayload.toString()).toBe('archive-bytes')

        const otherPlatformResponse = await app!.inject(byArchive(tokenB))
        expect(otherPlatformResponse.statusCode).toBe(StatusCodes.NOT_FOUND)
    })

    it('invalidates cached local dist tarball when package.json mtime changes', async () => {
        const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
        await db.save('integration_metadata', createMockPieceMetadata({
            name: '@inboxfm-connect/piece-local-dist',
            version: '1.0.0',
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
            platformId: undefined,
        }))
        const token = await engineToken(mockProject.id, mockPlatform.id)

        const res1 = await app!.inject(
            bundleRequest('@inboxfm-connect/piece-local-dist', '1.0.0', token),
        )
        expect(res1.statusCode).toBe(StatusCodes.OK)
        const tar1 = gunzipSync(res1.rawPayload)
        const manifest1 = JSON.parse(extractFileFromTar(tar1, 'package/package.json') ?? '{}')
        expect(manifest1['version']).toBe('1.0.0')

        // Rebuild in place: update package.json with a new mtime and description
        await new Promise((resolve) => setTimeout(resolve, 50))
        await writeFile(join(localDistState.distPath, 'package.json'), JSON.stringify({
            name: '@inboxfm-connect/piece-local-dist',
            version: '1.0.0',
            main: './dist/src/index.js',
            description: 'updated-after-rebuild',
            dependencies: {
                lodash: '^4.17.21',
            },
        }))

        const res2 = await app!.inject(
            bundleRequest('@inboxfm-connect/piece-local-dist', '1.0.0', token),
        )
        expect(res2.statusCode).toBe(StatusCodes.OK)
        const tar2 = gunzipSync(res2.rawPayload)
        const manifest2 = JSON.parse(extractFileFromTar(tar2, 'package/package.json') ?? '{}')
        expect(manifest2['description']).toBe('updated-after-rebuild')
    })

    it('enforces entry count and byte budgets with LRU eviction', () => {
        pieceBundleCache.clear()
        expect(pieceBundleCache.size()).toBe(0)
        expect(pieceBundleCache.totalBytes()).toBe(0)

        for (let i = 0; i < pieceBundleCache.maxEntries; i++) {
            pieceBundleCache.set(`key-${i}`, Buffer.alloc(100, i))
        }
        expect(pieceBundleCache.size()).toBe(20)
        expect(pieceBundleCache.totalBytes()).toBe(2000)

        // Adding one more entry evicts the oldest entry (key-0)
        pieceBundleCache.set('key-20', Buffer.alloc(100, 20))
        expect(pieceBundleCache.size()).toBe(20)
        expect(pieceBundleCache.get('key-0')).toBeUndefined()
        expect(pieceBundleCache.get('key-20')).toBeDefined()

        // Huge entry exceeds maxBytes and is rejected from caching
        pieceBundleCache.set('huge', Buffer.alloc(pieceBundleCache.maxBytes + 1))
        expect(pieceBundleCache.get('huge')).toBeUndefined()

        pieceBundleCache.clear()
    })

    it('returns 404 when an S3-backed archive object does not exist in S3', async () => {
        const s3Spy = vi.spyOn(s3HelperModule, 's3Helper').mockImplementation((log) => {
            const original = s3HelperModule.s3Helper(log)
            return {
                ...original,
                getFile: vi.fn(async () => {
                    throw new Error('NoSuchKey: The specified key does not exist.')
                }),
            }
        })
        try {
            const { mockPlatform, mockProject } = await mockAndSaveBasicSetup()
            const archiveId = apId()
            await db.save('file', createMockFile({
                id: archiveId,
                platformId: mockPlatform.id,
                projectId: null,
                type: FileType.PACKAGE_ARCHIVE,
                location: FileLocation.S3,
                compression: FileCompression.NONE,
                s3Key: 'deleted-archive.tar.gz',
            }))

            const token = await engineToken(mockProject.id, mockPlatform.id)
            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/engine/pieces/bundle?archiveId=${archiveId}`,
                headers: { authorization: `Bearer ${token}` },
            })

            expect(response.statusCode).toBe(StatusCodes.NOT_FOUND)
            const body = response.json()
            expect(body.code).toBe('ENTITY_NOT_FOUND')
        }
        finally {
            s3Spy.mockRestore()
        }
    })
})

function extractFileFromTar(tarBuffer: Buffer, fileName: string): string | null {
    let offset = 0
    while (offset + 512 <= tarBuffer.length) {
        const header = tarBuffer.subarray(offset, offset + 512)
        if (header.every((b) => b === 0)) {
            break
        }
        const name = header.subarray(0, 100).toString('ascii').replace(/\0+$/, '')
        const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0+$/, '').trim()
        const size = parseInt(sizeOctal, 8)
        offset += 512
        if (name === fileName) {
            return tarBuffer.subarray(offset, offset + size).toString('utf-8')
        }
        const padding = size % 512 === 0 ? 0 : 512 - (size % 512)
        offset += size + padding
    }
    return null
}

