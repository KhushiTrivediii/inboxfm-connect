import { ActivepiecesError, ErrorCode, isNil, PlatformId, ProjectId } from '@inboxfm-connect/core-utils'
import { PropertyType } from '@inboxfm-connect/pieces-framework'
import { AppConnection, AppConnectionStatus, AppConnectionType, AppConnectionValue, EngineResponseStatus, ExecuteRefreshTokenAuthResponse, WorkerJobType } from '@inboxfm-connect/shared'
import { isAxiosError } from 'axios'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { lru, LRU } from 'tiny-lru'
import { ArrayContains } from 'typeorm'
import { distributedLock } from '../../database/redis-connections'
import { encryptUtils } from '../../helper/encryption'
import { exceptionHandler } from '../../helper/exception-handler'
import { userInteractionWatcher } from '../../helper/user-interaction/user-interaction-watcher'
import { getPiecePackageWithoutArchive, pieceMetadataService } from '../../pieces/metadata/piece-metadata-service'
import { AppConnectionSchema } from '../app-connection.entity'
import { appConnectionsRepo } from './app-connection-service'
import { oauth2Handler } from './oauth2'
import { oauth2Util } from './oauth2/oauth2-util'

export const appConnectionHandler = (_log: FastifyBaseLogger) => ({

    async refresh(connection: AppConnection, projectId: ProjectId, log: FastifyBaseLogger): Promise<AppConnection> {
        switch (connection.value.type) {
            case AppConnectionType.PLATFORM_OAUTH2:
                connection.value = await oauth2Handler[connection.value.type](log).refresh({
                    pieceName: connection.pieceName,
                    platformId: connection.platformId,
                    projectId,
                    connectionValue: connection.value,
                })
                break
            case AppConnectionType.CLOUD_OAUTH2:
                connection.value = await oauth2Handler[connection.value.type](log).refresh({
                    pieceName: connection.pieceName,
                    platformId: connection.platformId,
                    projectId,
                    connectionValue: connection.value,
                })
                break
            case AppConnectionType.OAUTH2:
                connection.value = await oauth2Handler[connection.value.type](log).refresh({
                    pieceName: connection.pieceName,
                    platformId: connection.platformId,
                    projectId,
                    connectionValue: connection.value,
                })
                break
            case AppConnectionType.CUSTOM_AUTH: {
                const piece = await getPiecePackageWithoutArchive(log, connection.platformId, {
                    pieceName: connection.pieceName,
                    pieceVersion: connection.pieceVersion,
                })
                log.info({ pieceName: connection.pieceName, externalId: connection.externalId }, '[custom-auth-refresh] submitting token refresh job')
                let refreshResult: ExecuteRefreshTokenAuthResponse
                try {
                    refreshResult = await userInteractionWatcher.submitAndWaitForResponse<ExecuteRefreshTokenAuthResponse>({
                        piece,
                        projectId,
                        platformId: connection.platformId,
                        auth: connection.value,
                        jobType: WorkerJobType.EXECUTE_TOKEN_REFRESH,
                    }, log)
                }
                catch (err) {
                    if (err instanceof ActivepiecesError && err.error.code === ErrorCode.ENGINE_OPERATION_FAILURE && err.error.params.status === EngineResponseStatus.TIMEOUT) {
                        log.warn({ pieceName: connection.pieceName }, '[custom-auth-refresh] token refresh timed out — using existing credentials')
                        return connection
                    }
                    throw new CustomAuthRefreshError(`Custom auth token refresh failed: ${err instanceof Error ? err.message : 'unknown engine error'}`)
                }
                if (refreshResult.skipped) {
                    // Piece no longer has onRefreshToken (e.g. piece was updated) — clear
                    // the token so the next needRefresh call re-checks piece metadata.
                    log.info({ pieceName: connection.pieceName }, '[custom-auth-refresh] piece has no refresh callback — clearing stale token')
                    pieceRefreshSupportCache.set(pieceRefreshSupportCacheKey(connection), false)
                    connection.value = {
                        ...connection.value,
                        access_token: undefined,
                        token_refresh_at: undefined,
                    }
                }
                else {
                    log.info({ pieceName: connection.pieceName, expiresIn: refreshResult.expires_in }, '[custom-auth-refresh] token refreshed successfully')
                    connection.value = {
                        ...connection.value,
                        access_token: refreshResult.access_token,
                        token_refresh_at: computeTokenRefreshAt(refreshResult.expires_in),
                    }
                }
                break
            }
            default:
                break
        }
        return connection
    },

    /**
 * We should make sure this is accessed only once, as a race condition could occur where the token needs to be
 * refreshed and it gets accessed at the same time, which could result in the wrong request saving incorrect data.
 */
    async lockAndRefreshConnection({
        platformId,
        projectId,
        externalId,
        log,
    }: {
        platformId: PlatformId
        projectId: ProjectId
        externalId: string
        log: FastifyBaseLogger
    }) {

        return distributedLock(log).runExclusive({
            key: `${platformId}_${externalId}`,
            timeoutInSeconds: 60,
            fn: async () => {
                let appConnection: AppConnection | null = null

                try {
                    const encryptedAppConnection = await appConnectionsRepo().findOneBy({
                        projectIds: ArrayContains([projectId]),
                        externalId,
                    })
                    if (isNil(encryptedAppConnection)) {
                        return encryptedAppConnection
                    }
                    appConnection = await this.decryptConnection(encryptedAppConnection)
                    if (!await this.needRefresh(appConnection, log)) {
                        return appConnection
                    }
                    const refreshedAppConnection = await this.refresh(appConnection, projectId, log)
        
                    await appConnectionsRepo().update(refreshedAppConnection.id, {
                        status: AppConnectionStatus.ACTIVE,
                        value: await encryptUtils.encryptObject(refreshedAppConnection.value),
                    })
                    return refreshedAppConnection
                }
                catch (e) {
                    exceptionHandler.handle(e, log)
                    const isOAuth2Error = oauth2Util(log).isUserError(e)
                    const isCustomAuthError = e instanceof CustomAuthRefreshError
                    if (!isNil(appConnection) && (isOAuth2Error || isCustomAuthError)) {
                        appConnection.status = AppConnectionStatus.ERROR
                        await appConnectionsRepo().update(appConnection.id, {
                            status: appConnection.status,
                            updated: dayjs().toISOString(),
                        })
                    }
                }
                return appConnection
            },
        })
    },
    async decryptConnection(
        encryptedConnection: AppConnectionSchema,
    ): Promise<AppConnection> {
        const value = await encryptUtils.decryptObject<AppConnectionValue>(encryptedConnection.value)
        const connection: AppConnection = {
            ...encryptedConnection,
            value,
        }
        return connection
    },
    /**
     * Health check for POST /v1/app-connections/:id/test (issue #188). Unlike
     * lockAndRefreshConnection, which is best-effort and swallows refresh errors so
     * executions keep running, this reports an explicit verdict: it only claims a
     * connection is healthy when the credentials decrypt and a needed refresh actually
     * succeeded. The lock key matches lockAndRefreshConnection's, so a health check and
     * a concurrent execution-triggered refresh serialize instead of racing.
     */
    async lockAndTestConnection({
        platformId,
        projectId,
        externalId,
        log,
    }: {
        platformId: PlatformId
        projectId: ProjectId
        externalId: string
        log: FastifyBaseLogger
    }): Promise<TestConnectionOutcome> {
        return distributedLock(log).runExclusive({
            key: `${platformId}_${externalId}`,
            timeoutInSeconds: 60,
            fn: async (): Promise<TestConnectionOutcome> => {
                const encryptedAppConnection = await appConnectionsRepo().findOneBy({
                    projectIds: ArrayContains([projectId]),
                    externalId,
                })
                if (isNil(encryptedAppConnection)) {
                    return {
                        ok: false,
                        markRowError: false,
                        message: 'The connection could not be found. Refresh the page and try again.',
                    }
                }

                let appConnection: AppConnection
                try {
                    appConnection = await this.decryptConnection(encryptedAppConnection)
                }
                catch (e) {
                    exceptionHandler.handle(e, log)
                    return {
                        ok: false,
                        markRowError: true,
                        message: 'The stored credentials could not be decrypted. Reconnect the app to fix this connection.',
                    }
                }

                // A health check is an explicit, user-triggered verification, so it must not
                // trust the stored ERROR short-circuit in needRefresh (which exists so flow
                // executions stop hammering a known-bad token). Overriding the status makes a
                // stale token on an ERROR row get a real refresh attempt — the connection can
                // still be revived — instead of rubber-stamping the previous verdict.
                let needsRefresh: boolean
                try {
                    needsRefresh = await this.needRefresh({ ...appConnection, status: AppConnectionStatus.ACTIVE }, log)
                }
                catch (e) {
                    exceptionHandler.handle(e, log)
                    return {
                        ok: false,
                        markRowError: false,
                        message: 'The app for this connection could not be loaded, so the check could not run. Verify the app is installed.',
                    }
                }

                if (!needsRefresh) {
                    if (appConnection.status === AppConnectionStatus.ACTIVE) {
                        // Nothing refreshable to verify (api keys, basic auth, valid oauth
                        // tokens) — the value decrypting is the check that ran.
                        return { ok: true, markRowError: false }
                    }
                    return {
                        ok: false,
                        markRowError: appConnection.status === AppConnectionStatus.ERROR,
                        message: appConnection.status === AppConnectionStatus.MISSING
                            ? 'The connection has no credentials yet. Connect the app first.'
                            : 'The connection failed a previous check and has nothing refreshable to verify. Reconnect the app.',
                    }
                }

                try {
                    const refreshedAppConnection = await this.refresh(appConnection, projectId, log)
                    await appConnectionsRepo().update(refreshedAppConnection.id, {
                        status: AppConnectionStatus.ACTIVE,
                        value: await encryptUtils.encryptObject(refreshedAppConnection.value),
                    })
                    return { ok: true, markRowError: false }
                }
                catch (e) {
                    exceptionHandler.handle(e, log)
                    const isDefiniteFailure = oauth2Util(log).isUserError(e) || e instanceof CustomAuthRefreshError
                    if (isDefiniteFailure) {
                        await appConnectionsRepo().update(appConnection.id, {
                            status: AppConnectionStatus.ERROR,
                            updated: dayjs().toISOString(),
                        })
                    }
                    return {
                        ok: false,
                        markRowError: isDefiniteFailure,
                        message: formatRefreshFailureMessage({ e, log }),
                    }
                }
            },
        })
    },
    async needRefresh(connection: AppConnection, log: FastifyBaseLogger): Promise<boolean> {
        if (connection.status === AppConnectionStatus.ERROR) {
            return false
        }
        switch (connection.value.type) {
            case AppConnectionType.PLATFORM_OAUTH2:
            case AppConnectionType.CLOUD_OAUTH2:
            case AppConnectionType.OAUTH2:
                return oauth2Util(log).isExpired(connection.value)
            case AppConnectionType.CUSTOM_AUTH: {
                // Once a token exists, check expiry without a metadata lookup.
                if (!isNil(connection.value.access_token)) {
                    return isCustomAuthTokenStale(connection.value)
                }
                // No token yet — only dispatch a refresh job if the piece implements onRefreshToken.
                // Cache the result per piece version to avoid a metadata round-trip on every execution.
                const cacheKey = pieceRefreshSupportCacheKey(connection)
                const cached = pieceRefreshSupportCache.get(cacheKey)
                if (!isNil(cached)) {
                    return cached
                }
                const pieceMetadata = await pieceMetadataService(log).getOrThrow({
                    name: connection.pieceName,
                    version: connection.pieceVersion,
                    platformId: connection.platformId,
                })
                const auth = Array.isArray(pieceMetadata.auth) ? pieceMetadata.auth[0] : pieceMetadata.auth
                const hasRefresh = auth?.type === PropertyType.CUSTOM_AUTH && !isNil(auth.refresh)
                pieceRefreshSupportCache.set(cacheKey, hasRefresh)
                return hasRefresh
            }
            default:
                return false
        }
    },
})


const TOKEN_REFRESH_BUFFER_SECONDS = 15 * 60
const pieceRefreshSupportCache: LRU<boolean> = lru(1000, 0)

export function isCustomAuthTokenStale(value: { access_token?: string, token_refresh_at?: number }): boolean {
    if (isNil(value.access_token)) return true
    if (isNil(value.token_refresh_at)) return false
    return dayjs().unix() >= value.token_refresh_at
}

// Returns the unix timestamp at which the token should be refreshed: 15 minutes
// before expiry, but never earlier than half the token's lifetime — otherwise a
// token whose TTL is shorter than the buffer would be considered stale the instant
// it is minted, refreshing on every fetch and defeating the cache. `expiresIn <= 0`
// means the token never expires, so it never needs refreshing.
export function computeTokenRefreshAt(expiresIn: number): number | undefined {
    if (expiresIn <= 0) {
        return undefined
    }
    const buffer = Math.min(TOKEN_REFRESH_BUFFER_SECONDS, Math.floor(expiresIn / 2))
    return dayjs().unix() + expiresIn - buffer
}

function pieceRefreshSupportCacheKey(connection: Pick<AppConnection, 'platformId' | 'pieceName' | 'pieceVersion'>): string {
    return `${connection.platformId}:${connection.pieceName}@${connection.pieceVersion}`
}

class CustomAuthRefreshError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CustomAuthRefreshError'
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

// Turns a refresh failure into one readable sentence for the health-check response.
// Provider responses are external input: only the short `error`/`error_description`
// strings are surfaced, never raw payloads.
function formatRefreshFailureMessage({ e, log }: { e: unknown, log: FastifyBaseLogger }): string {
    if (isAxiosError(e)) {
        const data: unknown = e.response?.data
        const providerError = isRecord(data) ? data : {}
        const error = typeof providerError.error === 'string' ? providerError.error : undefined
        const errorDescription = typeof providerError.error_description === 'string' ? providerError.error_description : undefined
        if (oauth2Util(log).isUserError(e)) {
            return `The app rejected the stored credentials${errorDescription ? `: ${errorDescription}` : ` (error: ${error})`}. Reconnect the app to fix this connection.`
        }
        return `The app could not be reached to verify the connection${error ? ` (error: ${error})` : ''}. Try again in a moment.`
    }
    if (e instanceof CustomAuthRefreshError) {
        return 'The app could not refresh the custom auth token. Reconnect the app to fix this connection.'
    }
    return 'The connection could not be verified. Try again in a moment.'
}

export type TestConnectionOutcome = {
    ok: boolean
    // Whether the row's `status` should be flipped to ERROR — only definite failures
    // (the app rejected the credentials); transient errors leave executions retrying.
    markRowError: boolean
    message?: string
}

