import { randomBytes } from 'crypto'
import { apId, isNil } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { McpOAuthToken } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../../core/db/repo-factory'
import { JwtAudience, jwtUtils } from '../../../helper/jwt-utils'
import { mcpOAuthPkce } from '../mcp-oauth.pkce'
import { McpOAuthTokenEntity } from './mcp-oauth-token.entity'

const repo = repoFactory(McpOAuthTokenEntity)

const ACCESS_TOKEN_TTL_15_MINUTES_SECONDS = 15 * 60
const REFRESH_TOKEN_TTL_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const INTERNAL_CHAT_CLIENT_ID = 'internal-chat'

function generateRefreshToken(): string {
    return randomBytes(48).toString('base64url')
}

function hashRefreshToken(token: string): string {
    return cryptoUtils.hashSHA256(token)
}

async function issueAccessToken(params: IssueAccessTokenParams): Promise<string> {
    const key = await jwtUtils.getJwtSecret()
    return jwtUtils.sign({
        payload: {
            sub: params.userId,
            projectId: params.projectId,
            platformId: params.platformId,
            clientId: params.clientId,
            scopes: params.scopes,
            type: 'mcp_oauth',
        },
        key,
        expiresInSeconds: ACCESS_TOKEN_TTL_15_MINUTES_SECONDS,
        audience: JwtAudience.MCP_OAUTH_ACCESS,
    })
}

export const mcpOAuthTokenService = {
    async exchangeCode(params: ExchangeCodeParams): Promise<TokenResponse> {
        const valid = mcpOAuthPkce.verify(params.codeVerifier, params.codeChallenge, params.codeChallengeMethod)
        if (!valid) {
            throw new OAuthTokenError('invalid_grant', 'PKCE verification failed')
        }

        const rawRefreshToken = generateRefreshToken()
        const hashedRefreshToken = hashRefreshToken(rawRefreshToken)

        const tokenId = apId()
        const tokenRecord: McpOAuthToken = {
            id: tokenId,
            refreshToken: hashedRefreshToken,
            previousRefreshToken: null,
            familyId: tokenId,
            clientId: params.clientId,
            userId: params.userId,
            projectId: params.projectId,
            platformId: params.platformId,
            scopes: params.scopes,
            expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_30_DAYS_MS).toISOString(),
            revoked: false,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
        }
        await repo().save(tokenRecord)

        const accessToken = await issueAccessToken({
            userId: params.userId,
            projectId: params.projectId,
            platformId: params.platformId,
            clientId: params.clientId,
            scopes: params.scopes,
        })

        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: ACCESS_TOKEN_TTL_15_MINUTES_SECONDS,
            refresh_token: rawRefreshToken,
        }
    },

    async refreshAccessToken(params: RefreshParams): Promise<TokenResponse> {
        const hashed = hashRefreshToken(params.refreshToken)

        // RFC 6819 s5.2.2.3 / OAuth 2.1: rotate the refresh token on every use.
        // The claim is a single conditional UPDATE so two concurrent refresh calls
        // with the same token cannot both win - the loser sees no returned row and
        // gets invalid_grant. Reuse of a rotated token must be rejected, which
        // limits an attacker's window to a single refresh cycle.
        const rawNewRefreshToken = generateRefreshToken()
        const now = new Date().toISOString()
        const claim = await repo().createQueryBuilder()
            .update()
            .set({ revoked: true, updated: now })
            .where('"refreshToken" = :hashed AND "revoked" = false AND "expiresAt" > :now', { hashed, now })
            .returning('*')
            .execute()

        const claimedRows = claim.raw as McpOAuthToken[]
        const record = Array.isArray(claimedRows) && claimedRows.length > 0 ? claimedRows[0] : null
        if (isNil(record)) {
            // Reuse detection (#332): a rotated token row keeps a pointer to the hash
            // it was rotated FROM, so a replay can be attributed to its lineage and the
            // whole family revoked — N generations deep (RFC 6819 s5.2.2.3). Without
            // this check a replay was rejected but indistinguishable from an unknown
            // token, and the family kept authenticating.
            //
            // Two deterministic replay signals, race-free (codeant findings on #350):
            //   a. a successor row already points back at this hash (rotation completed)
            //   b. this hash exists but its row is revoked (rotation committed — the
            //      successor may not be saved yet if we lost a concurrent refresh race,
            //      but the presented token being already-revoked proves replay)
            // Signal (b) closes the race gap: a concurrent loser previously classified
            // the replay as an ordinary rejection when the winner had revoked the row
            // but not yet inserted the successor, leaving the family usable.
            const [replayed, revokedOriginal] = await Promise.all([
                repo().findOneBy({ previousRefreshToken: hashed }),
                repo().findOneBy({ refreshToken: hashed, revoked: true }),
            ])
            if (!isNil(replayed) || !isNil(revokedOriginal)) {
                const familyId = replayed?.familyId ?? revokedOriginal?.familyId
                await repo().update({ familyId }, { revoked: true, updated: now })
                params.log?.warn({ clientId: params.clientId, tokenHash: hashed, familyId }, '[mcpOAuth] Refresh token replay detected - revoking the entire token family')
                throw new OAuthTokenError('invalid_grant', 'Invalid or expired refresh token')
            }
            // Either unknown/expired, or the row is simply absent — genuine rejection.
            params.log?.warn({ clientId: params.clientId, tokenHash: hashed }, '[mcpOAuth] Refresh token rejected: unknown or expired')
            throw new OAuthTokenError('invalid_grant', 'Invalid or expired refresh token')
        }
        if (record.clientId !== params.clientId) {
            // The token was claimed but presented by the wrong client - revoke the
            // rotated token so the legitimate owner is not stranded with a token the
            // attacker now shares, and reject (RFC 6819 s5.2.2.3).
            await repo().update({ id: record.id }, { revoked: true, updated: now })
            params.log?.warn({ clientId: params.clientId, tokenHash: hashed }, '[mcpOAuth] Refresh token presented by the wrong client - rotated token revoked')
            throw new OAuthTokenError('invalid_grant', 'Client mismatch')
        }

        // Persist the successor as a NEW row carrying the lineage: it points at the
        // hash it was rotated FROM and inherits the familyId of the first issue, so a
        // replay of ANY earlier generation resolves to this family (#332). Old rows
        // keep their refreshToken hash, giving N-deep reuse detection.
        const successor: McpOAuthToken = {
            id: apId(),
            refreshToken: hashRefreshToken(rawNewRefreshToken),
            previousRefreshToken: hashed,
            familyId: record.familyId,
            clientId: record.clientId,
            userId: record.userId,
            projectId: record.projectId,
            platformId: record.platformId,
            scopes: record.scopes,
            expiresAt: record.expiresAt,
            revoked: false,
            created: now,
            updated: now,
        }
        try {
            await repo().save(successor)
        }
        catch (err) {
            // Successor persist failed after the claim committed (codeant finding on
            // #350): the old token would stay revoked with no replacement, forcing
            // re-auth even though the request never completed. Best-effort restore:
            // un-revoke the claimed row so a retry can claim it again. If the restore
            // also fails we stay fail-closed (revoked, no successor) — the safe side.
            try {
                await repo().update({ id: record.id }, { revoked: false, updated: now })
            }
            catch (restoreErr) {
                params.log?.error({ err: restoreErr, tokenId: record.id }, '[mcpOAuth] Failed to restore revoked token after successor save failure - staying fail-closed')
            }
            throw err
        }

        // If signing below throws, the token is already consumed with no replacement
        // delivered - fail-closed, so the client must re-auth. Acceptable trade-off:
        // delivering a successor AFTER persisting it would risk double-issuance.
        const accessToken = await issueAccessToken({
            userId: record.userId,
            projectId: record.projectId,
            platformId: record.platformId,
            clientId: record.clientId,
            scopes: record.scopes ?? [],
        })

        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: ACCESS_TOKEN_TTL_15_MINUTES_SECONDS,
            refresh_token: rawNewRefreshToken,
        }
    },

    async verifyAccessToken(token: string): Promise<McpOAuthAccessTokenPayload> {
        const key = await jwtUtils.getJwtSecret()
        const payload = await jwtUtils.decodeAndVerify<McpOAuthAccessTokenPayload>({
            jwt: token,
            key,
            audience: JwtAudience.MCP_OAUTH_ACCESS,
        })
        if (payload.type !== 'mcp_oauth') {
            throw new OAuthTokenError('invalid_token', 'Not an MCP OAuth token')
        }
        return payload
    },

    async revokeRefreshToken(refreshToken: string, clientId: string | undefined): Promise<void> {
        const hashed = hashRefreshToken(refreshToken)
        const criteria = clientId
            ? { refreshToken: hashed, clientId }
            : { refreshToken: hashed }
        await repo().update(criteria, { revoked: true })
    },

    async issueInternalAccessToken({ userId, platformId, projectId }: { userId: string, platformId: string, projectId: string | null }): Promise<string> {
        return issueAccessToken({ userId, platformId, projectId, clientId: INTERNAL_CHAT_CLIENT_ID, scopes: ['mcp'] })
    },
}

export class OAuthTokenError extends Error {
    constructor(
        public readonly errorCode: string,
        public readonly errorDescription: string,
    ) {
        super(errorDescription)
    }
}

type IssueAccessTokenParams = {
    userId: string
    projectId: string | null
    platformId: string
    clientId: string
    scopes: string[]
}

type ExchangeCodeParams = {
    codeVerifier: string
    codeChallenge: string
    codeChallengeMethod: string
    clientId: string
    userId: string
    projectId: string | null
    platformId: string
    scopes: string[]
}

type RefreshParams = {
    refreshToken: string
    clientId: string
    log?: FastifyBaseLogger
}

type TokenResponse = {
    access_token: string
    token_type: string
    expires_in: number
    refresh_token?: string
}

export type McpOAuthAccessTokenPayload = {
    sub: string
    projectId: string | null
    platformId: string
    clientId: string
    scopes: string[]
    type: 'mcp_oauth'
    iat: number
    exp: number
}
