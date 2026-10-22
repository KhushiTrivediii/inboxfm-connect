import { ErrorCode, PlatformRole, ProjectType, UserIdentityProvider, UserStatus } from '@inboxfm-connect/shared'
import { FastifyInstance } from 'fastify'
import { authenticationService } from '../../../../src/app/authentication/authentication.service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import {
    createMockProject,
    createMockUser,
    createMockUserIdentity,
    mockAndSaveBasicSetup,
} from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

const DISALLOWED_DOMAIN_EMAIL = 'victim@evil.test'
const ALLOWED_DOMAIN_EMAIL = 'member@goodcorp.test'

const platformParams = {
    enforceAllowedAuthDomains: true,
    allowedAuthDomains: ['goodcorp.test'],
    emailAuthEnabled: true,
}

beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('project').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('platform_plan').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('platform').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('user').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('user_identity').createQueryBuilder().delete().execute()
})

const savePlatformWithDomainPolicy = async (): Promise<string> => {
    const { mockPlatform } = await mockAndSaveBasicSetup({
        platform: platformParams,
        plan: {
            ssoEnabled: true,
        },
    })
    return mockPlatform.id
}

const saveIdentity = async ({ email, password }: { email: string, password?: string }): Promise<string> => {
    const identity = createMockUserIdentity({
        email,
        verified: true,
        provider: UserIdentityProvider.GOOGLE,
        password,
    })
    await databaseConnection().getRepository('user_identity').save(identity)
    return identity.id
}

const saveUserWithPersonalProject = async ({ identityId, platformId }: { identityId: string, platformId: string }): Promise<void> => {
    const user = createMockUser({
        identityId,
        platformId,
        platformRole: PlatformRole.MEMBER,
        status: UserStatus.ACTIVE,
    })
    await databaseConnection().getRepository('user').save(user)
    await databaseConnection().getRepository('project').save(createMockProject({
        ownerId: user.id,
        platformId,
        type: ProjectType.PERSONAL,
    }))
}

const federatedAuthnParams = (email: string, platformId: string) => ({
    email,
    firstName: 'Federated',
    lastName: 'User',
    newsLetter: false,
    trackEvents: true,
    provider: UserIdentityProvider.GOOGLE,
    predefinedPlatformId: platformId,
})

describe('federated authentication domain allowlist', () => {
    it('rejects federated sign-in for an existing member whose email domain is not allowed', async () => {
        const platformId = await savePlatformWithDomainPolicy()
        const identityId = await saveIdentity({ email: DISALLOWED_DOMAIN_EMAIL })
        await saveUserWithPersonalProject({ identityId, platformId })

        // the same identity is already blocked on the password path, so the
        // federated path must not let it back in through the side door
        await expect(authenticationService(app!.log).federatedAuthn(
            federatedAuthnParams(DISALLOWED_DOMAIN_EMAIL, platformId),
        )).rejects.toThrow(expect.objectContaining({
            error: expect.objectContaining({ code: ErrorCode.DOMAIN_NOT_ALLOWED }),
        }))
    })

    it('rejects federated sign-in for an existing identity that never joined the platform', async () => {
        const { mockPlatform } = await mockAndSaveBasicSetup({
            platform: platformParams,
            plan: {
                ssoEnabled: true,
            },
        })
        const platformId = mockPlatform.id
        const identityId = await saveIdentity({ email: DISALLOWED_DOMAIN_EMAIL })

        // identity exists (registered elsewhere) but never joined this platform:
        // a disallowed domain must not self-provision a user + project here
        await expect(authenticationService(app!.log).federatedAuthn(
            federatedAuthnParams(DISALLOWED_DOMAIN_EMAIL, platformId),
        )).rejects.toThrow(expect.objectContaining({
            error: expect.objectContaining({ code: ErrorCode.DOMAIN_NOT_ALLOWED }),
        }))

        const users = await databaseConnection().getRepository('user').find({
            where: { identityId },
        })
        expect(users).toHaveLength(0)
    })

    it('still allows federated sign-in for a member whose email domain is allowed', async () => {
        const platformId = await savePlatformWithDomainPolicy()
        const identityId = await saveIdentity({ email: ALLOWED_DOMAIN_EMAIL })
        await saveUserWithPersonalProject({ identityId, platformId })

        const response = await authenticationService(app!.log).federatedAuthn(
            federatedAuthnParams(ALLOWED_DOMAIN_EMAIL, platformId),
        )

        expect(response.token).toBeDefined()
        expect(response.platformId).toBe(platformId)
    })

    it('keeps blocking the password path for the same disallowed-domain identity (parity guard)', async () => {
        const platformId = await savePlatformWithDomainPolicy()
        const identityId = await saveIdentity({ email: DISALLOWED_DOMAIN_EMAIL, password: 'Password123!' })
        await saveUserWithPersonalProject({ identityId, platformId })

        await expect(authenticationService(app!.log).signInWithPassword({
            email: DISALLOWED_DOMAIN_EMAIL,
            password: 'Password123!',
            predefinedPlatformId: platformId,
        })).rejects.toThrow(expect.objectContaining({
            error: expect.objectContaining({ code: ErrorCode.DOMAIN_NOT_ALLOWED }),
        }))
    })

    it('sign-up still enforces the allowlist for new identities on the same platform (parity guard)', async () => {
        const platformId = await savePlatformWithDomainPolicy()

        await expect(authenticationService(app!.log).signUp({
            email: DISALLOWED_DOMAIN_EMAIL,
            firstName: 'New',
            lastName: 'User',
            password: 'Password123!',
            platformId,
            provider: UserIdentityProvider.EMAIL,
            trackEvents: true,
            newsLetter: false,
        })).rejects.toThrow(expect.objectContaining({
            error: expect.objectContaining({ code: ErrorCode.DOMAIN_NOT_ALLOWED }),
        }))
    })
})
