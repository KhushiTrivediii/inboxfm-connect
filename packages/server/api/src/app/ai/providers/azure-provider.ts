import { safeHttp } from '@inboxfm-connect/server-utils'
import { AIProviderModel, AIProviderModelType, AzureProviderAuthConfig, AzureProviderConfig, DEFAULT_AZURE_API_VERSION } from '@inboxfm-connect/shared'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'

export const azureProvider: AIProviderStrategy<AzureProviderAuthConfig, AzureProviderConfig> = {
    name: 'Azure OpenAI',
    async validateConnection(authConfig: AzureProviderAuthConfig, config: AzureProviderConfig, _log: FastifyBaseLogger): Promise<void> {
        await azureProvider.listModels(authConfig, config)
    },
    async listModels(authConfig: AzureProviderAuthConfig, config: AzureProviderConfig): Promise<AIProviderModel[]> {
        const endpoint = `https://${config.resourceName}.openai.azure.com`
        const apiKey = authConfig.apiKey
        const apiVersion = config.apiVersion ?? DEFAULT_AZURE_API_VERSION

        if (!endpoint || !apiKey) {
            return []
        }

        const client = safeHttp.createAxios()
        const res = await client.get<{ data: AzureModel[] }>(
            `${endpoint}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`,
            {
                headers: {
                    'api-key': apiKey,
                    'Content-Type': 'application/json',
                },
            },
        )

        const { data } = res.data

        return data.map((deployment: AzureModel) => ({
            id: deployment.name,
            name: deployment.name,
            type: AIProviderModelType.TEXT,
        }))
    },
}

type AzureModel = {
    name: string
}