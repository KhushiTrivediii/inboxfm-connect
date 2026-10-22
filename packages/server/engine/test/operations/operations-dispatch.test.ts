import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    AppConnectionType,
    EngineOperationType,
    EngineResponseStatus,
    PackageType,
    PieceType,
} from '@inboxfm-connect/shared'
import { execute } from '../../src/lib/operations'
import { authRefreshOperation } from '../../src/lib/operations/auth-refresh.operation'
import { authValidationOperation } from '../../src/lib/operations/auth-validation.operation'

describe('Engine Operations Dispatch (Issue #166)', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    const sampleAuthPayload = {
        piece: {
            packageType: PackageType.REGISTRY,
            pieceType: PieceType.OFFICIAL,
            pieceName: '@inboxfm-connect/piece-google-sheets',
            pieceVersion: '0.1.0',
        },
        auth: {
            type: AppConnectionType.OAUTH2,
            value: {
                access_token: 'old_access_token',
                refresh_token: 'sample_refresh_token',
            },
        },
        engineToken: 'test-token',
        internalApiUrl: 'http://localhost:3000',
        publicApiUrl: 'http://localhost:3000',
        timeoutInSeconds: 30,
        platformId: 'test-platform',
    } as const

    it('dispatches EXECUTE_REFRESH_TOKEN_AUTH exclusively to authRefreshOperation', async () => {
        const refreshSpy = vi.spyOn(authRefreshOperation, 'execute').mockResolvedValue({
            status: EngineResponseStatus.OK,
            response: { skipped: false, access_token: 'new_rotated_token', expires_in: 3600 },
        })
        const validateSpy = vi.spyOn(authValidationOperation, 'execute').mockResolvedValue({
            status: EngineResponseStatus.OK,
            response: { valid: true },
        })

        const result = await execute(EngineOperationType.EXECUTE_REFRESH_TOKEN_AUTH, sampleAuthPayload as any)

        expect(refreshSpy).toHaveBeenCalledTimes(1)
        expect(refreshSpy).toHaveBeenCalledWith(sampleAuthPayload)
        expect(validateSpy).not.toHaveBeenCalled()
        expect(result.status).toBe(EngineResponseStatus.OK)
        expect(result.response).toEqual({ skipped: false, access_token: 'new_rotated_token', expires_in: 3600 })
    })

    it('dispatches EXECUTE_VALIDATE_AUTH exclusively to authValidationOperation', async () => {
        const refreshSpy = vi.spyOn(authRefreshOperation, 'execute').mockResolvedValue({
            status: EngineResponseStatus.OK,
            response: { skipped: false, access_token: 'new_rotated_token', expires_in: 3600 },
        })
        const validateSpy = vi.spyOn(authValidationOperation, 'execute').mockResolvedValue({
            status: EngineResponseStatus.OK,
            response: { valid: true },
        })

        const result = await execute(EngineOperationType.EXECUTE_VALIDATE_AUTH, sampleAuthPayload as any)

        expect(validateSpy).toHaveBeenCalledTimes(1)
        expect(validateSpy).toHaveBeenCalledWith(sampleAuthPayload)
        expect(refreshSpy).not.toHaveBeenCalled()
        expect(result.status).toBe(EngineResponseStatus.OK)
        expect(result.response).toEqual({ valid: true })
    })

    it('returns INTERNAL_ERROR when payload does not satisfy the operation type guard', async () => {
        const refreshSpy = vi.spyOn(authRefreshOperation, 'execute')
        const validateSpy = vi.spyOn(authValidationOperation, 'execute')

        const invalidPayload = { invalid: true }
        const result = await execute(EngineOperationType.EXECUTE_REFRESH_TOKEN_AUTH, invalidPayload as any)

        expect(refreshSpy).not.toHaveBeenCalled()
        expect(validateSpy).not.toHaveBeenCalled()
        expect(result.status).toBe(EngineResponseStatus.INTERNAL_ERROR)
        expect(result.error).toBeDefined()
    })

    it('guarantees distinct enum discriminator values across wire protocol', () => {
        expect(EngineOperationType.EXECUTE_VALIDATE_AUTH).toBe('EXECUTE_VALIDATE_AUTH')
        expect(EngineOperationType.EXECUTE_REFRESH_TOKEN_AUTH).toBe('EXECUTE_REFRESH_TOKEN_AUTH')
        expect(EngineOperationType.EXECUTE_VALIDATE_AUTH).not.toBe(
            EngineOperationType.EXECUTE_REFRESH_TOKEN_AUTH
        )
    })

    it('dispatches wire-serialized string operation types to their distinct handlers', async () => {
        const refreshSpy = vi.spyOn(authRefreshOperation, 'execute').mockResolvedValue({
            status: EngineResponseStatus.OK,
            response: { skipped: false, access_token: 'wire_token' },
        })
        const validateSpy = vi.spyOn(authValidationOperation, 'execute').mockResolvedValue({
            status: EngineResponseStatus.OK,
            response: { valid: true },
        })

        // Wire path sending raw string value
        const refreshResult = await execute('EXECUTE_REFRESH_TOKEN_AUTH' as any, sampleAuthPayload as any)
        expect(refreshSpy).toHaveBeenCalledTimes(1)
        expect(validateSpy).not.toHaveBeenCalled()
        expect(refreshResult.status).toBe(EngineResponseStatus.OK)

        const validateResult = await execute('EXECUTE_VALIDATE_AUTH' as any, sampleAuthPayload as any)
        expect(validateSpy).toHaveBeenCalledTimes(1)
        expect(validateResult.status).toBe(EngineResponseStatus.OK)
    })

    it('returns INTERNAL_ERROR for an unknown or unsupported operation type', async () => {
        const result = await execute('UNKNOWN_OPERATION' as any, sampleAuthPayload as any)

        expect(result.status).toBe(EngineResponseStatus.INTERNAL_ERROR)
        expect(result.error).toContain('Unsupported operation type')
    })
})
