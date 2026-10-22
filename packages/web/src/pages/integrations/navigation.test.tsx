import { act } from 'react'
import { MemoryRouter, Outlet, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import IntegrationsPage from './index'
import IntegrationDetailPage from './detail'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { stubApi, StubRoute } from '@/test/api-stub'
import { ALL_SUMMARIES, CATEGORIES, githubConnection, githubMetadata, seekPage } from '@/test/fixtures/integrations'

let goBack: (() => void) | null = null

function HistoryControls() {
  const navigate = useNavigate()
  goBack = () => navigate(-1)
  return null
}

function ActionDestination() {
  const { pieceName, actionName } = useParams<{ pieceName: string; actionName: string }>()
  return <div data-testid="destination">runner:{pieceName}:{actionName}</div>
}

function ConnectDestination() {
  const [searchParams] = useSearchParams()
  return (
    <div data-testid="destination">
      connect-flow:{searchParams.get('pieceName') ?? ''}
    </div>
  )
}

function stubRoutes(): StubRoute[] {
  return [
    {
      match: (url) => url.pathname === '/api/v1/integrations/categories',
      respond: () => ({ status: 200, body: CATEGORIES }),
    },
    {
      match: (url) => url.pathname === '/api/v1/connections',
      respond: () => ({ status: 200, body: seekPage([githubConnection('conn_1', 'Mihir GitHub')]) }),
    },
    {
      match: (url) => url.pathname === '/api/v1/integrations',
      respond: () => ({ status: 200, body: seekPage(ALL_SUMMARIES) }),
    },
    {
      match: (url) => /^\/api\/v1\/integrations\/[^/]+$/.test(url.pathname),
      respond: (url) => {
        const name = url.pathname.split('/').pop() ?? ''
        if (name === 'github') {
          return { status: 200, body: githubMetadata() }
        }
        return { status: 404, body: { message: 'not found' } }
      },
    },
  ]
}

async function renderAt(initialEntry: string): Promise<HTMLElement> {
  goBack = null
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<><Outlet /><HistoryControls /></>}>
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/integrations/:name" element={<IntegrationDetailPage />} />
            <Route path="/actions/:pieceName/:actionName" element={<ActionDestination />} />
            <Route path="/connections/new" element={<ConnectDestination />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function clickButton(container: HTMLElement, matcher: (text: string) => boolean): Promise<void> {
  const target = Array.from(container.querySelectorAll('a, button')).find((element) =>
    matcher(element.textContent?.trim() ?? '')
  )
  expect(target).toBeDefined()
  await act(async () => {
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function clickTab(container: HTMLElement, label: string): Promise<void> {
  const tab = Array.from(container.querySelectorAll('[role="tab"]')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  expect(tab).not.toBeUndefined()
  await act(async () => {
    tab?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    )
  })
}

describe('Integration navigation', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    stubApi(stubRoutes())
  })

  it('navigates from a catalog card to the integration detail page', async () => {
    const container = await renderAt('/integrations')

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    await clickButton(container, (text) => text.includes('View Integration'))

    await waitFor(() => document.body.textContent?.includes('Developer collaboration') === true)
    expect(document.body.textContent).toContain('Authentication')
  }, 15000)

  it('opens /actions/:pieceName/:actionName when clicking an action', async () => {
    const container = await renderAt('/integrations/github')

    await waitFor(() => document.body.textContent?.includes('Summary') === true)
    await clickTab(container, 'Actions')

    await waitFor(() => document.body.textContent?.includes('Create Issue') === true)
    await clickButton(container, (text) => text.includes('Create Issue'))

    const destination = document.querySelector('[data-testid="destination"]')
    expect(destination?.textContent).toContain('runner:github:createIssue')
  }, 15000)

  it('opens /connections/new?pieceName=... when clicking Connect', async () => {
    const container = await renderAt('/integrations/github')

    await waitFor(() => document.body.textContent?.includes('Summary') === true)

    const connectLink = Array.from(container.querySelectorAll('a')).find(
      (link) => link.textContent?.trim() === 'Connect'
    )
    expect(connectLink?.getAttribute('href')).toBe('/connections/new?pieceName=github')

    await clickButton(container, (text) => text === 'Connect')

    const destination = document.querySelector('[data-testid="destination"]')
    expect(destination?.textContent).toContain('connect-flow:github')
  }, 15000)

  it('returns to the integration detail page on browser back', async () => {
    const container = await renderAt('/integrations/github')

    await waitFor(() => document.body.textContent?.includes('Summary') === true)

    await clickButton(container, (text) => text === 'Connect')
    await waitFor(() => document.querySelector('[data-testid="destination"]') !== null)

    await act(async () => {
      goBack?.()
    })

    await waitFor(() => document.querySelector('[data-testid="destination"]') === null)
    await waitFor(() => document.body.textContent?.includes('Summary') === true)
    expect(document.body.textContent).toContain('OAuth 2.0')
  }, 15000)
})
