import type { CreateAIProviderRequest } from '@inboxfm-connect/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { aiProvidersApi, AIProviderModelType, AIProviderName } from './ai-providers'
import { apiClient } from './client'

describe('aiProvidersApi', () => {
  beforeEach(() => {
    localStorage.clear()
    apiClient.setToken('test-token')
    apiClient.setProjectId('test-proj')
    vi.restoreAllMocks()
  })

  it('lists AI providers via GET /ai-providers', async () => {
    const mockProviders = [
      {
        id: 'prov_1',
        name: 'OpenAI',
        provider: AIProviderName.OPENAI,
        config: {},
        enabledForChat: true,
      },
    ]

    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValue(mockProviders)

    const result = await aiProvidersApi.list()
    expect(getSpy).toHaveBeenCalledWith('/ai-providers')
    expect(result).toEqual(mockProviders)
  })

  it('lists models for a provider via GET /ai-providers/:provider/models', async () => {
    const mockModels = [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        type: AIProviderModelType.TEXT,
      },
    ]

    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValue(mockModels)

    const result = await aiProvidersApi.listModels(AIProviderName.OPENAI)
    expect(getSpy).toHaveBeenCalledWith('/ai-providers/openai/models')
    expect(result).toEqual(mockModels)
  })

  it('creates an AI provider via POST /ai-providers', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValue(undefined)

    const req: CreateAIProviderRequest = {
      displayName: 'OpenAI Production',
      provider: AIProviderName.OPENAI,
      auth: { apiKey: 'sk-test' },
      config: {},
    }

    await aiProvidersApi.create(req)
    expect(postSpy).toHaveBeenCalledWith('/ai-providers', req)
  })

  it('updates an AI provider via POST /ai-providers/:id', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValue(undefined)

    const req = {
      displayName: 'OpenAI Updated',
      enabledForChat: true,
    }

    await aiProvidersApi.update('prov_1', req)
    expect(postSpy).toHaveBeenCalledWith('/ai-providers/prov_1', req)
  })

  it('deletes an AI provider via DELETE /ai-providers/:id', async () => {
    const deleteSpy = vi.spyOn(apiClient, 'delete').mockResolvedValue(undefined)

    await aiProvidersApi.delete('prov_1')
    expect(deleteSpy).toHaveBeenCalledWith('/ai-providers/prov_1')
  })
})
