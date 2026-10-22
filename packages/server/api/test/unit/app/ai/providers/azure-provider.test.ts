import { safeHttp } from '@inboxfm-connect/server-utils'
import { AIProviderModelType, AzureProviderConfig } from '@inboxfm-connect/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }))

vi.mock('@inboxfm-connect/server-utils', () => ({
    safeHttp: {
        createAxios: vi.fn(() => ({
            get: mockGet,
        })),
    },
}))

import { azureProvider } from '../../../../../src/app/ai/providers/azure-provider'

describe('Azure Provider & SSRF Safety (#163)', () => {
    beforeEach(() => {
        mockGet.mockReset()
        vi.mocked(safeHttp.createAxios).mockClear()
    })

    describe('AzureProviderConfig Schema', () => {
        it('accepts valid Azure resource names (2 to 64 characters)', () => {
            const valid = [
                'my-openai-resource',
                'openai123',
                'a-b-c-d',
                'azure-resource-2024',
                'ab', // minimum length 2
                'a' + 'b'.repeat(62) + 'c', // maximum length 64
            ]
            for (const resourceName of valid) {
                const parsed = AzureProviderConfig.safeParse({ resourceName })
                expect(parsed.success).toBe(true)
            }
        })

        it('rejects host-manipulating, single-char, and out-of-bounds resource names', () => {
            const malicious = [
                'a', // rejected: single character (Azure requires 2-64)
                '1', // rejected: single character
                'a' + 'b'.repeat(63) + 'c', // rejected: 65 characters (exceeds 64)
                'attacker.com#',
                '169.254.169.254',
                'internal.corp/evil',
                'foo?bar=1',
                'foo@bar',
                'foo:8080',
                '-leading-dash',
                'trailing-dash-',
                'has.dots.in.name',
                'has spaces',
            ]
            for (const resourceName of malicious) {
                const parsed = AzureProviderConfig.safeParse({ resourceName })
                expect(parsed.success).toBe(false)
            }
        })

        it('validates apiVersion against path/query manipulation', () => {
            const validVersion = AzureProviderConfig.safeParse({
                resourceName: 'my-openai',
                apiVersion: '2024-10-21',
            })
            expect(validVersion.success).toBe(true)

            const maliciousVersion = AzureProviderConfig.safeParse({
                resourceName: 'my-openai',
                apiVersion: '2024-10-21&admin=true',
            })
            expect(maliciousVersion.success).toBe(false)
        })
    })

    describe('azureProvider.listModels', () => {
        it('routes outbound HTTP through safeHttp.createAxios', async () => {
            mockGet.mockResolvedValue({
                data: {
                    data: [
                        { name: 'gpt-4o' },
                        { name: 'gpt-4o-mini' },
                    ],
                },
            })

            const models = await azureProvider.listModels(
                { apiKey: 'test-azure-key' },
                { resourceName: 'my-azure-resource', apiVersion: '2024-10-21' },
            )

            expect(safeHttp.createAxios).toHaveBeenCalledTimes(1)
            expect(mockGet).toHaveBeenCalledWith(
                'https://my-azure-resource.openai.azure.com/openai/deployments?api-version=2024-10-21',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'api-key': 'test-azure-key',
                    }),
                }),
            )
            expect(models).toEqual([
                { id: 'gpt-4o', name: 'gpt-4o', type: AIProviderModelType.TEXT },
                { id: 'gpt-4o-mini', name: 'gpt-4o-mini', type: AIProviderModelType.TEXT },
            ])
        })

        it('returns empty array when endpoint or apiKey is missing', async () => {
            const models = await azureProvider.listModels(
                { apiKey: '' },
                { resourceName: 'my-azure-resource' },
            )
            expect(models).toEqual([])
            expect(safeHttp.createAxios).not.toHaveBeenCalled()
        })
    })

    describe('azureProvider.validateConnection', () => {
        it('calls listModels to validate connection', async () => {
            mockGet.mockResolvedValue({
                data: {
                    data: [{ name: 'gpt-4o' }],
                },
            })

            await expect(
                azureProvider.validateConnection(
                    { apiKey: 'valid-key' },
                    { resourceName: 'my-azure-resource' },
                    {} as any,
                ),
            ).resolves.toBeUndefined()

            expect(safeHttp.createAxios).toHaveBeenCalledTimes(1)
        })

        it('propagates safeHttp connection rejection without catching internally', async () => {
            mockGet.mockRejectedValue(new Error('Connection rejected by SSRF filter'))

            await expect(
                azureProvider.validateConnection(
                    { apiKey: 'valid-key' },
                    { resourceName: 'my-azure-resource' },
                    {} as any,
                ),
            ).rejects.toThrow('Connection rejected by SSRF filter')
        })
    })
})
