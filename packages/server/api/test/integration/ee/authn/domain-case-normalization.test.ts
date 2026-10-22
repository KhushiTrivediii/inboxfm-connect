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

const UPPERCASE_DOMAIN_EMAIL = 'member@GOODCORP.TEST'
const LOWERCASE_DOMAIN_EMAIL = 'member@goodcorp.test'

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

const saveIdentity = async ({ email }: { email: string }): Promise<string> => {
    const identity = createMockUserIdentity({
        email,
        verified: true,
        provider: UserIdentityProvider.GOOGLE,
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

describe('domain allowlist case normalization', () => {
    it('allows an existing member whose email domain differs only in case from the allowlist entry', async () => {
        const platformId = await savePlatformWithDomainPolicy()
        // identity is stored normalized (lowercase) - createMockUserIdentity lowercases
        const identityId = await saveIdentity({ email: LOWERCASE_DOMAIN_EMAIL })
        await saveUserWithPersonalProject({ identityId, platformId })

        // act: federated claim arrives with the same address mixed-case
        // (Google id_token emails preserve the user's chosen casing)
        const response = await authenticationService(app!.log).federatedAuthn({
            email: UPPERCASE_DOMAIN_EMAIL,
            firstName: 'Member',
            lastName: 'Goodcorp',
            newsLetter: false,
            trackEvents: true,
            provider: UserIdentityProvider.GOOGLE,
            predefinedPlatformId: platformId,
        })

        // assert: the domain GOODCORP.TEST must match the allowed goodcorp.test
        expect(response.token).toBeDefined()
        expect(response.platformId).toBe(platformId)
    })

    it('still rejects a domain that is not in the allowlist regardless of case', async () => {
        const platformId = await savePlatformWithDomainPolicy()
        const identityId = await saveIdentity({ email: 'member@evil.test' })
        await saveUserWithPersonalProject({ identityId, platformId })

        await expect(authenticationService(app!.log).federatedAuthn({
            email: 'member@EVIL.TEST',
            firstName: 'Member',
            lastName: 'Evil',
            newsLetter: false,
            trackEvents: true,
            provider: UserIdentityProvider.GOOGLE,
            predefinedPlatformId: platformId,
        })).rejects.toThrow(expect.objectContaining({
            error: expect.objectContaining({ code: ErrorCode.DOMAIN_NOT_ALLOWED }),
        }))
    })
})
