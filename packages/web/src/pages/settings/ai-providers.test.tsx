import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsPage from './index'
import { apiClient } from '@/lib/api/client'
import { AuthProvider } from '@/lib/auth/auth-context'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { stubApi } from '@/test/api-stub'
import { testProject, testUser } from '@/test/fixtures/api-keys'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import type {
  CloudflareGatewayProviderConfig,
  CreateAIProviderRequest,
  OpenAICompatibleProviderConfig,
  UpdateAIProviderRequest,
} from '@inboxfm-connect/shared'
import { toast } from 'sonner'
import { AIProviderModelType, AIProviderName } from '@/lib/api/ai-providers'

const PROJECT = testProject()

function renderSettingsPage(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

const PROJECTS_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/projects' && method === 'GET'
const BILLING_INFO_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/platform-billing/info' && method === 'GET'
const AI_PROVIDERS_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/ai-providers' && method === 'GET'
const AI_PROVIDERS_CREATE_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/ai-providers' && method === 'POST'
const AI_PROVIDER_UPDATE_MATCH = (url: URL, method?: string) =>
  url.pathname.startsWith('/api/v1/ai-providers/') && !url.pathname.endsWith('/models') && method === 'POST'
const AI_PROVIDER_DELETE_MATCH = (url: URL, method?: string) =>
  url.pathname.startsWith('/api/v1/ai-providers/') && method === 'DELETE'
const AI_PROVIDER_MODELS_MATCH = (url: URL, method?: string) =>
  url.pathname.startsWith('/api/v1/ai-providers/') && url.pathname.endsWith('/models') && method === 'GET'

const defaultBilling = {
  stripeBillingEnabled: false,
  plan: { plan: 'community' },
  usage: {},
}

const sampleProviders = [
  {
    id: 'prov_openai',
    name: 'OpenAI Production',
    provider: AIProviderName.OPENAI,
    config: {},
    enabledForChat: true,
  },
  {
    id: 'prov_anthropic',
    name: 'Anthropic Claude',
    provider: AIProviderName.ANTHROPIC,
    config: {},
    enabledForChat: false,
  },
  {
    id: 'prov_managed',
    name: 'Activepieces',
    provider: AIProviderName.ACTIVEPIECES,
    config: {},
    enabledForChat: false,
  },
]

const sampleModels = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o Omnimodel',
    type: AIProviderModelType.TEXT,
  },
  {
    id: 'dall-e-3',
    name: 'DALL-E 3 Image Generation',
    type: AIProviderModelType.IMAGE,
  },
]

async function setInputValue(selector: string, value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(selector)
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
    input?.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function submitDialogForm(): Promise<void> {
  const form = document.body.querySelector('form')
  expect(form).not.toBeNull()
  await act(async () => {
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('AI Provider management in Settings page', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    apiClient.setToken('test-token')
    apiClient.setProjectId(PROJECT.id)
    sessionStorage.setItem('ap-user', JSON.stringify(testUser()))
    vi.restoreAllMocks()
  })

  it('renders configured AI providers list with status and chat default', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: sampleProviders }) },
    ])

    const container = renderSettingsPage()

    await waitFor(() => container.textContent?.includes('AI Providers') === true)
    await waitFor(() => container.textContent?.includes('OpenAI Production') === true)
    await waitFor(() => container.textContent?.includes('Anthropic Claude') === true)
    await waitFor(() => container.textContent?.includes('Activepieces') === true)

    // Check chat default label
    expect(container.textContent).toContain('Default')
    // Check status labels
    expect(container.textContent).toContain('Configured')
    expect(container.textContent).toContain('Managed')
  })

  it('renders empty state when no AI providers are configured', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: [] }) },
    ])

    const container = renderSettingsPage()

    await waitFor(() => container.textContent?.includes('No AI providers configured') === true)
    expect(container.textContent).toContain('Connect an API key from OpenAI')
  })

  it('allows adding a provider with masked input and submission', async () => {
    let createdPayload: CreateAIProviderRequest | null = null

    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      {
        match: AI_PROVIDERS_MATCH,
        respond: () => ({
          body: createdPayload
            ? [
                ...sampleProviders,
                {
                  id: 'prov_new',
                  name: createdPayload.displayName,
                  provider: createdPayload.provider,
                  config: createdPayload.config,
                  enabledForChat: false,
                },
              ]
            : sampleProviders,
        }),
      },
      {
        match: AI_PROVIDERS_CREATE_MATCH,
        respond: (_url, _init, body) => {
          createdPayload = body as CreateAIProviderRequest
          return { status: 201, body: {} }
        },
      },
    ])

    const container = renderSettingsPage()

    await waitFor(() => container.textContent?.includes('Add Provider') === true)

    // Click Add Provider button
    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Provider')
    )
    expect(addBtn).toBeDefined()

    await act(async () => {
      addBtn?.click()
    })

    // Dialog should open
    await waitFor(() => document.body.textContent?.includes('Configure AI Provider') === true)

    const keyInput = document.body.querySelector<HTMLInputElement>('#api-key-input')
    expect(keyInput).not.toBeNull()
    expect(keyInput?.type).toBe('password') // Input is masked by default

    // Toggle mask visibility
    const eyeBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="Show API key"]')
    expect(eyeBtn).not.toBeNull()

    await act(async () => {
      eyeBtn?.click()
    })
    expect(keyInput?.type).toBe('text') // Mask toggled off

    // Enter API key
    await setInputValue('#api-key-input', 'sk-test-key-12345')

    // Submit form
    await submitDialogForm()

    await waitFor(() => createdPayload !== null)
    const payload = createdPayload as unknown as CreateAIProviderRequest
    expect(payload.provider).toBe(AIProviderName.OPENAI)
    expect((payload.auth as { apiKey: string }).apiKey).toBe('sk-test-key-12345')
  })

  it('displays validation error banner inside dialog when API key validation fails', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: sampleProviders }) },
      {
        match: AI_PROVIDERS_CREATE_MATCH,
        respond: () => ({
          status: 400,
          body: {
            message: 'Failed to validate credentials for OpenAI: Incorrect API key provided',
          },
        }),
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Add Provider') === true)

    const addBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add Provider')
    )

    await act(async () => {
      addBtn?.click()
    })

    await waitFor(() => document.body.textContent?.includes('Configure AI Provider') === true)

    await setInputValue('#api-key-input', 'sk-invalid-key')
    await submitDialogForm()

    // Error banner should be rendered inside dialog
    await waitFor(
      () =>
        document.body.textContent?.includes(
          'Failed to validate credentials for OpenAI: Incorrect API key provided'
        ) === true
    )
    expect(document.body.textContent).toContain('Validation Failed')

    // Dialog must remain open so user can fix key
    expect(document.body.textContent).toContain('Configure AI Provider')
  })

  it('browses models via GET /:provider/models and filters them', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: sampleProviders }) },
      { match: AI_PROVIDER_MODELS_MATCH, respond: () => ({ body: sampleModels }) },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('OpenAI Production') === true)

    // Find and click the Models button on OpenAI row
    const modelsBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Browse models for OpenAI Production"]'
    )
    expect(modelsBtn).not.toBeNull()

    await act(async () => {
      modelsBtn?.click()
    })

    // Dialog should open and display models
    await waitFor(() => document.body.textContent?.includes('Available Models — OpenAI Production') === true)
    await waitFor(() => document.body.textContent?.includes('GPT-4o Omnimodel') === true)
    await waitFor(() => document.body.textContent?.includes('DALL-E 3 Image Generation') === true)

    // Filter models using search input
    await setInputValue('input[placeholder="Filter models by name or ID..."]', 'dall-e')

    await waitFor(() => document.body.textContent?.includes('1 of 2 models') === true)
    expect(document.body.textContent).toContain('DALL-E 3 Image Generation')
    expect(document.body.textContent).not.toContain('GPT-4o Omnimodel')
  })

  it('toggles enabledForChat for a provider', async () => {
    let updatePayload: UpdateAIProviderRequest | null = null

    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: sampleProviders }) },
      {
        match: AI_PROVIDER_UPDATE_MATCH,
        respond: (_url, _init, body) => {
          updatePayload = body as UpdateAIProviderRequest
          return { status: 200, body: {} }
        },
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Anthropic Claude') === true)

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle chat for Anthropic Claude"]'
    )
    expect(toggle).not.toBeNull()

    await act(async () => {
      toggle?.click()
    })

    await waitFor(() => updatePayload !== null)
    const payload = updatePayload as unknown as UpdateAIProviderRequest
    expect(payload.displayName).toBe('Anthropic Claude')
    expect(payload.enabledForChat).toBe(true)
  })

  it('allows removing an AI provider with confirm dialog', async () => {
    let deletedId: string | null = null

    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: sampleProviders }) },
      {
        match: AI_PROVIDER_DELETE_MATCH,
        respond: (url) => {
          const parts = url.pathname.split('/')
          deletedId = parts[parts.length - 1]
          return { status: 204, body: {} }
        },
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Anthropic Claude') === true)

    // Managed Activepieces provider should NOT have a delete button
    const managedRow = Array.from(container.querySelectorAll('tr')).find((tr) =>
      tr.textContent?.includes('Activepieces')
    )
    expect(managedRow?.querySelector('button[aria-label="Delete Activepieces"]')).toBeNull()

    // Non-managed provider should have a delete button
    const deleteBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Anthropic Claude"]'
    )
    expect(deleteBtn).not.toBeNull()

    await act(async () => {
      deleteBtn?.click()
    })

    // Confirmation dialog opens
    await waitFor(() => document.body.textContent?.includes('Remove AI Provider') === true)
    expect(document.body.textContent).toContain('Are you sure you want to remove Anthropic Claude?')

    const confirmBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === 'Remove'
    )
    expect(confirmBtn).toBeDefined()

    await act(async () => {
      confirmBtn?.click()
    })

    await waitFor(() => deletedId === 'prov_anthropic')
  })

  it('disables chat toggle for platform-managed Activepieces provider', async () => {
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: sampleProviders }) },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Activepieces') === true)

    const managedToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle chat for Activepieces"]'
    )
    expect(managedToggle).not.toBeNull()
    expect(managedToggle?.hasAttribute('disabled')).toBe(true)
    expect(managedToggle?.getAttribute('title')).toBe('Platform-managed provider cannot be disabled')
  })

  it('preserves existing custom models and defaultHeaders when editing a custom provider', async () => {
    let updatePayload: UpdateAIProviderRequest | null = null
    const customProvider = {
      id: 'prov_custom',
      name: 'Local Ollama',
      provider: AIProviderName.CUSTOM,
      config: {
        baseUrl: 'https://ollama.local/v1',
        apiKeyHeader: 'Authorization',
        models: [{ modelId: 'llama3', modelName: 'Llama 3', modelType: AIProviderModelType.TEXT }],
        defaultHeaders: { 'X-Custom-Header': 'custom-val' },
      },
      enabledForChat: false,
    }

    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: [customProvider] }) },
      {
        match: AI_PROVIDER_UPDATE_MATCH,
        respond: (_url, _init, body) => {
          updatePayload = body as UpdateAIProviderRequest
          return { status: 200, body: {} }
        },
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Local Ollama') === true)

    const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Local Ollama"]')
    expect(editBtn).not.toBeNull()

    await act(async () => {
      editBtn?.click()
    })

    await waitFor(() => document.body.textContent?.includes('Edit AI Provider — Local Ollama') === true)

    await setInputValue('input[placeholder="e.g. OpenAI Production"]', 'Local Ollama Renamed')

    const saveBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === 'Save Changes'
    )
    expect(saveBtn).toBeDefined()

    await act(async () => {
      saveBtn?.click()
    })

    await waitFor(() => updatePayload !== null)
    const payload = updatePayload as unknown as UpdateAIProviderRequest
    expect(payload.displayName).toBe('Local Ollama Renamed')
    expect(payload.auth).toBeUndefined()
    const config = payload.config as OpenAICompatibleProviderConfig
    expect(config.baseUrl).toBe('https://ollama.local/v1')
    expect(config.models).toEqual([
      { modelId: 'llama3', modelName: 'Llama 3', modelType: AIProviderModelType.TEXT },
    ])
    expect(config.defaultHeaders).toEqual({ 'X-Custom-Header': 'custom-val' })
  })

  it('validates Bedrock partial credentials and requires both or none on edit', async () => {
    const bedrockProvider = {
      id: 'prov_bedrock',
      name: 'AWS Bedrock Production',
      provider: AIProviderName.BEDROCK,
      config: { region: 'us-east-1' },
      enabledForChat: false,
    }

    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: [bedrockProvider] }) },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('AWS Bedrock Production') === true)

    const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Edit AWS Bedrock Production"]')
    expect(editBtn).not.toBeNull()

    await act(async () => {
      editBtn?.click()
    })

    await waitFor(() => document.body.textContent?.includes('Edit AI Provider — AWS Bedrock Production') === true)

    // Enter only access key, leaving secret key empty
    await setInputValue('#bedrock-access-key', 'AKIA12345EXAMPLE')

    const saveBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === 'Save Changes'
    )
    expect(saveBtn).toBeDefined()

    await act(async () => {
      saveBtn?.click()
    })

    await waitFor(() =>
      document.body.textContent?.includes('Both Access Key ID and Secret Access Key must be provided') === true
    )
    expect(document.body.textContent).toContain('Both Access Key ID and Secret Access Key must be provided')
  })

  it('preserves existing models, vertexProject, and vertexRegion when editing Cloudflare Gateway provider', async () => {
    let updatePayload: UpdateAIProviderRequest | null = null
    const cfProvider = {
      id: 'prov_cf',
      name: 'Edge Gateway',
      provider: AIProviderName.CLOUDFLARE_GATEWAY,
      config: {
        accountId: 'acc-12345',
        gatewayId: 'gw-67890',
        models: [{ modelId: 'llama-3-8b', modelName: 'Llama 3 8B', modelType: AIProviderModelType.TEXT }],
        vertexProject: 'my-gcp-project',
        vertexRegion: 'us-central1',
      },
      enabledForChat: false,
    }

    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: [cfProvider] }) },
      {
        match: AI_PROVIDER_UPDATE_MATCH,
        respond: (_url, _init, body) => {
          updatePayload = body as UpdateAIProviderRequest
          return { status: 200, body: {} }
        },
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Edge Gateway') === true)

    const editBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Edit Edge Gateway"]')
    expect(editBtn).not.toBeNull()

    await act(async () => {
      editBtn?.click()
    })

    await waitFor(() => document.body.textContent?.includes('Edit AI Provider — Edge Gateway') === true)

    await setInputValue('input[placeholder="e.g. OpenAI Production"]', 'Edge Gateway Renamed')

    const saveBtn = Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.trim() === 'Save Changes'
    )
    expect(saveBtn).toBeDefined()

    await act(async () => {
      saveBtn?.click()
    })

    await waitFor(() => updatePayload !== null)
    const payload = updatePayload as unknown as UpdateAIProviderRequest
    expect(payload.displayName).toBe('Edge Gateway Renamed')
    const config = payload.config as CloudflareGatewayProviderConfig
    expect(config.accountId).toBe('acc-12345')
    expect(config.gatewayId).toBe('gw-67890')
    expect(config.models).toEqual([
      { modelId: 'llama-3-8b', modelName: 'Llama 3 8B', modelType: AIProviderModelType.TEXT },
    ])
    expect(config.vertexProject).toBe('my-gcp-project')
    expect(config.vertexRegion).toBe('us-central1')
  })

  it('displays error toast when chat default toggle fails', async () => {
    const toastErrorSpy = vi.spyOn(toast, 'error')
    stubApi([
      { match: PROJECTS_MATCH, respond: () => ({ body: { data: [PROJECT] } }) },
      { match: BILLING_INFO_MATCH, respond: () => ({ body: defaultBilling }) },
      { match: AI_PROVIDERS_MATCH, respond: () => ({ body: sampleProviders }) },
      {
        match: AI_PROVIDER_UPDATE_MATCH,
        respond: () => ({ status: 500, body: { message: 'Database connection failed' } }),
      },
    ])

    const container = renderSettingsPage()
    await waitFor(() => container.textContent?.includes('Anthropic Claude') === true)

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle chat for Anthropic Claude"]'
    )
    expect(toggle).not.toBeNull()

    await act(async () => {
      toggle?.click()
    })

    await waitFor(() => toastErrorSpy.mock.calls.length > 0)
    expect(toastErrorSpy).toHaveBeenCalledWith(
      'Failed to update chat provider setting',
      expect.objectContaining({
        description: expect.any(String),
      })
    )
    toastErrorSpy.mockRestore()
  })
})
