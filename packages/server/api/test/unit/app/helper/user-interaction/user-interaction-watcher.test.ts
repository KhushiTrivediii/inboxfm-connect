import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import { ApLogger } from '@inboxfm-connect/server-utils'
import { WorkerJobType } from '@inboxfm-connect/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userInteractionWatcher } from '../../../../../src/app/helper/user-interaction/user-interaction-watcher'

const executeMock = vi.fn()

vi.mock('@inboxfm-connect/sandbox', () => ({
    createSandboxRuntime: () => ({
        execute: (...args: unknown[]) => executeMock(...args),
    }),
}))

vi.mock('../../../../../src/app/authentication/lib/access-token-manager', () => ({
    accessTokenManager: () => ({
        generateEngineToken: vi.fn().mockResolvedValue('engine-token'),
    }),
}))

vi.mock('../../../../../src/app/helper/domain-helper', () => ({
    domainHelper: {
        getPublicApiUrl: vi.fn().mockResolvedValue('http://localhost:4200/api/'),
        getInternalApiUrl: vi.fn().mockResolvedValue('http://localhost:3100/api/'),
    },
}))

const request = {
    jobType: WorkerJobType.EXECUTE_VALIDATION,
    piece: {
        pieceName: '@inboxfm-connect/piece-resend',
        pieceVersion: '0.4.3',
        packageType: 'REGISTRY',
        pieceType: 'OFFICIAL',
        archiveId: undefined,
    },
    platformId: 'platform-id',
    projectId: 'project-id',
    auth: { type: 'SECRET_TEXT', secret_text: 'test-key' },
}

const createMockLog = (): ApLogger => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
}) as unknown as ApLogger

describe('userInteractionWatcher contract', () => {
    beforeEach(() => {
        executeMock.mockReset()
    })

    it('resolves the BARE operation result, not the EngineResponse envelope', async () => {
        executeMock.mockResolvedValueOnce({ status: 'OK', response: { valid: true } })

        const result = await userInteractionWatcher.submitAndWaitForResponse<{ valid: boolean }>(request, createMockLog())

        expect(result).toEqual({ valid: true })
        expect(result.status).toBeUndefined()
    })

    it('throws ENGINE_OPERATION_FAILURE carrying the envelope status when the operation fails', async () => {
        executeMock.mockResolvedValueOnce({ status: 'TIMEOUT', error: 'sandbox timed out' })

        const operation = userInteractionWatcher.submitAndWaitForResponse(request, createMockLog())

        await expect(operation).rejects.toSatisfy((err: unknown) => {
            if (!(err instanceof ActivepiecesError)) {
                return false
            }
            return err.error.code === ErrorCode.ENGINE_OPERATION_FAILURE && err.error.params.status === 'TIMEOUT'
        })
    })

    it('propagates non-OK engine errors as ENGINE_OPERATION_FAILURE with the engine message', async () => {
        executeMock.mockResolvedValueOnce({ status: 'ERROR', error: 'piece crashed' })

        const operation = userInteractionWatcher.submitAndWaitForResponse(request, createMockLog())

        await expect(operation).rejects.toSatisfy((err: unknown) => {
            if (!(err instanceof ActivepiecesError)) {
                return false
            }
            return err.error.code === ErrorCode.ENGINE_OPERATION_FAILURE && err.error.params.message === 'piece crashed'
        })
    })
})
