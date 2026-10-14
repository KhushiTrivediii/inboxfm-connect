import { safeHttp } from '@inboxfm-connect/server-utils'
import { SecretManagerProviderId } from '@inboxfm-connect/shared'
import { AxiosInstance } from 'axios'
import { FastifyBaseLogger } from 'fastify'
import { SecretManagerProvider, throwConnectionError, throwGetSecretError } from './secret-manager-providers'

// TLS verification is ON by default: connections that do not opt out use the
// shared `safeHttp.retryingAxios` instance, whose HTTPS agent verifies the
// server certificate (Node's default, `rejectUnauthorized: true`) — the same
// posture as the hashicorp and onepassword providers. Only an explicit operator
// opt-in (`skipTlsVerification: true` on the saved connection config, intended
// for Conjur servers that present a self-signed certificate) selects an instance
// that relaxes certificate checks. The relaxed instance keeps the SSRF filter
// (private/loopback/metadata IPs stay blocked, see safe-http) and is created
// lazily, once, so every opted-out connection shares its keep-alive agents.
let tlsSkippingConjurAxios: AxiosInstance | undefined

function conjurAxios(skipTlsVerification: boolean): AxiosInstance {
    if (!skipTlsVerification) {
        return safeHttp.retryingAxios
    }
    tlsSkippingConjurAxios ??= safeHttp.createRetryingAxios(undefined, {
        httpsAgentOptions: { rejectUnauthorized: false },
    })
    return tlsSkippingConjurAxios
}

export const cyberarkConjurProvider = (log: FastifyBaseLogger): SecretManagerProvider<SecretManagerProviderId.CYBERARK> => ({
    checkConnection: async (config) => {
        const url = removeEndingSlash(config.url)
        const response = await conjurApi({
            url: `${url}/authn/${config.organizationAccountName}/${encodeURIComponent(config.loginId)}/authenticate`,
            method: 'POST',
            body: config.apiKey,
            skipTlsVerification: config.skipTlsVerification === true,
        }).catch((error) => {
            throwConnectionError({ error, provider: SecretManagerProviderId.CYBERARK, log })
        })
        const token = response.data
        if (!token) {
            throwConnectionError({ error: 'No token received', provider: SecretManagerProviderId.CYBERARK, log })
        }
        return Buffer.from(String(token).trim(), 'utf8').toString('base64')
    },
    connect: async (config) => {
        await cyberarkConjurProvider(log).checkConnection(config)
    },
    disconnect: async () => {
        return Promise.resolve()
    },
    getSecret: async (request, config) => {

        const token = await cyberarkConjurProvider(log).checkConnection(config) as string
        const url = removeEndingSlash(config.url)
        const response = await conjurApi({
            url: `${url}/secrets/${config.organizationAccountName}/variable/${encodeURIComponent(request.path)}`,
            token,
            method: 'GET',
            skipTlsVerification: config.skipTlsVerification === true,
        }).catch((error) => {
            throwGetSecretError({ error, path: request.path, provider: SecretManagerProviderId.CYBERARK, request, log })
        })
        const data = response.data

        if (!data) {
            throwGetSecretError({ error: 'No secret found at requested path', path: request.path, provider: SecretManagerProviderId.CYBERARK, request, log })
        }
        return data
    },
})

const removeEndingSlash = (path: string) => {
    return path.endsWith('/') ? path.slice(0, -1) : path
}

const conjurApi = async ({
    url,
    token,
    method,
    body,
    skipTlsVerification,
}: {
    url: string
    token?: string
    namespace?: string
    method: string
    body?: Record<string, unknown> | string
    skipTlsVerification?: boolean
}) => {
    return conjurAxios(skipTlsVerification ?? false).request({
        url,
        method,
        headers: {
            ...(token && { 'Authorization': `Token token="${token}"` }),
            ...(typeof body === 'string' && { 'Content-Type': 'text/plain' }),
        },
        data: body,
        responseType: typeof body === 'string' ? 'text' : 'json',
    })
}
