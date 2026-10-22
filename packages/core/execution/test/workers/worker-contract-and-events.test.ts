import { describe, expect, it } from 'vitest'
import {
    ActionPreviewEvent,
    ActionReceiptEvent,
    BuildPlanEvent,
    ChatAgentEvent,
    ChatAgentEventType,
    FileProducedEvent,
    ImageGeneratedEvent,
    ToolProgressEvent,
} from '../../src/lib/workers/chat-agent-events'
import {
    PrepareFlowBundleUploadResponse,
    PrewarmDataResponse,
    SendChatEmailResponse,
    WorkerToApiContract,
} from '../../src/lib/workers/worker-contract'
import { TriggerRunStatus } from '../../src/lib/flows/triggers/trigger-run'

describe('worker contracts and chat agent event typing', () => {
    describe('ChatAgentEvent variations', () => {
        it('handles CHUNK event', () => {
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.CHUNK,
                data: { delta: 'Hello world' },
            }
            expect(event.type).toBe(ChatAgentEventType.CHUNK)
            expect((event.data as any).delta).toBe('Hello world')
        })

        it('handles FINISHED event', () => {
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.FINISHED,
                data: { conversationId: 'conv_123' },
            }
            expect(event.type).toBe(ChatAgentEventType.FINISHED)
            expect(event.data.conversationId).toBe('conv_123')
        })

        it('handles ERROR event', () => {
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.ERROR,
                data: { message: 'Rate limit reached', code: 'RATE_LIMIT' },
            }
            expect(event.type).toBe(ChatAgentEventType.ERROR)
            expect(event.data.code).toBe('RATE_LIMIT')
        })

        it('handles TITLE_UPDATE event', () => {
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.TITLE_UPDATE,
                data: { title: 'Order processing conversation' },
            }
            expect(event.type).toBe(ChatAgentEventType.TITLE_UPDATE)
            expect(event.data.title).toBe('Order processing conversation')
        })

        it('handles TOOL_PROGRESS event', () => {
            const progress: ToolProgressEvent = {
                toolCallId: 'call_99',
                data: {
                    label: 'Syncing accounts',
                    total: 10,
                    completed: 5,
                    succeeded: 4,
                    failed: 1,
                    done: false,
                    results: [
                        { index: 0, success: true, output: { id: 'acc_1' } },
                        { index: 1, success: false, error: 'Network timeout' },
                    ],
                },
            }
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.TOOL_PROGRESS,
                data: progress,
            }
            expect(event.type).toBe(ChatAgentEventType.TOOL_PROGRESS)
            expect(event.data.data.results).toHaveLength(2)
        })

        it('handles ACTION_PREVIEW event', () => {
            const preview: ActionPreviewEvent = {
                toolCallId: 'call_100',
                pieceName: '@inboxfm-connect/piece-gmail',
                actionName: 'send_email',
                actionDisplayName: 'Send Email',
                connectionLabel: 'Work Gmail',
                input: { to: 'test@example.com', subject: 'Report' },
                isBatch: false,
            }
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.ACTION_PREVIEW,
                data: preview,
            }
            expect(event.type).toBe(ChatAgentEventType.ACTION_PREVIEW)
            expect(event.data.actionName).toBe('send_email')
        })

        it('handles ACTION_RECEIPT event', () => {
            const receipt: ActionReceiptEvent = {
                toolCallId: 'call_100',
                actionDisplayName: 'Send Email',
                pieceName: '@inboxfm-connect/piece-gmail',
                connectionLabel: 'Work Gmail',
                status: 'success',
                output: { messageId: 'msg_999' },
                timestamp: '2026-10-01T12:00:00.000Z',
            }
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.ACTION_RECEIPT,
                data: receipt,
            }
            expect(event.type).toBe(ChatAgentEventType.ACTION_RECEIPT)
            expect(event.data.status).toBe('success')
        })

        it('handles IMAGE generated event', () => {
            const img: ImageGeneratedEvent = {
                toolCallId: 'call_img',
                fileId: 'file_001',
                url: 'https://cdn.example.com/images/001.png',
                mediaType: 'image/png',
                prompt: 'A sunset over the mountains',
                timestamp: '2026-10-01T12:00:00.000Z',
            }
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.IMAGE,
                data: img,
            }
            expect(event.type).toBe(ChatAgentEventType.IMAGE)
            expect(event.data.mediaType).toBe('image/png')
        })

        it('handles FILE produced event', () => {
            const file: FileProducedEvent = {
                toolCallId: 'call_file',
                fileId: 'file_002',
                url: 'https://cdn.example.com/files/002.pdf',
                mediaType: 'application/pdf',
                fileName: 'Monthly Report.pdf',
                byteSize: 1048576,
                timestamp: '2026-10-01T12:00:00.000Z',
            }
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.FILE,
                data: file,
            }
            expect(event.type).toBe(ChatAgentEventType.FILE)
            expect(event.data.byteSize).toBe(1048576)
        })

        it('handles BUILD_PLAN event', () => {
            const plan: BuildPlanEvent = {
                buildId: 'bld_1',
                phase: 'building',
                steps: [
                    { id: 'step_1', label: 'Create trigger', status: 'done' },
                    { id: 'step_2', label: 'Configure Slack action', status: 'in_progress' },
                    { id: 'step_3', label: 'Test flow', status: 'pending' },
                ],
                updatedAt: '2026-10-01T12:00:00.000Z',
            }
            const event: ChatAgentEvent = {
                type: ChatAgentEventType.BUILD_PLAN,
                data: plan,
            }
            expect(event.type).toBe(ChatAgentEventType.BUILD_PLAN)
            expect(event.data.steps).toHaveLength(3)
        })
    })

    describe('worker response type shapes', () => {
        it('validates PrepareFlowBundleUploadResponse variants', () => {
            const urlResp: PrepareFlowBundleUploadResponse = { kind: 'url', url: 'https://s3.bucket/upload' }
            const inlineResp: PrepareFlowBundleUploadResponse = { kind: 'inline' }
            const skipResp: PrepareFlowBundleUploadResponse = { kind: 'skip' }

            expect(urlResp.kind).toBe('url')
            expect(inlineResp.kind).toBe('inline')
            expect(skipResp.kind).toBe('skip')
        })

        it('validates PrewarmDataResponse shape', () => {
            const prewarm: PrewarmDataResponse = {
                flows: [{ id: 'f1', versionId: 'v1', projectId: 'p1' }],
                platformId: 'plat_1',
                engineToken: 'token_sec',
            }
            expect(prewarm.flows[0].id).toBe('f1')
            expect(prewarm.platformId).toBe('plat_1')
        })

        it('validates SendChatEmailResponse shape', () => {
            const emailResp: SendChatEmailResponse = {
                sent: true,
                message: 'Email delivered',
                blockedRecipients: [],
            }
            expect(emailResp.sent).toBe(true)
            expect(emailResp.blockedRecipients).toEqual([])
        })
    })
})
