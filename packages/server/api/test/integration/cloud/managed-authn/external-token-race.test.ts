import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { Redis } from 'ioredis'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { generateMockExternalToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockSigningKey, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

async function deleteKeysByPattern(redis: Redis, pattern: string): Promise<void> {
    const stream = redis.scanStream({ match: pattern, count: 100 })
    for await (const keys of stream) {
        if (keys.length > 0) await redis.del(...keys)
    }
}

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    const redis = await redisConnections.useExisting()
    await deleteKeysByPattern(redis, 'concurrency-pool:limit:*')
    await deleteKeysByPattern(redis, 'project:concurrency-pool:*')
    // Clear any managed-authn locks left by previous tests so lock state
    // never leaks between tests.
    await deleteKeysByPattern(redis, 'redlock:*')
    await deleteKeysByPattern(redis, 'managed-authn:*')
})

describe('Managed Authentication API - concurrent sign-in races (Issue #469)', () => {
    describe('concurrent first sign-ins with the same external principal', () => {
        it('both requests succeed (no failure from the project find-then-create race)', async () => {
            // arrange
            const { mockPlatform } = await mockAndSaveBasicSetup()

            const mockSigningKey = createMockSigningKey({ platformId: mockPlatform.id })
            await db.save('signing_key', mockSigningKey)

            const { mockExternalToken, mockExternalTokenPayload } = generateMockExternalToken({
                platformId: mockPlatform.id,
                signingKeyId: mockSigningKey.id,
            })

            // act - two concurrent requests for the same external principal.
            // Pre-fix, both pass getByPlatformIdAndExternalId -> null before
            // either insert lands (each leg awaits a full query round-trip
            // between find and insert), so the loser of the insert race fails.
            const makeRequest = () => app!.inject({
                method: 'POST',
                url: '/api/v1/managed-authn/external-token',
                body: { externalAccessToken: mockExternalToken },
            })

            const [response1, response2] = await Promise.all([makeRequest(), makeRequest()])

            // assert
            expect(response1.statusCode).toBe(StatusCodes.OK)
            expect(response2.statusCode).toBe(StatusCodes.OK)

            const body1 = response1.json()
            const body2 = response2.json()
            expect(body1.projectId).toBe(body2.projectId)
            expect(body1.id).toBe(body2.id)

            // exactly one project row was created for the external id
            const projects = await databaseConnection().getRepository('project').find({
                where: { platformId: mockPlatform.id, externalId: mockExternalTokenPayload.externalProjectId },
            })
            expect(projects).toHaveLength(1)
        })

        it('both requests succeed (no failure from the user find-then-create race)', async () => {
            // arrange
            const { mockPlatform } = await mockAndSaveBasicSetup()

            const mockSigningKey = createMockSigningKey({ platformId: mockPlatform.id })
            await db.save('signing_key', mockSigningKey)

            const { mockExternalToken, mockExternalTokenPayload } = generateMockExternalToken({
                platformId: mockPlatform.id,
                signingKeyId: mockSigningKey.id,
            })

            // act
            const makeRequest = () => app!.inject({
                method: 'POST',
                url: '/api/v1/managed-authn/external-token',
                body: { externalAccessToken: mockExternalToken },
            })

            const [response1, response2] = await Promise.all([makeRequest(), makeRequest()])

            // assert
            expect(response1.statusCode).toBe(StatusCodes.OK)
            expect(response2.statusCode).toBe(StatusCodes.OK)

            const body1 = response1.json()
            const body2 = response2.json()
            expect(body1.id).toBe(body2.id)
            expect(body1.email).toBe(body2.email)

            // exactly one user row for the external id
            const users = await databaseConnection().getRepository('user').find({
                where: { platformId: mockPlatform.id, externalId: mockExternalTokenPayload.externalUserId },
            })
            expect(users).toHaveLength(1)
        })

        it('both requests succeed (no failure from the identity find-then-create race)', async () => {
            // arrange
            const { mockPlatform } = await mockAndSaveBasicSetup()

            const mockSigningKey = createMockSigningKey({ platformId: mockPlatform.id })
            await db.save('signing_key', mockSigningKey)

            const { mockExternalToken } = generateMockExternalToken({
                platformId: mockPlatform.id,
                signingKeyId: mockSigningKey.id,
            })

            // act
            const makeRequest = () => app!.inject({
                method: 'POST',
                url: '/api/v1/managed-authn/external-token',
                body: { externalAccessToken: mockExternalToken },
            })

            const [response1, response2] = await Promise.all([makeRequest(), makeRequest()])

            // assert
            expect(response1.statusCode).toBe(StatusCodes.OK)
            expect(response2.statusCode).toBe(StatusCodes.OK)

            // both resolved to the same identity (hash email is deterministic)
            const body1 = response1.json()
            const body2 = response2.json()
            expect(body1.email).toBe(body2.email)
            expect(body1.email).toHaveLength(64) // sha256 hex digest

            const identityRows = await databaseConnection().getRepository('user_identity').find({
                where: { email: body1.email },
            })
            expect(identityRows).toHaveLength(1)
        })

        it('high-concurrency same-principal sign-ins all succeed', async () => {
            // arrange
            const { mockPlatform } = await mockAndSaveBasicSetup()

            const mockSigningKey = createMockSigningKey({ platformId: mockPlatform.id })
            await db.save('signing_key', mockSigningKey)

            const { mockExternalToken } = generateMockExternalToken({
                platformId: mockPlatform.id,
                signingKeyId: mockSigningKey.id,
            })

            // act - five simultaneous same-principal requests through the real
            // route: the unique indexes must never surface a failure and all
            // requests must converge on the same rows
            const responses = await Promise.all(
                Array.from({ length: 5 }, () =>
                    app!.inject({
                        method: 'POST',
                        url: '/api/v1/managed-authn/external-token',
                        body: { externalAccessToken: mockExternalToken },
                    }),
                ),
            )

            // assert
            const codes = responses.map((r) => r.statusCode)
            expect(codes.filter((code) => code === StatusCodes.OK)).toHaveLength(5)
            const bodies = responses.map((r) => r.json())
            expect(new Set(bodies.map((body) => body.projectId)).size).toBe(1)
            expect(new Set(bodies.map((body) => body.id)).size).toBe(1)
        })

        it('sequential sign-ins reuse the existing project, user and identity', async () => {
            // arrange - guards the convergence paths against regressions that
            // would re-create rows on every login
            const { mockPlatform } = await mockAndSaveBasicSetup()

            const mockSigningKey = createMockSigningKey({ platformId: mockPlatform.id })
            await db.save('signing_key', mockSigningKey)

            const { mockExternalToken } = generateMockExternalToken({
                platformId: mockPlatform.id,
                signingKeyId: mockSigningKey.id,
            })

            const makeRequest = () => app!.inject({
                method: 'POST',
                url: '/api/v1/managed-authn/external-token',
                body: { externalAccessToken: mockExternalToken },
            })

            // act
            const first = await makeRequest()
            const second = await makeRequest()

            // assert
            expect(first.statusCode).toBe(StatusCodes.OK)
            expect(second.statusCode).toBe(StatusCodes.OK)

            const firstBody = first.json()
            const secondBody = second.json()
            expect(secondBody.projectId).toBe(firstBody.projectId)
            expect(secondBody.id).toBe(firstBody.id)
            expect(secondBody.email).toBe(firstBody.email)
        })
    })
})
