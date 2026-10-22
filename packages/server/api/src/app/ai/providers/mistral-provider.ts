import { safeHttp } from '@inboxfm-connect/server-utils'
import { AIProviderModel, AIProviderModelType, MistralProviderAuthConfig, MistralProviderConfig } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'

export const mistralProvider: AIProviderStrategy<MistralProviderAuthConfig, MistralProviderConfig> = {
    name: 'Mistral AI',
    async validateConnection(authConfig: MistralProviderAuthConfig, config: MistralProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await mistralProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: MistralProviderAuthConfig, _config: MistralProviderConfig): Promise<AIProviderModel[]> {
        const client = safeHttp.createAxios()
        const res = await client.get<{ data: MistralModel[] }>('https://api.mistral.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${authConfig.apiKey}`,
                'Content-Type': 'application/json',
            },
        })

        const { data } = res.data

        return data
            .filter((model) => model.capabilities?.completion_chat)
            .map((model) => ({
                id: model.id,
                name: model.id,
                type: AIProviderModelType.TEXT,
            }))
    },
}

type MistralModel = {
    id: string
    capabilities?: {
        completion_chat: boolean
    }
}
