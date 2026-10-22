import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { isNil } from '@inboxfm-connect/core-utils'
import { safeHttp } from '@inboxfm-connect/server-utils'
import { AIProviderModel, AIProviderModelType, CloudflareGatewayProviderAuthConfig, CloudflareGatewayProviderConfig, splitCloudflareGatewayModelId } from '@inboxfm-connect/shared'
import { generateText } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { AIProviderStrategy } from './ai-provider'

export const cloudflareGatewayProvider: AIProviderStrategy<CloudflareGatewayProviderAuthConfig, CloudflareGatewayProviderConfig> = {
    name: 'Cloudflare Gateway',
    async validateConnection(authConfig: CloudflareGatewayProviderAuthConfig, config: CloudflareGatewayProviderConfig, log: FastifyBaseLogger): Promise<void> {

        const textModels = config.models.filter(m => m.modelType === AIProviderModelType.TEXT)
        const invalidModels: string[] = []
        for (const model of textModels) {
            try {
                const { provider: providerPrefix, model: actualModelId, publisher } = splitCloudflareGatewayModelId(model.modelId)
                if (providerPrefix === 'google-vertex-ai') {
                    if (isNil(config.vertexProject) || isNil(config.vertexRegion)) {
                        throw new Error('Google Vertex ai project and region are required for Google Vertex AI models')
                    }
                    if (isNil(publisher)) {
                        throw new Error('Google Vertex ai publisher is required for Google Vertex AI models')
                    }
                    const providerConstructor = createGoogleGenerativeAI({
                        apiKey: authConfig.apiKey,
                        baseURL: `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/google-vertex-ai/v1/projects/${config.vertexProject}/locations/${config.vertexRegion}/publishers/${publisher}/`,
                        headers: {
                            'cf-aig-authorization': `Bearer ${authConfig.apiKey}`,
                        },
                        fetch: createSafeFetch({
                            'cf-aig-authorization': `Bearer ${authConfig.apiKey}`,
                        }),
                    })
                    const aiModel = providerConstructor(actualModelId)
                    await generateText({
                        model: aiModel,
                        messages: [{ role: 'user', content: 'Hi, reply only with "ok"' }],
                        maxOutputTokens: 1,
                    })
                }
                else {
                    const client = safeHttp.createAxios()
                    await client.post(
                        `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/compat/chat/completions`,
                        {
                            model: model.modelId,
                            messages: [{ role: 'user', content: 'Hi, reply only with "ok"' }],
                        },
                        {
                            headers: {
                                'cf-aig-authorization': `Bearer ${authConfig.apiKey}`,
                                'Content-Type': 'application/json',
                            },
                        },
                    )
                }
            }
            catch (error: unknown) {
                log.error({ error }, '[cloudflareGatewayProvider#validateConnection] Failed to validate model')
                invalidModels.push(model.modelId)
            }
        }
               
        
       

        if (invalidModels.length > 0) {
            throw new Error(
                `These models have issues: ${invalidModels.join(', ')}, make sure the model id is correct and in the{provider_name}/{model_name} format, also check that the other inputs are correct.`,
            )
        }
    },
    async listModels(_: CloudflareGatewayProviderAuthConfig, config: CloudflareGatewayProviderConfig): Promise<AIProviderModel[]> {
        return config.models.map(m => ({
            id: m.modelId,
            name: m.modelName,
            type: m.modelType,
        }))
    },
}

export function createSafeFetch(extraHeaders?: Record<string, string>): typeof fetch {
    return async (input, init) => {
        let url: string
        let requestHeaders: HeadersInit | undefined
        if (typeof input === 'string') {
            url = input
        }
        else if (input instanceof URL) {
            url = input.toString()
        }
        else {
            url = input.url
            requestHeaders = input.headers
        }

        const client = safeHttp.createAxios()
        const response = await client.request<ArrayBuffer>({
            method: init?.method ?? 'GET',
            url,
            headers: {
                ...(extraHeaders ?? {}),
                ...normalizeHeaders(requestHeaders),
                ...normalizeHeaders(init?.headers),
            },
            data: init?.body,
            signal: init?.signal ?? undefined,
            timeout: 10000,
            maxContentLength: 10 * 1024 * 1024,
            maxBodyLength: 10 * 1024 * 1024,
            responseType: 'arraybuffer',
            validateStatus: () => true,
        })
        const headers = typeof response.headers?.toJSON === 'function'
            ? response.headers.toJSON()
            : (response.headers as Record<string, string>)
        return new Response(Buffer.from(response.data), {
            status: response.status,
            statusText: response.statusText,
            headers: headers as HeadersInit,
        })
    }
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
    if (!headers) {
        return {}
    }
    if (headers instanceof Headers) {
        const result: Record<string, string> = {}
        headers.forEach((value, key) => {
            result[key] = value
        })
        return result
    }
    if (Array.isArray(headers)) {
        return Object.fromEntries(headers)
    }
    return headers as Record<string, string>
}
