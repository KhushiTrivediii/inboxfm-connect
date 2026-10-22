import { describe, expect, it } from 'vitest'
import {
    ChatFormResponse,
    createKeyForFormInput,
    FileResponseInterface,
    HumanInputFormResult,
    HumanInputFormResultTypes,
} from '../src/lib/automation/forms'
import {
    LockResourceRequest,
    LockResourceResponse,
    PresenceRequest,
    PresenceUpdatedEvent,
    PresenceUser,
    ResourceLockedEvent,
    ResourceUnlockedEvent,
    WebsocketClientEvent,
    WebsocketServerEvent,
} from '../src/lib/automation/websocket'

describe('Forms & Websocket Contracts & Schemas', () => {
    describe('Forms schemas & createKeyForFormInput', () => {
        it('createKeyForFormInput converts names to camelCase and strips quotes/delimiters', () => {
            expect(createKeyForFormInput('First Name')).toBe('firstName')
            expect(createKeyForFormInput('User Email Address')).toBe('userEmailAddress')
            expect(createKeyForFormInput('User\'s Nickname')).toBe('usersNickname')
            expect(createKeyForFormInput('Special\nInput\tField')).toBe('specialInputField')
        })

        it('validates FileResponseInterface V1 and V2 shapes', () => {
            const fileV1 = FileResponseInterface.parse({
                base64Url: 'data:text/plain;base64,SGVsbG8=',
                fileName: 'hello.txt',
                extension: 'txt',
            })
            expect(fileV1).toHaveProperty('base64Url')

            const fileV2 = FileResponseInterface.parse({
                mimeType: 'application/pdf',
                url: 'https://storage.example.com/doc.pdf',
                fileName: 'doc.pdf',
            })
            expect(fileV2).toHaveProperty('mimeType')

            expect(() => FileResponseInterface.parse({ invalid: 123 })).toThrow()
        })

        it('validates HumanInputFormResult for both file and markdown types', () => {
            const fileResult = HumanInputFormResult.parse({
                type: HumanInputFormResultTypes.FILE,
                value: {
                    base64Url: 'data:image/png;base64,...',
                    fileName: 'avatar.png',
                },
            })
            expect(fileResult.type).toBe('file')

            const mdResult = HumanInputFormResult.parse({
                type: HumanInputFormResultTypes.MARKDOWN,
                value: '# Header\nContent here',
                files: [
                    {
                        mimeType: 'image/png',
                        url: 'https://example.com/img.png',
                    },
                ],
            })
            expect(mdResult.type).toBe('markdown')
            if (mdResult.type === HumanInputFormResultTypes.MARKDOWN) {
                expect(mdResult.files).toHaveLength(1)
            }
        })

        it('validates ChatFormResponse schema', () => {
            const chatResp = ChatFormResponse.parse({
                sessionId: 'session_123',
                message: 'Hello Assistant',
                files: ['file_id_1'],
            })
            expect(chatResp.sessionId).toBe('session_123')
            expect(chatResp.message).toBe('Hello Assistant')
            expect(chatResp.files).toEqual(['file_id_1'])
        })
    })

    describe('Websocket event enums and resource locking schemas', () => {
        it('exposes defined websocket client and server event names', () => {
            expect(WebsocketClientEvent.FLOW_RUN_PROGRESS).toBe('FLOW_RUN_PROGRESS')
            expect(WebsocketClientEvent.RESOURCE_LOCKED).toBe('RESOURCE_LOCKED')
            expect(WebsocketServerEvent.TEST_FLOW_RUN).toBe('TEST_FLOW_RUN')
            expect(WebsocketServerEvent.WORKER_HEALTHCHECK).toBe('WORKER_HEALTHCHECK')
        })

        it('validates LockResourceRequest and LockResourceResponse', () => {
            const req = LockResourceRequest.parse({ resourceId: 'res_1', force: true })
            expect(req.force).toBe(true)

            const acquiredResp = LockResourceResponse.parse({
                acquired: true,
                lock: {
                    userId: 'usr_1',
                    userDisplayName: 'Admin User',
                },
            })
            expect(acquiredResp.acquired).toBe(true)
            expect(acquiredResp.lock?.userId).toBe('usr_1')

            const failedResp = LockResourceResponse.parse({
                acquired: false,
                lock: null,
            })
            expect(failedResp.acquired).toBe(false)
            expect(failedResp.lock).toBeNull()
        })

        it('validates ResourceLockedEvent and ResourceUnlockedEvent', () => {
            const locked = ResourceLockedEvent.parse({
                resourceId: 'res_1',
                userId: 'usr_1',
                userDisplayName: 'Admin User',
            })
            expect(locked.resourceId).toBe('res_1')

            const unlocked = ResourceUnlockedEvent.parse({
                resourceId: 'res_1',
            })
            expect(unlocked.resourceId).toBe('res_1')
        })

        it('validates PresenceRequest, PresenceUser, and PresenceUpdatedEvent', () => {
            const presReq = PresenceRequest.parse({ resourceId: 'flow_123' })
            expect(presReq.resourceId).toBe('flow_123')

            const user = PresenceUser.parse({
                userId: 'usr_1',
                userDisplayName: 'Jane Doe',
                userEmail: 'jane@example.com',
                userImageUrl: null,
            })
            expect(user.userDisplayName).toBe('Jane Doe')

            const event = PresenceUpdatedEvent.parse({
                resourceId: 'flow_123',
                users: [user],
            })
            expect(event.users).toHaveLength(1)
        })
    })
})
