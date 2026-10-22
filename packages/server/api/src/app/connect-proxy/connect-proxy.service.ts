import { ActivepiecesError, ErrorCode } from '@inboxfm-connect/core-utils'
import { safeHttp } from '@inboxfm-connect/server-utils'
import {
    ALLOWED_PROXY_PROVIDERS,
    AppConnectionStatus,
    BaseOAuth2ConnectionValue,
    ConnectProxyErrorCode,
    ConnectProxyRequest,
    ConnectProxyResponse,
    SecretTextConnectionValue,
} from '@inboxfm-connect/shared'
import { AxiosError, AxiosResponse } from 'axios'
import { FastifyBaseLogger } from 'fastify'
import { ArrayContains, In } from 'typeorm'
import { appConnectionService, appConnectionsRepo } from '../app-connection/app-connection-service/app-connection-service'

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'host',
    'authorization',
    'cookie',
    'set-cookie',
])

function sanitizeHeaders(headers: Record<string, unknown>): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, val] of Object.entries(headers)) {
        const lower = key.toLowerCase()
        if (!HOP_BY_HOP_HEADERS.has(lower) && typeof val === 'string') {
            result[lower] = val
        }
    }
    return result
}

function extractRateLimit(headers: Record<string, unknown>): ConnectProxyResponse['rateLimit'] {
    const getNum = (key: string): number | undefined => {
        const v = headers[key] ?? headers[key.toLowerCase()]
        if (typeof v === 'string') {
            const parsed = parseInt(v, 10)
            return isNaN(parsed) ? undefined : parsed
        }
        if (typeof v === 'number') return v
        return undefined
    }

    const limit = getNum('x-ratelimit-limit') ?? getNum('ratelimit-limit')
    const remaining = getNum('x-ratelimit-remaining') ?? getNum('ratelimit-remaining')
    const reset = getNum('x-ratelimit-reset') ?? getNum('ratelimit-reset')

    if (limit !== undefined || remaining !== undefined || reset !== undefined) {
        return { limit, remaining, reset }
    }
    return undefined
}

function redactSecrets(msg: string): string {
    return msg
        .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
        .replace(/(access_token|client_secret|api_key|secret|token)["']?\s*[:=]\s*["']?[^"'\s,]+/gi, '$1=[REDACTED]')
}

function getMatchingPieceNames(provider: string, providerConfig: (typeof ALLOWED_PROXY_PROVIDERS)[string]): string[] {
    const names = new Set<string>()
    const p = provider.toLowerCase()
    names.add(p)
    names.add(`piece-${p}`)
    names.add(`@inboxfm-connect/piece-${p}`)
    if (providerConfig.allowedPieceNames) {
        for (const piece of providerConfig.allowedPieceNames) {
            const pieceLower = piece.toLowerCase()
            names.add(pieceLower)
            names.add(`piece-${pieceLower}`)
            names.add(`@inboxfm-connect/piece-${pieceLower}`)
        }
    }
    return Array.from(names)
}

export const connectProxyService = (log: FastifyBaseLogger) => {
    return {
        async execute(request: ConnectProxyRequest): Promise<ConnectProxyResponse> {
            const providerConfig = ALLOWED_PROXY_PROVIDERS[request.provider.toLowerCase()]
            if (!providerConfig) {
                throw new ActivepiecesError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        code: ConnectProxyErrorCode.PROVIDER_NOT_SUPPORTED,
                        message: `Provider "${request.provider}" is not in the allowed Connect API proxy registry.`,
                    },
                })
            }

            // 1. Resolve and authenticate connection (scoped by provider pieceName to avoid selecting arbitrary connection)
            const allowedPieces = getMatchingPieceNames(request.provider, providerConfig)
            const connection = await appConnectionsRepo().findOneBy({
                ...(request.connectionId ? { id: request.connectionId } : { pieceName: In(allowedPieces) }),
                projectIds: ArrayContains([request.projectId]),
                externalId: request.externalUserId,
                status: AppConnectionStatus.ACTIVE,
            })

            if (!connection) {
                // Check if connection exists under another customer or project to reject with proper authorization denial
                if (request.connectionId) {
                    const anyConnection = await appConnectionsRepo().findOneBy({ id: request.connectionId })
                    if (anyConnection) {
                        if (!anyConnection.projectIds?.includes(request.projectId)) {
                            throw new ActivepiecesError({
                                code: ErrorCode.AUTHORIZATION,
                                params: {
                                    code: ConnectProxyErrorCode.CROSS_PROJECT_FORBIDDEN,
                                    message: `Connection "${request.connectionId}" does not belong to project "${request.projectId}".`,
                                },
                            })
                        }
                        if (anyConnection.externalId !== request.externalUserId) {
                            throw new ActivepiecesError({
                                code: ErrorCode.AUTHORIZATION,
                                params: {
                                    code: ConnectProxyErrorCode.CROSS_CUSTOMER_FORBIDDEN,
                                    message: `Connection "${request.connectionId}" does not belong to customer "${request.externalUserId}".`,
                                },
                            })
                        }
                    }
                }

                throw new ActivepiecesError({
                    code: ErrorCode.ENTITY_NOT_FOUND,
                    params: {
                        code: ConnectProxyErrorCode.CONNECTION_NOT_FOUND,
                        message: `No active connection found for provider "${request.provider}" and customer "${request.externalUserId}".`,
                    },
                })
            }

            // Verify provider match
            const normalizedPiece = connection.pieceName.toLowerCase().replace(/^@inboxfm-connect\/piece-/, '').replace(/^piece-/, '')
            const isMatch = allowedPieces.some(ap => ap.toLowerCase() === connection!.pieceName.toLowerCase() || ap.toLowerCase() === normalizedPiece)
            if (!isMatch) {
                throw new ActivepiecesError({
                    code: ErrorCode.AUTHORIZATION,
                    params: {
                        code: ConnectProxyErrorCode.PROVIDER_MISMATCH,
                        message: `Connection integration "${connection.pieceName}" does not match target proxy provider "${request.provider}".`,
                    },
                })
            }

            // 2. Decrypt and refresh credentials before URL resolution (subdomains may reside in decrypted OAuth values)
            const decryptedConnection = await appConnectionService(log).decryptAndRefreshConnection(
                connection,
                request.projectId,
                log,
            )

            let secretToken = ''
            if (decryptedConnection?.value) {
                const val = decryptedConnection.value
                if ('access_token' in val && typeof (val as BaseOAuth2ConnectionValue).access_token === 'string') {
                    secretToken = (val as BaseOAuth2ConnectionValue).access_token
                }
                else if ('secret_text' in val && typeof (val as SecretTextConnectionValue).secret_text === 'string') {
                    secretToken = (val as SecretTextConnectionValue).secret_text
                }
                else if ('key' in val && typeof (val as Record<string, unknown>).key === 'string') {
                    secretToken = (val as Record<string, unknown>).key as string
                }
            }

            if (!secretToken) {
                throw new ActivepiecesError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        code: ConnectProxyErrorCode.CONNECTION_NOT_FOUND,
                        message: `Failed to resolve access token for provider "${request.provider}".`,
                    },
                })
            }

            // 3. Validate path and build target URL (strictly reject schemes, backslashes, control characters, traversal)
            const rawPath = request.path
            const cleanPath = rawPath.trim()
            if (
                /[\x00-\x1F\x7F]/.test(rawPath) ||
                rawPath.includes('\\') ||
                cleanPath.startsWith('http://') ||
                cleanPath.startsWith('https://') ||
                cleanPath.startsWith('//') ||
                cleanPath.startsWith('\\') ||
                cleanPath.includes('/../') ||
                cleanPath.includes('/..\\') ||
                cleanPath.startsWith('../') ||
                cleanPath.endsWith('/..') ||
                cleanPath === '..'
            ) {
                throw new ActivepiecesError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        code: ConnectProxyErrorCode.INVALID_PATH,
                        message: 'Path must be relative and cannot contain URL schemes, backslashes, control characters, or directory traversal.',
                    },
                })
            }

            let baseUrl = providerConfig.baseUrl
            if (providerConfig.supportsSubdomain) {
                const decryptedValue = (decryptedConnection?.value as Record<string, unknown>) ?? {}
                const rawValue = (connection.value as Record<string, unknown>) ?? {}
                const subdomain = request.subdomain || decryptedValue['subdomain'] || rawValue['subdomain']
                if (!subdomain || (providerConfig.subdomainRegex && !providerConfig.subdomainRegex.test(String(subdomain)))) {
                    throw new ActivepiecesError({
                        code: ErrorCode.VALIDATION,
                        params: {
                            code: ConnectProxyErrorCode.INVALID_PATH,
                            message: `Provider "${request.provider}" requires a valid subdomain matching ${providerConfig.subdomainRegex}.`,
                        },
                    })
                }
                baseUrl = baseUrl.replace('{subdomain}', String(subdomain))
            }

            const expectedOrigin = new URL(baseUrl).origin
            const relativePath = cleanPath.startsWith('/') ? cleanPath.slice(1) : cleanPath
            const baseWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
            const targetUrl = new URL(relativePath, baseWithSlash)

            if (targetUrl.origin !== expectedOrigin) {
                throw new ActivepiecesError({
                    code: ErrorCode.VALIDATION,
                    params: {
                        code: ConnectProxyErrorCode.INVALID_PATH,
                        message: `Target origin "${targetUrl.origin}" does not match provider origin "${expectedOrigin}".`,
                    },
                })
            }

            // 4. Construct outbound request headers (caller cannot override authorization)
            const outboundHeaders: Record<string, string> = {}
            for (const [key, value] of Object.entries(providerConfig.defaultHeaders ?? {})) {
                if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
                    outboundHeaders[key] = value
                }
            }
            for (const [key, value] of Object.entries(request.headers ?? {})) {
                if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && typeof value === 'string') {
                    outboundHeaders[key] = value
                }
            }

            if (request.idempotencyKey) {
                outboundHeaders['Idempotency-Key'] = request.idempotencyKey
            }

            // Inject credentials
            const headerName = providerConfig.authHeaderName ?? 'Authorization'
            const headerPrefix = providerConfig.authHeaderPrefix ?? 'Bearer '
            outboundHeaders[headerName] = `${headerPrefix}${secretToken}`

            // 5. Execute with safeHttp (guarded against SSRF, loopback, and metadata endpoints)
            const client = safeHttp.createAxios({
                timeout: request.timeoutMs ?? 30000,
                maxContentLength: 10 * 1024 * 1024,
                maxBodyLength: 5 * 1024 * 1024,
                validateStatus: () => true, // Don't throw on 4xx/5xx so we forward status transparently
            })

            try {
                const response: AxiosResponse = await client.request({
                    url: targetUrl.toString(),
                    method: request.method,
                    params: request.query,
                    data: request.body,
                    headers: outboundHeaders,
                })

                return {
                    status: response.status,
                    statusText: response.statusText,
                    headers: sanitizeHeaders(response.headers as Record<string, unknown>),
                    data: response.data,
                    provider: request.provider,
                    rateLimit: extractRateLimit(response.headers as Record<string, unknown>),
                }
            }
            catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                log.warn({ error: redactSecrets(msg), provider: request.provider }, 'Connect proxy upstream call failed')

                if (msg.includes('SSRF') || msg.includes('not allowed') || msg.includes('private IP') || msg.includes('Loopback')) {
                    throw new ActivepiecesError({
                        code: ErrorCode.VALIDATION,
                        params: {
                            code: ConnectProxyErrorCode.SSRF_BLOCKED,
                            message: 'Target destination was blocked by the outbound security SSRF filter.',
                        },
                    })
                }

                if ((err as AxiosError).code === 'ECONNABORTED' || msg.includes('timeout')) {
                    throw new ActivepiecesError({
                        code: ErrorCode.VALIDATION,
                        params: {
                            code: ConnectProxyErrorCode.UPSTREAM_TIMEOUT,
                            message: `Request to provider "${request.provider}" timed out after ${request.timeoutMs ?? 30000}ms.`,
                        },
                    })
                }

                throw new ActivepiecesError({
                    code: ErrorCode.ENGINE_OPERATION_FAILURE,
                    params: {
                        code: ConnectProxyErrorCode.UPSTREAM_ERROR,
                        message: redactSecrets(msg),
                    },
                })
            }
        },
    }
}
