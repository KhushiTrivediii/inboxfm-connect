import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openRouterApi } from '../../../../../src/app/ee/platform/platform-plan/openrouter/openrouter-api'

const mockGet = vi.hoisted(() => vi.fn())
const mockPost = vi.hoisted(() => vi.fn())
const mockPatch = vi.hoisted(() => vi.fn())

vi.mock('@inboxfm-connect/server-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@inboxfm-connect/server-utils')>()
    const instance = actual.safeHttp.createAxios({ validateStatus: () => true })
    instance.get = mockGet
    instance.post = mockPost
    instance.patch = mockPatch
    return {
        ...actual,
        safeHttp: {
            ...actual.safeHttp,
            createAxios: () => instance,
        },
    }
})

describe('openRouterApi safeHttp migration (issue #143)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        process.env['AP_OPENROUTER_PROVISION_KEY'] = 'test-provision-key'
    })

    it('returns response data on success', async () => {
        mockGet.mockResolvedValue({ status: 200, data: { data: { hash: 'abc' } } })
        const result = await openRouterApi.getKey({ hash: 'abc' })
        expect(result).toEqual({ data: { hash: 'abc' } })
        expect(mockGet).toHaveBeenCalledWith(
            expect.stringContaining('/keys/abc'),
            expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-provision-key' }) }),
        )
    })

    it('throws a status-preserving error on failure', async () => {
        mockGet.mockResolvedValue({ status: 500, data: { error: 'boom' } })
        await expect(openRouterApi.getKey({ hash: 'abc' })).rejects.toThrow('[OpenRouter] getKey error: 500')
    })

    it('forwards listKeys pagination params in the URL', async () => {
        mockGet.mockResolvedValue({ status: 200, data: { data: [] } })
        await openRouterApi.listKeys({ offset: 10, include_disabled: 'true' })
        const url = String(mockGet.mock.calls[0]?.[0] ?? '')
        expect(url).toContain('offset=10')
        expect(url).toContain('include_disabled=true')
    })

    it('posts the createKey body and returns the created key', async () => {
        mockPost.mockResolvedValue({ status: 200, data: { key: 'sk-or-test', data: { hash: 'abc' } } })
        const result = await openRouterApi.createKey({ name: 'ci-key' })
        expect(result).toEqual({ key: 'sk-or-test', data: { hash: 'abc' } })
        expect(mockPost).toHaveBeenCalledWith(
            expect.stringContaining('/keys'),
            { name: 'ci-key' },
            expect.anything(),
        )
    })

    it('sends updateKey as PATCH without the hash in the body', async () => {
        mockPatch.mockResolvedValue({ status: 200, data: { data: { hash: 'abc' } } })
        await openRouterApi.updateKey({ hash: 'abc', name: 'renamed' })
        expect(mockPatch).toHaveBeenCalledWith(
            expect.stringContaining('/keys/abc'),
            { name: 'renamed' },
            expect.anything(),
        )
    })
})
