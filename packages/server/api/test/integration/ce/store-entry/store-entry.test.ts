import { apId } from '@inboxfm-connect/core-utils'
import { PrincipalType } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

const engineToken = async (params: { projectId: string, platformId: string }): Promise<string> => {
    return generateMockToken({
        type: PrincipalType.ENGINE,
        id: apId(),
        projectId: params.projectId,
        platform: { id: params.platformId },
    })
}

const call = async (params: {
    method: 'POST' | 'GET' | 'DELETE'
    token: string
    body?: Record<string, unknown>
    query?: Record<string, string>
}) => {
    return app!.inject({
        method: params.method,
        url: '/api/v1/store-entries',
        headers: { authorization: `Bearer ${params.token}` },
        body: params.body,
        query: params.query,
    })
}

describe('Store Entries API', () => {
    describe('round trip', () => {
        it('stores a value and reads it back', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const token = await engineToken({ projectId: mockProject.id, platformId: mockPlatform.id })

            const put = await call({
                method: 'POST',
                token,
                body: { key: 'cart', value: { items: ['a', 'b'] } },
            })
            expect(put.statusCode).toBe(StatusCodes.OK)

            const get = await call({ method: 'GET', token, query: { key: 'cart' } })
            expect(get.statusCode).toBe(StatusCodes.OK)
            expect(get.json().value).toEqual({ items: ['a', 'b'] })
        })

        it('returns 404 with the structured error contract for a key that was never written', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const token = await engineToken({ projectId: mockProject.id, platformId: mockPlatform.id })

            const get = await call({ method: 'GET', token, query: { key: 'nope' } })
            expect(get.statusCode).toBe(StatusCodes.NOT_FOUND)
            // The 404 used to be a plain-text body ('Value not found!'); every
            // other miss on the API answers with the { code, params } contract.
            expect(get.json()).toEqual({
                code: 'ENTITY_NOT_FOUND',
                params: { entityType: 'storeEntry', entityId: 'nope' },
            })
        })

        it('deletes a key so a later read misses', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const token = await engineToken({ projectId: mockProject.id, platformId: mockPlatform.id })

            await call({ method: 'POST', token, body: { key: 'tmp', value: 1 } })
            const del = await call({ method: 'DELETE', token, query: { key: 'tmp' } })
            expect(del.statusCode).toBe(StatusCodes.OK)

            const get = await call({ method: 'GET', token, query: { key: 'tmp' } })
            expect(get.statusCode).toBe(StatusCodes.NOT_FOUND)
        })
    })

    describe('upsert', () => {
        it('keeps the same row id and refreshes the timestamp on overwrite', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const token = await engineToken({ projectId: mockProject.id, platformId: mockPlatform.id })

            const first = await call({ method: 'POST', token, body: { key: 'state', value: 1 } })
            expect(first.statusCode).toBe(StatusCodes.OK)
            const firstBody = first.json()

            const second = await call({ method: 'POST', token, body: { key: 'state', value: 2 } })
            expect(second.statusCode).toBe(StatusCodes.OK)
            const secondBody = second.json()

            expect(firstBody.id).toBeDefined()
            expect(secondBody.value).toBe(2)

            const rows = await db.findManyBy<{ id: string, created: string, updated: string, value: unknown }>(
                'store-entry',
                { projectId: mockProject.id, key: 'state' },
            )
            expect(rows).toHaveLength(1)
            expect(rows[0].value).toEqual(2)

            expect(firstBody.id).toBe(rows[0].id)
            expect(secondBody.id).toBe(rows[0].id)
            expect(secondBody.created).toBe(firstBody.created)

            expect(typeof firstBody.created).toBe('string')
            expect(typeof firstBody.updated).toBe('string')
            expect(new Date(secondBody.updated).getTime())
                .toBeGreaterThanOrEqual(new Date(firstBody.updated).getTime())
        })
    })

    describe('project isolation', () => {
        it('does not let another project read the key', async () => {
            const writer = await mockAndSaveBasicSetup()
            const reader = await mockAndSaveBasicSetup()
            const writerToken = await engineToken({ projectId: writer.mockProject.id, platformId: writer.mockPlatform.id })
            const readerToken = await engineToken({ projectId: reader.mockProject.id, platformId: reader.mockPlatform.id })

            await call({
                method: 'POST',
                token: writerToken,
                body: { key: 'secret', value: 'from-project-a' },
            })

            const read = await call({ method: 'GET', token: readerToken, query: { key: 'secret' } })
            expect(read.statusCode).toBe(StatusCodes.NOT_FOUND)

            const readOwn = await call({ method: 'GET', token: writerToken, query: { key: 'secret' } })
            expect(readOwn.statusCode).toBe(StatusCodes.OK)
            expect(readOwn.json().value).toBe('from-project-a')
        })

        it('does not let another project delete the key', async () => {
            const writer = await mockAndSaveBasicSetup()
            const attacker = await mockAndSaveBasicSetup()
            const writerToken = await engineToken({ projectId: writer.mockProject.id, platformId: writer.mockPlatform.id })
            const attackerToken = await engineToken({ projectId: attacker.mockProject.id, platformId: attacker.mockPlatform.id })

            await call({ method: 'POST', token: writerToken, body: { key: 'keep', value: 'mine' } })

            await call({ method: 'DELETE', token: attackerToken, query: { key: 'keep' } })

            const read = await call({ method: 'GET', token: writerToken, query: { key: 'keep' } })
            expect(read.statusCode).toBe(StatusCodes.OK)
            expect(read.json().value).toBe('mine')
        })
    })
})
