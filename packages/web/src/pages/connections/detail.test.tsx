import { act } from 'react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConnectionDetailPage from './detail'
import { githubConnection, slackConnection } from '@/test/fixtures/integrations'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

function renderDetail(id: string): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/connections/${id}`]}>
        <Routes>
          <Route path="/connections" element={<div>list</div>} />
          <Route path="/connections/new" element={<div>new</div>} />
          <Route path="/connections/:id" element={<ConnectionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function stubRoutes(): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = String(input)
    if (raw.includes('/connections/conn_1')) {
      if (init?.method === 'DELETE') {
        return new Response(undefined, { status: 204 })
      }
      return new Response(JSON.stringify(githubConnection('conn_1', 'Mihir GitHub')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (raw.includes('/connections/missing')) {
      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (raw.includes('/integrations/github')) {
      return new Response(
        JSON.stringify({
          name: 'github',
          displayName: 'GitHub',
          logoUrl: 'https://cdn.example/github.svg',
          description: '',
          version: '0.3.4',
          auth: { type: 'OAUTH2' },
          actions: {},
          triggers: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    return new Response(JSON.stringify({ message: 'unhandled' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  })
}

describe('Connection detail page', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders non-sensitive metadata only', async () => {
    stubRoutes()
    const container = renderDetail('conn_1')

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const text = document.body.textContent || ''
    expect(text).toContain('Connection')
    expect(text).toContain('Integration')
    expect(text).toContain('Authentication')
    expect(text).toContain('OAuth 2.0')
    expect(text).toContain('Status')
    expect(text).toContain('Connected')
    expect(text).toContain('Created')
    expect(text).toContain('Updated')
    expect(text).toContain('External ID')
    expect(text).toContain('ext_conn_1')

    // No credential payloads are ever rendered.
    expect(text.toLowerCase()).not.toContain('access_token')
    expect(text.toLowerCase()).not.toContain('client_secret')
    expect(text.toLowerCase()).not.toContain('"code"')
  }, 15000)

  it('shows reconnect and delete actions with a working back link', async () => {
    stubRoutes()
    const container = renderDetail('conn_1')

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const reconnectLink = Array.from(container.querySelectorAll('a')).find((link) =>
      link.getAttribute('href')?.includes('/connections/new?pieceName=github&externalId=ext_conn_1')
    )
    expect(reconnectLink).toBeDefined()

    const backLink = container.querySelector<HTMLAnchorElement>('a[href="/connections"]')
    expect(backLink).not.toBeNull()

    const deleteButton = container.querySelector<HTMLButtonElement>('button span')
    expect(deleteButton).not.toBeNull()
  }, 15000)

  /**
   * The last-tested verdict is persisted on the row (POST /test writes
   * testedAt/testedStatus/testedMessage), so it must survive a fresh page load —
   * not only exist in the component's state right after a click.
   */
  it('shows the persisted last-tested result without running a test', async () => {
    const testedAt = '2026-10-13T09:30:00.000Z'
    global.fetch = vi.fn(async (): Promise<Response> => {
      return new Response(
        JSON.stringify(
          githubConnection('conn_1', 'Mihir GitHub', {
            testedAt,
            testedStatus: 'ERROR',
            testedMessage: 'The app rejected the stored credentials.',
          })
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const container = renderDetail('conn_1')

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    expect(container.textContent).toContain('Last tested')
    expect(container.textContent).toContain(new Date(testedAt).toLocaleString())
    expect(container.textContent).toContain('Test result')
    expect(container.textContent).toContain('The app rejected the stored credentials.')
  }, 15000)

  it('shows an em dash for last tested when the connection was never tested', async () => {
    stubRoutes()
    const container = renderDetail('conn_1')

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const lastTestedRow = Array.from(container.querySelectorAll('*')).find((node) =>
      node.textContent?.trim().startsWith('Last tested')
    )
    expect(lastTestedRow?.textContent).toContain('—')
    expect(container.textContent).not.toContain('Test result')
  }, 15000)

  it('shows the not-found state for an unknown connection id', async () => {
    stubRoutes()
    const container = renderDetail('missing')

    await waitFor(() => container.textContent?.includes('Connection not found') === true, 4000)
    expect(container.textContent).toContain('Back to Connections')
  }, 15000)

  it('navigates back to the list after deleting the connection', async () => {
    let deleted = false
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = String(input)
      if (raw.includes('/connections/conn_1') && init?.method === 'DELETE') {
        deleted = true
        return new Response(undefined, { status: 204 })
      }
      if (raw.includes('/connections/conn_1')) {
        return new Response(JSON.stringify(slackConnection('conn_1', 'VedLabs Workspace')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (raw.includes('/integrations/slack')) {
        return new Response(
          JSON.stringify({
            name: 'slack',
            displayName: 'Slack',
            logoUrl: '',
            description: '',
            version: '0.2.1',
            auth: { type: 'SECRET_TEXT' },
            actions: {},
            triggers: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify({ message: 'unhandled' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    })

    const container = renderDetail('conn_1')

    await waitFor(() => container.textContent?.includes('VedLabs Workspace') === true)

    const deleteButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Delete')
    )
    expect(deleteButton).not.toBeUndefined()
    deleteButton?.click()

    await waitFor(() => document.body.textContent?.includes('Delete connection?') === true)

    const dialog = document.body.querySelector('[role="dialog"]')
    const confirmButton = Array.from((dialog ?? document.body).querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Delete'
    )
    expect(confirmButton).not.toBeUndefined()
    await act(async () => {
      confirmButton?.click()
    })

    await waitFor(() => deleted === true)
    expect(deleted).toBe(true)
    await waitFor(() => container.textContent?.includes('list') === true)
  }, 15000)

  it('runs the health check and shows the last-tested result', async () => {
    let tested = false
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = String(input)
      if (raw.includes('/connections/conn_1/test') && init?.method === 'POST') {
        tested = true
        return new Response(
          JSON.stringify({ ok: true, status: 'ACTIVE', testedAt: new Date('2026-09-28T12:00:00Z').toISOString() }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (raw.includes('/connections/conn_1')) {
        return new Response(JSON.stringify(githubConnection('conn_1', 'Mihir GitHub')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (raw.includes('/integrations/github')) {
        return new Response(
          JSON.stringify({
            name: 'github',
            displayName: 'GitHub',
            logoUrl: '',
            description: '',
            version: '0.3.4',
            auth: { type: 'OAUTH2' },
            actions: {},
            triggers: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify({ message: 'unhandled' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    })

    const container = renderDetail('conn_1')

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const testButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.trim() === 'Test'
    )
    expect(testButton).not.toBeUndefined()
    await act(async () => {
      testButton?.click()
    })

    await waitFor(() => tested === true)
    expect(tested).toBe(true)
    await waitFor(() => container.textContent?.includes('Last tested') === true)
  }, 15000)

  it('surfaces the failure message when the health check fails', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = String(input)
      if (raw.includes('/connections/conn_1/test') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ ok: false, status: 'ERROR', testedAt: new Date('2026-09-28T12:00:00Z').toISOString(), message: 'Token expired' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (raw.includes('/connections/conn_1')) {
        return new Response(JSON.stringify(githubConnection('conn_1', 'Mihir GitHub')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (raw.includes('/integrations/github')) {
        return new Response(
          JSON.stringify({
            name: 'github',
            displayName: 'GitHub',
            logoUrl: '',
            description: '',
            version: '0.3.4',
            auth: { type: 'OAUTH2' },
            actions: {},
            triggers: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(JSON.stringify({ message: 'unhandled' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    })

    const container = renderDetail('conn_1')

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const testButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.trim() === 'Test'
    )
    await act(async () => {
      testButton?.click()
    })

    await waitFor(() => container.textContent?.includes('Token expired') === true)
    expect(container.textContent).toContain('Token expired')
  }, 15000)

  /**
   * Regression: the component instance is reused across a /connections/:id ->
   * /connections/:otherId navigation (same route, new param), so testResult
   * used to survive and paint the previous connection's verdict, timestamp and
   * failure message next to the newly-loaded one.
   */
  it('clears the previous test result when the route param changes', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw = String(input)

      if (init?.method === 'POST' && raw.includes('/test')) {
        return new Response(
          JSON.stringify({
            ok: false,
            status: 'ERROR',
            testedAt: new Date('2026-09-28T12:00:00Z').toISOString(),
            message: 'Token expired',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (raw.includes('/connections/conn_2')) {
        return new Response(JSON.stringify(slackConnection('conn_2', 'Mihir Slack')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (raw.includes('/connections/conn_1')) {
        return new Response(JSON.stringify(githubConnection('conn_1', 'Mihir GitHub')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (raw.includes('/integrations/')) {
        return new Response(
          JSON.stringify({
            name: 'github',
            displayName: 'GitHub',
            logoUrl: '',
            description: '',
            version: '0.3.4',
            auth: { type: 'OAUTH2' },
            actions: {},
            triggers: {},
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ message: 'unhandled' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    })

    const queryClient = createTestQueryClient()
    const container = mount(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/connections/conn_1']}>
          <Link to="/connections/conn_2" data-testid="route-link">
            go
          </Link>
          <Routes>
            <Route path="/connections/:id" element={<ConnectionDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    )

    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    const testButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'Test'
    )
    await act(async () => {
      testButton?.click()
    })
    await waitFor(() => container.textContent?.includes('Token expired') === true)

    // Same component instance, different :id.
    const probeLink = container.querySelector('[data-testid="route-link"]')
    if (probeLink instanceof HTMLElement) {
      await act(async () => {
        probeLink.click()
      })
    }

    await waitFor(() => container.textContent?.includes('Mihir Slack') === true)

    // conn_2's own row must not inherit conn_1's verdict.
    expect(container.textContent).not.toContain('Token expired')

    const testResultRow = Array.from(container.querySelectorAll('*')).find((node) =>
      node.textContent?.trim().startsWith('Test result')
    )
    expect(testResultRow?.textContent ?? '').not.toContain('Token expired')
  }, 20000)
})

