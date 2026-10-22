import { ActivepiecesError, apId, ErrorCode, isNil, secureApId } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { ConnectSession, ConnectSessionPublicInfo } from '@inboxfm-connect/shared'
import { In, LessThan } from 'typeorm'
import { repoFactory } from '../core/db/repo-factory'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { ConnectSessionEntity } from './connect-session.entity'

const CONNECT_SESSION_TOKEN_LENGTH = 64
const DEFAULT_EXPIRES_IN_SECONDS = 900
const MAX_SESSIONS_PER_CLEANUP_ITERATION = 5000
const MAX_SESSIONS_PER_CLEANUP_RUN = 100_000
const repo = repoFactory<ConnectSession>(ConnectSessionEntity)

export const connectSessionService = {
    async create({ projectId, externalUserId, allowedPieceNames, expiresInSeconds }: CreateParams): Promise<CreateResult> {
        const token = generateConnectSessionToken()
        const expiresAt = new Date(Date.now() + (expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000).toISOString()

        await repo().save({
            id: apId(),
            projectId,
            externalUserId,
            allowedPieceNames: allowedPieceNames ?? null,
            hashedToken: token.hashed,
            truncatedToken: token.truncated,
            expiresAt,
            consumedAt: null,
        })

        return {
            token: token.raw,
            expiresAt,
            connectUrl: buildConnectUrl(token.raw),
        }
    },

    async getPublicInfoOrThrow(token: string): Promise<ConnectSessionPublicInfo> {
        const session = await getActiveSessionOrThrow(token)
        return {
            projectId: session.projectId,
            externalUserId: session.externalUserId,
            allowedPieceNames: session.allowedPieceNames,
            expiresAt: session.expiresAt,
        }
    },

    // Only fetches + validates; does not burn the token. Used before a downstream
    // OAuth/secret exchange that might still fail, so a failed attempt can be retried
    // with the same session instead of forcing the end-user to restart the whole flow.
    async getActiveOrThrow(token: string): Promise<ConnectSession> {
        return getActiveSessionOrThrow(token)
    },

    // Atomically claims the session: the UPDATE only matches a row that is still
    // unconsumed and unexpired, so two concurrent redemptions of the same token
    // cannot both succeed — the loser sees no returned row and is rejected. The
    // predicates live in the WHERE clause itself, making the single-use guarantee
    // race-free even across replicas. RETURNING is used instead of the driver's
    // affected-rows count because the PGLite driver does not populate the latter.
    async consumeOrThrow(id: string): Promise<void> {
        const now = new Date().toISOString()
        const updateResult = await repo().createQueryBuilder()
            .update()
            .set({ consumedAt: now })
            .where('id = :id AND "consumedAt" IS NULL AND "expiresAt" > :now', { id, now })
            .returning('id')
            .execute()
        const returnedRows: unknown = updateResult.raw
        if (!Array.isArray(returnedRows) || returnedRows.length === 0) {
            throw new ActivepiecesError({
                code: ErrorCode.SESSION_EXPIRED,
                params: {
                    message: 'Connect session has already been used or expired',
                },
            })
        }
    },

    // Deletes sessions that expired before the given boundary — consumed or not,
    // an expired session's token no longer authorizes anything, so past the
    // retention boundary the row is dead weight. Idempotent and bounded per run;
    // called by the CONNECT_SESSION_CLEANUP system job. Returns rows removed.
    async deleteExpiredBefore({ boundaryIso, maxPerRun = MAX_SESSIONS_PER_CLEANUP_RUN }: DeleteExpiredBeforeParams): Promise<number> {
        let totalDeleted = 0
        let lastBatchSize = MAX_SESSIONS_PER_CLEANUP_ITERATION
        while (lastBatchSize === MAX_SESSIONS_PER_CLEANUP_ITERATION && totalDeleted < maxPerRun) {
            const expiredSessions = await repo().find({
                select: ['id'],
                where: {
                    expiresAt: LessThan(boundaryIso),
                },
                // Clamp the batch to the remaining budget so custom maxPerRun values
                // cannot overshoot between iteration boundaries.
                take: Math.min(MAX_SESSIONS_PER_CLEANUP_ITERATION, maxPerRun - totalDeleted),
            })
            if (expiredSessions.length === 0) {
                break
            }
            const deleteResult = await repo().delete({
                id: In(expiredSessions.map((session) => session.id)),
            })
            lastBatchSize = expiredSessions.length
            totalDeleted += deleteResult.affected ?? expiredSessions.length
        }
        return totalDeleted
    },
}

async function getActiveSessionOrThrow(token: string): Promise<ConnectSession> {
    const session = await repo().findOneBy({
        hashedToken: cryptoUtils.hashSHA256(token),
    })
    if (isNil(session)) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'connect_session',
                message: 'Connect session not found or already used',
            },
        })
    }
    if (!isNil(session.consumedAt)) {
        throw new ActivepiecesError({
            code: ErrorCode.SESSION_EXPIRED,
            params: {
                message: 'Connect session has already been used',
            },
        })
    }
    if (new Date(session.expiresAt).getTime() < Date.now()) {
        throw new ActivepiecesError({
            code: ErrorCode.SESSION_EXPIRED,
            params: {
                message: 'Connect session has expired',
            },
        })
    }
    return session
}

function generateConnectSessionToken(): { raw: string, hashed: string, truncated: string } {
    const raw = `cs-${secureApId(CONNECT_SESSION_TOKEN_LENGTH - 3)}`
    return {
        raw,
        hashed: cryptoUtils.hashSHA256(raw),
        truncated: raw.slice(-4),
    }
}

function buildConnectUrl(token: string): string {
    const frontendUrl = system.get(AppSystemProp.FRONTEND_URL) ?? 'http://localhost:3000'
    return `${frontendUrl}/connect/${token}`
}

type CreateParams = {
    projectId: string
    externalUserId: string
    allowedPieceNames?: string[]
    expiresInSeconds?: number
}

type CreateResult = {
    token: string
    connectUrl: string
    expiresAt: string
}

type DeleteExpiredBeforeParams = {
    boundaryIso: string
    maxPerRun?: number
}