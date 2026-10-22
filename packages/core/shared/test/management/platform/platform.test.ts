import { describe, expect, it } from 'vitest'
import {
    AddAllowedEmbedOriginsRequestBody,
    AddAllowedEmbedOriginsResponse,
    allowedEmbedOriginSchema,
    CreatePlatformRequest,
    MAX_EMBED_ORIGIN_LENGTH,
    UpdatePlatformRequestBody,
} from '../../../src/lib/management/platform/platform.request'
import {
    FilteredPieceBehavior,
    Platform,
} from '../../../src/lib/management/platform/platform.model'
import { ConcurrencyPool } from '../../../src/lib/management/platform/concurrency-pool'

describe('allowedEmbedOriginSchema and MAX_EMBED_ORIGIN_LENGTH', () => {
    it('defines MAX_EMBED_ORIGIN_LENGTH as 300', () => {
        expect(MAX_EMBED_ORIGIN_LENGTH).toBe(300)
    })

    it('accepts valid http and https origins with ports', () => {
        expect(allowedEmbedOriginSchema.parse('http://localhost:3000')).toBe('http://localhost:3000')
        expect(allowedEmbedOriginSchema.parse('https://app.example.com')).toBe('https://app.example.com')
        expect(allowedEmbedOriginSchema.parse('https://portal.my-domain.io:8443')).toBe('https://portal.my-domain.io:8443')
    })

    it('accepts wildcard subdomains for http and https', () => {
        expect(allowedEmbedOriginSchema.parse('https://*.example.com')).toBe('https://*.example.com')
        expect(allowedEmbedOriginSchema.parse('http://*.internal.org')).toBe('http://*.internal.org')
    })

    it('rejects disallowed protocols (ftp, file, javascript)', () => {
        expect(() => allowedEmbedOriginSchema.parse('ftp://example.com')).toThrow()
        expect(() => allowedEmbedOriginSchema.parse('javascript:alert(1)')).toThrow()
        expect(() => allowedEmbedOriginSchema.parse('ws://example.com')).toThrow()
    })

    it('rejects origins with path components or trailing slashes (must be pure origins)', () => {
        expect(() => allowedEmbedOriginSchema.parse('https://example.com/')).toThrow()
        expect(() => allowedEmbedOriginSchema.parse('https://example.com/path')).toThrow()
        expect(() => allowedEmbedOriginSchema.parse('https://example.com?query=1')).toThrow()
    })

    it('rejects origins exceeding MAX_EMBED_ORIGIN_LENGTH', () => {
        const longDomain = `https://${'a'.repeat(300)}.com`
        expect(() => allowedEmbedOriginSchema.parse(longDomain)).toThrow()
    })
})

describe('CreatePlatformRequest schema and SAFE_STRING_PATTERN defense', () => {
    it('parses valid platform name', () => {
        const parsed = CreatePlatformRequest.parse({ name: 'Enterprise-Platform_1' })
        expect(parsed.name).toBe('Enterprise-Platform_1')
    })

    it('rejects platform name containing "." or "/"', () => {
        expect(() => CreatePlatformRequest.parse({ name: 'platform.sub' })).toThrow()
        expect(() => CreatePlatformRequest.parse({ name: 'platform/traversal' })).toThrow()
    })

    it('rejects empty or oversized platform name', () => {
        expect(() => CreatePlatformRequest.parse({ name: '' })).toThrow()
        expect(() => CreatePlatformRequest.parse({ name: 'a'.repeat(101) })).toThrow()
    })
})

describe('UpdatePlatformRequestBody schema', () => {
    it('parses partial platform updates with allowed origins and piece filtering', () => {
        const body = {
            name: 'Updated-Name',
            primaryColor: '#0055ff',
            filteredPieceBehavior: FilteredPieceBehavior.ALLOWED,
            filteredPieceNames: ['@inboxfm-connect/piece-slack'],
            cloudAuthEnabled: true,
            allowedEmbedOrigins: ['https://*.company.com', 'http://localhost:3000'],
        }
        const parsed = UpdatePlatformRequestBody.parse(body)
        expect(parsed.filteredPieceBehavior).toBe(FilteredPieceBehavior.ALLOWED)
        expect(parsed.allowedEmbedOrigins).toHaveLength(2)
        expect(parsed.cloudAuthEnabled).toBe(true)
    })
})

describe('AddAllowedEmbedOriginsRequestBody & Response', () => {
    it('requires at least one origin', () => {
        expect(() => AddAllowedEmbedOriginsRequestBody.parse({ allowedEmbedOrigins: [] })).toThrow()
    })

    it('parses valid AddAllowedEmbedOriginsRequestBody and Response', () => {
        const req = { allowedEmbedOrigins: ['https://app.client.com'] }
        const parsedReq = AddAllowedEmbedOriginsRequestBody.parse(req)
        expect(parsedReq.allowedEmbedOrigins).toEqual(['https://app.client.com'])

        const res = { allowedEmbedOrigins: ['https://app.client.com', 'https://*.client.com'] }
        const parsedRes = AddAllowedEmbedOriginsResponse.parse(res)
        expect(parsedRes.allowedEmbedOrigins).toHaveLength(2)
    })
})

describe('ConcurrencyPool schema', () => {
    const validPool = {
        id: '123456789012345678901',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        platformId: '123456789012345678901',
        key: 'pool-default',
        maxConcurrentJobs: 25,
    }

    it('parses valid ConcurrencyPool model', () => {
        const parsed = ConcurrencyPool.parse(validPool)
        expect(parsed.key).toBe('pool-default')
        expect(parsed.maxConcurrentJobs).toBe(25)
    })

    it('rejects zero or negative maxConcurrentJobs', () => {
        expect(() => ConcurrencyPool.parse({ ...validPool, maxConcurrentJobs: 0 })).toThrow()
        expect(() => ConcurrencyPool.parse({ ...validPool, maxConcurrentJobs: -5 })).toThrow()
    })
})

describe('Platform model schema', () => {
    it('parses platform model', () => {
        const platform = {
            id: '123456789012345678901',
            created: '2026-01-01T00:00:00.000Z',
            updated: '2026-01-01T00:00:00.000Z',
            ownerId: '123456789012345678902',
            name: 'Production-Platform',
            primaryColor: '#3b82f6',
            themeColors: null,
            logoIconUrl: 'https://cdn.example.com/logo-icon.png',
            fullLogoUrl: 'https://cdn.example.com/full-logo.png',
            favIconUrl: 'https://cdn.example.com/favicon.ico',
            filteredPieceBehavior: FilteredPieceBehavior.ALLOWED,
            filteredPieceNames: [],
            cloudAuthEnabled: true,
            googleAuthEnabled: false,
            emailAuthEnabled: true,
            enforceAllowedAuthDomains: false,
            allowedAuthDomains: [],
            allowedEmbedOrigins: ['https://app.client.com'],
            ssoDomain: null,
            ssoDomainVerification: null,
            federatedAuthProviders: {},
            pinnedPieces: [],
            pieceSelectorConfig: null,
        }
        const parsed = Platform.parse(platform)
        expect(parsed.name).toBe('Production-Platform')
        expect(parsed.ownerId).toBe('123456789012345678902')
    })
})
