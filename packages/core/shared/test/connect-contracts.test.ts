import { describe, it, expect } from 'vitest'
import { apId } from '@inboxfm-connect/core-utils'
import {
    ConnectApiKey,
    ConnectApiKeyResponseWithValue,
    ConnectApiKeyResponseWithoutValue,
    CreateConnectApiKeyRequest,
} from '../src/lib/connect-api-key'
import {
    ConnectSession,
    CreateConnectSessionRequest,
    CreateConnectSessionResponse,
    ConnectSessionPublicInfo,
} from '../src/lib/connect-session'
import { ExecuteRequestBody } from '../src/lib/connect-execute/execute-request'

describe('Connect Domain Contracts', () => {
    const validId1 = apId()
    const validId2 = apId()
    const validPlatformId = apId()
    const validProjectId = apId()

    describe('ConnectApiKey and Responses', () => {
        const baseKey = {
            id: validId1,
            created: '2026-10-01T00:00:00.000Z',
            updated: '2026-10-01T00:00:00.000Z',
            platformId: validPlatformId,
            projectId: validProjectId,
            displayName: 'Prod API Key',
            hashedValue: 'sha256_hash_value',
            truncatedValue: 'ck_live_...1234',
            lastUsedAt: null,
            expiresAt: null,
        }

        it('should validate complete ConnectApiKey entity', () => {
            const parsed = ConnectApiKey.safeParse(baseKey)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.displayName).toBe('Prod API Key')
                expect(parsed.data.truncatedValue).toBe('ck_live_...1234')
            }
        })

        it('should validate ConnectApiKeyResponseWithValue including value and omitting hashedValue', () => {
            const responseWithValue = {
                id: validId1,
                created: '2026-10-01T00:00:00.000Z',
                updated: '2026-10-01T00:00:00.000Z',
                platformId: validPlatformId,
                projectId: validProjectId,
                displayName: 'Prod API Key',
                truncatedValue: 'ck_live_...1234',
                lastUsedAt: null,
                expiresAt: null,
                value: 'ck_live_secret_plain_text_key',
            }
            const parsed = ConnectApiKeyResponseWithValue.safeParse(responseWithValue)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.value).toBe('ck_live_secret_plain_text_key')
            }
        })

        it('should validate ConnectApiKeyResponseWithoutValue', () => {
            const { hashedValue: _, ...withoutHash } = baseKey
            const parsed = ConnectApiKeyResponseWithoutValue.safeParse(withoutHash)
            expect(parsed.success).toBe(true)
        })

        it('should validate CreateConnectApiKeyRequest with future date or undefined', () => {
            const validWithoutExpiry = {
                displayName: 'New Key',
                projectId: validProjectId,
            }
            expect(CreateConnectApiKeyRequest.safeParse(validWithoutExpiry).success).toBe(true)

            const futureDate = new Date(Date.now() + 86400000 * 30).toISOString()
            const validWithFuture = {
                ...validWithoutExpiry,
                expiresAt: futureDate,
            }
            expect(CreateConnectApiKeyRequest.safeParse(validWithFuture).success).toBe(true)

            const pastDate = new Date(Date.now() - 86400000).toISOString()
            const invalidPast = {
                ...validWithoutExpiry,
                expiresAt: pastDate,
            }
            expect(CreateConnectApiKeyRequest.safeParse(invalidPast).success).toBe(false)
        })
    })

    describe('ConnectSession contracts', () => {
        const baseSession = {
            id: validId2,
            created: '2026-10-01T00:00:00.000Z',
            updated: '2026-10-01T00:00:00.000Z',
            projectId: validProjectId,
            externalUserId: 'usr_ext_999',
            allowedPieceNames: ['@inboxfm-connect/piece-slack'],
            hashedToken: 'hash_123',
            truncatedToken: 'tok_...456',
            expiresAt: '2026-10-02T00:00:00.000Z',
            consumedAt: null,
        }

        it('should validate complete ConnectSession entity', () => {
            const parsed = ConnectSession.safeParse(baseSession)
            expect(parsed.success).toBe(true)
        })

        it('should validate CreateConnectSessionRequest rules and limits', () => {
            const valid = {
                projectId: validProjectId,
                externalUserId: 'user_42',
                allowedPieceNames: ['@inboxfm-connect/piece-github'],
                expiresInSeconds: 1800,
            }
            expect(CreateConnectSessionRequest.safeParse(valid).success).toBe(true)

            const emptyUserId = { ...valid, externalUserId: '' }
            expect(CreateConnectSessionRequest.safeParse(emptyUserId).success).toBe(false)

            const overLimitExpiry = { ...valid, expiresInSeconds: 3601 }
            expect(CreateConnectSessionRequest.safeParse(overLimitExpiry).success).toBe(false)

            const negativeExpiry = { ...valid, expiresInSeconds: -60 }
            expect(CreateConnectSessionRequest.safeParse(negativeExpiry).success).toBe(false)
        })

        it('should validate CreateConnectSessionResponse and ConnectSessionPublicInfo', () => {
            const response = {
                token: 'jwt_connect_token',
                connectUrl: 'https://connect.activepieces.com?token=jwt_connect_token',
                expiresAt: '2026-10-01T12:00:00.000Z',
            }
            expect(CreateConnectSessionResponse.safeParse(response).success).toBe(true)

            const publicInfo = {
                projectId: validProjectId,
                externalUserId: 'usr_ext_999',
                allowedPieceNames: null,
                expiresAt: '2026-10-01T12:00:00.000Z',
            }
            expect(ConnectSessionPublicInfo.safeParse(publicInfo).success).toBe(true)
        })
    })

    describe('ExecuteRequestBody contract', () => {
        it('should validate ExecuteRequestBody with required integration, tool, and input', () => {
            const valid = {
                projectId: validProjectId,
                integration: '@inboxfm-connect/piece-gmail',
                tool: 'send_email',
                connectionId: 'conn_789',
                externalUserId: 'user_bob',
                input: {
                    to: 'test@example.com',
                    subject: 'Hello',
                    body: 'World',
                },
            }
            const parsed = ExecuteRequestBody.safeParse(valid)
            expect(parsed.success).toBe(true)
            if (parsed.success) {
                expect(parsed.data.integration).toBe('@inboxfm-connect/piece-gmail')
                expect(parsed.data.tool).toBe('send_email')
            }
        })

        it('should reject ExecuteRequestBody when required properties are missing', () => {
            const missingTool = {
                integration: '@inboxfm-connect/piece-slack',
                input: {},
            }
            expect(ExecuteRequestBody.safeParse(missingTool).success).toBe(false)

            const missingInput = {
                integration: '@inboxfm-connect/piece-slack',
                tool: 'send_message',
            }
            expect(ExecuteRequestBody.safeParse(missingInput).success).toBe(false)
        })
    })
})
