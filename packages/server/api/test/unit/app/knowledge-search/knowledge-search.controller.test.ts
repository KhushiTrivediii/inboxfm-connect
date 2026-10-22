import fastify, { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()

vi.mock('../../../../src/app/knowledge-search/knowledge-search.service', () => ({
    knowledgeSearchService: vi.fn(() => ({
        query: mockQuery,
    })),
}))

import { knowledgeSearchController } from '../../../../src/app/knowledge-search/knowledge-search.controller'

describe('knowledgeSearchController', () => {
    let app: FastifyInstance

    beforeEach(async () => {
        vi.clearAllMocks()
        app = fastify({ logger: false })
        app.setValidatorCompiler(validatorCompiler)
        app.setSerializerCompiler(serializerCompiler)

        // Mock principal and project security decoration
        app.addHook('preHandler', async (req) => {
            Object.assign(req, {
                principal: {
                    platform: { id: 'plt-test-123' },
                    type: 'USER',
                },
                projectId: 'prj-test-456',
            })
        })

        await app.register(knowledgeSearchController)
        await app.ready()
    })

    afterEach(async () => {
        await app.close()
    })

    it('rejects an empty query string with 400 Bad Request', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/query',
            payload: {
                query: '',
            },
        })

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(mockQuery).not.toHaveBeenCalled()
    })

    it('rejects query when limit is out of allowed bounds (1 to 50)', async () => {
        const responseZero = await app.inject({
            method: 'POST',
            url: '/query',
            payload: {
                query: 'test query',
                limit: 0,
            },
        })
        expect(responseZero.statusCode).toBe(StatusCodes.BAD_REQUEST)

        const responseTooLarge = await app.inject({
            method: 'POST',
            url: '/query',
            payload: {
                query: 'test query',
                limit: 51,
            },
        })
        expect(responseTooLarge.statusCode).toBe(StatusCodes.BAD_REQUEST)

        const responseFloat = await app.inject({
            method: 'POST',
            url: '/query',
            payload: {
                query: 'test query',
                limit: 5.5,
            },
        })
        expect(responseFloat.statusCode).toBe(StatusCodes.BAD_REQUEST)
    })

    it('rejects an invalid objectKind enum', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/query',
            payload: {
                query: 'send email',
                objectKind: 'invalid_kind',
            },
        })

        expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        expect(mockQuery).not.toHaveBeenCalled()
    })

    it('successfully scopes query to platformId and projectId and returns 200 with results', async () => {
        const mockResults = [
            {
                pieceName: '@inboxfm-connect/piece-slack',
                objectName: 'send_message',
                objectKind: 'action' as const,
                displayName: 'Send Message',
                oneLineDescription: 'Sends a Slack message',
                requiresConnection: true,
                cosine: 0.91,
                connected: true,
            },
        ]

        mockQuery.mockResolvedValueOnce({
            results: mockResults,
            mode: 'semantic',
        })

        const response = await app.inject({
            method: 'POST',
            url: '/query',
            payload: {
                query: 'send a slack notification',
                objectKind: 'action',
                limit: 10,
                pieceName: '@inboxfm-connect/piece-slack',
                audiences: ['AGENT'],
            },
        })

        expect(response.statusCode).toBe(StatusCodes.OK)
        expect(mockQuery).toHaveBeenCalledWith({
            query: 'send a slack notification',
            limit: 10,
            objectKind: 'action',
            pieceName: '@inboxfm-connect/piece-slack',
            audiences: ['AGENT'],
            platformId: 'plt-test-123',
            projectId: 'prj-test-456',
        })

        const body = JSON.parse(response.body)
        expect(body.mode).toBe('semantic')
        expect(body.results).toEqual(mockResults)
    })
})
