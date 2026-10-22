import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { InboxFM as EsmClient } from '@inboxfm-connect/sdk'

const require = createRequire(import.meta.url)
const { InboxFM: CjsClient } = require('@inboxfm-connect/sdk')
const seen = []
const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const chunks = []
    for await (const chunk of request) {
        chunks.push(chunk)
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    seen.push({ method: request.method, path: url.pathname, token: request.headers.authorization, projectId: body?.projectId ?? url.searchParams.get('projectId') })
    response.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/v1/connect-sessions') {
        response.statusCode = 201
        response.end(JSON.stringify({ token: 'session-token', connectUrl: 'https://example.com/connect/session-token', expiresAt: '2026-12-01T00:00:00Z' }))
    }
    else if (url.pathname === '/v1/connections') {
        response.end(JSON.stringify({ data: [], next: null, previous: null }))
    }
    else if (url.pathname === '/v1/integrations/smoke') {
        response.end(JSON.stringify({ actions: { run: { name: 'run', displayName: 'Run', description: 'Smoke tool', requireAuth: false, props: {} } } }))
    }
    else if (url.pathname === '/v1/execute') {
        response.end(JSON.stringify({ success: true }))
    }
    else {
        response.statusCode = 404
        response.end(JSON.stringify({ code: 'ENTITY_NOT_FOUND' }))
    }
})

try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address !== 'string')
    for (const Client of [EsmClient, CjsClient]) {
        const client = new Client({ apiKey: 'smoke-api-key', projectId: 'smoke-project', baseUrl: `http://127.0.0.1:${address.port}` })
        const session = await client.createConnectSession({ externalUserId: 'smoke-user' })
        assert.equal(session.token, 'session-token')
        const connections = await client.listConnections({ externalUserId: 'smoke-user' })
        assert.deepEqual(connections.data, [])
        const tools = await client.listTools({ integration: 'smoke' })
        assert.deepEqual(tools.map((tool) => tool.name), ['run'])
        const execution = await client.execute({ integration: 'smoke', tool: 'run', input: {} })
        assert.deepEqual(execution, { success: true })
    }
    assert.equal(seen.length, 8)
    assert(seen.every((request) => request.token === 'Bearer smoke-api-key'))
    assert(seen.filter((request) => request.path !== '/v1/integrations/smoke').every((request) => request.projectId === 'smoke-project'))
    console.log('Clean consumer ESM/CJS auth, session, list, tools, and execute smoke passed')
}
finally {
    server.close()
}
