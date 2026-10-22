import { describe, expect, it } from 'vitest'
import {
    ALLOWED_PROXY_PROVIDERS,
    ConnectProxyErrorCode,
    ConnectProxyRequest,
    ConnectProxyResponse,
    ProxyHttpMethod,
    ProxyHttpMethodSchema,
} from '../src/lib/connect-proxy'

describe('Connect Proxy Contracts & Schemas', () => {
    describe('ProxyHttpMethodSchema', () => {
        it('accepts valid HTTP methods', () => {
            expect(ProxyHttpMethodSchema.parse('GET')).toBe(ProxyHttpMethod.GET)
            expect(ProxyHttpMethodSchema.parse('POST')).toBe(ProxyHttpMethod.POST)
            expect(ProxyHttpMethodSchema.parse('PUT')).toBe(ProxyHttpMethod.PUT)
            expect(ProxyHttpMethodSchema.parse('PATCH')).toBe(ProxyHttpMethod.PATCH)
            expect(ProxyHttpMethodSchema.parse('DELETE')).toBe(ProxyHttpMethod.DELETE)
        })

        it('rejects unsupported HTTP methods', () => {
            expect(() => ProxyHttpMethodSchema.parse('OPTIONS')).toThrow()
            expect(() => ProxyHttpMethodSchema.parse('HEAD')).toThrow()
            expect(() => ProxyHttpMethodSchema.parse('TRACE')).toThrow()
        })
    })

    describe('ALLOWED_PROXY_PROVIDERS', () => {
        it('registers all default supported providers', () => {
            const providers = Object.keys(ALLOWED_PROXY_PROVIDERS)
            expect(providers).toContain('slack')
            expect(providers).toContain('github')
            expect(providers).toContain('notion')
            expect(providers).toContain('hubspot')
            expect(providers).toContain('google')
            expect(providers).toContain('stripe')
            expect(providers).toContain('zendesk')
        })

        it('verifies provider structures and base URLs', () => {
            const slack = ALLOWED_PROXY_PROVIDERS.slack
            expect(slack.baseUrl).toBe('https://slack.com/api')
            expect(slack.authType).toBe('bearer')
            expect(slack.allowedPieceNames).toContain('slack')

            const zendesk = ALLOWED_PROXY_PROVIDERS.zendesk
            expect(zendesk.supportsSubdomain).toBe(true)
            expect(zendesk.subdomainRegex?.test('my-company')).toBe(true)
            expect(zendesk.subdomainRegex?.test('invalid!subdomain')).toBe(false)
        })
    })

    describe('ConnectProxyRequest validation', () => {
        const validPayload = {
            projectId: 'proj_123',
            externalUserId: 'cust_abc',
            provider: 'slack',
            path: '/conversations.list',
        }

        it('parses valid minimal request and applies defaults', () => {
            const parsed = ConnectProxyRequest.parse(validPayload)
            expect(parsed.method).toBe(ProxyHttpMethod.GET)
            expect(parsed.timeoutMs).toBe(30000)
            expect(parsed.path).toBe('/conversations.list')
        })

        it('rejects absolute URLs in path', () => {
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: 'https://evil.com/leak' })).toThrow(
                /cannot contain an absolute URL scheme/,
            )
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: 'http://localhost/admin' })).toThrow(
                /cannot contain an absolute URL scheme/,
            )
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: '//evil.com/sub' })).toThrow(
                /cannot contain an absolute URL scheme/,
            )
        })

        it('rejects directory traversal in path', () => {
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: '/../etc/passwd' })).toThrow(
                /directory traversal/,
            )
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: '../relative' })).toThrow(
                /directory traversal/,
            )
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: '/foo/..' })).toThrow(
                /directory traversal/,
            )
        })

        it('rejects backslashes and control characters in path', () => {
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: '\\windows\\path' })).toThrow(
                /backslashes/,
            )
            expect(() => ConnectProxyRequest.parse({ ...validPayload, path: '/api/\x00null' })).toThrow(
                /control characters/,
            )
        })

        it('enforces timeout limits between 500ms and 60000ms', () => {
            expect(() => ConnectProxyRequest.parse({ ...validPayload, timeoutMs: 100 })).toThrow()
            expect(() => ConnectProxyRequest.parse({ ...validPayload, timeoutMs: 120000 })).toThrow()
            const ok = ConnectProxyRequest.parse({ ...validPayload, timeoutMs: 5000 })
            expect(ok.timeoutMs).toBe(5000)
        })
    })

    describe('ConnectProxyResponse schema', () => {
        it('validates successful response with rateLimit metadata', () => {
            const resp = ConnectProxyResponse.parse({
                status: 200,
                statusText: 'OK',
                headers: { 'content-type': 'application/json' },
                data: { ok: true, channels: [] },
                provider: 'slack',
                rateLimit: {
                    limit: 100,
                    remaining: 95,
                    reset: 1700000000,
                },
            })
            expect(resp.status).toBe(200)
            expect(resp.rateLimit?.remaining).toBe(95)
        })
    })

    describe('ConnectProxyErrorCode enum', () => {
        it('exposes all expected error codes', () => {
            expect(ConnectProxyErrorCode.PROVIDER_NOT_SUPPORTED).toBe('PROVIDER_NOT_SUPPORTED')
            expect(ConnectProxyErrorCode.CROSS_CUSTOMER_FORBIDDEN).toBe('CROSS_CUSTOMER_FORBIDDEN')
            expect(ConnectProxyErrorCode.SSRF_BLOCKED).toBe('SSRF_BLOCKED')
            expect(ConnectProxyErrorCode.INVALID_PATH).toBe('INVALID_PATH')
        })
    })
})
