import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ApiKeysPage from './index'
import { apiClient } from '@/lib/api/client'
import { User } from '@/lib/api/types'
import { AuthProvider } from '@/lib/auth/auth-context'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { StubRoute, stubApi } from '@/test/api-stub'
import {
  platformApiKey,
  platformApiKeyWithValue,
  platformWithPlan,
  projectApiKey,
  projectApiKeyWithValue,
  testProject,
  testUser,
} from '@/test/fixtures/api-keys'
import { seekPage } from '@/test/fixtures/integrations'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

const PROJECT = testProject()

function signIn({ user = testUser() }: { user?: User } = {}): void {
  apiClient.setToken('test-token')
  apiClient.setProjectId(PROJECT.id)
  sessionStorage.setItem('ap-user', JSON.stringify(user))
}

function renderApiKeysPage(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <MemoryRouter initialEntries={['/api-keys']}>
            <Routes>
              <Route path="/api-keys" element={<ApiKeysPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

const PROJECTS_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/projects' && method === 'GET'
const PROJECT_KEYS_LIST_MATCH = (url: URL, method?: string) =>
  url.pathname === '/api/v1/connect-api-keys' && method === 'GET'
const PROJECT_KEYS_CREATE_MATCH = (url: URL, method?: string) =>
  url.pathname === '/api/v1/connect-api-keys' && method === 'POST'
const PROJECT_KEY_DELETE_MATCH = (url: URL, method?: string) =>
  url.pathname.startsWith('/api/v1/connect-api-keys/') && method === 'DELETE'
const PLATFORM_MATCH = (url: URL, method?: string) =>
  url.pathname === `/api/v1/platforms/${PROJECT.platformId}` && method === 'GET'
const PLATFORM_KEYS_LIST_MATCH = (url: URL, method?: string) => url.pathname === '/api/v1/api-keys' && method === 'GET'
const PLATFORM_KEYS_CREATE_MATCH = (url: URL, method?: string) =>
  url.pathname === '/api/v1/api-keys' && method === 'POST'
const PLATFORM_KEY_DELETE_MATCH = (url: URL, method?: string) =>
  url.pathname.startsWith('/api/v1/api-keys/') && method === 'DELETE'

function baseRoutes({
  projectKeys = [],
  platformKeys = [],
  platformEnabled = true,
}: {
  projectKeys?: ReturnType<typeof projectApiKey>[]
  platformKeys?: ReturnType<typeof platformApiKey>[]
  platformEnabled?: boolean
} = {}): StubRoute[] {
  return [
    { match: PROJECTS_MATCH, respond: () => ({ status: 200, body: { data: [PROJECT] } }) },
    { match: PROJECT_KEYS_LIST_MATCH, respond: () => ({ status: 200, body: seekPage(projectKeys) }) },
    {
      match: PLATFORM_MATCH,
      respond: () => ({ status: 200, body: platformWithPlan({ plan: { apiKeysEnabled: platformEnabled } }) }),
    },
    { match: PLATFORM_KEYS_LIST_MATCH, respond: () => ({ status: 200, body: seekPage(platformKeys) }) },
  ]
}

async function clickButton(container: HTMLElement, ariaLabel: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`)
  expect(button).not.toBeNull()
  await act(async () => {
    button?.click()
  })
}

async function clickTextButton(label: string): Promise<void> {
  const dialog = document.body.querySelector('[role="dialog"]')
  const scope = dialog ?? document.body
  const button = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button).not.toBeUndefined()
  await act(async () => {
    button?.click()
  })
}

async function clickTab(label: string): Promise<void> {
  const dialog = document.body.querySelector('[role="dialog"]')
  const scope = dialog ?? document.body
  const tab = Array.from(scope.querySelectorAll('[role="tab"]')).find((candidate) =>
    candidate.textContent?.trim() === label
  )
  expect(tab).not.toBeUndefined()
  await act(async () => {
    tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  })
}

async function setNameInput(value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('#api-key-name')
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('API Keys page', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    apiClient.setToken(null)
    apiClient.setProjectId(null)
  })

  it('renders project API keys with masked value, created and last-used columns, and hides the platform section for a non-admin', async () => {
    signIn({ user: testUser({ platformRole: 'MEMBER' }) })
    stubApi(baseRoutes({ projectKeys: [projectApiKey({ displayName: 'Prod backend' })] }))
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('Prod backend') === true)

    expect(container.textContent).toContain('cak-')
    expect(container.textContent).not.toContain('Platform API Keys')

    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent)
    expect(headers).toEqual(['Name', 'Key', 'Created', 'Last used', 'Actions'])
  }, 15000)

  it('shows the empty state with onboarding call to action when there are no project API keys', async () => {
    signIn({ user: testUser({ platformRole: 'MEMBER' }) })
    stubApi(baseRoutes())
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('No project API keys yet') === true)
    expect(container.textContent).toContain('Create your first API key')
  }, 15000)

  it('creates a project API key and reveals the raw value exactly once', async () => {
    signIn({ user: testUser({ platformRole: 'MEMBER' }) })
    const routes = baseRoutes()
    routes.push({
      match: PROJECT_KEYS_CREATE_MATCH,
      respond: () => ({
        status: 201,
        body: projectApiKeyWithValue({ displayName: 'New key', value: 'cak-revealme1234567890' }),
      }),
    })
    stubApi(routes)
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('No project API keys yet') === true)
    await clickTextButton('Create API Key')
    await waitFor(() => document.body.textContent?.includes('Create API key') === true)

    await setNameInput('New key')

    await clickTextButton('Create')

    await waitFor(() => document.body.textContent?.includes('Your new API key') === true)
    expect(document.body.textContent).toContain('cak-revealme1234567890')
  }, 15000)

  it('requires confirmation before revoking a project API key', async () => {
    signIn({ user: testUser({ platformRole: 'MEMBER' }) })
    let deleteCalls = 0
    const routes = baseRoutes({ projectKeys: [projectApiKey({ id: 'cak_1', displayName: 'Prod backend' })] })
    routes.push({
      match: PROJECT_KEY_DELETE_MATCH,
      respond: () => {
        deleteCalls += 1
        return { status: 200, body: undefined }
      },
    })
    stubApi(routes)
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('Prod backend') === true)
    await clickButton(container, 'Revoke Prod backend')

    await waitFor(() => document.body.textContent?.includes('Revoke API key') === true)
    await clickTextButton('Cancel')
    await waitFor(() => document.body.textContent?.includes('Revoke API key') === false)
    expect(deleteCalls).toBe(0)

    await clickButton(container, 'Revoke Prod backend')
    await waitFor(() => document.body.textContent?.includes('Revoke API key') === true)
    await clickTextButton('Revoke')
    await waitFor(() => deleteCalls === 1)
    expect(deleteCalls).toBe(1)
  }, 15000)

  it('shows platform API keys for a platform admin on an entitled plan', async () => {
    signIn({ user: testUser({ platformRole: 'ADMIN' }) })
    stubApi(
      baseRoutes({
        platformKeys: [platformApiKey({ displayName: 'CI service key' })],
        platformEnabled: true,
      })
    )
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('CI service key') === true)
    expect(container.textContent).toContain('Platform API Keys')
    expect(container.textContent).toContain('sk-')
    expect(container.textContent).not.toContain('Requires an upgraded plan')
  }, 15000)

  it('requires confirmation before revoking a platform API key', async () => {
    signIn({ user: testUser({ platformRole: 'ADMIN' }) })
    let deleteCalls = 0
    const routes = baseRoutes({
      platformKeys: [platformApiKey({ id: 'sk_1', displayName: 'CI service key' })],
      platformEnabled: true,
    })
    routes.push({
      match: PLATFORM_KEY_DELETE_MATCH,
      respond: () => {
        deleteCalls += 1
        return { status: 200, body: undefined }
      },
    })
    stubApi(routes)
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('CI service key') === true)
    await clickButton(container, 'Revoke CI service key')

    await waitFor(() => document.body.textContent?.includes('Revoke API key') === true)
    await clickTextButton('Revoke')
    await waitFor(() => deleteCalls === 1)
    expect(deleteCalls).toBe(1)
  }, 15000)

  it('shows a locked state for a platform admin on a non-entitled plan and hides the platform scope in the create dialog', async () => {
    signIn({ user: testUser({ platformRole: 'ADMIN' }) })
    stubApi(baseRoutes({ platformEnabled: false }))
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('Requires an upgraded plan') === true)

    await clickTextButton('Create API Key')
    await waitFor(() => document.body.textContent?.includes('Create API key') === true)
    expect(document.body.textContent).not.toContain('Platform key (sk-)')
  }, 15000)

  it('creates a platform API key when entitled and reveals it once', async () => {
    signIn({ user: testUser({ platformRole: 'ADMIN' }) })
    const routes = baseRoutes({ platformEnabled: true })
    routes.push({
      match: PLATFORM_KEYS_CREATE_MATCH,
      respond: () => ({
        status: 201,
        body: platformApiKeyWithValue({ displayName: 'Root key', value: 'sk-revealme1234567890' }),
      }),
    })
    stubApi(routes)
    const container = renderApiKeysPage()

    await waitFor(() => container.textContent?.includes('No platform API keys yet') === true)
    await clickTextButton('Create API Key')
    await waitFor(() => document.body.textContent?.includes('Create API key') === true)
    await clickTab('Platform key (sk-)')

    await setNameInput('Root key')

    await clickTextButton('Create')

    await waitFor(() => document.body.textContent?.includes('Your new API key') === true)
    expect(document.body.textContent).toContain('sk-revealme1234567890')
  }, 15000)
})
