import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import { safeHttp } from '@inboxfm-connect/server-utils'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { googleAuthnProvider } from '../../../../../../src/app/ee/authentication/federated-authn/google-authn-provider'

vi.mock('../../../../../../src/app/ee/authentication/federated-authn/federated-authn-service', () => ({
    federatedAuthnService: () => ({
        getThirdPartyRedirectUrl: vi.fn().mockResolvedValue('http://localhost:4200/redirect'),
    }),
}))

describe('Google Authn Provider (Issue #143)', () => {
    const mockLogger = {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    } as unknown as FastifyBaseLogger

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('throws ActivepiecesError(INVALID_CREDENTIALS) when Google returns non-2xx / error body', async () => {
        vi.spyOn(safeHttp.axios, 'post').mockResolvedValueOnce({
            status: 400,
            data: { error: 'invalid_grant', error_description: 'Bad Request' },
        } as any)

        const provider = googleAuthnProvider(mockLogger)

        await expect(
            provider.authenticate({
                clientId: 'client-id',
                clientSecret: 'client-secret',
                authorizationCode: 'bad-auth-code',
                platformId: 'platform-1',
            }),
        ).rejects.toMatchObject({
            error: {
                code: ErrorCode.INVALID_CREDENTIALS,
            },
        })
    })

    it('throws ActivepiecesError(INVALID_CREDENTIALS) when Google response is missing id_token', async () => {
        vi.spyOn(safeHttp.axios, 'post').mockResolvedValueOnce({
            status: 200,
            data: { access_token: 'some-access-token' }, // missing id_token
        } as any)

        const provider = googleAuthnProvider(mockLogger)

        await expect(
            provider.authenticate({
                clientId: 'client-id',
                clientSecret: 'client-secret',
                authorizationCode: 'valid-code',
                platformId: 'platform-1',
            }),
        ).rejects.toMatchObject({
            error: {
                code: ErrorCode.INVALID_CREDENTIALS,
            },
        })
    })

    it('throws ActivepiecesError(INVALID_CREDENTIALS) on network or transport failure during token exchange', async () => {
        vi.spyOn(safeHttp.axios, 'post').mockRejectedValueOnce(new Error('Connection reset by peer'))

        const provider = googleAuthnProvider(mockLogger)

        await expect(
            provider.authenticate({
                clientId: 'client-id',
                clientSecret: 'client-secret',
                authorizationCode: 'valid-code',
                platformId: 'platform-1',
            }),
        ).rejects.toMatchObject({
            error: {
                code: ErrorCode.INVALID_CREDENTIALS,
            },
        })
    })
})
