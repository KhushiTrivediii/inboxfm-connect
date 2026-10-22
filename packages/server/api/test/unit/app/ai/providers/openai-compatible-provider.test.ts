import { outboundUrlPolicy } from '@inboxfm-connect/core-utils'
import { formErrors, OpenAICompatibleProviderConfig } from '@inboxfm-connect/shared'
import { describe, expect, it } from 'vitest'

const baseConfig = {
    apiKeyHeader: 'Authorization',
    models: [{ modelId: 'gpt-4o', modelName: 'GPT-4o', modelType: 'text' as const }],
}

describe('OpenAI Compatible Provider config hardening', () => {
    describe('OpenAICompatibleProviderConfig schema', () => {
        it('accepts an ordinary hosted OpenAI-compatible endpoint', () => {
            const parsed = OpenAICompatibleProviderConfig.safeParse({
                ...baseConfig,
                baseUrl: 'https://api.vendor.com/v1',
            })
            expect(parsed.success).toBe(true)
        })

        it('accepts a self-hosted gateway on a private address, which is a legitimate deployment', () => {
            // The egress decision is made at request time and is allow-list aware, so a private
            // host must still be expressible here — rejecting it would break self-hosted vLLM etc.
            const parsed = OpenAICompatibleProviderConfig.safeParse({
                ...baseConfig,
                baseUrl: 'http://10.0.0.5:8080/v1',
            })
            expect(parsed.success).toBe(true)
        })

        it('accepts custom default headers when the names are valid HTTP tokens', () => {
            const parsed = OpenAICompatibleProviderConfig.safeParse({
                ...baseConfig,
                baseUrl: 'https://api.vendor.com/v1',
                defaultHeaders: { 'X-Tenant-Id': 'acme' },
            })
            expect(parsed.success).toBe(true)
        })

        it('rejects base URLs that are not a single well-formed http(s) origin', () => {
            const rejected = [
                'not a url',
                '',
                'file:///etc/passwd',
                'javascript:alert(1)',
                'gopher://example.com',
                'ftp://example.com',
                // userinfo would let the real host be misread by anything that parses it loosely
                'https://user:pass@api.vendor.com/v1',
                `https://api.vendor.com/${'a'.repeat(400)}`,
            ]
            for (const baseUrl of rejected) {
                const parsed = OpenAICompatibleProviderConfig.safeParse({ ...baseConfig, baseUrl })
                expect(parsed.success, `expected ${JSON.stringify(baseUrl)} to be rejected`).toBe(false)
                if (!parsed.success) {
                    expect(parsed.error.issues[0]?.message).toBe(formErrors.invalidAiProviderBaseUrl)
                }
            }
        })

        it('rejects an apiKeyHeader that is not a valid HTTP header name', () => {
            const rejected = ['', 'X Api Key', 'X-Api-Key: Bearer', 'X-Api-Key\r\nX-Injected: 1', 'X-Api\nKey']
            for (const apiKeyHeader of rejected) {
                const parsed = OpenAICompatibleProviderConfig.safeParse({ ...baseConfig, apiKeyHeader, baseUrl: 'https://api.vendor.com/v1' })
                expect(parsed.success, `expected ${JSON.stringify(apiKeyHeader)} to be rejected`).toBe(false)
            }
        })

        it('rejects default header names that could smuggle a second header', () => {
            const parsed = OpenAICompatibleProviderConfig.safeParse({
                ...baseConfig,
                baseUrl: 'https://api.vendor.com/v1',
                defaultHeaders: { 'X-Fine\r\nX-Injected': 'boom' },
            })
            expect(parsed.success).toBe(false)
        })
    })

    describe('outboundUrlPolicy.isBlockedOutboundHost', () => {
        it('blocks cloud metadata, loopback and private-range targets', () => {
            const blocked = ['169.254.169.254', '127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1', '0.0.0.0', '::1', '[::1]', 'localhost', '']
            for (const hostname of blocked) {
                expect(
                    outboundUrlPolicy.isBlockedOutboundHost({ hostname, allowList: [] }),
                    `expected ${JSON.stringify(hostname)} to be blocked`,
                ).toBe(true)
            }
        })

        it('allows public DNS names and public IPs', () => {
            for (const hostname of ['api.openai.com', 'gateway.example.com', '8.8.8.8']) {
                expect(
                    outboundUrlPolicy.isBlockedOutboundHost({ hostname, allowList: [] }),
                    `expected ${hostname} to be allowed`,
                ).toBe(false)
            }
        })

        it('honours AP_SSRF_ALLOW_LIST so a trusted private gateway stays reachable', () => {
            expect(outboundUrlPolicy.isBlockedOutboundHost({ hostname: '10.0.0.5', allowList: ['10.0.0.5'] })).toBe(false)
            expect(outboundUrlPolicy.isBlockedOutboundHost({ hostname: '10.0.0.7', allowList: ['10.0.0.0/8'] })).toBe(false)
            expect(outboundUrlPolicy.isBlockedOutboundHost({ hostname: 'localhost', allowList: ['localhost'] })).toBe(false)
        })
    })
})
