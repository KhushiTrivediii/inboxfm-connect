import { ActivepiecesError, apId, ErrorCode, isNil, PlatformId, spreadIfDefined } from '@inboxfm-connect/core-utils'
import { AiToolAuthConfig, AiToolCapability, AiToolConfigWithoutSensitiveData, CreateAiToolConfigRequest, GetEnabledAiToolsResponse, ResolvedAiTool, UpdateAiToolConfigRequest } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../core/db/repo-factory'
import { encryptUtils } from '../helper/encryption'
import { AiToolConfigEntity, AiToolConfigSchema } from './ai-tool-config-entity'

const aiToolConfigRepo = repoFactory<AiToolConfigSchema>(AiToolConfigEntity)

export const aiToolConfigService = (_log: FastifyBaseLogger) => ({
    async list(platformId: PlatformId): Promise<AiToolConfigWithoutSensitiveData[]> {
        const configs = await aiToolConfigRepo().findBy({ platformId })
        return configs.map(toWithoutSensitiveData)
    },

    async upsert(platformId: PlatformId, request: CreateAiToolConfigRequest): Promise<void> {
        // The previous find-then-save had a first-configure race: two concurrent
        // POSTs for the same capability both read `existing = null` before either
        // insert lands, so both save a fresh row and the loser of the unique
        // index idx_ai_tool_config_platform_capability gets a raw driver error
        // (23505 on Postgres / its PGLite equivalent) surfaced as a 500 on a
        // platform-admin settings route. Building the upsert as a single
        // INSERT ... ON CONFLICT DO UPDATE makes the unique index itself
        // arbitrate: exactly one row is created, the loser converges into the
        // winner's row, and no column outside the conflict target (notably id)
        // is ever rewritten — same shape as the project-member and oauth-app
        // upserts.
        const encryptedAuth = await encryptUtils.encryptObject(request.auth)
        // `config` joins the DO UPDATE column set only when the request carries
        // one: the update() route treats an omitted config as "keep the stored
        // value" (spreadIfDefined), and the upsert must not disagree - otherwise
        // re-posting a capability just to flip `enabled` would silently erase the
        // stored provider config, since EXCLUDED.config is null for a request
        // that omitted it.
        const overwriteColumns = isNil(request.config)
            ? ['provider', 'auth', 'enabled']
            : ['provider', 'auth', 'config', 'enabled']
        await aiToolConfigRepo()
            .createQueryBuilder()
            .insert()
            .into(AiToolConfigEntity)
            .values({
                id: apId(),
                platformId,
                capability: request.capability,
                provider: request.provider,
                auth: encryptedAuth,
                // Nullable jsonb column: spreadIfDefined omits the key when
                // absent so the column falls back to its NULL default instead
                // of fighting the _QueryDeepPartialEntity union.
                ...spreadIfDefined('config', request.config),
                enabled: request.enabled ?? true,
            })
            .orUpdate(
                overwriteColumns,
                ['platformId', 'capability'],
            )
            .execute()
    },

    async update(platformId: PlatformId, id: string, request: UpdateAiToolConfigRequest): Promise<void> {
        const config = await aiToolConfigRepo().findOneBy({ platformId, id })
        if (isNil(config)) {
            throw new ActivepiecesError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityId: id, entityType: 'AiToolConfig' },
            })
        }
        const encryptedAuth = !isNil(request.auth) ? await encryptUtils.encryptObject(request.auth) : undefined
        await aiToolConfigRepo().update(id, {
            ...spreadIfDefined('provider', request.provider),
            ...spreadIfDefined('auth', encryptedAuth),
            ...spreadIfDefined('config', request.config),
            ...spreadIfDefined('enabled', request.enabled),
        })
    },

    async delete(platformId: PlatformId, id: string): Promise<void> {
        await aiToolConfigRepo().delete({ platformId, id })
    },

    async getEnabledTools({ platformId }: { platformId: PlatformId }): Promise<GetEnabledAiToolsResponse> {
        const configs = await aiToolConfigRepo().findBy({ platformId, enabled: true })
        const result: GetEnabledAiToolsResponse = {}
        for (const config of configs) {
            const resolved = await toResolvedTool(config)
            if (isNil(resolved)) {
                continue
            }
            switch (config.capability) {
                case AiToolCapability.WEB_SEARCH:
                    result.webSearch = resolved
                    break
                case AiToolCapability.WEB_SCRAPING:
                    result.webScraping = resolved
                    break
                case AiToolCapability.IMAGE_GENERATION:
                    result.imageGeneration = resolved
                    break
            }
        }
        return result
    },
})

function toWithoutSensitiveData(config: AiToolConfigSchema): AiToolConfigWithoutSensitiveData {
    return {
        id: config.id,
        capability: config.capability,
        provider: config.provider,
        config: config.config,
        enabled: config.enabled,
        hasApiKey: !isNil(config.auth),
    }
}

async function toResolvedTool(config: AiToolConfigSchema): Promise<ResolvedAiTool | null> {
    const auth = await encryptUtils.decryptObject<AiToolAuthConfig>(config.auth)
    if (isNil(auth?.apiKey) || auth.apiKey === '') {
        return null
    }
    return {
        provider: config.provider,
        apiKey: auth.apiKey,
        ...spreadIfDefined('config', config.config ?? undefined),
    }
}
