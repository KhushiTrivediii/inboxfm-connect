import { PlatformRole, ScimPatchRequest, UserStatus } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUserGet = vi.fn()
const mockUserUpdate = vi.fn()
const mockUserGetOrThrow = vi.fn()

vi.mock('../../../../../src/app/user/user-service', () => ({
    userService: () => ({
        get: mockUserGet,
        update: mockUserUpdate,
        getOrThrow: mockUserGetOrThrow,
    }),
}))

const mockGetBasicInformation = vi.fn()
const mockIdentityUpdate = vi.fn()

vi.mock('../../../../../src/app/authentication/user-identity/user-identity-service', () => ({
    userIdentityService: () => ({
        getBasicInformation: mockGetBasicInformation,
        update: mockIdentityUpdate,
    }),
}))

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

type ScimUserService = ReturnType<typeof import('../../../../../src/app/ee/scim/scim-user-service').scimUserService>

async function loadScimUserService(): Promise<ScimUserService> {
    const mod = await import('../../../../../src/app/ee/scim/scim-user-service')
    return mod.scimUserService(mockLog)
}

const SCIM_CUSTOM_USER_ATTRIBUTES_SCHEMA = 'urn:ietf:params:scim:schemas:activepieces:1.0:CustomUserAttributes'

const buildUser = () => ({
    id: 'user-1',
    platformId: 'platform-1',
    identityId: 'identity-1',
    platformRole: PlatformRole.MEMBER,
    status: UserStatus.ACTIVE,
})

const rolePatch = (role: string, separator: ':' | '.'): ScimPatchRequest => ({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [
        {
            op: 'add',
            path: `${SCIM_CUSTOM_USER_ATTRIBUTES_SCHEMA}${separator}platformRole`,
            value: role,
        },
    ],
})

// The patch `add` operation accepts the custom platformRole attribute under two
// path spellings in the wild: RFC 7644 attribute notation (colon-separated —
// what Azure AD and Okta actually send) and a dotted variant some providers
// emit. The service validated ONE spelling (dotted) but APPLIED only the other
// (colon), so the spec-compliant spelling skipped enum validation entirely and
// the dotted spelling silently dropped the value — an IdP demotion that
// reported success while the user kept the old role. These tests pin the
// unified behavior: both spellings are accepted, both are validated, and
// unknown add paths are ignored per RFC 7644 §3.5.2 instead of issuing an
// all-undefined update.
describe('scimUserService.patch() — platformRole add-operation path spellings', () => {
    let service: ScimUserService

    beforeEach(async () => {
        vi.clearAllMocks()
        vi.resetModules()
        service = await loadScimUserService()
        mockUserGet.mockResolvedValue(buildUser())
        mockUserGetOrThrow.mockResolvedValue(buildUser())
        mockUserUpdate.mockResolvedValue(undefined)
        mockGetBasicInformation.mockResolvedValue({
            email: 'user@example.test',
            firstName: 'First',
            lastName: 'Last',
        })
    })

    it('applies a valid platformRole sent via the colon-separated (RFC 7644) path', async () => {
        await service.patch({
            platformId: 'platform-1',
            userId: 'user-1',
            request: rolePatch(PlatformRole.OPERATOR, ':'),
        })

        expect(mockUserUpdate).toHaveBeenCalledTimes(1)
        const updateParams = mockUserUpdate.mock.calls[0][0]
        expect(updateParams.platformRole).toBe(PlatformRole.OPERATOR)
    })

    it('applies a valid platformRole sent via the dotted path', async () => {
        await service.patch({
            platformId: 'platform-1',
            userId: 'user-1',
            request: rolePatch(PlatformRole.OPERATOR, '.'),
        })

        expect(mockUserUpdate).toHaveBeenCalledTimes(1)
        const updateParams = mockUserUpdate.mock.calls[0][0]
        expect(updateParams.platformRole).toBe(PlatformRole.OPERATOR)
    })

    it('rejects an invalid platformRole sent via the colon-separated path', async () => {
        // Pre-fix: validation only ran for the dotted spelling, so this request
        // skipped enum validation entirely and wrote the IdP-supplied string
        // straight into the user's platformRole.
        await expect(
            service.patch({
                platformId: 'platform-1',
                userId: 'user-1',
                request: rolePatch('super-admin', ':'),
            }),
        ).rejects.toThrow(/Invalid platform role/)
    })

    it('rejects an invalid platformRole sent via the dotted path', async () => {
        await expect(
            service.patch({
                platformId: 'platform-1',
                userId: 'user-1',
                request: rolePatch('super-admin', '.'),
            }),
        ).rejects.toThrow(/Invalid platform role/)
    })

    it('applies a valid platformRole sent via a lowercased path (RFC 7644 §2.1 attribute names are case-insensitive)', async () => {
        await service.patch({
            platformId: 'platform-1',
            userId: 'user-1',
            request: {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [
                    {
                        op: 'add',
                        path: `${SCIM_CUSTOM_USER_ATTRIBUTES_SCHEMA}:PLATFORMROLE`.toLowerCase(),
                        value: PlatformRole.OPERATOR,
                    },
                ],
            } as unknown as ScimPatchRequest,
        })

        expect(mockUserUpdate).toHaveBeenCalledTimes(1)
        const updateParams = mockUserUpdate.mock.calls[0][0]
        expect(updateParams.platformRole).toBe(PlatformRole.OPERATOR)
    })

    it('rejects an invalid platformRole sent via a lowercased path', async () => {
        await expect(
            service.patch({
                platformId: 'platform-1',
                userId: 'user-1',
                request: {
                    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                    Operations: [
                        {
                            op: 'add',
                            path: `${SCIM_CUSTOM_USER_ATTRIBUTES_SCHEMA}.PlatformRole`.toLowerCase(),
                            value: 'super-admin',
                        },
                    ],
                } as unknown as ScimPatchRequest,
            }),
        ).rejects.toThrow(/Invalid platform role/)
    })

    it('issues no user update when an add path matches no known attribute', async () => {
        // RFC 7644 §3.5.2: unknown attributes SHALL be ignored. Pre-fix, any
        // unmatched `add` path still initialized the pending-fields object and
        // triggered a user update with all-undefined fields.
        await service.patch({
            platformId: 'platform-1',
            userId: 'user-1',
            request: {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [
                    {
                        op: 'add',
                        path: `${SCIM_CUSTOM_USER_ATTRIBUTES_SCHEMA}.someOtherAttr`,
                        value: 'x',
                    },
                ],
            } as unknown as ScimPatchRequest,
        })

        expect(mockUserUpdate).not.toHaveBeenCalled()
    })

    it('issues no user update and does not throw on a schema-valid no-path add operation', async () => {
        // RFC 7644 §3.5.2.1: `path` may be omitted when `value` is an object.
        // The case-insensitivity push read `operation.path` unguarded, so this
        // schema-valid request crashed with `undefined.toLowerCase()` -> 500.
        await expect(service.patch({
            platformId: 'platform-1',
            userId: 'user-1',
            request: {
                schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                Operations: [
                    {
                        op: 'add',
                        value: { x: 'y' },
                    },
                ],
            } as unknown as ScimPatchRequest,
        })).resolves.not.toThrow()

        expect(mockUserUpdate).not.toHaveBeenCalled()
    })
})
