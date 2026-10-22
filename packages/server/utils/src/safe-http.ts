import http from 'node:http'
import https from 'node:https'
import { isNil } from '@inboxfm-connect/core-utils';
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios'
import axiosRetry from 'axios-retry'
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent'

export function parseAllowListFromEnv(): string[] {
    const raw = process.env['AP_SSRF_ALLOW_LIST']
    if (!raw) return []
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

function buildAgents({ allowList, httpAgentOptions, httpsAgentOptions }: BuildAgentsParams): SsrfAgents {
    const filteringOptions = {
        keepAlive: true,
        allowIPAddressList: allowList,
    }
    const pinnedSecurityOptions = {
        allowPrivateIPAddress: false,
        allowLoopbackIPAddress: false,
        allowMetaIPAddress: false,
    }
    return {
        httpAgent: new RequestFilteringHttpAgent({
            ...filteringOptions,
            ...httpAgentOptions,
            ...pinnedSecurityOptions,
        }),
        httpsAgent: new RequestFilteringHttpsAgent({
            ...filteringOptions,
            ...httpsAgentOptions,
            ...pinnedSecurityOptions,
        }),
    }
}

function isSsrfFilterError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    const message = typeof error.message === 'string' ? error.message : ''
    const cause = error.cause instanceof Error ? error.cause.message : ''
    return SSRF_FILTER_MESSAGE_REGEX.test(message) || SSRF_FILTER_MESSAGE_REGEX.test(cause)
}

function attachSsrfErrorInterceptor(instance: AxiosInstance): AxiosInstance {
    instance.interceptors.response.use(undefined, (error: unknown) => {
        if (isSsrfFilterError(error)) {
            const original = error instanceof Error ? error.message : String(error)
            const enriched = `${original} — ${SSRF_REMEDIATION_HINT}`
            if (error instanceof Error) error.message = enriched
        }
        return Promise.reject(error)
    })
    return instance
}

// Issue #371: axios's default is NO timeout, so any safeHttp caller that forgets
// an explicit timeout can hang its request handler indefinitely on a stalled
// upstream. Bound that here with a conservative default; an explicit caller
// value still wins because ...config spreads after it.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

function createAxios(config?: AxiosRequestConfig, { httpAgentOptions, httpsAgentOptions }: SafeAxiosOptions = {}): AxiosInstance {
    const { httpAgent, httpsAgent } = buildAgents({
        allowList: parseAllowListFromEnv(),
        httpAgentOptions,
        httpsAgentOptions,
    })
    return attachSsrfErrorInterceptor(axios.create({
        timeout: DEFAULT_REQUEST_TIMEOUT_MS,
        ...config,
        httpAgent,
        httpsAgent,
    }))
}

function createRetryingAxios(config?: AxiosRequestConfig, options?: SafeAxiosOptions): AxiosInstance {
    const instance = createAxios(config, options)
    axiosRetry(instance, {
        retries: 3,
        retryDelay: () => 2000,
        retryCondition: (error: AxiosError) =>
            !isNil(error.response?.status) && error.response.status >= 500 && error.response.status < 600,
    })
    return instance
}

let lazyDefaultAxios: AxiosInstance | undefined
let lazyRetryingAxios: AxiosInstance | undefined

const SSRF_FILTER_MESSAGE_REGEX = /(DNS lookup .* not allowed|IP .* is not allowed)/i
const SSRF_REMEDIATION_HINT = 'the target is blocked by the SSRF filter. If it is a trusted internal host (e.g. a self-hosted Vault, Conjur, or OAuth2 provider), add its IP or CIDR to the AP_SSRF_ALLOW_LIST environment variable (comma-separated) and restart the server.'

export const safeHttp = {
    buildAgents,
    createAxios,
    createRetryingAxios,
    get axios(): AxiosInstance {
        lazyDefaultAxios ??= createAxios()
        return lazyDefaultAxios
    },
    get retryingAxios(): AxiosInstance {
        lazyRetryingAxios ??= createRetryingAxios()
        return lazyRetryingAxios
    },
}

export type SsrfAgents = {
    httpAgent: http.Agent
    httpsAgent: https.Agent
}

export type SafeAxiosOptions = {
    httpAgentOptions?: http.AgentOptions
    httpsAgentOptions?: https.AgentOptions
}

type BuildAgentsParams = {
    allowList: string[]
    httpAgentOptions?: http.AgentOptions
    httpsAgentOptions?: https.AgentOptions
}
