import { FastifyBaseLogger } from 'fastify'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { userService } from '../../../../src/app/user/user-service'
import { createMockUserIdentity, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

async function deleteKeysByPattern(redis: Redis, pattern: string): Promise<void> {
    const stream = redis.scanStream({ match: pattern, count: 100 })
    for await (const keys of stream) {
        if (keys.length > 0) {
            await redis.del(...keys)
        }
    }
}

let app: Awaited<ReturnType<typeof setupTestEnvironment>> | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    // runExclusive() hands `key` to redlock as the raw Redis resource, so the key lands
    // unprefixed - `redlock:*` matches nothing here. Clear this suite's own prefix so a
    // crashed run cannot leave a lock behind that makes the next run's create block until
    // it expires.
    const redis = await redisConnections.useExisting()
    await deleteKeysByPattern(redis, 'user:get-or-create:*')
})

describe('userService.getOrCreateWithProject concurrent first provision', () => {
    it('creates exactly one user and one personal project when two sign-ins race', async () => {
        // arrange
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const identity = await databaseConnection().getRepository('user_identity')
            .save(createMockUserIdentity())
        const svc = userService(app!.log as FastifyBaseLogger)

        // act - both callers observe no existing user and provision concurrently.
        // Without serialization both inserts target idx_user_platform_id_email
        // (platformId, identityId) and one surfaces a raw unique violation.
        const results = await Promise.allSettled([
            svc.getOrCreateWithProject({ identity, platformId: mockPlatform.id }),
            svc.getOrCreateWithProject({ identity, platformId: mockPlatform.id }),
        ])

        // assert - neither caller may see an error.
        for (const result of results) {
            if (result.status === 'rejected') {
                throw result.reason
            }
        }

        // Both callers converge on the same row.
        const ids = results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id)
        expect(new Set(ids).size).toBe(1)

        const users = await databaseConnection().getRepository('user').find({
            where: { platformId: mockPlatform.id, identityId: identity.id },
        })
        expect(users).toHaveLength(1)

        // And exactly one personal project for that user.
        const projects = await databaseConnection().getRepository('project').find({
            where: { ownerId: users[0].id },
        })
        expect(projects).toHaveLength(1)
    })

    it('still creates the personal project when the caller already has a user', async () => {
        // arrange - a second, sequential call must be idempotent, not a no-op that
        // skips project creation.
        const { mockPlatform } = await mockAndSaveBasicSetup()
        const identity = await databaseConnection().getRepository('user_identity')
            .save(createMockUserIdentity())
        const svc = userService(app!.log as FastifyBaseLogger)

        // act
        const first = await svc.getOrCreateWithProject({ identity, platformId: mockPlatform.id })
        const second = await svc.getOrCreateWithProject({ identity, platformId: mockPlatform.id })

        // assert
        expect(second.id).toBe(first.id)

        const projects = await databaseConnection().getRepository('project').find({
            where: { ownerId: first.id },
        })
        expect(projects).toHaveLength(1)
    })
})
