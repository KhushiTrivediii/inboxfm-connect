import { ActivepiecesError, apId, ErrorCode, isNil, secureApId } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { ConnectApiKey, ConnectApiKeyResponseWithValue } from '@inboxfm-connect/shared'
import { repoFactory } from '../core/db/repo-factory'
import { transaction } from '../core/db/transaction'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { ConnectApiKeyEntity } from './connect-api-key.entity'

export const CONNECT_API_KEY_PREFIX = 'cak-'
const CONNECT_API_KEY_TOKEN_LENGTH = 64
const DEFAULT_ROTATION_GRACE_PERIOD_SECONDS = 86400
const connectApiKeyRepo = repoFactory<ConnectApiKey>(ConnectApiKeyEntity)

export const connectApiKeyService = {
    async add({ platformId, projectId, displayName, expiresAt }: AddParams): Promise<ConnectApiKeyResponseWithValue> {
        const generated = generateConnectApiKey()
        const saved = await connectApiKeyRepo().save({
            id: apId(),
            platformId,
            projectId,
            displayName,
            hashedValue: generated.hashed,
            truncatedValue: generated.truncated,
            expiresAt: expiresAt ?? null,
        })
        return {
            ...saved,
            value: generated.raw,
        }
    },

    async getByValue(value: string): Promise<ConnectApiKey | null> {
        const key = await connectApiKeyRepo().findOneBy({
            hashedValue: cryptoUtils.hashSHA256(value),
        })
        if (isNil(key)) {
            return null
        }
        if (isExpired(key)) {
            return null
        }
        await connectApiKeyRepo().update(key.id, {
            lastUsedAt: new Date().toISOString(),
        })
        return key
    },

    async list({ projectId }: ListParams): Promise<{ data: ConnectApiKey[], next: null, previous: null }> {
        const data = await connectApiKeyRepo().findBy({ projectId })
        return { data, next: null, previous: null }
    },

    async delete({ projectId, id }: KeyIdentityParams): Promise<void> {
        const key = await getOwnedKeyOrThrow({ projectId, id })
        await connectApiKeyRepo().delete({ id: key.id })
    },

    // Rotation is create-replacement-then-grace-period-revoke, not hard cutover: mint a
    // fresh key up front, then push the old key's expiry out to `now + grace period`
    // (never sooner than an expiry it already had) instead of deleting it, so callers
    // have a window to swap the new value in before getByValue's expiry check (above)
    // starts rejecting the old one.
    //
    // The mint and the old key's grace-expiry update run in ONE transaction: if the
    // update failed or the process died between them, the old key would keep its
    // original (possibly null = never-expiring) expiresAt while the replacement's raw
    // value is already lost (only its hash is stored), leaving a revoked-by-intent key
    // that still authenticates forever and an orphan replacement nobody can use.
    async rotate({ projectId, id }: KeyIdentityParams): Promise<ConnectApiKeyResponseWithValue> {
        const oldKey = await getOwnedKeyOrThrow({ projectId, id })
        const gracePeriodSeconds = system.getNumber(AppSystemProp.API_KEY_ROTATION_GRACE_PERIOD_SECONDS) ?? DEFAULT_ROTATION_GRACE_PERIOD_SECONDS
        const graceExpiresAt = new Date(Date.now() + gracePeriodSeconds * 1000).toISOString()
        const nextExpiresAt = earlierExpiry(oldKey.expiresAt, graceExpiresAt)
        const generated = generateConnectApiKey()

        const saved = await transaction(async (entityManager) => {
            const newKey = await connectApiKeyRepo(entityManager).save({
                id: apId(),
                platformId: oldKey.platformId,
                projectId: oldKey.projectId,
                displayName: oldKey.displayName,
                hashedValue: generated.hashed,
                truncatedValue: generated.truncated,
                expiresAt: null,
            })
            await connectApiKeyRepo(entityManager).update(oldKey.id, {
                expiresAt: nextExpiresAt,
            })
            return newKey
        })

        return {
            ...saved,
            value: generated.raw,
        }
    },
}

async function getOwnedKeyOrThrow({ projectId, id }: KeyIdentityParams): Promise<ConnectApiKey> {
    const key = await connectApiKeyRepo().findOneBy({ projectId, id })
    if (isNil(key)) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                entityType: 'connect_api_key',
                message: `Connect API key with id ${id} not found`,
            },
        })
    }
    return key
}

function isExpired(key: ConnectApiKey): boolean {
    if (isNil(key.expiresAt)) {
        return false
    }
    return new Date(key.expiresAt).getTime() <= Date.now()
}

function earlierExpiry(current: string | null | undefined, candidate: string): string {
    if (isNil(current)) {
        return candidate
    }
    return new Date(current).getTime() < new Date(candidate).getTime() ? current : candidate
}

export function generateConnectApiKey(): { raw: string, hashed: string, truncated: string } {
    const raw = `${CONNECT_API_KEY_PREFIX}${secureApId(CONNECT_API_KEY_TOKEN_LENGTH - CONNECT_API_KEY_PREFIX.length)}`
    return {
        raw,
        hashed: cryptoUtils.hashSHA256(raw),
        truncated: raw.slice(-4),
    }
}

type AddParams = {
    platformId: string
    projectId: string
    displayName: string
    expiresAt?: string
}

type ListParams = {
    projectId: string
}

type KeyIdentityParams = {
    projectId: string
    id: string
}
