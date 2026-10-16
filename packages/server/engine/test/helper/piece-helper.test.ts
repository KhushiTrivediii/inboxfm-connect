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
})
