import { safeHttp } from '@inboxfm-connect/server-utils'
import { AIProviderModel, AIProviderModelType, AnthropicProviderAuthConfig, AnthropicProviderConfig } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'

export const anthropicProvider: AIProviderStrategy<AnthropicProviderAuthConfig, AnthropicProviderConfig> = {
    name: 'Anthropic',
    async validateConnection(authConfig: AnthropicProviderAuthConfig, config: AnthropicProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await anthropicProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: AnthropicProviderAuthConfig, _config: AnthropicProviderConfig): Promise<AIProviderModel[]> {
        const client = safeHttp.createAxios()
        const res = await client.get<{ data: AnthropicModel[] }>('https://api.anthropic.com/v1/models', {
            headers: {
                'x-api-key': authConfig.apiKey,
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
            },
        })

        const { data } = res.data

        return data.map((model: AnthropicModel) => ({
            id: model.id,
            name: model.display_name,
            type: AIProviderModelType.TEXT,
        }))
    },
}

type AnthropicModel = {
    id: string
    display_name: string
}