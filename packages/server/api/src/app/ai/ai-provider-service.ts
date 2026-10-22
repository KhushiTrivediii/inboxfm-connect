import { ActivepiecesError, AIProviderName, apId, ErrorCode, isNil, PlatformId, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { cryptoUtils } from '@inboxfm-connect/server-utils'
import { ActivePiecesProviderAuthConfig, AIProviderAuthConfig, AIProviderConfig, AIProviderModel, AIProviderWithoutSensitiveData, AzureProviderConfig, BaseAIProviderAuthConfig, BedrockProviderAuthConfig, BedrockProviderConfig, CreateAIProviderRequest, GetProviderConfigResponse, UpdateAIProviderRequest } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import cron from 'node-cron'
import { repoFactory } from '../core/db/repo-factory'
import { distributedLock } from '../database/redis-connections'
import { flagService } from '../flags/flag.service'
import { encryptUtils } from '../helper/encryption'
import { AIProviderEntity, AIProviderSchema } from './ai-provider-entity'
import { aiProviders } from './providers'

const aiProviderRepo = repoFactory<AIProviderSchema>(AIProviderEntity)

const modelsCache = new Map<string, AIProviderModel[]>()

export const aiProviderService = (log: FastifyBaseLogger) => ({
    async setup(): Promise<void> {
        cron.schedule('0 0 * * *', () => {
            log.info('Clearing AI provider models cache')
            modelsCache.clear()
        })
    },

    async listProviders(platformId: PlatformId): Promise<AIProviderWithoutSensitiveData[]> {
        const activepiecesExists = await aiProviderRepo().existsBy({
            platformId,
            provider: AIProviderName.ACTIVEPIECES,
        })

        if (flagService(log).aiCreditsEnabled() && !activepiecesExists) {
            await runProvisionExclusiveOrWithoutLock({
                platformId,
                log,
                fn: async () => {
                    const activepiecesExists = await aiProviderRepo().existsBy({
                        platformId,
                        provider: AIProviderName.ACTIVEPIECES,
                    })
                    if (activepiecesExists) {
                        return
                    }
                    // Managed AI is the default chat provider so the chat page skips the "set up a
                    // provider" wall — but only when nothing else is already enabled for chat, so we never
                    // create a second chat provider or override an existing BYO choice (see update()).
                    const hasChatProvider = await aiProviderRepo().existsBy({ platformId, enabledForChat: true })
                    try {
                        await aiProviderRepo().save({
                            id: apId(),
                            auth: await encryptUtils.encryptObject({}),
                            config: {},
                            provider: AIProviderName.ACTIVEPIECES,
                            displayName: 'Inboxfm Connect',
                            platformId,
                            enabledForChat: !hasChatProvider,
                        })
                    }
                    catch (error) {
                        // Two concurrent first list calls both pass the outer
                        // existsBy check before either insert lands; the loser
                        // hits the (platformId, provider) unique index. That is
                        // a lost race, not a failure - the winner already
                        // created the row this call wanted to exist.
                        if (isUniqueConstraintViolation(error)) {
                            return
                        }
                        throw error
                    }
                },
            })
        }
        const configuredProviders = await aiProviderRepo().findBy({ platformId })

        return configuredProviders.map((p): AIProviderWithoutSensitiveData => ({
            id: p.id,
            name: p.displayName,
            provider: p.provider,
            config: p.config,
            enabledForChat: p.enabledForChat ?? false,
        }))
    },

    async listModels(platformId: PlatformId, provider: AIProviderName): Promise<AIProviderModel[]> {
        const { config, auth } = await this.getConfigOrThrow({ platformId, provider })

        const fingerprint = getAuthCacheFingerprint({ provider, auth, config })
        // Review spot-check (platform scoping): two platforms alternating on the
        // same provider each ran a supersession sweep that deleted the other
        // platform's entry - the cache never hit. platformId in the key scopes
        // the sweep per platform; rotation detection is unchanged because a
        // rotation on THIS platform produces a different fingerprint and the
        // old entry for THIS platformId still matches the sweep prefix.
        const cacheKey = `${platformId}-${provider}-${fingerprint}`
        if (modelsCache.has(cacheKey) && !('models' in config)) {
            return modelsCache.get(cacheKey)!
        }

        // Rotation cleanup (issue #402): a credential change means every other
        // cached entry for this platform + provider is superseded — drop it now
        // instead of letting retired fingerprints linger until the midnight sweep.
        for (const key of modelsCache.keys()) {
            if (key.startsWith(`${platformId}-${provider}-`) && key !== cacheKey) {
                modelsCache.delete(key)
            }
        }

        const data = await aiProviders[provider].listModels(auth, config)

        // CodeAnt finding on #403 (race): a concurrent request that started on an
        // older credential can finish after the rotation cleanup above ran and
        // re-insert its retired-fingerprint entry. Re-run the supersession sweep
        // after the await so the surviving entry set is exactly the current
        // credential generation - the last writer wins instead of accumulating
        // generations.
        for (const key of modelsCache.keys()) {
            if (key.startsWith(`${platformId}-${provider}-`) && key !== cacheKey) {
                modelsCache.delete(key)
            }
        }

        modelsCache.set(cacheKey, data.map(model => ({
            id: model.id,
            name: model.name,
            type: model.type,
        })))

        return modelsCache.get(cacheKey)!
    },

    async create(platformId: PlatformId, request: CreateAIProviderRequest): Promise<void> {
        await this.validateProviderCredentials(request.provider, request.auth, request.config)
        await aiProviderRepo().save({
            id: apId(),
            auth: await encryptUtils.encryptObject(request.auth),
            config: request.config,
            provider: request.provider,
            displayName: request.displayName,
            platformId,
        })
    },
    async update(platformId: PlatformId, providerId: string, request: UpdateAIProviderRequest): Promise<void> {
        const aiProvider = await aiProviderRepo().findOneBy({
            platformId,
            id: providerId,
        })
        if (isNil(aiProvider)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityId: providerId, entityType: 'AIProvider' },
            })
        }

        if (aiProvider.provider === AIProviderName.ACTIVEPIECES) {
            if (request.enabledForChat === true) {
                await runProvisionExclusiveOrWithoutLock({
                    platformId,
                    log,
                    fn: async () => {
                        await aiProviderRepo().manager.transaction(async (manager) => {
                            await manager.update(AIProviderEntity, { platformId }, { enabledForChat: false })
                            await manager.update(AIProviderEntity, providerId, { enabledForChat: true })
                        })
                    },
                })
            }
            return
        }

        const config = request.config ?? aiProvider.config
        if (!isNil(request.auth)) {
            await this.validateProviderCredentials(aiProvider.provider, request.auth, config)
        }
        else {
            const { auth } = await this.getConfigOrThrow({ platformId, provider: aiProvider.provider })
            await this.validateProviderCredentials(aiProvider.provider, auth, config)
        }

        const encryptedAuth = !isNil(request.auth) ? await encryptUtils.encryptObject(request.auth) : undefined
        const updates = {
            ...spreadIfDefined('auth', encryptedAuth),
            ...spreadIfDefined('config', request.config),
            ...spreadIfDefined('enabledForChat', request.enabledForChat),
            displayName: request.displayName,
        }

        if (request.enabledForChat === true) {
            await runProvisionExclusiveOrWithoutLock({
                platformId,
                log,
                fn: async () => {
                    await aiProviderRepo().manager.transaction(async (manager) => {
                        await manager.update(AIProviderEntity, { platformId }, { enabledForChat: false })
                        await manager.update(AIProviderEntity, providerId, updates)
                    })
                },
            })
        }
        else {
            await aiProviderRepo().update(providerId, updates)
        }
    },

    async delete(platformId: PlatformId, providerId: string): Promise<void> {
        await aiProviderRepo().delete({
            platformId,
            id: providerId,
        })
    },
    async validateProviderCredentials(provider: AIProviderName, auth: AIProviderAuthConfig, config: AIProviderConfig): Promise<void> {
        const providerStrategy = aiProviders[provider]
        try {
            await providerStrategy.validateConnection(auth, config, log)
        }
        catch (error: unknown) {
            log.error({ error }, '[aiProviderService#validateProviderCredentials] Failed to validate provider credentials')
            throw new ActivepiecesError({
                code: ErrorCode.INVALID_AI_PROVIDER_CREDENTIALS,
                params: {
                    provider,
                    message: `Failed to validate credentials for ${providerStrategy.name}`,
                },
            })
        }
    },
    async getConfigOrThrow({ platformId, provider }: GetOrCreateActivepiecesConfigResponse): Promise<GetProviderConfigResponse> {
        const aiProvider = await aiProviderRepo().findOneBy({
            platformId,
            provider,
        })
        if (isNil(aiProvider)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityId: provider,
                    entityType: 'AIProvider',
                },
            })
        }

        const auth = await encryptUtils.decryptObject<AIProviderAuthConfig>(aiProvider.auth)

        return { provider: aiProvider.provider, auth, config: aiProvider.config, platformId }
    },
    async getActivepiecesProviderIfEnriched(platformId: PlatformId): Promise<ActivePiecesProviderAuthConfig | null> {
        const aiProvider = await aiProviderRepo().findOneBy({
            platformId,
            provider: AIProviderName.ACTIVEPIECES,
        })
        if (isNil(aiProvider)) {
            return null
        }
        const doesHaveKeys = await doesActivepiecesProviderHasKeys(aiProvider)
        if (!doesHaveKeys) {
            return null
        }
        const { auth } = await this.getConfigOrThrow({ platformId, provider: aiProvider.provider })

        return auth as ActivePiecesProviderAuthConfig
    },

})


// The managed-AI auto-create inside listProviders is a find-then-create on the
// unique index (platformId, provider) that runs on a plain GET route. Two
// concurrent first list calls race the SELECT-then-INSERT gap and the loser
// surfaces a raw QueryFailedError (500) from a read endpoint. Serializing the
// whole check-then-insert on a per-platform key removes the race in-process
// and cross-process (Redis-backed lock); the fail-open path keeps the list
// working when the lock infrastructure itself is unavailable.
//
// The same lock also serializes the auto-create against update()'s
// enabledForChat assignment: the auto-create reads hasChatProvider and then
// inserts with enabledForChat when no chat provider exists, while update()
// flips every provider off and the chosen one on inside a transaction. Without
// a shared lock the two interleave and leave TWO providers enabled for chat,
// breaking the never-create-a-second-chat-provider invariant. update() takes
// this lock around ONLY its chat-assignment transaction - the credential
// validation (a slow upstream HTTP call) runs before the lock is acquired.
async function runProvisionExclusiveOrWithoutLock({ platformId, fn, log }: {
    platformId: PlatformId
    fn: () => Promise<void>
    log: FastifyBaseLogger
}): Promise<void> {
    const key = ['ai-provider', 'provision', platformId].join(':')
    let fnSettled = false
    try {
        await distributedLock(log).runExclusive({
            key,
            timeoutInSeconds: 60,
            fn: async () => {
                try {
                    await fn()
                }
                finally {
                    // Mark settled on EVERY exit path (throw AND success) so a
                    // lock-infra error after a successful fn cannot fail open and
                    // run fn a second time.
                    fnSettled = true
                }
            },
        })
    }
    catch (error) {
        if (fnSettled) {
            throw error
        }
        log.warn({ error, lockKey: key }, 'AI provider list auto-create lock unavailable - failing open')
        await fn()
    }
}

function isUniqueConstraintViolation(error: unknown): boolean {
    // Postgres unique-violation driver code (SQLSTATE 23505), gated on the driver
    // code the same way as the approved #460/#466/#470 helpers: the two drivers
    // pinned in this repo (pg 8.11.3, @electric-sql/pglite 0.3.14) do not always
    // surface the code on the same property, so match both the top-level error
    // and the wrapped driverError. Any other failure must propagate raw.
    const candidate = error as { code?: string, driverError?: { code?: string } } | null | undefined
    return candidate?.code === '23505' || candidate?.driverError?.code === '23505'
}

type GetOrCreateActivepiecesConfigResponse = {
    platformId: PlatformId
    provider: AIProviderName
}

async function doesActivepiecesProviderHasKeys(aiProvider: AIProviderSchema): Promise<boolean> {
    if (isNil(aiProvider) || isNil(aiProvider.auth)) {
        return false
    }
    const decryptedAuth = await encryptUtils.decryptObject<ActivePiecesProviderAuthConfig>(aiProvider.auth)
    return !isNil(decryptedAuth) && !isNil(decryptedAuth.apiKey) && decryptedAuth.apiKey !== ''
}

// Cache keys are fingerprints of the credential, never the credential itself
// (issue #402): the previous key format embedded the raw AWS secretAccessKey /
// provider API key as a Map string, keeping decrypted secrets resident in the
// heap until the midnight sweep — and every rotation left the retired key's
// entry behind with the raw secret still inside it. Hashing keeps rotation
// detection (new credential -> new fingerprint) without retaining secrets, and
// scoping by provider stops two providers sharing one API key from colliding
// into a single cache entry.
export function getAuthCacheFingerprint({ provider, auth, config }: { provider: AIProviderName, auth: AIProviderAuthConfig, config: AIProviderConfig }): string {
    switch (provider) {
        case AIProviderName.BEDROCK: {
            const { accessKeyId, secretAccessKey } = auth as BedrockProviderAuthConfig
            const { region } = config as BedrockProviderConfig
            return cryptoUtils.hashSHA256(`${provider}:${accessKeyId}:${secretAccessKey}:${region ?? ''}`)
        }
        case AIProviderName.AZURE: {
            // CodeAnt finding on #403: Azure deployments are addressed by resource
            // name + api version, not by the key alone. Two providers on the same
            // key against different resources (or api versions) must not share a
            // cache entry - the models come from different deployment sources.
            const { apiKey } = auth as BaseAIProviderAuthConfig
            const { resourceName, apiVersion } = config as AzureProviderConfig
            return cryptoUtils.hashSHA256(`${provider}:${apiKey ?? ''}:${resourceName ?? ''}:${apiVersion ?? ''}`)
        }
        default: {
            const { apiKey } = auth as BaseAIProviderAuthConfig
            return cryptoUtils.hashSHA256(`${provider}:${apiKey ?? ''}`)
        }
    }
}