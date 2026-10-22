import { safeHttp } from '@inboxfm-connect/server-utils'
import { CloudflareGatewayProviderConfig } from '@inboxfm-connect/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }))

vi.mock('@inboxfm-connect/server-utils', () => ({
    safeHttp: {
        createAxios: vi.fn(() => ({
            request: mockRequest,
            post: vi.fn(),
        })),
    },
}))

import { createSafeFetch } from '../../../../../src/app/ai/providers/cloudflare-gateway-provider'

describe('Cloudflare Gateway Provider & createSafeFetch (#163)', () => {
    beforeEach(() => {
        mockRequest.mockReset()
        vi.mocked(safeHttp.createAxios).mockClear()
    })

    describe('CloudflareGatewayProviderConfig Schema', () => {
        it('accepts valid accountId and gatewayId with alphanumeric, underscores, and hyphens', () => {
            const valid = [
                { accountId: 'account-123', gatewayId: 'gw_456' },
                { accountId: 'cf_acc', gatewayId: 'my-gateway-01' },
                { accountId: '1234567890abcdef', gatewayId: 'gateway_v1' },
            ]
            for (const cfg of valid) {
                const parsed = CloudflareGatewayProviderConfig.safeParse({
                    ...cfg,
                    models: [],
                })
                expect(parsed.success).toBe(true)
            }
        })

        it('rejects path-manipulating, injection, and invalid characters in accountId or gatewayId', () => {
            const invalid = [
                { accountId: '../evil', gatewayId: 'gw' },
                { accountId: 'acc', gatewayId: '../../etc/passwd' },
                { accountId: 'acc/with/slashes', gatewayId: 'gw' },
                { accountId: 'acc?foo=bar', gatewayId: 'gw' },
                { accountId: 'acc#hash', gatewayId: 'gw' },
                { accountId: 'acc@host', gatewayId: 'gw' },
                { accountId: 'has space', gatewayId: 'gw' },
                { accountId: 'acc', gatewayId: 'gw:8080' },
            ]
            for (const cfg of invalid) {
                const parsed = CloudflareGatewayProviderConfig.safeParse({
                    ...cfg,
                    models: [],
                })
                expect(parsed.success).toBe(false)
            }
        })
    })

    describe('createSafeFetch', () => {
        it('forwards method, body, signal, and sets timeout and size limits on safeHttp request', async () => {
            const fetchFn = createSafeFetch({ 'cf-aig-authorization': 'Bearer secret-key' })
            const responseData = Buffer.from(JSON.stringify({ text: 'ok' }))
            const mockHeadersToJSON = vi.fn().mockReturnValue({ 'content-type': 'application/json' })

            mockRequest.mockResolvedValueOnce({
                status: 200,
                statusText: 'OK',
                data: responseData,
                headers: {
                    toJSON: mockHeadersToJSON,
                },
            })

            const controller = new AbortController()
            const body = JSON.stringify({ prompt: 'hello' })
            const response = await fetchFn('https://gateway.ai.cloudflare.com/v1/acc/gw/test', {
                method: 'POST',
                body,
                headers: { 'custom-header': 'value' },
                signal: controller.signal,
            })

            expect(mockRequest).toHaveBeenCalledTimes(1)
            const callConfig = mockRequest.mock.calls[0][0]
            expect(callConfig.method).toBe('POST')
            expect(callConfig.url).toBe('https://gateway.ai.cloudflare.com/v1/acc/gw/test')
            expect(callConfig.data).toBe(body)
            expect(callConfig.signal).toBe(controller.signal)
            expect(callConfig.timeout).toBe(10000)
            expect(callConfig.maxContentLength).toBe(10 * 1024 * 1024)
            expect(callConfig.maxBodyLength).toBe(10 * 1024 * 1024)
            expect(callConfig.headers).toMatchObject({
                'cf-aig-authorization': 'Bearer secret-key',
                'custom-header': 'value',
            })

            expect(response.status).toBe(200)
            expect(response.statusText).toBe('OK')
            const text = await response.text()
            expect(JSON.parse(text)).toEqual({ text: 'ok' })
            expect(response.headers.get('content-type')).toBe('application/json')
        })

        it('handles URL instance and Headers instance properly', async () => {
            const fetchFn = createSafeFetch()
            mockRequest.mockResolvedValueOnce({
                status: 200,
                statusText: 'OK',
                data: Buffer.from('pong'),
                headers: {
                    toJSON: () => ({ 'x-ping': 'pong' }),
                },
            })

            const urlObj = new URL('https://gateway.ai.cloudflare.com/v1/ping')
            const headersObj = new Headers()
            headersObj.set('x-client', 'test')

            const response = await fetchFn(urlObj, {
                method: 'GET',
                headers: headersObj,
            })

            expect(mockRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'GET',
                    url: 'https://gateway.ai.cloudflare.com/v1/ping',
                    headers: expect.objectContaining({
                        'x-client': 'test',
                    }),
                }),
            )
            expect(await response.text()).toBe('pong')
        })

        it('returns non-200 responses without throwing due to validateStatus: () => true', async () => {
            const fetchFn = createSafeFetch()
            const errorPayload = Buffer.from(JSON.stringify({ error: 'Model not found' }))
            mockRequest.mockResolvedValueOnce({
                status: 404,
                statusText: 'Not Found',
                data: errorPayload,
                headers: {
                    toJSON: () => ({ 'content-type': 'application/json' }),
                },
            })

            const response = await fetchFn('https://gateway.ai.cloudflare.com/v1/acc/gw/missing', {
                method: 'GET',
            })

            expect(response.status).toBe(404)
            expect(response.statusText).toBe('Not Found')
            const body = await response.json()
            expect(body).toEqual({ error: 'Model not found' })
        })
    })
})
