import { ConnectError, InboxFM } from '@inboxfm-connect/sdk'
import { runAgentCycle } from './agent-cycle'

async function main(): Promise<void> {
    const client = new InboxFM({
        baseUrl: requireEnv({ name: 'INBOXFM_BASE_URL' }),
        apiKey: requireEnv({ name: 'INBOXFM_API_KEY' }),
        projectId: requireEnv({ name: 'INBOXFM_PROJECT_ID' }),
    })

    const result = await runAgentCycle({
        client,
        externalUserId: process.env['INBOXFM_EXTERNAL_USER_ID'] ?? 'quickstart-user',
        integration: requireEnv({ name: 'INBOXFM_INTEGRATION' }),
        tool: requireEnv({ name: 'INBOXFM_TOOL' }),
        input: parseToolInput({ raw: process.env['INBOXFM_TOOL_INPUT'] ?? '{}' }),
        connectTimeoutMs: Number(process.env['INBOXFM_CONNECT_TIMEOUT_SECONDS'] ?? '300') * 1000,
        pollIntervalMs: 3_000,
        log: (line) => console.log(line),
    })

    console.log(`${result.tool.displayName} returned:`)
    console.log(JSON.stringify(result.output, null, 2))
}

function requireEnv({ name }: { name: string }): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(`Set ${name} before running the quickstart`)
    }
    return value
}

function parseToolInput({ raw }: { raw: string }): Record<string, unknown> {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('INBOXFM_TOOL_INPUT must be a JSON object')
    }
    return Object.fromEntries(Object.entries(parsed))
}

function describeFailure({ error }: { error: unknown }): string {
    if (!(error instanceof ConnectError)) {
        return error instanceof Error ? error.message : String(error)
    }
    const detail = `${error.message}${error.code ? ` [${error.code}]` : ''}`
    if (error.code === 'ENGINE_OPERATION_FAILURE') {
        return `The tool ran but failed: ${String(error.params?.['message'] ?? error.message)}`
    }
    switch (error.category) {
        case 'authentication':
            return `The API key was rejected or cannot access this project: ${detail}`
        case 'not_found':
            return `The integration, connection, or tool does not exist on this server: ${detail}`
        case 'validation':
            return `The server rejected the request payload: ${detail}`
        case 'rate_limit':
            return `Rate limited even after retries${error.retryAfterMs !== undefined ? `; retry in ${error.retryAfterMs}ms` : ''}: ${detail}`
        case 'network':
        case 'timeout':
            return `Could not reach ${process.env['INBOXFM_BASE_URL']}: ${detail}`
        case 'server':
            return `The server failed: ${detail}`
        default:
            return detail
    }
}

main().catch((error: unknown) => {
    console.error(describeFailure({ error }))
    process.exitCode = 1
})
