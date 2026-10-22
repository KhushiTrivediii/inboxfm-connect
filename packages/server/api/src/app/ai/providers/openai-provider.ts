import { safeHttp } from '@inboxfm-connect/server-utils'
import { AIProviderModel, AIProviderModelType, OpenAIProviderAuthConfig, OpenAIProviderConfig } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'

export const openaiProvider: AIProviderStrategy<OpenAIProviderAuthConfig, OpenAIProviderConfig> = {
    name: 'OpenAI',
    async validateConnection(authConfig: OpenAIProviderAuthConfig, config: OpenAIProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await openaiProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: OpenAIProviderAuthConfig, _config: OpenAIProviderConfig): Promise<AIProviderModel[]> {
        const client = safeHttp.createAxios()
        const res = await client.get<{ data: OpenAIModel[] }>('https://api.openai.com/v1/models', {
            headers: {
                'Authorization': `Bearer ${authConfig.apiKey}`,
                'Content-Type': 'application/json',
            },
        })

        const { data } = res.data

        const openaiImageModels = [
            'gpt-image-1',
            'dall-e-3',
            'dall-e-2',
        ]

        return data.map((model: OpenAIModel) => ({
            id: model.id,
            name: model.id,
            type: openaiImageModels.includes(model.id) ? AIProviderModelType.IMAGE : AIProviderModelType.TEXT,
        }))
    },
}

type OpenAIModel = {
    id: string
}