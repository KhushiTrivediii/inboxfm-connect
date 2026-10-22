import { safeHttp } from '@inboxfm-connect/server-utils'
import { AIProviderModel, AIProviderModelType, OpenRouterProviderAuthConfig, OpenRouterProviderConfig } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'

export const openRouterProvider: AIProviderStrategy<OpenRouterProviderAuthConfig, OpenRouterProviderConfig> = {
    name: 'OpenRouter',
    async validateConnection(authConfig: OpenRouterProviderAuthConfig, _config: OpenRouterProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        const client = safeHttp.createAxios()
        await client.get('https://openrouter.ai/api/v1/auth/key', {
            headers: {
                'Authorization': `Bearer ${authConfig.apiKey}`,
                'Content-Type': 'application/json',
            },
        })
    },
    async listModels(_authConfig: OpenRouterProviderAuthConfig, _config: OpenRouterProviderConfig): Promise<AIProviderModel[]> {
        const client = safeHttp.createAxios()
        const res = await client.get<{ data: OpenRouterModel[] }>('https://openrouter.ai/api/v1/models', {
            headers: {
                'Content-Type': 'application/json',
            },
        })

        const { data } = res.data

        return data.map((model: OpenRouterModel) => ({
            id: model.id,
            name: model.name,
            type: model.architecture.output_modalities.includes('image') ? AIProviderModelType.IMAGE : AIProviderModelType.TEXT,
        }))
    },
}

type OpenRouterModel = {
    id: string
    name: string
    architecture: {
        output_modalities: string[]
    }
}