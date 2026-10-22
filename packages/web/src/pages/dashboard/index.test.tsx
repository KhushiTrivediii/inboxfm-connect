import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardPage from './index'
import { apiClient } from '@/lib/api/client'
import { AuthProvider } from '@/lib/auth/auth-context'
import { ThemeProvider } from '@/lib/theme/theme-provider'
import { stubApi, StubRoute } from '@/test/api-stub'
import { testProject, testUser } from '@/test/fixtures/api-keys'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

const PROJECT = testProject()

function signIn(): void {
  apiClient.setToken('test-token')
  apiClient.setProjectId(PROJECT.id)
  sessionStorage.setItem('ap-user', JSON.stringify(testUser({ firstName: 'Alex' })))
}

function renderDashboard(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <AuthProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<DashboardPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

function successRoutes(): StubRoute[] {
  return [
    {
      match: (url) => url.pathname.includes('/projects'),
      respond: () => ({ status: 200, body: { data: [PROJECT] } }),
    },
    {
      match: (url) => url.pathname.includes('/integrations') && !url.pathname.includes('/options'),
      respond: () => ({
        status: 200,
        body: {
          data: [
            { name: 'slack', displayName: 'Slack', actions: 5, triggers: 2 },
            { name: 'github', displayName: 'GitHub', actions: 8, triggers: 3 },
          ],
        },
      }),
    },
    {
      match: (url) => url.pathname.includes('/connections'),
      respond: () => ({
        status: 200,
        body: {
          data: [
            { id: 'conn_1', pieceName: 'slack', status: 'ACTIVE' },
            { id: 'conn_2', pieceName: 'github', status: 'ACTIVE' },
          ],
        },
      }),
    },
    {
      match: (url) => url.pathname.includes('/trigger-bindings'),
      respond: () => ({
        status: 200,
        body: {
          data: [
            { id: 'tb_1', status: 'ENABLED' },
            { id: 'tb_2', status: 'ENABLED' },
            { id: 'tb_3', status: 'DISABLED' },
          ],
        },
      }),
    },
    {
      match: (url) => url.pathname.includes('/scheduled-tasks'),
      respond: () => ({
        status: 200,
        body: {
          data: [{ id: 'st_1', status: 'ENABLED' }],
        },
      }),
    },
    {
      match: (url) => url.pathname.includes('/executions'),
      respond: () => ({
        status: 200,
        body: {
          data: [
            {
              id: 'exec_1',
              status: 'COMPLETED',
              prompt: 'Run weekly newsletter sync',
              created: '2026-09-27T10:00:00.000Z',
            },
          ],
        },
      }),
    },
  ]
}

describe('DashboardPage', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    signIn()
    vi.restoreAllMocks()
  })

  it('renders all 4 metrics and executions on success', async () => {
    stubApi(successRoutes())
    const container = renderDashboard()

    await waitFor(() => container.textContent?.includes('Available Tools') === true)
    await waitFor(() => container.textContent?.includes('13') === true) // 5 + 8 actions

    expect(container.textContent).toContain('Available Tools')
    expect(container.textContent).toContain('Across 2 integrations')
    expect(container.textContent).toContain('Active Connections')
    expect(container.textContent).toContain('2') // 2 active
    expect(container.textContent).toContain('Trigger Bindings')
    expect(container.textContent).toContain('Scheduled Tasks')
    expect(container.textContent).toContain('Run weekly newsletter sync')
  })

  it('surfaces inline error state and retry for integrations without rendering zero (#172)', async () => {
    let callCount = 0
    stubApi([
      ...successRoutes().filter(
        (r) => !r.match(new URL('http://localhost/api/v1/integrations'), 'GET')
      ),
      {
        match: (url) => url.pathname.includes('/integrations') && !url.pathname.includes('/options'),
        respond: () => {
          callCount++
          if (callCount === 1) {
            return { status: 500, body: { message: 'Internal Server Error' } }
          }
          return {
            status: 200,
            body: { data: [{ name: 'slack', displayName: 'Slack', actions: 4, triggers: 1 }] },
          }
        },
      },
    ])

    const container = renderDashboard()

    // Wait for the "Failed to load" message on the Available Tools card
    await waitFor(() => container.textContent?.includes('Failed to load') === true)

    // Must never show 0 or "Across 0 integrations" on failure
    expect(container.textContent).not.toContain('Across 0 integrations')

    // Find and click the Retry button on the Available Tools card
    const retryButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-testid="retry-button"]')
    )
    expect(retryButtons.length).toBeGreaterThanOrEqual(1)

    act(() => {
      retryButtons[0].click()
    })

    await waitFor(() => container.textContent?.includes('Across 1 integrations') === true)
    expect(callCount).toBe(2)
  })

  it('surfaces inline error state and retry for connections without rendering zero (#172)', async () => {
    let callCount = 0
    stubApi([
      ...successRoutes().filter(
        (r) => !r.match(new URL('http://localhost/api/v1/connections'), 'GET')
      ),
      {
        match: (url) => url.pathname.includes('/connections'),
        respond: () => {
          callCount++
          if (callCount === 1) {
            return { status: 500, body: { message: 'Failed connections' } }
          }
          return {
            status: 200,
            body: {
              data: [
                { id: 'c1', pieceName: 'slack', status: 'ACTIVE' },
              ],
            },
          }
        },
      },
    ])

    const container = renderDashboard()
    await waitFor(() => container.textContent?.includes('Failed to load') === true)

    // Should not show 0 total credentials
    expect(container.textContent).not.toContain('0 total credentials')

    const retryButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-testid="retry-button"]')
    )
    expect(retryButtons.length).toBeGreaterThanOrEqual(1)
    act(() => {
      retryButtons[0].click()
    })
    await waitFor(() => container.textContent?.includes('1 total credentials') === true)
    expect(callCount).toBe(2)
  })

  it('surfaces inline error state and retry for trigger bindings without rendering zero (#172)', async () => {
    let callCount = 0
    stubApi([
      ...successRoutes().filter(
        (r) => !r.match(new URL('http://localhost/api/v1/trigger-bindings'), 'GET')
      ),
      {
        match: (url) => url.pathname.includes('/trigger-bindings'),
        respond: () => {
          callCount++
          if (callCount === 1) {
            return { status: 500, body: { message: 'Failed triggers' } }
          }
          return {
            status: 200,
            body: {
              data: [
                { id: 'tb1', status: 'ENABLED' },
              ],
            },
          }
        },
      },
    ])

    const container = renderDashboard()
    await waitFor(() => container.textContent?.includes('Failed to load') === true)

    expect(container.textContent).not.toContain('0 configured event listeners')

    const retryButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-testid="retry-button"]')
    )
    expect(retryButtons.length).toBeGreaterThanOrEqual(1)
    act(() => {
      retryButtons[0].click()
    })
    await waitFor(() => container.textContent?.includes('1 configured event listeners') === true)
    expect(callCount).toBe(2)
  })

  it('surfaces inline error state and retry for scheduled tasks without rendering zero (#172)', async () => {
    let callCount = 0
    stubApi([
      ...successRoutes().filter(
        (r) => !r.match(new URL('http://localhost/api/v1/scheduled-tasks'), 'GET')
      ),
      {
        match: (url) => url.pathname.includes('/scheduled-tasks'),
        respond: () => {
          callCount++
          if (callCount === 1) {
            return { status: 500, body: { message: 'Failed schedules' } }
          }
          return {
            status: 200,
            body: {
              data: [
                { id: 'st1', status: 'ENABLED' },
              ],
            },
          }
        },
      },
    ])

    const container = renderDashboard()
    await waitFor(() => container.textContent?.includes('Failed to load') === true)

    expect(container.textContent).not.toContain('0 cron schedules')

    const retryButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[data-testid="retry-button"]')
    )
    expect(retryButtons.length).toBeGreaterThanOrEqual(1)
    act(() => {
      retryButtons[0].click()
    })
    await waitFor(() => container.textContent?.includes('1 cron schedules') === true)
    expect(callCount).toBe(2)
  })

  it('surfaces ErrorState on executions failure and never renders empty state (#172)', async () => {
    stubApi([
      ...successRoutes().filter(
        (r) => !r.match(new URL('http://localhost/api/v1/executions'), 'GET')
      ),
      {
        match: (url) => url.pathname.includes('/executions'),
        respond: () => ({ status: 500, body: { message: 'Executions DB unavailable' } }),
      },
    ])

    const container = renderDashboard()
    await waitFor(() => container.textContent?.includes('Unable to load recent executions') === true)

    // Never render the empty state title when query failed
    expect(container.textContent).not.toContain('No executions recorded yet')
    expect(container.textContent).toContain('The execution log could not be reached. Retry shortly.')
  })

  it('renders EmptyState when executions list is cleanly empty', async () => {
    stubApi([
      ...successRoutes().filter(
        (r) => !r.match(new URL('http://localhost/api/v1/executions'), 'GET')
      ),
      {
        match: (url) => url.pathname.includes('/executions'),
        respond: () => ({ status: 200, body: { data: [] } }),
      },
    ])

    const container = renderDashboard()
    await waitFor(() => container.textContent?.includes('No executions recorded yet') === true)

    expect(container.textContent).toContain('No executions recorded yet')
    expect(container.textContent).not.toContain('Unable to load recent executions')
  })
})
