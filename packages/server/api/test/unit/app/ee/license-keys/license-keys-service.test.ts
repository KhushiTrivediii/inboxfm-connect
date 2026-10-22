import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import { CreateTrialLicenseKeyRequestBody } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { licenseKeysService } from '../../../../../src/app/ee/license-keys/license-keys-service'

const mockGet = vi.hoisted(() => vi.fn())
const mockPost = vi.hoisted(() => vi.fn())

vi.mock('@inboxfm-connect/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@inboxfm-connect/server-utils')>()
    const instance = actual.safeHttp.createAxios({ validateStatus: () => true })
    instance.get = mockGet
    instance.post = mockPost
    return {
        ...actual,
        safeHttp: {
            ...actual.safeHttp,
            createAxios: () => instance,
        },
    }
})

const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as unknown as FastifyBaseLogger

const trialRequest: CreateTrialLicenseKeyRequestBody = {
    email: 'a@b.c',
    companyName: 'Test Co',
    goal: 'evaluation',
    customerName: 'Tester',
    ssoEnabled: false,
    scimEnabled: false,
    environmentsEnabled: false,
    showPoweredBy: false,
    embeddingEnabled: false,
    auditLogEnabled: false,
    customAppearanceEnabled: false,
    manageProjectsEnabled: false,
    managePiecesEnabled: false,
    manageTemplatesEnabled: false,
    apiKeysEnabled: false,
    projectRolesEnabled: false,
    analyticsEnabled: false,
    globalConnectionsEnabled: false,
    customRolesEnabled: false,
    eventStreamingEnabled: false,
    secretManagersEnabled: false,
    agentsEnabled: false,
    aiProvidersEnabled: false,
}

describe('licenseKeysService safeHttp migration (issue #143)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns null when the license key is not found', async () => {
        mockGet.mockResolvedValue({ status: 404, data: null })
        const service = licenseKeysService(mockLog)
        await expect(service.getKey('missing')).resolves.toBeNull()
    })

    it('returns the license entity on success', async () => {
        mockGet.mockResolvedValue({ status: 200, data: { key: 'abc', email: 'a@b.c' } })
        const service = licenseKeysService(mockLog)
        await expect(service.getKey('abc')).resolves.toEqual({ key: 'abc', email: 'a@b.c' })
    })

    it('throws on unexpected statuses', async () => {
        mockGet.mockResolvedValue({ status: 500, data: { error: 'boom' } })
        const service = licenseKeysService(mockLog)
        await expect(service.getKey('abc')).rejects.toThrow()
    })

    it('maps trial conflicts to EMAIL_ALREADY_HAS_ACTIVATION_KEY', async () => {
        mockPost.mockResolvedValue({ status: 409, data: null })
        const service = licenseKeysService(mockLog)
        const failure: unknown = await service.requestTrial(trialRequest).catch((error: unknown) => error)
        if (!(failure instanceof ActivepiecesError)) {
            expect.fail('expected requestTrial conflict to throw ActivepiecesError')
        }
        expect(failure.error.code).toBe(ErrorCode.EMAIL_ALREADY_HAS_ACTIVATION_KEY)
    })

    it('returns the created trial license on success', async () => {
        mockPost.mockResolvedValue({ status: 200, data: { key: 'trial-1' } })
        const service = licenseKeysService(mockLog)
        await expect(service.requestTrial(trialRequest)).resolves.toEqual({ key: 'trial-1' })
    })

    it('treats activation 404 as success and swallows network errors', async () => {
        const service = licenseKeysService(mockLog)
        mockPost.mockResolvedValue({ status: 404, data: null })
        await expect(service.markAsActiviated({ key: 'abc' })).resolves.toBeUndefined()
        mockPost.mockRejectedValue(new Error('network down'))
        await expect(service.markAsActiviated({ key: 'abc' })).resolves.toBeUndefined()
    })
})
