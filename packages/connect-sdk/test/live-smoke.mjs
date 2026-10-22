import assert from 'node:assert/strict'
import { InboxFM } from '@inboxfm-connect/sdk'

const baseUrl = process.env.CONNECT_SDK_SMOKE_BASE_URL
const apiKey = process.env.CONNECT_SDK_SMOKE_API_KEY
const projectId = process.env.CONNECT_SDK_SMOKE_PROJECT_ID
const connectionId = process.env.CONNECT_SDK_SMOKE_CONNECTION_ID
assert(baseUrl && apiKey && projectId && connectionId, 'Live SDK smoke requires base URL, API key, project ID, and Text Helper connection ID')

const client = new InboxFM({ baseUrl, apiKey, projectId })
const externalUserId = `sdk-smoke-${Date.now()}`
const session = await client.createConnectSession({ externalUserId, allowedPieceNames: ['@inboxfm-connect/piece-text-helper'] })
assert(session.token && session.connectUrl, 'Connect session response is incomplete')

const connections = await client.listConnections({ externalUserId })
assert(Array.isArray(connections.data), 'Connection list response is incomplete')

const tools = await client.listTools({ integration: '@inboxfm-connect/piece-text-helper' })
assert(tools.some((tool) => tool.name === 'concat'), 'Text Helper tool list does not include concat')

const execution = await client.execute({
    integration: '@inboxfm-connect/piece-text-helper',
    tool: 'concat',
    connectionId,
    input: { texts: ['smoke', 'ready'], separator: '-' },
})
assert.equal(execution, 'smoke-ready')
console.log('Packed SDK passed authenticated Connect session, connection list, tool list, and Text Helper execution against the configured server')
