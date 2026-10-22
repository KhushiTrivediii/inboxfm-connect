import { AppCredentialType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Issue #415: the optional ?appName= filter used a chained second .where(),
// which RESETS TypeORM's where-list (SelectQueryBuilder.js:341) and wiped the
// projectId tenant scoping — ?appName=X listed every tenant's credential rows.
// Behavior pin: a filtered list must stay scoped to the caller's project.

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

const createCredential = async (ctx: Awaited<ReturnType<typeof createTestContext>>, appName: string): Promise<string> => {
    const response = await ctx.post('/v1/app-credentials', {
        appName,
        projectId: ctx.project.id,
        settings: {
            type: AppCredentialType.API_KEY,
        },
    })
    expect(response?.statusCode).toBe(StatusCodes.OK)
    return response?.json().id
}

describe('app-credentials list WHERE composition (issue #415)', () => {
    it('the appName filter stays projectId-scoped: no other tenant rows leak into a filtered list', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)

        // both projects hold a credential with the SAME appName
        const idA = await createCredential(ctxA, 'shared-name')
        await createCredential(ctxB, 'shared-name')

        // filtered list for project A: must contain A's row and NOT B's
        const response = await ctxA.get('/v1/app-credentials', {
            projectId: ctxA.project.id,
            appName: 'shared-name',
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
        const rows: { id: string, projectId: string }[] = response?.json().data
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe(idA)
        expect(rows[0].projectId).toBe(ctxA.project.id)

        // unfiltered sanity: the scoping composes, pagination intact
        const unfiltered = await ctxA.get('/v1/app-credentials', {
            projectId: ctxA.project.id,
        })
        const allIds: string[] = unfiltered?.json().data.map((row: { id: string }) => row.id)
        expect(allIds).toContain(idA)
        expect(allIds).toHaveLength(1)
    })

    it('no appName filter: the projectId scoping alone still holds', async () => {
        const ctxA = await createTestContext(app!)
        const ctxB = await createTestContext(app!)
        const idA = await createCredential(ctxA, 'unfiltered-app')
        await createCredential(ctxB, 'other-project-app')

        const response = await ctxA.get('/v1/app-credentials', {
            projectId: ctxA.project.id,
        })
        expect(response?.statusCode).toBe(StatusCodes.OK)
        const ids: string[] = response?.json().data.map((row: { id: string }) => row.id)
        expect(ids).toContain(idA)
        expect(ids).toHaveLength(1)
    })
})
