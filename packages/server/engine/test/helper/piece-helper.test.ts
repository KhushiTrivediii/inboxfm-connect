import { ContextVersion } from '@inboxfm-connect/pieces-framework'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pieceHelper } from '../../src/lib/helper/piece-helper'

const runMock = vi.fn()

vi.mock('../../src/lib/helper/piece-loader', () => ({
    pieceLoader: {
        getPieceAndActionOrThrow: vi.fn().mockResolvedValue({
            piece: {
                getContextInfo: () => ({ version: ContextVersion.V2 }),
            },
            pieceAction: {
                props: {},
                requireAuth: false,
                run: (...args: unknown[]) => runMock(...args),
            },
        }),
    },
}))

const params = {
    pieceName: '@inboxfm-connect/piece-ai',
    pieceVersion: '0.0.1',
    actionName: 'askAi',
    input: {},
    engineToken: 'engine-token',
    projectId: 'project-1',
    platformId: 'platform-1',
    internalApiUrl: 'http://localhost:3100/api/',
    publicApiUrl: 'http://localhost:3100/api/',
    timeoutInSeconds: 60,
}

describe('pieceHelper.executeTool headless context contract', () => {
    beforeEach(() => {
        runMock.mockReset()
    })

    it('carries the flows key so pieces reading context.flows do not crash headlessly (#618)', async () => {
        runMock.mockImplementation(async (ctx: { flows: { current: { id: string }, list: unknown } }) => ({
            flowsCurrentId: ctx.flows.current.id,
            listType: typeof ctx.flows.list,
        }))

        const response = await pieceHelper.executeTool({ params, devPieces: [] })

        expect(response.status).toBe('OK')
        expect(response.response).toEqual({
            flowsCurrentId: 'headless',
            listType: 'function',
        })
    })

    it('builds a well-formed flows.list URL from an internal URL without a trailing slash', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        runMock.mockImplementation(async (ctx: { flows: { list: (params: unknown) => Promise<unknown> } }) => {
            await ctx.flows.list({})
            return { calledUrl: fetchMock.mock.calls[0][0] }
        })

        try {
            const response = await pieceHelper.executeTool({
                params: { ...params, internalApiUrl: 'http://localhost:3100/api' },
                devPieces: [],
            })

            expect(response.status).toBe('OK')
            expect(response.response).toEqual({ calledUrl: 'http://localhost:3100/api/v1/engine/populated-flows?' })
        }
        finally {
            vi.unstubAllGlobals()
        }
    })

    it('wires store with engineToken and normalizes internalApiUrl for store operations (#544)', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ key: 'flow_headless/demo-key', value: 'demo-val' }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        runMock.mockImplementation(async (ctx: { store: { get: (key: string) => Promise<unknown> } }) => {
            const val = await ctx.store.get('demo-key')
            return {
                val,
                calledUrl: fetchMock.mock.calls[0][0].toString(),
                authHeader: (fetchMock.mock.calls[0][1] as RequestInit)?.headers,
            }
        })

        try {
            const response = await pieceHelper.executeTool({
                params: { ...params, internalApiUrl: 'http://localhost:3100/api', engineToken: 'secret-engine-token' },
                devPieces: [],
            })

            expect(response.status).toBe('OK')
            expect(response.response).toEqual({
                val: 'demo-val',
                calledUrl: 'http://localhost:3100/api/v1/store-entries?key=flow_headless%2Fdemo-key',
                authHeader: {
                    Authorization: 'Bearer secret-engine-token',
                },
            })
        }
        finally {
            vi.unstubAllGlobals()
        }
    })

    it('normalizes internalApiUrl without trailing slash for file uploads (#544)', async () => {
        const fetchMock = vi.fn(async () => new Response(JSON.stringify({ readUrl: 'http://localhost:3100/api/v1/files/read-url' }), { status: 200, headers: { 'content-type': 'application/json' } }))
        vi.stubGlobal('fetch', fetchMock)
        runMock.mockImplementation(async (ctx: { files: { write: (p: { fileName: string, data: Buffer }) => Promise<string> } }) => {
            const readUrl = await ctx.files.write({ fileName: 'test.txt', data: Buffer.from('hello') })
            return {
                readUrl,
                calledUrl: fetchMock.mock.calls[0][0].toString(),
            }
        })

        try {
            const response = await pieceHelper.executeTool({
                params: { ...params, internalApiUrl: 'http://localhost:3100/api', engineToken: 'secret-engine-token' },
                devPieces: [],
            })

            expect(response.status).toBe('OK')
            const res = response.response as { readUrl: string, calledUrl: string }
            expect(res.readUrl).toBe('http://localhost:3100/api/v1/files/read-url')
            expect(res.calledUrl).toMatch(/^http:\/\/localhost:3100\/api\/v1\/files\//)
        }
        finally {
            vi.unstubAllGlobals()
        }
    })
})
