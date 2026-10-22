import { apId } from '@inboxfm-connect/core-utils'
import { FilteredPieceBehavior, PiecesFilterType, PieceType, PlatformRole, PrincipalType } from '@inboxfm-connect/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { pieceCache } from '../../../../src/app/pieces/metadata/piece-cache'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import {
    createMockPieceMetadata,
    createMockPlan,
    createMockProject,
    mockAndSaveBasicSetup,
    mockBasicUser,
} from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('integration_metadata').createQueryBuilder().delete().execute()
    // Truncating the table clears only one of the two layers the list endpoint reads:
    // pieceListCache lives in Redis and would otherwise serve the previous test's rows.
    await pieceCache(mockLog).invalidate()
})
describe('Piece Metadata API', () => {
    describe('Get Piece metadata', () => {
        it('Should return metadata when authenticated', async () => {
            // arrange
            const mockPieceMetadata = createMockPieceMetadata({
                name: '@inboxfm-connect/a',
                pieceType: PieceType.OFFICIAL,
            })
            await db.save('integration_metadata', mockPieceMetadata)

            await pieceCache(mockLog).setup()

            const ctx = await createTestContext(app!, {
                platform: {
                    filteredPieceBehavior: FilteredPieceBehavior.BLOCKED,
                    filteredPieceNames: [],
                },
            })

            // act
            const response = await ctx.get(`/v1/integrations/@inboxfm-connect/a?projectId=${ctx.project.id}`)

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(responseBody.id).toBe(mockPieceMetadata.id)
        })

        it('Should return metadata when not authenticated', async () => {
            // arrange
            const mockPieceMetadata = createMockPieceMetadata({
                name: '@inboxfm-connect/a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
            })
            await db.save('integration_metadata', mockPieceMetadata)

            await pieceCache(mockLog).setup()
            const testToken = await generateMockToken({
                type: PrincipalType.UNKNOWN,
                id: apId(),
            })

            // act
            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/integrations/@inboxfm-connect/a',
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            // Expectations for each attribute
            expect(responseBody.actions).toEqual(mockPieceMetadata.actions)
            expect(responseBody.triggers).toEqual(mockPieceMetadata.triggers)
            expect(responseBody.archiveId).toBe(mockPieceMetadata.archiveId)
            expect(responseBody.auth).toEqual(mockPieceMetadata.auth)
            expect(responseBody.description).toBe(mockPieceMetadata.description)
            expect(responseBody.directoryPath).toBe(mockPieceMetadata.directoryPath)
            expect(responseBody.displayName).toBe(mockPieceMetadata.displayName)
            expect(responseBody.id).toBe(mockPieceMetadata.id)
            expect(responseBody.logoUrl).toBe(mockPieceMetadata.logoUrl)
            expect(responseBody.maximumSupportedRelease).toBe(
                mockPieceMetadata.maximumSupportedRelease,
            )
            expect(responseBody.minimumSupportedRelease).toBe(
                mockPieceMetadata.minimumSupportedRelease,
            )
            expect(responseBody.packageType).toBe(mockPieceMetadata.packageType)
            expect(responseBody.pieceType).toBe(mockPieceMetadata.pieceType)
            expect(responseBody.platformId).toBe(mockPieceMetadata.platformId)
            expect(responseBody.version).toBe(mockPieceMetadata.version)
        })
    })
    describe('List Piece Metadata endpoint', () => {
        it('Should list platform pieces', async () => {
            const { mockOwner, mockPlatform } = await mockAndSaveBasicSetup({
                platform: {
                    filteredPieceBehavior: FilteredPieceBehavior.BLOCKED,
                    filteredPieceNames: [],
                },
            })

            const { mockPlatform: mockPlatform2 } = await mockAndSaveBasicSetup({
                user: {
                    platformId: mockPlatform.id,
                    platformRole: PlatformRole.MEMBER,
                },
            })

            const mockProject = await createProjectAndPlan({
                platformId: mockPlatform.id,
                ownerId: mockOwner.id,
            })


            // arrange
            const mockPieceMetadataA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.CUSTOM,
                platformId: mockPlatform.id,
                displayName: 'a',
            })
            const mockPieceMetadataB = createMockPieceMetadata({
                name: 'b',
                pieceType: PieceType.OFFICIAL,
                displayName: 'b',
            })
            const mockPieceMetadataC = createMockPieceMetadata({
                name: 'c',
                pieceType: PieceType.CUSTOM,
                platformId: mockPlatform2.id,
                displayName: 'c',
            })
            const mockPieceMetadataD = createMockPieceMetadata({
                name: 'd',
                pieceType: PieceType.CUSTOM,
                platformId: mockPlatform.id,
                displayName: 'd',
            })
            await db.save('integration_metadata', [
                mockPieceMetadataA,
                mockPieceMetadataB,
                mockPieceMetadataC,
                mockPieceMetadataD,
            ])

            await pieceCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.USER,
                
                id: mockOwner.id,
                platform: {
                    id: mockPlatform.id,
                },
            })

            // act
            const response = await app?.inject({
                method: 'GET',
                url: `/api/v1/integrations?projectId=${mockProject.id}`,
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })
            // assert
            const responseBody = response?.json()
            expect(response?.statusCode).toBe(StatusCodes.OK)
            // The endpoint merges the shipped local catalog with the DB (fetchLatestPieces),
            // so the seeded mocks are listed alongside the ~700 real pieces rather than alone —
            // assert membership/exclusion and relative order, not an exact result count.
            const ids = responseBody.data.map((piece: { id: string }) => piece.id)
            expect(ids).toContain(mockPieceMetadataA.id)
            expect(ids).toContain(mockPieceMetadataB.id)
            expect(ids).toContain(mockPieceMetadataD.id)
            expect(ids).not.toContain(mockPieceMetadataC.id)
            const mockIds = [mockPieceMetadataA.id, mockPieceMetadataB.id, mockPieceMetadataD.id]
            expect(ids.filter((id: string) => mockIds.includes(id))).toEqual(mockIds)
        })

        it('Should show official piece to other platforms when a custom piece with the same name exists', async () => {
            // arrange
            const { mockOwner: ownerA, mockPlatform: platformA } = await mockAndSaveBasicSetup({
                platform: {
                    filteredPieceBehavior: FilteredPieceBehavior.BLOCKED,
                    filteredPieceNames: [],
                },
            })
            const { mockOwner: ownerB, mockPlatform: platformB } = await mockAndSaveBasicSetup({
                platform: {
                    filteredPieceBehavior: FilteredPieceBehavior.BLOCKED,
                    filteredPieceNames: [],
                },
            })

            const projectA = await createProjectAndPlan({
                platformId: platformA.id,
                ownerId: ownerA.id,
            })
            const projectB = await createProjectAndPlan({
                platformId: platformB.id,
                ownerId: ownerB.id,
            })

            const officialPieceA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
                version: '1.0.0',
            })
            const customPieceA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.CUSTOM,
                platformId: platformA.id,
                displayName: 'a',
                version: '2.0.0',
            })
            await db.save('integration_metadata', [officialPieceA, customPieceA])

            await pieceCache(mockLog).setup()

            const tokenA = await generateMockToken({
                type: PrincipalType.USER,
                id: ownerA.id,
                platform: {
                    id: platformA.id,
                },
            })
            const tokenB = await generateMockToken({
                type: PrincipalType.USER,
                id: ownerB.id,
                platform: {
                    id: platformB.id,
                },
            })

            const responseA = await app?.inject({
                method: 'GET',
                url: `/api/v1/integrations?projectId=${projectA.id}`,
                headers: {
                    authorization: `Bearer ${tokenA}`,
                },
            })

            const responseB = await app?.inject({
                method: 'GET',
                url: `/api/v1/integrations?projectId=${projectB.id}`,
                headers: {
                    authorization: `Bearer ${tokenB}`,
                },
            })

            // The endpoint merges the shipped local catalog with the DB (fetchLatestPieces), so a
            // filter of BLOCKED with no filtered names lets the full catalog through — assert the
            // seeded piece named 'a' resolves to the expected version/type, not an exact list length.
            const bodyA = responseA?.json()
            expect(responseA?.statusCode).toBe(StatusCodes.OK)
            const pieceAInBodyA = bodyA?.data.find((piece: { name: string }) => piece.name === 'a')
            expect(pieceAInBodyA?.version).toBe('2.0.0')
            expect(pieceAInBodyA?.pieceType).toBe(PieceType.CUSTOM)

            const bodyB = responseB?.json()
            expect(responseB?.statusCode).toBe(StatusCodes.OK)
            const pieceAInBodyB = bodyB?.data.find((piece: { name: string }) => piece.name === 'a')
            expect(pieceAInBodyB?.version).toBe('1.0.0')
            expect(pieceAInBodyB?.pieceType).toBe(PieceType.OFFICIAL)
        })

        it('Should list correct version by piece name', async () => {
            // arrange
            const mockPieceMetadataA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
                version: '0.0.1',
            })
            const mockPieceMetadataB = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
                version: '0.0.2',
            })
            const mockPieceMetadataC = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
                version: '0.1.0',
            })
            const mockPieceMetadataD = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
                version: '0.1.1',
            })
            await db.save('integration_metadata', [mockPieceMetadataA, mockPieceMetadataB, mockPieceMetadataC, mockPieceMetadataD])

            const testToken = await generateMockToken({
                type: PrincipalType.UNKNOWN,
                id: apId(),
            })
            await pieceCache(mockLog).setup()

            // act
            const exactVersionResponse = await app?.inject({
                method: 'GET',
                url: '/api/v1/integrations/a?version=0.0.1',
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })
            const exactVersionResponseBody = exactVersionResponse?.json()
            expect(exactVersionResponse?.statusCode).toBe(StatusCodes.OK)
            expect(exactVersionResponseBody?.id).toBe(mockPieceMetadataA.id)

            const telda2VersionResponse = await app?.inject({
                method: 'GET',
                url: '/api/v1/integrations/a?version=~0.0.2',
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })
            const teldaVersion2ResponseBody = telda2VersionResponse?.json()
            expect(telda2VersionResponse?.statusCode).toBe(StatusCodes.OK)
            expect(teldaVersion2ResponseBody?.id).toBe(mockPieceMetadataB.id)

            const teldaVersionResponse = await app?.inject({
                method: 'GET',
                url: '/api/v1/integrations/a?version=~0.0.1',
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })
            const teldaVersionResponseBody = teldaVersionResponse?.json()
            expect(teldaVersionResponse?.statusCode).toBe(StatusCodes.OK)
            expect(teldaVersionResponseBody?.id).toBe(mockPieceMetadataB.id)

            const notFoundVersionResponse = await app?.inject({
                method: 'GET',
                url: '/api/v1/integrations/a?version=~0.1.2',
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })
            expect(notFoundVersionResponse?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('Should list latest version by piece name', async () => {
            // arrange
            const mockPieceMetadataA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
                version: '0.31.0',
            })
            const mockPieceMetadataB = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
                version: '1.0.0',
            })
            await db.save('integration_metadata', [mockPieceMetadataA, mockPieceMetadataB])

            await pieceCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.UNKNOWN,
                id: apId(),
            })

            // act
            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/integrations',
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            // The endpoint merges the shipped local catalog with the DB (fetchLatestPieces),
            // so the seeded piece is listed alongside the ~700 real pieces — find it by name
            // and assert only the latest version won the dedupe, not an exact list length.
            const piecesNamedA = responseBody.data.filter((piece: { name: string }) => piece.name === 'a')
            expect(piecesNamedA).toHaveLength(1)
            expect(piecesNamedA[0].id).toBe(mockPieceMetadataB.id)
        })


        it('Sorts by piece name', async () => {
            // arrange
            const mockPieceMetadataA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
            })
            const mockPieceMetadataB = createMockPieceMetadata({
                name: 'b',
                pieceType: PieceType.OFFICIAL,
                displayName: 'b',
            })
            await db.save('integration_metadata', [mockPieceMetadataA, mockPieceMetadataB])

            await pieceCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.UNKNOWN,
                id: apId(),
            })

            // act
            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/integrations',
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            // The endpoint merges the shipped local catalog with the DB (fetchLatestPieces),
            // so the ~700 real pieces interleave with the seeded mocks — assert the seeded
            // mocks' relative order survives the sort, not an exact list length.
            const ids = responseBody.data.map((piece: { id: string }) => piece.id)
            const mockIds = [mockPieceMetadataA.id, mockPieceMetadataB.id]
            expect(ids.filter((id: string) => mockIds.includes(id))).toEqual(mockIds)
        })

        it('Allows filtered pieces if project filter is set to "ALLOWED"', async () => {
            // arrange
            const { mockPlatform } = await mockAndSaveBasicSetup({
                platform: {
                    filteredPieceBehavior: FilteredPieceBehavior.BLOCKED,
                    filteredPieceNames: [],
                },
            })

            const { mockUser } = await mockBasicUser({
                user: {
                    platformId: mockPlatform.id,
                    platformRole: PlatformRole.MEMBER,
                },
            })

            const mockProject = await createProjectAndPlan({
                ownerId: mockUser.id,
                platformId: mockPlatform.id,
                piecesFilterType: PiecesFilterType.ALLOWED,
                pieces: ['a'],
            })

            const mockPieceMetadataA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
            })
            const mockPieceMetadataB = createMockPieceMetadata({
                name: 'b',
                pieceType: PieceType.OFFICIAL,
                displayName: 'b',
            })
            await db.save('integration_metadata', [mockPieceMetadataA, mockPieceMetadataB])

            await pieceCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.USER,

                platform: {
                    id: mockPlatform.id,
                },
                id: mockUser.id,
            })

            // act
            const response = await app?.inject({
                method: 'GET',
                url: `/api/v1/integrations?projectId=${mockProject.id}`,
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(responseBody.data).toHaveLength(1)
            expect(responseBody?.data?.[0].id).toBe(mockPieceMetadataA.id)
        })

        it('Allows filtered pieces if platform filter is set to "ALLOWED"', async () => {
            // arrange
            const { mockPlatform } = await mockAndSaveBasicSetup({
                platform: {
                    filteredPieceNames: ['a'],
                    filteredPieceBehavior: FilteredPieceBehavior.ALLOWED,
                },
            })

            const { mockUser } = await mockBasicUser({
                user: {
                    platformId: mockPlatform.id,
                    platformRole: PlatformRole.MEMBER,
                },
            })

            const mockProject = await createProjectAndPlan({
                ownerId: mockUser.id,
                platformId: mockPlatform.id,
            })

            const mockPieceMetadataA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
            })
            const mockPieceMetadataB = createMockPieceMetadata({
                name: 'b',
                pieceType: PieceType.OFFICIAL,
                displayName: 'b',
            })
            await db.save('integration_metadata', [mockPieceMetadataA, mockPieceMetadataB])

            await pieceCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.USER,

                platform: {
                    id: mockPlatform.id,
                },
                id: mockUser.id,
            })

            // act
            const response = await app?.inject({
                method: 'GET',
                url: `/api/v1/integrations?projectId=${mockProject.id}`,
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(responseBody.data).toHaveLength(1)
            expect(responseBody?.data?.[0].id).toBe(mockPieceMetadataA.id)
        })

        it('Blocks filtered pieces if platform filter is set to "BLOCKED"', async () => {
            // arrange
            const { mockPlatform } = await mockAndSaveBasicSetup({
                platform: {
                    filteredPieceNames: ['a'],
                    filteredPieceBehavior: FilteredPieceBehavior.BLOCKED,
                },
            })

            const { mockUser } = await mockBasicUser({
                user: {
                    platformId: mockPlatform.id,
                    platformRole: PlatformRole.MEMBER,
                },
            })

            const mockProject = await createProjectAndPlan({
                ownerId: mockUser.id,
                platformId: mockPlatform.id,
            })

            const mockPieceMetadataA = createMockPieceMetadata({
                name: 'a',
                pieceType: PieceType.OFFICIAL,
                displayName: 'a',
            })
            const mockPieceMetadataB = createMockPieceMetadata({
                name: 'b',
                pieceType: PieceType.OFFICIAL,
                displayName: 'b',
            })
            await db.save('integration_metadata', [mockPieceMetadataA, mockPieceMetadataB])

            await pieceCache(mockLog).setup()

            const testToken = await generateMockToken({
                type: PrincipalType.USER,

                platform: {
                    id: mockPlatform.id,
                },
                id: mockUser.id,
            })

            // act
            const response = await app?.inject({
                method: 'GET',
                url: `/api/v1/integrations?projectId=${mockProject.id}`,
                headers: {
                    authorization: `Bearer ${testToken}`,
                },
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            // BLOCKED with a single blocked name only removes that one piece — the ~700 real
            // pieces in the shipped catalog still pass through — so assert the blocked/allowed
            // mocks specifically, not an exact list length.
            const ids = responseBody.data.map((piece: { id: string }) => piece.id)
            expect(ids).not.toContain(mockPieceMetadataA.id)
            expect(ids).toContain(mockPieceMetadataB.id)
        })
    })
})

async function createProjectAndPlan({
    platformId,
    ownerId,
    piecesFilterType,
    pieces,
}: {
    platformId: string
    ownerId: string
    piecesFilterType?: PiecesFilterType
    pieces?: string[]
}) {
    const project = createMockProject({
        platformId,
        ownerId,
    })
    await db.save('project', [project])

    const projectPlan = createMockPlan({
        projectId: project.id,
        piecesFilterType,
        pieces,
    })
    await db.save('project_plan', [projectPlan])
    return project
}