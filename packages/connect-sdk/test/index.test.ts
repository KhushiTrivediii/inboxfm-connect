import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectError, InboxFM } from '../src/index'

function jsonResponse({ status, body, headers }: { status: number, body: unknown, headers?: Record<string, string> }): Response {
    return new Response(JSON.stringify(body), { status, headers })
}

function client(overrides: Partial<ConstructorParameters<typeof InboxFM>[0]> = {}): InboxFM {
    return new InboxFM({
        apiKey: 'test-key',
        projectId: 'project-a',
        baseUrl: 'https://api.example.com',
        retryBaseDelayMs: 1,
        retryMaxDelayMs: 5,
        ...overrides,
    })
}

describe('InboxFM transport', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends the bearer token and project id on a successful GET', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: { data: [], next: null, previous: null } }))

        const result = await client().listConnections({ externalUserId: 'user_1' })

        expect(result).toEqual({ data: [], next: null, previous: null })
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toContain('projectId=project-a')
        expect(init.headers.Authorization).toBe('Bearer test-key')
    })

    it('throws a typed ConnectError on a non-2xx response', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 404, body: { code: 'ENTITY_NOT_FOUND', params: { entityId: 'abc' } } }))

        await expect(client().listConnections({ externalUserId: 'user_1' })).rejects.toMatchObject({
            category: 'not_found',
            code: 'ENTITY_NOT_FOUND',
        })
    })

    it('retries a safe GET request on a transient network failure', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(jsonResponse({ status: 200, body: { data: [], next: null, previous: null } }))

        const result = await client().listConnections({ externalUserId: 'user_1' })

        expect(result).toEqual({ data: [], next: null, previous: null })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does NOT retry a non-idempotent POST (execute) on a network failure, even with an idempotency key', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'))

        await expect(
            client().execute({ integration: 'slack', tool: 'send_message', input: {}, idempotencyKey: 'key-1' }),
        ).rejects.toMatchObject({ category: 'network' })

        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does NOT retry a non-idempotent POST (createConnectSession) on a 500 response', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ status: 500, body: { message: 'boom' } }))

        await expect(client().createConnectSession({ externalUserId: 'user_1' })).rejects.toMatchObject({ category: 'server' })

        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries a POST automatically on a 429 response, since the request was rejected before execution', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse({ status: 429, body: { code: 'PROJECT_RATE_LIMIT_EXCEEDED', params: {} } }))
            .mockResolvedValueOnce(jsonResponse({ status: 200, body: { token: 't', connectUrl: 'https://x', expiresAt: '2026-01-01' } }))

        const result = await client().createConnectSession({ externalUserId: 'user_1' })

        expect(result.token).toBe('t')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('lets a caller opt a mutation into retries explicitly via retryable: true', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(jsonResponse({ status: 200, body: { token: 't', connectUrl: 'https://x', expiresAt: '2026-01-01' } }))

        const result = await client().createConnectSession({ externalUserId: 'user_1', retryable: true })

        expect(result.token).toBe('t')
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('retries deleteConnection (naturally idempotent) on a network failure by default', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(new Response(null, { status: 204 }))

        await client().deleteConnection({ connectionId: 'conn_1' })

        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('gives up after exhausting max attempts and surfaces the last error', async () => {
        fetchMock.mockRejectedValue(new TypeError('fetch failed'))

        await expect(client({ maxAttempts: 2 }).listConnections({ externalUserId: 'user_1' })).rejects.toBeInstanceOf(ConnectError)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('respects a caller-provided AbortSignal', async () => {
        const controller = new AbortController()
        fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
            if (init.signal.aborted) {
                reject(new DOMException('aborted', 'AbortError'))
                return
            }
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }))
        controller.abort()

        await expect(
            client().listConnections({ externalUserId: 'user_1', signal: controller.signal }),
        ).rejects.toMatchObject({ category: 'aborted' })
    })

    it('surfaces a timeout as a typed ConnectError', async () => {
        fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
            if (init.signal.aborted) {
                reject(new DOMException('aborted', 'AbortError'))
                return
            }
            init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }))

        await expect(
            client({ timeoutMs: 5, maxAttempts: 1 }).listConnections({ externalUserId: 'user_1' }),
        ).rejects.toMatchObject({ category: 'timeout' })
    })

    it('sends the Idempotency-Key header when provided', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: { token: 't', connectUrl: 'https://x', expiresAt: '2026-01-01' } }))

        await client().createConnectSession({ externalUserId: 'user_1', idempotencyKey: 'key-42' })

        const [, init] = fetchMock.mock.calls[0]
        expect(init.headers['Idempotency-Key']).toBe('key-42')
    })

    it('scopes requests to the configured project id without leaking across clients', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ status: 200, body: { data: [], next: null, previous: null } }))

        await client({ projectId: 'project-b' }).listConnections({ externalUserId: 'user_1' })

        const [url] = fetchMock.mock.calls[0]
        expect(String(url)).toContain('projectId=project-b')
        expect(String(url)).not.toContain('projectId=project-a')
    })
})

describe('InboxFM request shapes', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('normalizes a trailing slash on baseUrl so paths are never doubled', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: { data: [], next: null, previous: null } }))

        await client({ baseUrl: 'https://api.example.com/api///' }).listConnections({ externalUserId: 'user_1' })

        const [url] = fetchMock.mock.calls[0]
        expect(String(url)).toMatch(/^https:\/\/api\.example\.com\/api\/v1\/connections\?/)
    })

    it('sends every createConnectSession field in the body alongside the configured project id', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 201, body: { token: 't', connectUrl: 'https://x', expiresAt: '2026-01-01' } }))

        await client().createConnectSession({ externalUserId: 'user_1', allowedPieceNames: ['@inboxfm-connect/piece-slack'], expiresInSeconds: 600 })

        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe('https://api.example.com/v1/connect-sessions')
        expect(init.method).toBe('POST')
        expect(JSON.parse(init.body)).toEqual({
            projectId: 'project-a',
            externalUserId: 'user_1',
            allowedPieceNames: ['@inboxfm-connect/piece-slack'],
            expiresInSeconds: 600,
        })
    })

    it('filters listConnections by piece name and maps externalUserId to the externalId query param', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: { data: [], next: null, previous: null } }))

        await client().listConnections({ externalUserId: 'user_1', pieceName: '@inboxfm-connect/piece-slack' })

        const url = new URL(String(fetchMock.mock.calls[0][0]))
        expect(url.searchParams.get('externalId')).toBe('user_1')
        expect(url.searchParams.get('pieceName')).toBe('@inboxfm-connect/piece-slack')
        expect(url.searchParams.get('projectId')).toBe('project-a')
        expect(url.searchParams.has('cursor')).toBe(false)
        expect(url.searchParams.has('limit')).toBe(false)
    })

    it('forwards the pagination cursor and page size to listConnections', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: { data: [], next: null, previous: 'prev-cursor' } }))

        await client().listConnections({ externalUserId: 'user_1', cursor: 'next-cursor', limit: 50 })

        const url = new URL(String(fetchMock.mock.calls[0][0]))
        expect(url.searchParams.get('cursor')).toBe('next-cursor')
        expect(url.searchParams.get('limit')).toBe('50')
    })

    it('posts execute with the project id and returns the raw tool output unchanged', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: 'smoke-ready' }))

        const output = await client().execute({
            integration: '@inboxfm-connect/piece-text-helper',
            tool: 'concat',
            externalUserId: 'user_1',
            input: { texts: ['smoke', 'ready'], separator: '-' },
        })

        expect(output).toBe('smoke-ready')
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe('https://api.example.com/v1/execute')
        expect(JSON.parse(init.body)).toEqual({
            projectId: 'project-a',
            integration: '@inboxfm-connect/piece-text-helper',
            tool: 'concat',
            externalUserId: 'user_1',
            input: { texts: ['smoke', 'ready'], separator: '-' },
        })
    })

    it('surfaces a failed tool run (the server maps ENGINE_OPERATION_FAILURE to 400) as a typed, non-retried ConnectError', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ status: 400, body: { code: 'ENGINE_OPERATION_FAILURE', params: { message: 'boom' } } }))

        await expect(client().execute({ integration: 'x', tool: 'y', connectionId: 'conn_1', input: {}, retryable: true })).rejects.toMatchObject({
            category: 'validation',
            retryable: false,
            code: 'ENGINE_OPERATION_FAILURE',
            params: { message: 'boom' },
        })
    })

    it('does not retry deleteConnection on a 404, since the connection is already gone', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ status: 404, body: { code: 'ENTITY_NOT_FOUND', params: {} } }))

        await expect(client().deleteConnection({ connectionId: 'conn_1' })).rejects.toMatchObject({ category: 'not_found' })

        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe('https://api.example.com/v1/connections/conn_1')
        expect(init.method).toBe('DELETE')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})

describe('InboxFM.listTools', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    const integrationMetadata = {
        name: '@inboxfm-connect/piece-text-helper',
        displayName: 'Text Helper',
        platformId: 'platform-internal',
        triggers: { ignored: { name: 'ignored' } },
        actions: {
            concat: {
                name: 'concat',
                displayName: 'Concatenate',
                description: 'Join texts with a separator',
                requireAuth: false,
                audience: 'both',
                aiMetadata: { idempotent: true },
                errorHandlingOptions: { retryOnFailure: { value: false } },
                outputSchema: { type: 'string' },
                props: {
                    texts: { displayName: 'Texts', type: 'ARRAY', required: true, properties: {} },
                    separator: { displayName: 'Separator', description: 'Placed between texts', type: 'SHORT_TEXT', required: false, defaultValue: '' },
                },
            },
        },
    }

    it('fetches the integration by its URL-encoded scoped name and maps actions to tools', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: integrationMetadata }))

        const tools = await client().listTools({ integration: '@inboxfm-connect/piece-text-helper' })

        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe('https://api.example.com/v1/integrations/%40inboxfm-connect%2Fpiece-text-helper')
        expect(init.method).toBe('GET')
        expect(init.headers.Authorization).toBe('Bearer test-key')
        expect(tools).toEqual([
            {
                name: 'concat',
                displayName: 'Concatenate',
                description: 'Join texts with a separator',
                requireAuth: false,
                audience: 'both',
                aiMetadata: { idempotent: true },
                inputs: [
                    { name: 'texts', displayName: 'Texts', type: 'ARRAY', required: true },
                    { name: 'separator', displayName: 'Separator', description: 'Placed between texts', type: 'SHORT_TEXT', required: false },
                ],
            },
        ])
    })

    it('pins a specific integration version through the version query param', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: { actions: {} } }))

        const tools = await client().listTools({ integration: 'text-helper', version: '0.5.1' })

        expect(tools).toEqual([])
        expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('version')).toBe('0.5.1')
    })

    it('retries like any safe GET on a transient network failure', async () => {
        fetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(jsonResponse({ status: 200, body: { actions: {} } }))

        await client().listTools({ integration: 'text-helper' })

        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('surfaces an unknown integration as a not_found ConnectError', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 404, body: { code: 'ENTITY_NOT_FOUND', params: {} } }))

        await expect(client().listTools({ integration: 'does-not-exist' })).rejects.toMatchObject({ category: 'not_found' })
    })
})

describe('InboxFM.proxy', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends proxy request with project context and relative path', async () => {
        const expectedResponse = {
            status: 200,
            statusText: 'OK',
            headers: { 'content-type': 'application/json' },
            data: { user: { id: 'U12345', name: 'Alice' } },
            provider: 'slack',
            rateLimit: { limit: 100, remaining: 99, reset: 1600000000 },
        }
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: expectedResponse }))

        const result = await client().proxy({
            externalUserId: 'cust_abc_123',
            provider: 'slack',
            method: 'GET',
            path: '/users.info',
            query: { user: 'U12345' },
        })

        expect(result).toEqual(expectedResponse)
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe('https://api.example.com/v1/connect-proxy/request')
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
            projectId: 'project-a',
            externalUserId: 'cust_abc_123',
            provider: 'slack',
            method: 'GET',
            path: '/users.info',
            query: { user: 'U12345' },
        })
    })

    it('passes request body, headers, and idempotencyKey', async () => {
        const expectedResponse = {
            status: 201,
            statusText: 'Created',
            headers: { 'content-type': 'application/json' },
            data: { ok: true, channel: 'C123' },
            provider: 'slack',
        }
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 200, body: expectedResponse }))

        const result = await client().proxy({
            externalUserId: 'cust_abc_123',
            provider: 'slack',
            method: 'POST',
            path: '/conversations.create',
            headers: { 'X-Custom-Client': 'TestClient' },
            body: { name: 'general' },
            idempotencyKey: 'idemp-xyz-123',
        })

        expect(result.status).toBe(201)
        const [, init] = fetchMock.mock.calls[0]
        expect(init?.headers?.['Idempotency-Key']).toBe('idemp-xyz-123')
        expect(JSON.parse(String(init?.body))).toMatchObject({
            method: 'POST',
            path: '/conversations.create',
            body: { name: 'general' },
            idempotencyKey: 'idemp-xyz-123',
        })
    })

    it('surfaces upstream or validation errors as typed ConnectError', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            status: 400,
            body: { code: 'PROVIDER_NOT_SUPPORTED', params: { provider: 'unknown_service' } },
        }))

        await expect(client().proxy({
            externalUserId: 'cust_abc_123',
            provider: 'unknown_service',
            path: '/test',
        })).rejects.toMatchObject({
            category: 'validation',
        })
    })
})

describe('InboxFM.createMcpToken', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('creates a bounded delegated MCP token for an external user', async () => {
        const expectedResponse = {
            token: 'mock-mcp-token',
            mcpServerUrl: 'https://api.example.com/mcp',
            expiresAt: '2026-09-28T21:00:00.000Z',
            projectId: 'project-a',
            externalUserId: 'cust_abc_123',
            allowedPieceNames: ['@inboxfm-connect/piece-slack'],
        }
        fetchMock.mockResolvedValueOnce(jsonResponse({ status: 201, body: expectedResponse }))

        const result = await client().createMcpToken({
            externalUserId: 'cust_abc_123',
            allowedPieceNames: ['@inboxfm-connect/piece-slack'],
            expiresInSeconds: 3600,
        })

        expect(result).toEqual(expectedResponse)
        const [url, init] = fetchMock.mock.calls[0]
        expect(String(url)).toBe('https://api.example.com/v1/connect-mcp/token')
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
            projectId: 'project-a',
            externalUserId: 'cust_abc_123',
            allowedPieceNames: ['@inboxfm-connect/piece-slack'],
            expiresInSeconds: 3600,
        })
    })

    it('surfaces validation errors as validation ConnectError', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({
            status: 400,
            body: { code: 'VALIDATION', params: { message: 'externalUserId cannot be empty' } },
        }))

        await expect(client().createMcpToken({ externalUserId: '' })).rejects.toMatchObject({
            category: 'validation',
        })
    })
})
