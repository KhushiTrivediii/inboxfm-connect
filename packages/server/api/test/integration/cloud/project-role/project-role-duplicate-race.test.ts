import { RoleType } from '@inboxfm-connect/core-utils'
import { CreateProjectRoleRequestBody } from '@inboxfm-connect/shared'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { projectRoleService } from '../../../../src/app/ee/projects/project-role/project-role.service'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

async function deleteKeysByPattern(redis: Redis, pattern: string): Promise<void> {
    const stream = redis.scanStream({ match: pattern, count: 100 })
    for await (const keys of stream) {
        if (keys.length > 0) {
            await redis.del(...keys)
        }
    }
}

const role = (name: string): CreateProjectRoleRequestBody => ({
    name,
    permissions: [],
    type: RoleType.CUSTOM,
})

beforeAll(async () => {
    await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    // runExclusive() hands `key` to redlock as the raw Redis resource, so the keys land
    // unprefixed. Clear this suite's own prefix so a crashed run cannot leave a lock
    // behind that makes the next run's create block until it expires.
    const redis = await redisConnections.useExisting()
    await deleteKeysByPattern(redis, 'project-role:create:*')
})

describe('projectRoleService.create duplicate-name handling', () => {
    it('rejects a second role with the same name instead of inserting a duplicate', async () => {
        // arrange
        const { mockPlatform } = await mockAndSaveBasicSetup()

        // act
        await projectRoleService.create(mockPlatform.id, role('Duplicated Role'))

        // assert - a repeat create is a client error, not a second row.
        await expect(projectRoleService.create(mockPlatform.id, role('Duplicated Role')))
            .rejects.toThrow()

        const rows = await databaseConnection().getRepository('project_role').find({
            where: { platformId: mockPlatform.id, name: 'Duplicated Role' },
        })
        expect(rows).toHaveLength(1)
    })

    it('rejects a concurrent pair of creates for the same name', async () => {
        // arrange - two admins race on the same role name.
        const { mockPlatform } = await mockAndSaveBasicSetup()

        // act
        const results = await Promise.allSettled([
            projectRoleService.create(mockPlatform.id, role('Racing Role')),
            projectRoleService.create(mockPlatform.id, role('Racing Role')),
        ])

        // assert - exactly one succeeds; the loser is told the name is taken.
        const fulfilled = results.filter((r) => r.status === 'fulfilled')
        const rejected = results.filter((r) => r.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)

        const rows = await databaseConnection().getRepository('project_role').find({
            where: { platformId: mockPlatform.id, name: 'Racing Role' },
        })
        expect(rows).toHaveLength(1)
    })

    it('treats a differently-cased name as the same role', async () => {
        // arrange
        const { mockPlatform } = await mockAndSaveBasicSetup()

        // act
        await projectRoleService.create(mockPlatform.id, role('Cased Role'))

        // assert - getOne() lowercases both sides, so this must be a conflict too.
        await expect(projectRoleService.create(mockPlatform.id, role('cased role')))
            .rejects.toThrow()

        const rows = await databaseConnection().getRepository('project_role').find({
            where: { platformId: mockPlatform.id },
        })
        expect(rows.filter((r) => r.name.toLowerCase() === 'cased role')).toHaveLength(1)
    })
})
