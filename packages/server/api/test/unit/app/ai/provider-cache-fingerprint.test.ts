import { AIProviderName } from '@inboxfm-connect/core-utils'
import { describe, expect, it } from 'vitest'
import { getAuthCacheFingerprint } from '../../../../src/app/ai/ai-provider-service'

describe('getAuthCacheFingerprint (issue #402)', () => {
    it('never embeds the raw secret in the key', () => {
        const key = getAuthCacheFingerprint({
            provider: AIProviderName.OPENAI,
            auth: { apiKey: 'sk-live-DO-NOT-LEAK-abcdef123456' } as never,
            config: {} as never,
        })
        expect(key).not.toContain('sk-live-DO-NOT-LEAK-abcdef123456')
        expect(key).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
    })

    it('scopes the fingerprint by provider so shared keys do not collide', () => {
        const openai = getAuthCacheFingerprint({
            provider: AIProviderName.OPENAI,
            auth: { apiKey: 'shared-key' } as never,
            config: {} as never,
        })
        const anthropic = getAuthCacheFingerprint({
            provider: AIProviderName.ANTHROPIC,
            auth: { apiKey: 'shared-key' } as never,
            config: {} as never,
        })
        expect(openai).not.toBe(anthropic)
    })

    it('changes when the credential rotates (rotation detection preserved)', () => {
        const before = getAuthCacheFingerprint({
            provider: AIProviderName.OPENAI,
            auth: { apiKey: 'old-key' } as never,
            config: {} as never,
        })
        const after = getAuthCacheFingerprint({
            provider: AIProviderName.OPENAI,
            auth: { apiKey: 'new-key' } as never,
            config: {} as never,
        })
        expect(before).not.toBe(after)
    })

    it('separates azure deployments on the same key by resource name and api version (codeant #403)', () => {
        const resourceA = getAuthCacheFingerprint({
            provider: AIProviderName.AZURE,
            auth: { apiKey: 'shared-azure-key' } as never,
            config: { resourceName: 'res-a', apiVersion: '2024-10-21' } as never,
        })
        const resourceB = getAuthCacheFingerprint({
            provider: AIProviderName.AZURE,
            auth: { apiKey: 'shared-azure-key' } as never,
            config: { resourceName: 'res-b', apiVersion: '2024-10-21' } as never,
        })
        const versioned = getAuthCacheFingerprint({
            provider: AIProviderName.AZURE,
            auth: { apiKey: 'shared-azure-key' } as never,
            config: { resourceName: 'res-a', apiVersion: '2025-01-01' } as never,
        })
        expect(resourceA).not.toBe(resourceB)
        expect(resourceA).not.toBe(versioned)
        expect(resourceA).not.toContain('shared-azure-key')
    })

    it('includes bedrock region and credentials in the hash without leaking them', () => {
        const key = getAuthCacheFingerprint({
            provider: AIProviderName.BEDROCK,
            auth: { accessKeyId: 'AKIAXXXX', secretAccessKey: 'super-secret-value' } as never,
            config: { region: 'us-east-1' } as never,
        })
        expect(key).not.toContain('super-secret-value')
        expect(key).not.toContain('AKIAXXXX')
        expect(key).toMatch(/^[0-9a-f]{64}$/)
    })
})
