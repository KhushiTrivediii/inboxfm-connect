import {
    PackageType,
    PieceScope,
    PieceType,
} from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'


let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('integration_metadata').createQueryBuilder().delete().execute()
})

async function countGlobalRows(name: string): Promise<number> {
    const repo = databaseConnection().getRepository('integration_metadata')
    return repo.count({ where: { name } })
}

async function findGlobalRow(name: string): Promise<{ platformId: string | null, pieceType: string | null, packageType: string | null } | null> {
    const repo = databaseConnection().getRepository('integration_metadata')
    const rows = await repo.find({ where: { name } })
    return rows.length > 0 ? { platformId: (rows[0] as { platformId: string | null }).platformId, pieceType: (rows[0] as { pieceType: string | null }).pieceType, packageType: (rows[0] as { packageType: string | null }).packageType } : null
}

describe('POST /v1/integrations — archive metadata cannot poison the global catalog', () => {
    it('must not let engine-returned metadata override server-pinned platformId/pieceType', async () => {
        const ctx = await createTestContext(app!)

        // The piece engine runs the real archive through loadPieceOrThrow ->
        // extractPieceFromModule. To drive the engine response deterministically
        // without building a crafted archive binary, park the user interaction
        // watcher (the single hop between installPiece and the engine response)
        // and answer with a METADATA SHAPE the archive controls: a crafted
        // archive's metadata() can return arbitrary keys, and extractPieceFromModule
        // only checks constructor.name before trusting it.
        const { userInteractionWatcher } = await import('../../../../src/app/helper/user-interaction/user-interaction-watcher')
        const watcherSpy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockResolvedValue({
            // Crafted-archive metadata: every override key present.
            name: 'poison-catalog-piece',
            displayName: 'Poison Catalog Piece',
            logoUrl: 'https://example.com/logo.png',
            version: '1.0.0',
            minimumSupportedRelease: '0.0.0',
            maximumSupportedRelease: '999.999.999',
            actions: {},
            triggers: {},
            authors: [],
            // ---- server-pinned keys the archive must NOT control ----
            platformId: null,
            pieceType: PieceType.OFFICIAL,
            packageType: PackageType.REGISTRY,
        })

        try {
            // Minimal valid ARCHIVE install request: body must pass AddPieceRequestBody zod.
            const formData = new FormData()
            formData.append('pieceName', 'poison-catalog-piece')
            formData.append('pieceVersion', '1.0.0')
            formData.append('packageType', PackageType.ARCHIVE)
            formData.append('scope', PieceScope.PLATFORM)
            formData.append('pieceArchive', new Blob([new Uint8Array([1, 2, 3])], { type: 'application/gzip' }), 'piece.tgz')

            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/integrations',
                body: formData,
            })

            expect(response.statusCode).toBe(201)
        }
        finally {
            watcherSpy.mockRestore()
        }

        // The row must be platform-scoped CUSTOM, exactly one row for this platform.
        expect(await countGlobalRows('poison-catalog-piece')).toBe(1)
        const row = await findGlobalRow('poison-catalog-piece')
        expect(row?.platformId).toBe(ctx.platform.id)
        expect(row?.pieceType).toBe(PieceType.CUSTOM)
        expect(row?.packageType).toBe(PackageType.ARCHIVE)
    })

    it('must keep a poisoned-name piece invisible to another platform (registry variant)', async () => {
        const ctx = await createTestContext(app!)
        const otherCtx = await createTestContext(app!)

        const { userInteractionWatcher } = await import('../../../../src/app/helper/user-interaction/user-interaction-watcher')
        const watcherSpy = vi.spyOn(userInteractionWatcher, 'submitAndWaitForResponse').mockResolvedValue({
            name: 'registry-variant-piece',
            displayName: 'Registry Variant Piece',
            logoUrl: 'https://example.com/logo.png',
            version: '2.0.0',
            minimumSupportedRelease: '0.0.0',
            maximumSupportedRelease: '999.999.999',
            actions: {},
            triggers: {},
            authors: [],
            platformId: null,
            pieceType: PieceType.OFFICIAL,
            packageType: PackageType.REGISTRY,
        })

        try {
            const response = await ctx.inject({
                method: 'POST',
                url: '/api/v1/integrations',
                body: {
                    packageType: PackageType.REGISTRY,
                    scope: PieceScope.PLATFORM,
                    pieceName: 'registry-variant-piece',
                    pieceVersion: '2.0.0',
                },
            })
            expect(response.statusCode).toBe(201)
        }
        finally {
            watcherSpy.mockRestore()
        }

        const repo = databaseConnection().getRepository('integration_metadata')
        const rows = await repo.find({ where: { name: 'registry-variant-piece' } })
        expect(rows).toHaveLength(1)
        expect((rows[0] as { platformId: string | null }).platformId).toBe(ctx.platform.id)
        expect((rows[0] as { pieceType: string | null }).pieceType).toBe(PieceType.CUSTOM)
        expect((rows[0] as { pieceType: string | null }).packageType).toBe(PackageType.REGISTRY)

        // The piece must NOT surface for a different platform's admin: the poisoned
        // name was not written as a global (NULL-platformId) row.
        const { pieceMetadataService } = await import('../../../../src/app/pieces/metadata/piece-metadata-service')
        const otherList = await pieceMetadataService(app!.log).list({
            platformId: otherCtx.platform.id,
            includeTags: false,
        })
        expect(otherList.some((piece) => piece.name === 'registry-variant-piece')).toBe(false)
    })
})
