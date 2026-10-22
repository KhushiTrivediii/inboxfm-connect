import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionsPage from './index'
import { StubRoute, stubApi } from '@/test/api-stub'
import {
  githubConnection,
  githubSummary,
  slackConnection,
  slackSummary,
  seekPage,
} from '@/test/fixtures/integrations'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { apiClient } from '@/lib/api/client'
import { AuthProvider, useAuth } from '@/lib/auth/auth-context'
import { testProject, testUser } from '@/test/fixtures/api-keys'

function renderConnections(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/connections']}>
        <Routes>
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/connections/:id" element={<div>detail</div>} />
          <Route path="/connections/new" element={<div>new</div>} />
          <Route path="*" element={<div>other</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

const LIST_MATCH = (url: URL) => url.pathname === '/api/v1/connections'

function successRoutes(): StubRoute[] {
  return [
    {
      match: LIST_MATCH,
      respond: () => ({
        status: 200,
        body: seekPage([
          githubConnection('conn_1', 'Mihir GitHub'),
          slackConnection('conn_2', 'VedLabs Workspace'),
        ]),
      }),
    },
    {
      match: (url) => url.pathname === '/api/v1/integrations',
      respond: () => ({
        status: 200,
        body: seekPage([githubSummary(), slackSummary()]),
      }),
    },
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

describe('Connections page', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders the connection table with integration, name, external user, auth type, status and created columns', async () => {
    stubApi(successRoutes())
    const container = renderConnections()

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent)
    expect(headers).toEqual([
      'Integration',
      'Connection name',
      'External user',
      'Auth type',
      'Status',
      'Created',
      'Actions',
    ])

    const text = document.body.textContent || ''
    expect(text).toContain('GitHub')
    expect(text).toContain('ext_conn_1')
    expect(text).toContain('ext_conn_2')
    expect(text).toContain('OAuth 2.0')
    expect(text).toContain('Connected')
    expect(text).toContain('Slack')
    expect(text).toContain('API Key')
    expect(text).toContain('Error')

    const detailLink = container.querySelector<HTMLAnchorElement>('a[href="/connections/conn_1"]')
    expect(detailLink).not.toBeNull()
  }, 15000)

  it('shows a loading skeleton before data arrives', async () => {
    stubApi(successRoutes())
    const container = renderConnections()

    await waitFor(
      () => container.querySelectorAll('.animate-pulse').length > 0
    )
    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)
  }, 15000)

  it('shows the empty state when no connections exist', async () => {
    stubApi([
      { match: LIST_MATCH, respond: () => ({ status: 200, body: seekPage([]) }) },
    ])
    const container = renderConnections()

    await waitFor(() => container.textContent?.includes('No connections yet') === true)

    expect(container.textContent).toContain('Browse Integrations')
  }, 15000)

  it('shows an error state with retry when the list request fails', async () => {
    stubApi([
      { match: LIST_MATCH, respond: () => ({ status: 500, body: { message: 'boom' } }) },
    ])
    const container = renderConnections()

    await waitFor(
      () => container.textContent?.includes('Unable to load connections.') === true,
      4000
    )
    expect(container.textContent).toContain('Try again')
  }, 15000)

  it('requires confirmation before deleting a connection and calls DELETE once confirmed', async () => {
    let deleteCalls = 0
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = String(input)
      if (raw.includes('/connections/conn_1')) {
        if (init?.method === 'DELETE') {
          deleteCalls += 1
          return new Response(undefined, { status: 204 })
        }
      }
      if (LIST_MATCH(new URL(raw, 'http://localhost'))) {
        return new Response(
          JSON.stringify(seekPage([githubConnection('conn_1', 'Mihir GitHub')])),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify({ message: 'unhandled' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    })

    const container = renderConnections()
    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    await clickButton(container, 'Delete Mihir GitHub')

    await waitFor(() => document.body.textContent?.includes('Delete connection?') === true)
    expect(document.body.textContent).toContain(
      'Existing tools using it will no longer authenticate.'
    )

    await clickTextButton('Cancel')
    await waitFor(() => document.body.textContent?.includes('Delete connection?') === false)
    expect(deleteCalls).toBe(0)

    await clickButton(container, 'Delete Mihir GitHub')
    await waitFor(() => document.body.textContent?.includes('Delete connection?') === true)

    await clickTextButton('Delete')
    await waitFor(() => deleteCalls === 1)
    expect(deleteCalls).toBe(1)
  }, 15000)

  it('never renders credential values in the list', async () => {
    stubApi(successRoutes())
    const container = renderConnections()

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const text = (document.body.textContent || '').toLowerCase()
    expect(text).not.toContain('access_token')
    expect(text).not.toContain('client_secret')
    expect(text).not.toContain('refresh_token')
  }, 15000)

  it('renders pagination pager controls and row count reflecting more available when next cursor exists', async () => {
    let requestedCursor: string | null = null
    stubApi([
      {
        match: LIST_MATCH,
        respond: (url) => {
          requestedCursor = url.searchParams.get('cursor')
          if (requestedCursor === 'cursor_page_2') {
            return {
              status: 200,
              body: {
                data: [slackConnection('conn_3', 'Secondary Slack')],
                next: null,
                previous: 'cursor_page_1',
              },
            }
          }
          return {
            status: 200,
            body: {
              data: [githubConnection('conn_1', 'Mihir GitHub')],
              next: 'cursor_page_2',
              previous: null,
            },
          }
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/integrations',
        respond: () => ({ status: 200, body: seekPage([githubSummary(), slackSummary()]) }),
      },
    ])

    const container = renderConnections()
    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const countSpan = container.querySelector('[data-testid="connections-count"]')
    expect(countSpan?.textContent).toContain('Showing 1 connection (more available)')

    const prevButton = container.querySelector<HTMLButtonElement>('[data-testid="connections-prev-page"]')
    const nextButton = container.querySelector<HTMLButtonElement>('[data-testid="connections-next-page"]')
    expect(prevButton?.disabled).toBe(true)
    expect(nextButton?.disabled).toBe(false)

    await act(async () => {
      nextButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Secondary Slack') === true)
    expect(requestedCursor).toBe('cursor_page_2')
    expect(container.querySelector('[data-testid="connections-count"]')?.textContent).toContain(
      'Showing 1 connection'
    )
    expect(container.querySelector('[data-testid="connections-count"]')?.textContent).not.toContain(
      '(more available)'
    )
  }, 15000)

  it('shows a page-specific empty state instead of No connections yet past the first page', async () => {
    stubApi([
      {
        match: LIST_MATCH,
        respond: (url) => {
          if (url.searchParams.get('cursor') === 'cursor_page_2') {
            return {
              status: 200,
              body: { ...seekPage([]), previous: 'cursor_page_1' },
            }
          }
          return {
            status: 200,
            body: {
              ...seekPage([githubConnection('conn_1', 'Mihir GitHub')]),
              next: 'cursor_page_2',
            },
          }
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/integrations',
        respond: () => ({
          status: 200,
          body: seekPage([githubSummary(), slackSummary()]),
        }),
      },
    ])
    const container = renderConnections()

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)
    await clickTextButton('Next')
    await waitFor(() => container.textContent?.includes('No connections on this page') === true)
    expect(container.textContent).not.toContain('No connections yet')

    await clickTextButton('Previous page')
    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)
  }, 15000)

  it('resets cursor to page 1 when switching projects', async () => {
    const project1 = testProject({ id: 'proj_1', displayName: 'Project 1' })
    const project2 = testProject({ id: 'proj_2', displayName: 'Project 2' })

    const capturedCursors: { projectId: string | null; cursor: string | null }[] = []

    stubApi([
      {
        match: (url) => url.pathname === '/api/v1/projects',
        respond: () => ({ status: 200, body: { data: [project1, project2] } }),
      },
      {
        match: LIST_MATCH,
        respond: (url) => {
          const projectId = apiClient.getProjectId()
          const cursor = url.searchParams.get('cursor')
          capturedCursors.push({ projectId, cursor })

          if (projectId === 'proj_2') {
            return {
              status: 200,
              body: {
                data: [githubConnection('conn_proj2', 'Project 2 GitHub')],
                next: null,
                previous: null,
              },
            }
          }

          if (cursor === 'cursor_page_2') {
            return {
              status: 200,
              body: {
                data: [slackConnection('conn_proj1_p2', 'Project 1 Slack')],
                next: null,
                previous: 'cursor_page_1',
              },
            }
          }

          return {
            status: 200,
            body: {
              data: [githubConnection('conn_proj1_p1', 'Project 1 GitHub')],
              next: 'cursor_page_2',
              previous: null,
            },
          }
        },
      },
      {
        match: (url) => url.pathname === '/api/v1/integrations',
        respond: () => ({ status: 200, body: seekPage([githubSummary(), slackSummary()]) }),
      },
    ])

    let authSetter: ((p: any) => void) | null = null
    function AuthController() {
      const auth = useAuth()
      authSetter = auth.setCurrentProject
      return null
    }

    apiClient.setToken('test-token')
    apiClient.setProjectId('proj_1')
    sessionStorage.setItem('ap-user', JSON.stringify(testUser()))

    const queryClient = createTestQueryClient()
    const container = mount(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AuthController />
          <MemoryRouter initialEntries={['/connections']}>
            <Routes>
              <Route path="/connections" element={<ConnectionsPage />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>
    )

    await waitFor(() => container.textContent?.includes('Project 1 GitHub') === true)

    await clickTextButton('Next')
    await waitFor(() => container.textContent?.includes('Project 1 Slack') === true)

    const p1Page2Call = capturedCursors.find((c) => c.projectId === 'proj_1' && c.cursor === 'cursor_page_2')
    expect(p1Page2Call).toBeDefined()

    await act(async () => {
      authSetter?.(project2)
    })

    await waitFor(() => container.textContent?.includes('Project 2 GitHub') === true)

    const p2Calls = capturedCursors.filter((c) => c.projectId === 'proj_2')
    expect(p2Calls.length).toBeGreaterThan(0)
    expect(p2Calls.every((c) => c.cursor === null)).toBe(true)
  }, 15000)
})
