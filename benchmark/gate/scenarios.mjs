function resolve({ name, env }) {
    const factory = SCENARIOS[name]
    if (!factory) {
        throw new Error(`Unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`)
    }
    return factory(env)
}

function executeTextHelper(env) {
    const { baseUrl, apiKey, projectId } = requireEnv({ env, keys: ['BENCH_BASE_URL', 'BENCH_API_KEY', 'BENCH_PROJECT_ID'] })
    const connectionId = requireEnv({ env, keys: ['BENCH_CONNECTION_ID'] }).connectionId
    const body = JSON.stringify({
        projectId,
        integration: '@inboxfm-connect/piece-text-helper',
        tool: 'concat',
        connectionId,
        input: { texts: ['bench', 'ok'], separator: '-' },
    })
    return {
        name: 'execute-text-helper',
        target: new URL(baseUrl).host,
        buildRequest: () => ({
            url: `${trimSlash(baseUrl)}/v1/execute`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body,
        }),
        validate: ({ status, text }) => {
            if (status !== 200) {
                return `HTTP ${status}: ${text.slice(0, 200)}`
            }
            return parseJson(text) === 'bench-ok' ? null : `Unexpected execute output: ${text.slice(0, 200)}`
        },
    }
}

function connectionsList(env) {
    const { baseUrl, apiKey, projectId } = requireEnv({ env, keys: ['BENCH_BASE_URL', 'BENCH_API_KEY', 'BENCH_PROJECT_ID'] })
    const query = new URLSearchParams({ projectId, limit: '10' })
    return {
        name: 'connections-list',
        target: new URL(baseUrl).host,
        buildRequest: () => ({
            url: `${trimSlash(baseUrl)}/v1/connections?${query.toString()}`,
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        }),
        validate: ({ status, text }) => (status === 200 ? null : `HTTP ${status}: ${text.slice(0, 200)}`),
    }
}

function stub(env) {
    const { baseUrl } = requireEnv({ env, keys: ['BENCH_BASE_URL'] })
    return {
        name: 'stub',
        target: new URL(baseUrl).host,
        buildRequest: () => ({ url: `${trimSlash(baseUrl)}/`, method: 'GET', headers: {} }),
        validate: ({ status }) => (status === 200 ? null : `HTTP ${status}`),
    }
}

function requireEnv({ env, keys }) {
    const missing = keys.filter((key) => !env[key])
    if (missing.length > 0) {
        throw new Error(`Missing required environment: ${missing.join(', ')}`)
    }
    return Object.fromEntries(keys.map((key) => [ENV_TO_FIELD[key], env[key]]))
}

function parseJson(text) {
    try {
        return JSON.parse(text)
    }
    catch {
        return undefined
    }
}

function trimSlash(url) {
    return url.replace(/\/+$/, '')
}

const ENV_TO_FIELD = {
    BENCH_BASE_URL: 'baseUrl',
    BENCH_API_KEY: 'apiKey',
    BENCH_PROJECT_ID: 'projectId',
    BENCH_CONNECTION_ID: 'connectionId',
}

const SCENARIOS = {
    'execute-text-helper': executeTextHelper,
    'connections-list': connectionsList,
    stub,
}

export const benchScenarios = { resolve, names: Object.keys(SCENARIOS) }
