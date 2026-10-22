import type { Connection, InboxFM, Tool } from '@inboxfm-connect/sdk'

export async function runAgentCycle({ client, externalUserId, integration, tool, input, connectTimeoutMs, pollIntervalMs, log }: RunAgentCycleParams): Promise<AgentCycleResult> {
    const connection = await findOrWaitForConnection({ client, externalUserId, integration, connectTimeoutMs, pollIntervalMs, log })
    log(`Using connection ${connection.id} (${connection.displayName})`)

    const tools = await client.listTools({ integration })
    log(`${integration} exposes ${tools.length} tool(s): ${tools.map((candidate) => candidate.name).join(', ')}`)
    const selectedTool = tools.find((candidate) => candidate.name === tool)
    if (!selectedTool) {
        throw new Error(`Tool "${tool}" is not available on ${integration}`)
    }
    const missingInputs = findMissingRequiredInputs({ tool: selectedTool, input })
    if (missingInputs.length > 0) {
        throw new Error(`Tool "${tool}" requires input(s) that were not provided: ${missingInputs.join(', ')}`)
    }

    const output = await client.execute({ integration, tool, connectionId: connection.id, input })
    return { connection, tool: selectedTool, output }
}

async function findOrWaitForConnection({ client, externalUserId, integration, connectTimeoutMs, pollIntervalMs, log }: FindOrWaitForConnectionParams): Promise<Connection> {
    const existing = await findActiveConnection({ client, externalUserId, integration })
    if (existing) {
        return existing
    }

    // The end-user authorizes the integration in their own browser, so the backend only
    // hands out the URL and polls; it never sees the user's third-party credentials.
    const session = await client.createConnectSession({ externalUserId, allowedPieceNames: [integration] })
    log(`No ${integration} connection for ${externalUserId} yet. Open this link to connect it (expires ${session.expiresAt}):`)
    log(session.connectUrl)

    const deadline = Date.now() + connectTimeoutMs
    while (Date.now() < deadline) {
        await sleep({ ms: pollIntervalMs })
        const connection = await findActiveConnection({ client, externalUserId, integration })
        if (connection) {
            return connection
        }
    }
    throw new Error(`Timed out after ${connectTimeoutMs}ms waiting for ${externalUserId} to connect ${integration}`)
}

async function findActiveConnection({ client, externalUserId, integration }: { client: InboxFM, externalUserId: string, integration: string }): Promise<Connection | undefined> {
    const page = await client.listConnections({ externalUserId, pieceName: integration })
    return page.data.find((connection) => connection.status === 'ACTIVE')
}

function findMissingRequiredInputs({ tool, input }: { tool: Tool, input: Record<string, unknown> }): string[] {
    return tool.inputs
        .filter((toolInput) => toolInput.required && input[toolInput.name] === undefined)
        .map((toolInput) => toolInput.name)
}

function sleep({ ms }: { ms: number }): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

export type RunAgentCycleParams = {
    client: InboxFM
    externalUserId: string
    integration: string
    tool: string
    input: Record<string, unknown>
    connectTimeoutMs: number
    pollIntervalMs: number
    log: (line: string) => void
}

export type AgentCycleResult = {
    connection: Connection
    tool: Tool
    output: unknown
}

type FindOrWaitForConnectionParams = Pick<RunAgentCycleParams, 'client' | 'externalUserId' | 'integration' | 'connectTimeoutMs' | 'pollIntervalMs' | 'log'>
