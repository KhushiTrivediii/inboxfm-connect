import { ActivepiecesError, AIProviderName, ErrorCode } from '@inboxfm-connect/core-utils'
import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { aiProviderService } from '../../../../src/app/ai/ai-provider-service'
import { aiProviders } from '../../../../src/app/ai/providers'

describe('aiProviderService & Credential Error Masking (#163)', () => {
    const mockLog: FastifyBaseLogger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: () => mockLog,
        level: 'info',
        silent: vi.fn(),
    } as unknown as FastifyBaseLogger

    it('does not leak upstream error response bodies or sensitive messages to the client', async () => {
        const sensitiveUpstreamError = new Error('Upstream failed with token sk-ant-secret12345 at http://169.254.169.254')
        Object.assign(sensitiveUpstreamError, {
            response: {
                status: 401,
                data: {
                    secret_system_token: 'leak_secret_value',
                    internal_trace: 'trace at 10.0.0.1:8080',
                },
            },
        })

        const validateSpy = vi.spyOn(aiProviders[AIProviderName.OPENAI], 'validateConnection').mockRejectedValueOnce(sensitiveUpstreamError)

        const service = aiProviderService(mockLog)

        let caughtError: unknown
        try {
            await service.validateProviderCredentials(
                AIProviderName.OPENAI,
                { apiKey: 'test-api-key' },
                {},
            )
        }
        catch (err) {
            caughtError = err
        }

        expect(caughtError).toBeInstanceOf(ActivepiecesError)
        const apError = caughtError as ActivepiecesError<{ provider: AIProviderName, message: string }>

        expect(apError.error.code).toBe(ErrorCode.INVALID_AI_PROVIDER_CREDENTIALS)
        expect(apError.error.params.provider).toBe(AIProviderName.OPENAI)
        expect(apError.error.params.message).toBe(`Failed to validate credentials for ${aiProviders[AIProviderName.OPENAI].name}`)

        // Crucial security assertion: client-facing error parameters must never contain the upstream secret data
        const serializedError = JSON.stringify(apError.error)
        expect(serializedError).not.toContain('sk-ant-secret12345')
        expect(serializedError).not.toContain('169.254.169.254')
        expect(serializedError).not.toContain('leak_secret_value')
        expect(serializedError).not.toContain('10.0.0.1')
        expect((apError.error.params as Record<string, unknown>).httpErrorResponse).toBeUndefined()

        // Internal server log still retains the full error context for platform debugging
        expect(mockLog.error).toHaveBeenCalledWith(
            { error: sensitiveUpstreamError },
            '[aiProviderService#validateProviderCredentials] Failed to validate provider credentials',
        )

        validateSpy.mockRestore()
    })
})
