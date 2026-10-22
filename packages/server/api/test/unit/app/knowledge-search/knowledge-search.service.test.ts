import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSearchActions = vi.fn()
const mockSearchTriggers = vi.fn()

vi.mock('../../../../src/app/tool-search/tool-search.service', () => ({
    toolSearchService: vi.fn(() => ({
        searchActions: mockSearchActions,
        searchTriggers: mockSearchTriggers,
    })),
}))

import { knowledgeSearchService } from '../../../../src/app/knowledge-search/knowledge-search.service'
import { ToolSearchEmbedder } from '../../../../src/app/tool-search/embedder'
import { ActionSearchResult, TriggerSearchResult } from '../../../../src/app/tool-search/tool-search.service'

describe('knowledgeSearchService', () => {
    const mockLog = {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    } as unknown as FastifyBaseLogger

    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe('objectKind: "action"', () => {
        it('queries searchActions, formats action results, and ignores triggers', async () => {
            const mockAction: ActionSearchResult = {
                pieceName: '@inboxfm-connect/piece-slack',
                actionName: 'send_channel_message',
                displayName: 'Send Slack Message',
                oneLineDescription: 'Sends a message to a channel',
                requiresConnection: true,
                cosine: 0.88,
                connected: true,
            }

            mockSearchActions.mockResolvedValueOnce({
                results: [mockAction],
                mode: 'semantic',
            })

            const service = knowledgeSearchService(mockLog)
            const response = await service.query({
                query: 'send message to slack channel',
                objectKind: 'action',
                platformId: 'plt-test',
                projectId: 'prj-test',
                limit: 5,
                pieceName: '@inboxfm-connect/piece-slack',
                audiences: ['AI_AGENT'],
            })

            expect(mockSearchActions).toHaveBeenCalledWith('send message to slack channel', {
                platformId: 'plt-test',
                projectId: 'prj-test',
                limit: 5,
                pieceName: '@inboxfm-connect/piece-slack',
                audiences: ['AI_AGENT'],
                embedder: undefined,
            })
            expect(mockSearchTriggers).not.toHaveBeenCalled()

            expect(response.mode).toBe('semantic')
            expect(response.results).toEqual([
                {
                    pieceName: '@inboxfm-connect/piece-slack',
                    objectName: 'send_channel_message',
                    objectKind: 'action',
                    displayName: 'Send Slack Message',
                    oneLineDescription: 'Sends a message to a channel',
                    requiresConnection: true,
                    cosine: 0.88,
                    connected: true,
                },
            ])
        })
    })

    describe('objectKind: "trigger"', () => {
        it('queries searchTriggers, formats trigger results, and ignores actions', async () => {
            const mockTrigger: TriggerSearchResult = {
                pieceName: '@inboxfm-connect/piece-gmail',
                triggerName: 'new_email_received',
                displayName: 'New Email',
                oneLineDescription: 'Triggers when a new email arrives',
                requiresConnection: true,
                cosine: 0.92,
                connected: false,
            }

            mockSearchTriggers.mockResolvedValueOnce({
                results: [mockTrigger],
                mode: 'semantic',
            })

            const service = knowledgeSearchService(mockLog)
            const response = await service.query({
                query: 'new incoming email',
                objectKind: 'trigger',
                platformId: 'plt-test',
                projectId: 'prj-test',
                limit: 3,
            })

            expect(mockSearchTriggers).toHaveBeenCalledWith('new incoming email', {
                platformId: 'plt-test',
                projectId: 'prj-test',
                limit: 3,
                pieceName: undefined,
                embedder: undefined,
            })
            expect(mockSearchActions).not.toHaveBeenCalled()

            expect(response.mode).toBe('semantic')
            expect(response.results).toEqual([
                {
                    pieceName: '@inboxfm-connect/piece-gmail',
                    objectName: 'new_email_received',
                    objectKind: 'trigger',
                    displayName: 'New Email',
                    oneLineDescription: 'Triggers when a new email arrives',
                    requiresConnection: true,
                    cosine: 0.92,
                    connected: false,
                },
            ])
        })
    })

    describe('objectKind: "all" (default)', () => {
        it('queries both actions and triggers, sorts results by cosine descending, and limits results', async () => {
            const mockAction1: ActionSearchResult = {
                pieceName: '@inboxfm-connect/piece-slack',
                actionName: 'send_message',
                displayName: 'Send Message',
                oneLineDescription: 'Send a message',
                requiresConnection: true,
                cosine: 0.75,
                connected: true,
            }
            const mockAction2: ActionSearchResult = {
                pieceName: '@inboxfm-connect/piece-discord',
                actionName: 'send_channel_msg',
                displayName: 'Send Discord Message',
                oneLineDescription: 'Send message in Discord',
                requiresConnection: false,
                cosine: 0.95,
                connected: true,
            }
            const mockTrigger1: TriggerSearchResult = {
                pieceName: '@inboxfm-connect/piece-slack',
                triggerName: 'new_channel_message',
                displayName: 'New Slack Message',
                oneLineDescription: 'Triggers on new message',
                requiresConnection: true,
                cosine: 0.85,
                connected: true,
            }
            const mockTrigger2: TriggerSearchResult = {
                pieceName: '@inboxfm-connect/piece-github',
                triggerName: 'new_issue',
                displayName: 'New GitHub Issue',
                oneLineDescription: 'Triggers on new issue',
                requiresConnection: false,
                cosine: 0.60,
                connected: false,
            }

            mockSearchActions.mockResolvedValueOnce({
                results: [mockAction1, mockAction2],
                mode: 'semantic',
            })
            mockSearchTriggers.mockResolvedValueOnce({
                results: [mockTrigger1, mockTrigger2],
                mode: 'semantic',
            })

            const service = knowledgeSearchService(mockLog)
            const response = await service.query({
                query: 'message',
                objectKind: 'all',
                platformId: 'plt-test',
                projectId: 'prj-test',
                limit: 3,
            })

            expect(mockSearchActions).toHaveBeenCalledWith('message', expect.objectContaining({ limit: 3 }))
            expect(mockSearchTriggers).toHaveBeenCalledWith('message', expect.objectContaining({ limit: 3 }))

            expect(response.mode).toBe('semantic')
            expect(response.results).toHaveLength(3)

            // Should be sorted by cosine descending: 0.95 (action2), 0.85 (trigger1), 0.75 (action1)
            expect(response.results[0].objectName).toBe('send_channel_msg')
            expect(response.results[0].cosine).toBe(0.95)

            expect(response.results[1].objectName).toBe('new_channel_message')
            expect(response.results[1].cosine).toBe(0.85)

            expect(response.results[2].objectName).toBe('send_message')
            expect(response.results[2].cosine).toBe(0.75)
        })

        it('returns keyword mode when both sub-searches run in keyword mode', async () => {
            mockSearchActions.mockResolvedValueOnce({
                results: [],
                mode: 'keyword',
            })
            mockSearchTriggers.mockResolvedValueOnce({
                results: [],
                mode: 'keyword',
            })

            const service = knowledgeSearchService(mockLog)
            const response = await service.query({
                query: 'non-embedded fallback query',
                platformId: 'plt-test',
                projectId: 'prj-test',
            })

            expect(response.mode).toBe('keyword')
            expect(response.results).toEqual([])
        })

        it('returns semantic mode when at least one sub-search is semantic', async () => {
            mockSearchActions.mockResolvedValueOnce({
                results: [],
                mode: 'semantic',
            })
            mockSearchTriggers.mockResolvedValueOnce({
                results: [],
                mode: 'keyword',
            })

            const service = knowledgeSearchService(mockLog)
            const response = await service.query({
                query: 'mixed mode query',
                platformId: 'plt-test',
                projectId: 'prj-test',
            })

            expect(response.mode).toBe('semantic')
        })
    })

    describe('custom embedder propagation', () => {
        it('forwards the custom embedder (memo-wrapped) to toolSearchService and embeds the shared query once', async () => {
            const embedSpy = vi.fn().mockResolvedValue([[0.1, 0.2]])
            const fakeEmbedder: ToolSearchEmbedder = {
                modelVersion: 'test-v1',
                dimensions: 768,
                tau: 0.5,
                embed: embedSpy,
            }

            mockSearchActions.mockResolvedValueOnce({ results: [], mode: 'semantic' })
            mockSearchTriggers.mockResolvedValueOnce({ results: [], mode: 'semantic' })

            const service = knowledgeSearchService(mockLog)
            await service.query({
                query: 'test',
                platformId: 'plt-test',
                projectId: 'prj-test',
                embedder: fakeEmbedder,
            })

            // The unified pipeline forwards a memoizing wrapper, not the raw
            // object: the custom embedder's config must survive the wrap...
            const actionsArg = mockSearchActions.mock.calls[0][1]
            const triggersArg = mockSearchTriggers.mock.calls[0][1]
            expect(actionsArg.embedder).toBeDefined()
            expect(actionsArg.embedder.modelVersion).toBe('test-v1')
            expect(actionsArg.embedder.dimensions).toBe(768)
            expect(actionsArg.embedder.tau).toBe(0.5)
            expect(triggersArg.embedder.modelVersion).toBe('test-v1')
            // ...and the shared query text is embedded exactly once, not once
            // per branch.
            await Promise.all([
                actionsArg.embedder.embed(['test']),
                triggersArg.embedder.embed(['test']),
            ])
            expect(embedSpy).toHaveBeenCalledTimes(1)
            // A different text is NOT memoized - it passes through to the API.
            await actionsArg.embedder.embed(['other'])
            expect(embedSpy).toHaveBeenCalledTimes(2)
        })

        it('single-kind searches forward the memo-wrapped custom embedder too', async () => {
            const embedSpy = vi.fn().mockResolvedValue([[0.5, 0.5]])
            const fakeEmbedder: ToolSearchEmbedder = {
                modelVersion: 'test-v1',
                dimensions: 768,
                tau: 0.5,
                embed: embedSpy,
            }

            mockSearchActions.mockResolvedValueOnce({ results: [], mode: 'semantic' })

            const service = knowledgeSearchService(mockLog)
            await service.query({
                query: 'test',
                platformId: 'plt-test',
                projectId: 'prj-test',
                objectKind: 'action',
                embedder: fakeEmbedder,
            })

            const actionsArg = mockSearchActions.mock.calls[0][1]
            expect(actionsArg.embedder.modelVersion).toBe('test-v1')
            await actionsArg.embedder.embed(['test'])
            expect(embedSpy).toHaveBeenCalledTimes(1)
        })
    })
})
