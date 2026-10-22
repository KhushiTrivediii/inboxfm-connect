import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import ActionsPage from './index'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { stubApi, StubResponse, StubRoute } from '@/test/api-stub'
import { ALL_SUMMARIES, CATEGORIES, seekPage } from '@/test/fixtures/integrations'

function knowledgeSearchResult() {
  return {
    results: [
      {
        pieceName: 'github',
        objectName: 'createIssue',
        objectKind: 'action',
        displayName: 'Create Issue',
        oneLineDescription: 'Create a GitHub issue in a repository.',
        requiresConnection: true,
      },
      {
        pieceName: 'gmail',
        objectName: 'sendEmail',
        objectKind: 'action',
        displayName: 'Send Email',
        oneLineDescription: 'Send an email via Gmail.',
        requiresConnection: true,
      },
    ],
    mode: 'semantic',
  }
}

function catalogRoutes(options: {
  search?: (url: URL) => StubResponse
} = {}): StubRoute[] {
  return [
    {
      match: (url) => url.pathname === '/api/v1/integrations/categories',
      respond: () => ({ status: 200, body: CATEGORIES }),
    },
    {
      match: (url) => url.pathname === '/api/v1/knowledge-search/query',
      respond: (url) =>
        options.search ? options.search(url) : { status: 200, body: knowledgeSearchResult() },
    },
    {
      match: (url) => url.pathname === '/api/v1/integrations',
      respond: () => ({ status: 200, body: seekPage(ALL_SUMMARIES) }),
    },
  ]
}

function renderActions(initialRoute = '/actions'): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route path="/actions" element={<ActionsPage />} />
          <Route path="/actions/:pieceName/:actionName" element={<div>runner</div>} />
          <Route path="/integrations/:name" element={<div>integration detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function typeSearch(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')
  expect(input).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('Actions catalog', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('browses integrations without fetching each integration individually', async () => {
    const { calls } = stubApi(catalogRoutes())
    const container = renderActions()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    const integrationCalls = calls.filter(
      (call) => call.includes('/api/v1/integrations?sortBy=NAME')
    )
    expect(integrationCalls.length).toBe(1)
    expect(calls.some((call) => /\/api\/v1\/integrations\/(github|slack|gmail)/.test(call))).toBe(
      false
    )

    const browseCards = container.querySelectorAll('[data-testid="action-browse-card"]')
    expect(browseCards.length).toBe(3)
    const firstCard = browseCards[0] as HTMLAnchorElement
    expect(firstCard.getAttribute('href')).toContain('/integrations/github?tab=actions')
  }, 15000)

  it('searches actions through the knowledge-search endpoint and links to the runner', async () => {
    const { calls } = stubApi(catalogRoutes())
    const container = renderActions()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    await typeSearch(container, 'create issue')

    await waitFor(
      () =>
        calls.some((call) => call.includes('/api/v1/knowledge-search/query')) === true,
      4000
    )
    await waitFor(
      () => container.querySelector('[data-testid="action-search-results"]') !== null
    )

    const runnerLinks = Array.from(container.querySelectorAll('a')).filter((link) =>
      link.getAttribute('href')?.includes('/actions/github/createIssue')
    )
    expect(runnerLinks.length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Create Issue')
    expect(container.textContent).toContain('Send Email')

    const searchRequest = calls.find((call) => call.includes('/api/v1/knowledge-search/query'))
    expect(searchRequest).toBeTruthy()
  }, 15000)

  it('filters browse results by integration and connection requirement', async () => {
    stubApi(catalogRoutes())
    const container = renderActions()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>(
        'select[aria-label="Filter by integration"]'
      )
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value'
      )?.set
      setter?.call(select, 'github')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(
      () => container.querySelectorAll('[data-testid="action-browse-card"]').length === 1
    )
    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).not.toContain('Team communication')
  }, 15000)

  it('restores the search query from URL state on load', async () => {
    const { calls } = stubApi(catalogRoutes())
    renderActions('/actions?q=create%20issue')

    await waitFor(
      () =>
        calls.some((call) => call.includes('/api/v1/knowledge-search/query')) === true,
      4000
    )
  }, 15000)

  it('shows an empty state when nothing matches the search', async () => {
    stubApi(
      catalogRoutes({
        search: () => ({ status: 200, body: { results: [], mode: 'keyword' } }),
      })
    )
    const container = renderActions()

    await typeSearch(container, 'zzzznotfound')

    await waitFor(
      () => container.textContent?.includes('No actions found') === true,
      5000
    )
  }, 15000)

  it('shows a retryable error state when the search fails', async () => {
    let failSearch = true
    const { calls } = stubApi(
      catalogRoutes({
        search: () =>
          failSearch
            ? { status: 500, body: { message: 'boom' } }
            : { status: 200, body: knowledgeSearchResult() },
      })
    )
    const container = renderActions()

    await typeSearch(container, 'create issue')

    await waitFor(
      () => container.textContent?.includes('Search failed') === true,
      5000
    )

    failSearch = false
    const retry = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Try again')
    )
    expect(retry).toBeTruthy()
    await act(async () => {
      retry?.click()
    })

    await waitFor(
      () =>
        calls.filter((call) => call.includes('/api/v1/knowledge-search/query')).length >= 2,
      4000
    )
    await waitFor(
      () => container.querySelector('[data-testid="action-search-results"]') !== null
    )
  }, 15000)
})
