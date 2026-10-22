import { AxiosInstance } from 'axios'
import { ConnectSecretManagerRequestSchema, CyberarkConjurProviderConfigSchema, SECRET_MANAGER_PROVIDERS_METADATA, SecretManagerConnectionScope, SecretManagerProviderId, SecretManagerProviderMetaDataSchema } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { MockInstance } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// w5 security finding 5: the Conjur provider used to build its axios client with
// `httpsAgentOptions: { rejectUnauthorized: false }`, so every Conjur call —
// including the authenticate POST whose body IS the account API key, plus every
// fetched secret value — accepted any certificate, letting a MITM on the path
// to Conjur capture the API key and read all secrets. These tests pin the fixed
// resolution: the connection verifies TLS unless the operator explicitly sets
// `skipTlsVerification` on the connection config.

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

const conjurConfig = {
    organizationAccountName: 'dev',
    loginId: 'host/activepieces',
    url: 'https://conjur.example.com',
    apiKey: 'conjur-api-key',
}

const authenticateResponse = { data: 'session-token' }

// The provider memoizes the TLS-relaxed axios instance at module scope, so each
// test re-imports the provider — and server-utils first, so the spies land on
// the same `safeHttp` object the freshly imported provider resolves.
let defaultRequestSpy: MockInstance
let relaxedRequest: ReturnType<typeof vi.fn>
let createRetryingAxiosSpy: MockInstance
let cyberarkConjurProvider: typeof import('../../../../../src/app/ee/secret-managers/secret-manager-providers/cyberark-conjur-provider').cyberarkConjurProvider

beforeEach(async () => {
    vi.resetModules()
    const { safeHttp } = await import('@inboxfm-connect/server-utils')
    relaxedRequest = vi.fn().mockResolvedValue(authenticateResponse)
    createRetryingAxiosSpy = vi
        .spyOn(safeHttp, 'createRetryingAxios')
        .mockReturnValue({ request: relaxedRequest } as unknown as AxiosInstance)
    defaultRequestSpy = vi
        .spyOn(safeHttp.retryingAxios, 'request')
        .mockResolvedValue(authenticateResponse)
    ;({ cyberarkConjurProvider } = await import('../../../../../src/app/ee/secret-managers/secret-manager-providers/cyberark-conjur-provider'))
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('CyberArk Conjur provider TLS verification (w5 finding 5)', () => {
    it('verifies the server certificate by default — requests go through the shared verify-ON client and no TLS-relaxed client is ever built', async () => {
        await cyberarkConjurProvider(mockLog).checkConnection(conjurConfig)

        expect(defaultRequestSpy).toHaveBeenCalledTimes(1)
        expect(createRetryingAxiosSpy).not.toHaveBeenCalled()
        expect(relaxedRequest).not.toHaveBeenCalled()
    })

    it('treats skipTlsVerification: false as verify-ON too', async () => {
        await cyberarkConjurProvider(mockLog).checkConnection({ ...conjurConfig, skipTlsVerification: false })

        expect(defaultRequestSpy).toHaveBeenCalledTimes(1)
        expect(createRetryingAxiosSpy).not.toHaveBeenCalled()
    })

    it('honors an explicit opt-out: builds the relaxed client with rejectUnauthorized false and sends traffic through it', async () => {
        await cyberarkConjurProvider(mockLog).checkConnection({ ...conjurConfig, skipTlsVerification: true })

        expect(createRetryingAxiosSpy).toHaveBeenCalledWith(undefined, {
            httpsAgentOptions: { rejectUnauthorized: false },
        })
        expect(relaxedRequest).toHaveBeenCalledTimes(1)
        expect(defaultRequestSpy).not.toHaveBeenCalled()
    })

    it('threads the opt-out through getSecret, not just the connection check', async () => {
        relaxedRequest.mockResolvedValue({ data: 'super-secret-value' })
        const secret = await cyberarkConjurProvider(mockLog).getSecret({ path: 'key-1' }, { ...conjurConfig, skipTlsVerification: true })

        expect(secret).toBe('super-secret-value')
        // authenticate + secret fetch: both calls must use the relaxed client
        expect(relaxedRequest).toHaveBeenCalledTimes(2)
        expect(defaultRequestSpy).not.toHaveBeenCalled()
    })

    it('resolves secrets over the verify-ON client when not opted out', async () => {
        defaultRequestSpy
            .mockResolvedValueOnce(authenticateResponse)
            .mockResolvedValueOnce({ data: 'super-secret-value' })
        const secret = await cyberarkConjurProvider(mockLog).getSecret({ path: 'key-1' }, conjurConfig)

        expect(secret).toBe('super-secret-value')
        expect(defaultRequestSpy).toHaveBeenCalledTimes(2)
        expect(createRetryingAxiosSpy).not.toHaveBeenCalled()
    })

    it('reuses a single relaxed client across opted-out calls (lazy memoization)', async () => {
        await cyberarkConjurProvider(mockLog).checkConnection({ ...conjurConfig, skipTlsVerification: true })
        await cyberarkConjurProvider(mockLog).checkConnection({ ...conjurConfig, skipTlsVerification: true })

        expect(createRetryingAxiosSpy).toHaveBeenCalledTimes(1)
        expect(relaxedRequest).toHaveBeenCalledTimes(2)
    })
})

describe('CyberarkConjurProviderConfigSchema.skipTlsVerification resolution', () => {
    it('is absent by default — connections created without the field verify TLS', () => {
        const parsed = CyberarkConjurProviderConfigSchema.parse(conjurConfig)
        expect(parsed.skipTlsVerification).toBeUndefined()
    })

    it('accepts a real boolean', () => {
        expect(CyberarkConjurProviderConfigSchema.parse({ ...conjurConfig, skipTlsVerification: true }).skipTlsVerification).toBe(true)
        expect(CyberarkConjurProviderConfigSchema.parse({ ...conjurConfig, skipTlsVerification: false }).skipTlsVerification).toBe(false)
    })

    it("coerces 'true'/'false' strings — the provider form renders this as a text field (SCIM `primary` pattern)", () => {
        expect(CyberarkConjurProviderConfigSchema.parse({ ...conjurConfig, skipTlsVerification: 'true' }).skipTlsVerification).toBe(true)
        expect(CyberarkConjurProviderConfigSchema.parse({ ...conjurConfig, skipTlsVerification: 'false' }).skipTlsVerification).toBe(false)
        // blank text field means "not opted out", not a validation error
        expect(CyberarkConjurProviderConfigSchema.parse({ ...conjurConfig, skipTlsVerification: '' }).skipTlsVerification).toBe(false)
    })

    it('rejects values that are neither boolean nor true/false/empty string', () => {
        expect(() => CyberarkConjurProviderConfigSchema.parse({ ...conjurConfig, skipTlsVerification: 'yes' })).toThrow()
        expect(() => CyberarkConjurProviderConfigSchema.parse({ ...conjurConfig, skipTlsVerification: 1 })).toThrow()
    })

    it('is normalized inside the connect request schema too', () => {
        const parsed = ConnectSecretManagerRequestSchema.parse({
            name: 'conjur',
            scope: SecretManagerConnectionScope.PLATFORM,
            providerId: SecretManagerProviderId.CYBERARK,
            config: { ...conjurConfig, skipTlsVerification: 'true' },
        })
        expect(parsed.providerId).toBe(SecretManagerProviderId.CYBERARK)
        if (parsed.providerId !== SecretManagerProviderId.CYBERARK) {
            throw new Error('unreachable')
        }
        expect(parsed.config.skipTlsVerification).toBe(true)
    })
})

describe('Conjur provider metadata documents the TLS opt-out', () => {
    it('marks skipTlsVerification as an optional text field with self-signed guidance', () => {
        const conjur = SECRET_MANAGER_PROVIDERS_METADATA.find((provider) => provider.id === SecretManagerProviderId.CYBERARK)
        expect(conjur).toBeDefined()
        if (conjur?.id !== SecretManagerProviderId.CYBERARK) {
            throw new Error('cyberark conjur metadata missing')
        }
        expect(conjur.fields.skipTlsVerification).toMatchObject({
            displayName: 'Skip TLS Verification',
            optional: true,
            type: 'text',
        })
        expect(conjur.fields.skipTlsVerification?.placeholder).toContain('self-signed')
    })

    it('keeps every config key documented as a form field (metadata stays schema-valid)', () => {
        // The record key enum is derived from CyberarkConjurProviderConfigSchema's
        // shape, so a config field without a metadata entry would fail here.
        expect(() => z.array(SecretManagerProviderMetaDataSchema).parse(SECRET_MANAGER_PROVIDERS_METADATA)).not.toThrow()
    })
})
