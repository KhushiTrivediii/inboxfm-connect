import { describe, expect, it } from 'vitest'
import {
    UserIdentity,
    UserIdentityProvider,
} from '../../../src/lib/core/authentication/user-identity'
import {
    AuthenticationResponse,
    UserWithoutPassword,
} from '../../../src/lib/core/authentication/dto/authentication-response'
import { SignInRequest } from '../../../src/lib/core/authentication/dto/sign-in-request'
import {
    SignUpRequest,
    SwitchPlatformRequest,
} from '../../../src/lib/core/authentication/dto/sign-up-request'
import {
    ALL_PRINCIPAL_TYPES,
    EndpointScope,
    PrincipalType,
} from '../../../src/lib/core/authentication/model/principal-type'
import {
    AnnonymousPrincipal,
    EnginePrincipal,
    OnboardingPrincipal,
    Principal,
    ServicePrincipal,
    UserPrincipal,
    WorkerPrincipal,
} from '../../../src/lib/core/authentication/model/principal'
import {
    AP_MAXIMUM_PROFILE_PICTURE_SIZE,
    EmailType,
    PasswordType,
    PlatformRole,
    PROFILE_PICTURE_ALLOWED_TYPES,
    UpdateMeResponse,
    User,
    UserStatus,
    UserWithMetaInformation,
} from '../../../src/lib/core/user/user'

describe('UserIdentity schema', () => {
    const validIdentity = {
        id: '123456789012345678901',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        firstName: 'Rakshit',
        lastName: 'Sapariya',
        email: 'rakshits9828@gmail.com',
        password: '$2b$10$hashedpasswordstringsample',
        trackEvents: true,
        newsLetter: false,
        verified: true,
        provider: UserIdentityProvider.EMAIL,
        imageUrl: null,
        lastLoggedInPlatformId: null,
    }

    it('parses valid user identity', () => {
        const parsed = UserIdentity.parse(validIdentity)
        expect(parsed.firstName).toBe('Rakshit')
        expect(parsed.provider).toBe(UserIdentityProvider.EMAIL)
        expect(parsed.verified).toBe(true)
    })

    it('supports alternative identity providers', () => {
        const googleIdentity = { ...validIdentity, provider: UserIdentityProvider.GOOGLE }
        expect(UserIdentity.parse(googleIdentity).provider).toBe(UserIdentityProvider.GOOGLE)

        const samlIdentity = { ...validIdentity, provider: UserIdentityProvider.SAML }
        expect(UserIdentity.parse(samlIdentity).provider).toBe(UserIdentityProvider.SAML)

        const jwtIdentity = { ...validIdentity, provider: UserIdentityProvider.JWT }
        expect(UserIdentity.parse(jwtIdentity).provider).toBe(UserIdentityProvider.JWT)
    })

    it('rejects invalid provider enum', () => {
        expect(() => UserIdentity.parse({ ...validIdentity, provider: 'TWITTER' })).toThrow()
    })

    it('accepts optional tokenVersion and nullable imageUrl', () => {
        const parsed = UserIdentity.parse({
            ...validIdentity,
            tokenVersion: 'v2',
            imageUrl: 'https://cdn.example.com/avatar.png',
            lastLoggedInPlatformId: 'plat-123',
        })
        expect(parsed.tokenVersion).toBe('v2')
        expect(parsed.imageUrl).toBe('https://cdn.example.com/avatar.png')
        expect(parsed.lastLoggedInPlatformId).toBe('plat-123')
    })
})

describe('EmailType and PasswordType schemas', () => {
    it('validates well-formed emails and rejects malformed emails', () => {
        expect(EmailType.parse('user@example.com')).toBe('user@example.com')
        expect(EmailType.parse('dev.lead+test@sub.domain.org')).toBe('dev.lead+test@sub.domain.org')

        expect(() => EmailType.parse('not-an-email')).toThrow()
        expect(() => EmailType.parse('@missinguser.com')).toThrow()
        expect(() => EmailType.parse('user@')).toThrow()
    })

    it('validates password length between 8 and 64 characters', () => {
        expect(PasswordType.parse('8charmin')).toBe('8charmin')
        expect(PasswordType.parse('a'.repeat(64))).toBe('a'.repeat(64))

        // Too short (< 8)
        expect(() => PasswordType.parse('short1')).toThrow()
        // Too long (> 64)
        expect(() => PasswordType.parse('a'.repeat(65))).toThrow()
    })
})

describe('SignInRequest schema', () => {
    it('parses valid sign-in credentials', () => {
        const parsed = SignInRequest.parse({
            email: 'user@domain.com',
            password: 'validSecurePassword123',
        })
        expect(parsed.email).toBe('user@domain.com')
        expect(parsed.password).toBe('validSecurePassword123')
    })

    it('rejects short passwords on sign-in', () => {
        expect(() => SignInRequest.parse({
            email: 'user@domain.com',
            password: '123',
        })).toThrow()
    })
})

describe('SignUpRequest schema and SAFE_STRING_PATTERN guard', () => {
    it('parses valid sign-up request', () => {
        const parsed = SignUpRequest.parse({
            email: 'newuser@inboxfm.com',
            password: 'securepassword123',
            firstName: 'Rakshit',
            lastName: 'Sapariya',
            trackEvents: true,
            newsLetter: false,
        })
        expect(parsed.firstName).toBe('Rakshit')
        expect(parsed.captchaToken).toBeUndefined()
    })

    it('accepts optional captchaToken', () => {
        const parsed = SignUpRequest.parse({
            email: 'newuser@inboxfm.com',
            password: 'securepassword123',
            firstName: 'Rakshit',
            lastName: 'Sapariya',
            trackEvents: false,
            newsLetter: true,
            captchaToken: 'recaptcha-response-token',
        })
        expect(parsed.captchaToken).toBe('recaptcha-response-token')
    })

    it('enforces SAFE_STRING_PATTERN: rejects names containing "." or "/" (traversal defense)', () => {
        // Dot in name
        expect(() => SignUpRequest.parse({
            email: 'bad@inboxfm.com',
            password: 'securepassword123',
            firstName: 'user.name',
            lastName: 'valid',
            trackEvents: false,
            newsLetter: false,
        })).toThrow()

        // Slash in name
        expect(() => SignUpRequest.parse({
            email: 'bad@inboxfm.com',
            password: 'securepassword123',
            firstName: 'valid',
            lastName: 'path/traversal',
            trackEvents: false,
            newsLetter: false,
        })).toThrow()

        // Traversal sequence ../
        expect(() => SignUpRequest.parse({
            email: 'bad@inboxfm.com',
            password: 'securepassword123',
            firstName: '../attacker',
            lastName: 'smith',
            trackEvents: false,
            newsLetter: false,
        })).toThrow()
    })

    it('accepts hyphen and underscore in names', () => {
        const parsed = SignUpRequest.parse({
            email: 'hyphen@inboxfm.com',
            password: 'securepassword123',
            firstName: 'Mary-Jane',
            lastName: 'Watson_Parker',
            trackEvents: false,
            newsLetter: false,
        })
        expect(parsed.firstName).toBe('Mary-Jane')
        expect(parsed.lastName).toBe('Watson_Parker')
    })
})

describe('SwitchPlatformRequest schema', () => {
    it('validates platformId as ApId format', () => {
        const parsed = SwitchPlatformRequest.parse({ platformId: '123456789012345678901' })
        expect(parsed.platformId).toBe('123456789012345678901')
    })

    it('rejects missing or invalid ApId', () => {
        expect(() => SwitchPlatformRequest.parse({})).toThrow()
        expect(() => SwitchPlatformRequest.parse({ platformId: 'short' })).toThrow()
    })
})

describe('AuthenticationResponse & UserWithoutPassword schemas', () => {
    it('parses UserWithoutPassword', () => {
        const user = {
            id: '123456789012345678901',
            platformRole: PlatformRole.ADMIN,
            status: UserStatus.ACTIVE,
            externalId: null,
            platformId: 'plat-1',
        }
        const parsed = UserWithoutPassword.parse(user)
        expect(parsed.platformRole).toBe(PlatformRole.ADMIN)
    })

    it('parses complete AuthenticationResponse', () => {
        const authRes = {
            id: '123456789012345678901',
            platformRole: PlatformRole.ADMIN,
            status: UserStatus.ACTIVE,
            externalId: null,
            platformId: 'plat-1',
            verified: true,
            firstName: 'Rakshit',
            lastName: 'Sapariya',
            email: 'rakshits9828@gmail.com',
            trackEvents: true,
            newsLetter: false,
            token: 'jwt.token.string',
            projectId: 'proj-123',
        }
        const parsed = AuthenticationResponse.parse(authRes)
        expect(parsed.token).toBe('jwt.token.string')
        expect(parsed.projectId).toBe('proj-123')
    })
})

describe('Principal models and PrincipalType enum', () => {
    it('exposes all expected principal types in ALL_PRINCIPAL_TYPES', () => {
        expect(ALL_PRINCIPAL_TYPES).toContain(PrincipalType.USER)
        expect(ALL_PRINCIPAL_TYPES).toContain(PrincipalType.ENGINE)
        expect(ALL_PRINCIPAL_TYPES).toContain(PrincipalType.SERVICE)
        expect(ALL_PRINCIPAL_TYPES).toContain(PrincipalType.WORKER)
        expect(ALL_PRINCIPAL_TYPES).toContain(PrincipalType.UNKNOWN)
        expect(ALL_PRINCIPAL_TYPES).toContain(PrincipalType.ONBOARDING)
        expect(ALL_PRINCIPAL_TYPES).toHaveLength(6)
    })

    it('exposes EndpointScope enum values', () => {
        expect(EndpointScope.PLATFORM).toBe('PLATFORM')
        expect(EndpointScope.PROJECT).toBe('PROJECT')
    })

    it('supports all Principal discriminated variants', () => {
        const worker: WorkerPrincipal = { id: 'w1', type: PrincipalType.WORKER }
        const anon: AnnonymousPrincipal = { id: 'a1', type: PrincipalType.UNKNOWN }
        const service: ServicePrincipal = { id: 's1', type: PrincipalType.SERVICE, platform: { id: 'plat' }, projectId: 'proj' }
        const user: UserPrincipal = { id: 'u1', type: PrincipalType.USER, platform: { id: 'plat' }, tokenVersion: 'v1' }
        const engine: EnginePrincipal = { id: 'e1', type: PrincipalType.ENGINE, projectId: undefined, platform: { id: 'plat' } }
        const onboarding: OnboardingPrincipal = { id: 'o1', type: PrincipalType.ONBOARDING, tokenVersion: 'v1' }

        const principals: Principal[] = [worker, anon, service, user, engine, onboarding]
        expect(principals.map((p) => p.type)).toEqual([
            PrincipalType.WORKER,
            PrincipalType.UNKNOWN,
            PrincipalType.SERVICE,
            PrincipalType.USER,
            PrincipalType.ENGINE,
            PrincipalType.ONBOARDING,
        ])
    })
})

describe('User models and Profile Constants', () => {
    it('validates User and UserWithMetaInformation schemas', () => {
        const baseUser = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            platformRole: PlatformRole.MEMBER,
            status: UserStatus.ACTIVE,
            identityId: 'ident-1',
            externalId: null,
            platformId: null,
            lastActiveDate: '2026-01-02T00:00:00.000Z',
        }
        expect(User.parse(baseUser).identityId).toBe('ident-1')

        const userWithMeta = {
            id: '123456789012345678901',
            email: 'user@example.com',
            firstName: 'Jane',
            lastName: 'Doe',
            status: UserStatus.ACTIVE,
            externalId: null,
            platformId: null,
            platformRole: PlatformRole.OPERATOR,
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            lastActiveDate: null,
            imageUrl: null,
        }
        expect(UserWithMetaInformation.parse(userWithMeta).platformRole).toBe(PlatformRole.OPERATOR)
    })

    it('verifies profile picture configuration and size limits', () => {
        expect(AP_MAXIMUM_PROFILE_PICTURE_SIZE).toBe(5 * 1024 * 1024)
        expect(PROFILE_PICTURE_ALLOWED_TYPES).toEqual([
            'image/jpeg',
            'image/png',
            'image/gif',
            'image/webp',
        ])
    })

    it('validates UpdateMeResponse schema', () => {
        const updateRes = {
            email: 'updated@example.com',
            firstName: 'Updated',
            lastName: 'Name',
            trackEvents: true,
            newsLetter: true,
            imageUrl: 'https://cdn.example.com/pic.png',
        }
        const parsed = UpdateMeResponse.parse(updateRes)
        expect(parsed.imageUrl).toBe('https://cdn.example.com/pic.png')
    })
})
