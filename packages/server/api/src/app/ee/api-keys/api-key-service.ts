import { ActivepiecesError, apId, ErrorCode, isNil, secureApId, SeekPage } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { ApiKey, ApiKeyResponseWithValue } from '@inboxfm-connect/shared'
import { ApiKeyEntity } from '../../api-keys/api-key.entity'
import { repoFactory } from '../../core/db/repo-factory'
import { transaction } from '../../core/db/transaction'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'

const API_KEY_TOKEN_LENGTH = 64
const DEFAULT_ROTATION_GRACE_PERIOD_SECONDS = 86400
const repo = repoFactory<ApiKey>(ApiKeyEntity)

// Lookup-by-value (used by authentication) lives in the non-ee apiKeyService at
// ../../api-keys/api-key.service — it must stay reachable from CE code.
export const apiKeyService = {
    async add({
        platformId,
        displayName,
        expiresAt,
    }: AddParams): Promise<ApiKeyResponseWithValue> {
        const generatedApiKey = generateApiKey()
        const savedApiKey = await repo().save({
            id: apId(),
            platformId,
            displayName,
            hashedValue: generatedApiKey.secretHashed,
            truncatedValue: generatedApiKey.secretTruncated,
            expiresAt: expiresAt ?? null,
        })
        return {
            ...savedApiKey,
            value: generatedApiKey.secret,
        }
    },
    async list({ platformId }: ListParams): Promise<SeekPage<ApiKey>> {
        const data = await repo().findBy({
            platformId,
        })

        return {
            data,
            next: null,
            previous: null,
        }
    },
    async delete({ platformId, id }: KeyIdentityParams): Promise<void> {
        await getOwnedKeyOrThrow({ platformId, id })
        await repo().delete({
            platformId,
            id,
        })
    },

    // Rotation is create-replacement-then-grace-period-revoke, not hard cutover: mint a
    // fresh key up front, then push the old key's expiry out to `now + grace period`
    // (never sooner than an expiry it already had) instead of deleting it, so callers
    // have a window to swap the new value in before the non-ee apiKeyService's expiry
    // check (../../api-keys/api-key.service.ts) starts rejecting the old one.
    // The replacement mint and the old key's grace-expiry update run in ONE
    // transaction: between the two statements the replacement's raw value exists
    // only in this call's memory (only its hash is stored), so a failure in between
    // would leave the old key keeping its original (possibly null = never-expiring)
    // expiry while the already-minted replacement is unusable — a key the operator
    // believes was rotated still authenticating forever.
    async rotate({ platformId, id }: KeyIdentityParams): Promise<ApiKeyResponseWithValue> {
        const oldApiKey = await getOwnedKeyOrThrow({ platformId, id })
        const gracePeriodSeconds = system.getNumber(AppSystemProp.API_KEY_ROTATION_GRACE_PERIOD_SECONDS) ?? DEFAULT_ROTATION_GRACE_PERIOD_SECONDS
        const graceExpiresAt = new Date(Date.now() + gracePeriodSeconds * 1000).toISOString()
        const nextExpiresAt = earlierExpiry(oldApiKey.expiresAt, graceExpiresAt)
        const generatedApiKey = generateApiKey()

        const savedApiKey = await transaction(async (entityManager) => {
            const newApiKey = await repo(entityManager).save({
                id: apId(),
                platformId: oldApiKey.platformId,
                displayName: oldApiKey.displayName,
                hashedValue: generatedApiKey.secretHashed,
                truncatedValue: generatedApiKey.secretTruncated,
                expiresAt: null,
            })
            await repo(entityManager).update(oldApiKey.id, {
                expiresAt: nextExpiresAt,
            })
            return newApiKey
        })

        return {
            ...savedApiKey,
            value: generatedApiKey.secret,
        }
    },
}

async function getOwnedKeyOrThrow({ platformId, id }: KeyIdentityParams): Promise<ApiKey> {
    const apiKey = await repo().findOneBy({
        platformId,
        id,
    })
    if (isNil(apiKey)) {
        throw new ActivepiecesError({
            code: ErrorCode.ENTITY_NOT_FOUND,
            params: {
                message: `api key with id ${id} not found`,
            },
        })
    }
    return apiKey
}

function earlierExpiry(current: string | null | undefined, candidate: string): string {
    if (isNil(current)) {
        return candidate
    }
    return new Date(current).getTime() < new Date(candidate).getTime() ? current : candidate
}

export function generateApiKey() {
    const secretValue = secureApId(API_KEY_TOKEN_LENGTH - 3)
    const secretKey = `sk-${secretValue}`
    return {
        secret: secretKey,
        secretHashed: cryptoUtils.hashSHA256(secretKey),
        secretTruncated: secretKey.slice(-4),
    }
}

type AddParams = {
    platformId: string
    displayName: string
    expiresAt?: string
}

type KeyIdentityParams = {
    id: string
    platformId: string
}

type ListParams = {
    platformId?: string
}
