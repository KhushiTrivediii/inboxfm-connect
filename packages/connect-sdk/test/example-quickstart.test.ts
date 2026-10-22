import { createServer, IncomingMessage, Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentCycle } from '../examples/quickstart/agent-cycle'
import { InboxFM } from '../src/index'

const INTEGRATION = '@inboxfm-connect/piece-text-helper'

const CONNECTION = {
    id: 'conn_1',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    externalId: 'quickstart-user',
    displayName: 'Text Helper',
    type: 'SECRET_TEXT',
    pieceName: INTEGRATION,
    projectIds: ['project-a'],
    scope: 'PROJECT',
    status: 'ACTIVE',
    pieceVersion: '0.5.1',
    preSelectForNewProjects: false,
    usingSecretManager: false,
}

const INTEGRATION_METADATA = {
    name: INTEGRATION,
    displayName: 'Text Helper',
    triggers: {},
    actions: {
        concat: {
            name: 'concat',
            displayName: 'Concatenate',
            description: 'Join texts with a separator',
            requireAuth: false,
            props: {
                texts: { displayName: 'Texts', type: 'ARRAY', required: true },
                separator: { displayName: 'Separator', type: 'SHORT_TEXT', required: false },
            },
        },
    },
}

async function readJsonBody({ request }: { request: IncomingMessage }): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of request) {
        chunks.push(Buffer.from(chunk))
    }
    return chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
}

function startFixtureServer({ connectionAppearsAfterPolls }: { connectionAppearsAfterPolls: number }): Promise<FixtureServer> {
    const calls: RecordedCall[] = []
    let connectionListCalls = 0
    const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const body = await readJsonBody({ request })
        calls.push({ method: request.method ?? '', path: url.pathname, authorization: request.headers.authorization, body })
        response.setHeader('Content-Type', 'application/json')

        if (request.method === 'GET' && url.pathname === '/v1/connections') {
            connectionListCalls += 1
            const connected = connectionListCalls > connectionAppearsAfterPolls
            response.end(JSON.stringify({ data: connected ? [CONNECTION] : [], next: null, previous: null }))
            return
        }
        if (request.method === 'POST' && url.pathname === '/v1/connect-sessions') {
            response.statusCode = 201
            response.end(JSON.stringify({ token: 'session-token', connectUrl: 'https://app.example.com/connect/session-token', expiresAt: '2026-12-01T00:00:00.000Z' }))
            return
        }
        if (request.method === 'GET' && url.pathname === `/v1/integrations/${encodeURIComponent(INTEGRATION)}`) {
            response.end(JSON.stringify(INTEGRATION_METADATA))
            return
        }
        if (request.method === 'POST' && url.pathname === '/v1/execute') {
            response.end(JSON.stringify('smoke-ready'))
            return
        }
        response.statusCode = 404
        response.end(JSON.stringify({ code: 'ENTITY_NOT_FOUND', params: {} }))
    })
    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (address === null || typeof address === 'string') {
                reject(new Error('Fixture server did not bind a TCP port'))
                return
            }
            resolve({ server, calls, baseUrl: `http://127.0.0.1:${address.port}` })
        })
    })
}

describe('quickstart example against a local Connect API fixture', () => {
    let fixture: FixtureServer | undefined

    beforeEach(() => {
        fixture = undefined
    })

    afterEach(async () => {
        const server = fixture?.server
        if (server) {
            await new Promise((resolve) => server.close(resolve))
        }
    })

    function clientFor({ baseUrl }: { baseUrl: string }): InboxFM {
        return new InboxFM({ apiKey: 'cak-test', projectId: 'project-a', baseUrl })
    }

    it('creates a connect session, waits for the end-user to connect, lists tools, and runs one', async () => {
        fixture = await startFixtureServer({ connectionAppearsAfterPolls: 2 })
        const lines: string[] = []

        const result = await runAgentCycle({
            client: clientFor({ baseUrl: fixture.baseUrl }),
            externalUserId: 'quickstart-user',
            integration: INTEGRATION,
            tool: 'concat',
            input: { texts: ['smoke', 'ready'], separator: '-' },
            connectTimeoutMs: 5_000,
            pollIntervalMs: 1,
            log: (line) => lines.push(line),
        })

        expect(result.output).toBe('smoke-ready')
        expect(result.connection.id).toBe('conn_1')
        expect(result.tool.inputs.map((toolInput) => toolInput.name)).toEqual(['texts', 'separator'])
        expect(lines).toContain('https://app.example.com/connect/session-token')
        expect(fixture.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
            'GET /v1/connections',
            'POST /v1/connect-sessions',
            'GET /v1/connections',
            'GET /v1/connections',
            `GET /v1/integrations/${encodeURIComponent(INTEGRATION)}`,
            'POST /v1/execute',
        ])
        expect(fixture.calls.every((call) => call.authorization === 'Bearer cak-test')).toBe(true)
        expect(fixture.calls[1].body).toEqual({ projectId: 'project-a', externalUserId: 'quickstart-user', allowedPieceNames: [INTEGRATION] })
        expect(fixture.calls[5].body).toEqual({
            projectId: 'project-a',
            integration: INTEGRATION,
            tool: 'concat',
            connectionId: 'conn_1',
            input: { texts: ['smoke', 'ready'], separator: '-' },
        })
    })

    it('reuses an existing connection without creating a connect session', async () => {
        fixture = await startFixtureServer({ connectionAppearsAfterPolls: 0 })

        await runAgentCycle({
            client: clientFor({ baseUrl: fixture.baseUrl }),
            externalUserId: 'quickstart-user',
            integration: INTEGRATION,
            tool: 'concat',
            input: { texts: ['a'] },
            connectTimeoutMs: 5_000,
            pollIntervalMs: 1,
            log: () => undefined,
        })

        expect(fixture.calls.some((call) => call.path === '/v1/connect-sessions')).toBe(false)
    })

    it('refuses to call a tool when a required input is missing', async () => {
        fixture = await startFixtureServer({ connectionAppearsAfterPolls: 0 })

        await expect(runAgentCycle({
            client: clientFor({ baseUrl: fixture.baseUrl }),
            externalUserId: 'quickstart-user',
            integration: INTEGRATION,
            tool: 'concat',
            input: { separator: '-' },
            connectTimeoutMs: 5_000,
            pollIntervalMs: 1,
            log: () => undefined,
        })).rejects.toThrow('texts')

        expect(fixture.calls.some((call) => call.path === '/v1/execute')).toBe(false)
    })
})

type RecordedCall = {
    method: string
    path: string
    authorization: string | undefined
    body: unknown
}

type FixtureServer = {
    server: Server
    calls: RecordedCall[]
    baseUrl: string
}
