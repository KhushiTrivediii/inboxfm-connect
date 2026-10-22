import { ConnectionKeyType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Issue #413: DELETE /v1/connection-keys/:connectionkeyId used to have no
// security config (-> PUBLIC) plus an id-only service delete, so any
// unauthenticated caller could destroy any tenant's connection key.
// Behavior pins for the fix: authn + authz now run on the route and the
// delete is scoped to the row's own project (TABLE resource lookup).

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

type TestContext = Awaited<ReturnType<typeof createTestContext>>

const createKey = async (ctx: TestContext): Promise<string> => {
    const created = await ctx.post('/v1/connection-keys', {
        projectId: ctx.project.id,
        settings: { type: ConnectionKeyType.SIGNING_KEY },
    })
    expect(created?.statusCode).toBe(StatusCodes.OK)
    return created?.json().id
}

describe('connection-key DELETE /:connectionkeyId security (issue #413)', () => {
    it('401s for a garbage bearer token (authentication runs)', async () => {
        const response = await app!.inject({
            method: 'DELETE',
            url: '/api/v1/connection-keys/ck_anything',
            headers: { authorization: 'Bearer garbage-token' },
        })
        expect(response.statusCode).toBe(StatusCodes.UNAUTHORIZED)
    })

    it('rejects an unauthenticated call against an existing key (row survives)', async () => {
        const ctx = await createTestContext(app!)
        const keyId = await createKey(ctx)

        // no authorization header at all: the route must not delete the row
        const response = await app!.inject({
            method: 'DELETE',
            url: `/api/v1/connection-keys/${keyId}`,
        })
        expect([StatusCodes.UNAUTHORIZED, StatusCodes.FORBIDDEN]).toContain(response.statusCode)

        // row must still exist
        const list = await ctx.get('/v1/connection-keys', { projectId: ctx.project.id })
        const ids: string[] = list?.json().data.map((row: { id: string }) => row.id)
        expect(ids).toContain(keyId)
    })

    it('404s an unknown id (TABLE lookup ENTITY_NOT_FOUND)', async () => {
        const ctx = await createTestContext(app!)
        const response = await ctx.delete('/v1/connection-keys/ck_does_not_exist')
        expect(response?.statusCode).toBe(StatusCodes.NOT_FOUND)
    })

    it('deletes own-project key: 200 + row gone (happy path)', async () => {
        const ctx = await createTestContext(app!)
        const keyId = await createKey(ctx)

        const response = await ctx.delete(`/v1/connection-keys/${keyId}`)
        expect(response?.statusCode).toBe(StatusCodes.OK)

        const listAfter = await ctx.get('/v1/connection-keys', { projectId: ctx.project.id })
        expect(listAfter?.statusCode).toBe(StatusCodes.OK)
        const ids: string[] = listAfter?.json().data.map((row: { id: string }) => row.id)
        expect(ids).not.toContain(keyId)
    })

    it('cross-project id: victim row of another project is NOT deletable', async () => {
        // victim key lives in project B; attacker holds a valid token for project A
        const victimCtx = await createTestContext(app!)
        const victimKeyId = await createKey(victimCtx)

        const attackerCtx = await createTestContext(app!)
        const response = await attackerCtx.delete(`/v1/connection-keys/${victimKeyId}`)
        expect([StatusCodes.FORBIDDEN, StatusCodes.NOT_FOUND]).toContain(response?.statusCode)

        // and the victim row must still exist
        const victimList = await victimCtx.get('/v1/connection-keys', { projectId: victimCtx.project.id })
        const ids: string[] = victimList?.json().data.map((row: { id: string }) => row.id)
        expect(ids).toContain(victimKeyId)
    })
})
