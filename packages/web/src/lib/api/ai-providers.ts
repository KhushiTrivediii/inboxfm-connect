import {
  AIProviderModelType,
  AIProviderName,
} from '@inboxfm-connect/shared'
import type {
  AIProviderModel,
  AIProviderWithoutSensitiveData,
  CreateAIProviderRequest,
  UpdateAIProviderRequest,
} from '@inboxfm-connect/shared'
import { apiClient } from './client'

export { AIProviderModelType, AIProviderName }

const AI_PROVIDERS_PATH = '/ai-providers'

const aiProvidersApi = {
  list(): Promise<AIProviderWithoutSensitiveData[]> {
    return apiClient.get<AIProviderWithoutSensitiveData[]>(AI_PROVIDERS_PATH)
  },

  listModels(provider: AIProviderName): Promise<AIProviderModel[]> {
    return apiClient.get<AIProviderModel[]>(`${AI_PROVIDERS_PATH}/${encodeURIComponent(provider)}/models`)
  },

  create(request: CreateAIProviderRequest): Promise<void> {
    return apiClient.post<void>(AI_PROVIDERS_PATH, request)
  },

  update(id: string, request: UpdateAIProviderRequest): Promise<void> {
    return apiClient.post<void>(`${AI_PROVIDERS_PATH}/${encodeURIComponent(id)}`, request)
  },

  delete(id: string): Promise<void> {
    return apiClient.delete<void>(`${AI_PROVIDERS_PATH}/${encodeURIComponent(id)}`)
  },
}

export { aiProvidersApi }
