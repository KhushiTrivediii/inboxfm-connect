import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import IntegrationsPage from './index'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { stubApi, StubResponse, StubRoute } from '@/test/api-stub'
import { ALL_SUMMARIES, CATEGORIES, seekPage } from '@/test/fixtures/integrations'

function catalogRoutes(options: {
  list?: (url: URL) => StubResponse
  categoriesFail?: boolean
} = {}): StubRoute[] {
  return [
    {
      match: (url) => url.pathname === '/api/v1/integrations/categories',
      respond: () => ({
        status: options.categoriesFail ? 500 : 200,
        body: options.categoriesFail ? { message: 'boom' } : CATEGORIES,
      }),
    },
    {
      match: (url) => url.pathname === '/api/v1/integrations',
      respond: (url) => (options.list ? options.list(url) : { status: 200, body: seekPage(ALL_SUMMARIES) }),
    },
  ]
}

function renderCatalog(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/integrations']}>
        <Routes>
          <Route path="/integrations" element={<IntegrationsPage />} />
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

describe('Integrations catalog', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  it('loads and renders integrations from the backend', async () => {
    const { calls } = stubApi(catalogRoutes())
    const container = renderCatalog()

    await waitFor(() => container.textContent?.includes('3 integrations available') === true)

    const text = container.textContent || ''
    expect(text).toContain('GitHub')
    expect(text).toContain('Slack')
    expect(text).toContain('Gmail')
    expect(text).toContain('31 Actions')
    expect(text).toContain('12 Triggers')
    expect(text).toContain('Developer Tools')
    expect(
      calls.some((call) => call.includes('/api/v1/integrations?sortBy=NAME&orderBy=ASC'))
    ).toBe(true)
    expect(calls.some((call) => call.includes('/api/v1/integrations/categories'))).toBe(true)

    const viewLinks = Array.from(container.querySelectorAll('a')).filter((link) =>
      link.textContent?.includes('View Integration')
    )
    expect(viewLinks.length).toBe(3)
    expect(viewLinks[0].getAttribute('href')).toBe('/integrations/github')
  }, 15000)

  it('sends the debounced search term to the backend and renders filtered results', async () => {
    const { calls } = stubApi(
      catalogRoutes({
        list: (url) => {
          const query = url.searchParams.get('searchQuery') ?? ''
          const matches = ALL_SUMMARIES.filter(
            (piece) =>
              piece.displayName.toLowerCase().includes(query.toLowerCase()) ||
              piece.name.toLowerCase().includes(query.toLowerCase())
          )
          return { status: 200, body: seekPage(matches) }
        },
      })
    )
    const container = renderCatalog()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    await typeSearch(container, 'slack')

    await waitFor(() => calls.some((call) => call.includes('searchQuery=slack')) === true, 4000)
    await waitFor(() => container.textContent?.includes('1 integration matching filters') === true)

    const text = container.textContent || ''
    expect(text).toContain('Slack')
    expect(text).not.toContain('Developer collaboration')
  }, 15000)

  it('filters by category through the category pills', async () => {
    const { calls } = stubApi(
      catalogRoutes({
        list: (url) => {
          const requested = url.searchParams.getAll('categories')
          if (requested.length === 0) {
            return { status: 200, body: seekPage(ALL_SUMMARIES) }
          }
          return {
            status: 200,
            body: seekPage(
              ALL_SUMMARIES.filter((piece) =>
                piece.categories.some((category) => requested.includes(category))
              )
            ),
          }
        },
      })
    )
    const container = renderCatalog()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    const communicationPill = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Communication'
    )
    expect(communicationPill).toBeDefined()

    await act(async () => {
      communicationPill?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(
      () => calls.some((call) => call.includes('categories=COMMUNICATION')) === true,
      4000
    )
    await waitFor(() => container.textContent?.includes('2 integrations matching filters') === true)

    const text = container.textContent || ''
    expect(text).toContain('Slack')
    expect(text).not.toContain('Developer collaboration')
  }, 15000)

  it('exposes sorting options backed by the API', async () => {
    const { calls } = stubApi(catalogRoutes())
    const container = renderCatalog()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    const sortSelect = container.querySelector<HTMLSelectElement>('#integrations-sort-by')
    expect(sortSelect).not.toBeNull()
    const orderSelect = container.querySelector<HTMLSelectElement>('#integrations-sort-order')
    expect(orderSelect).not.toBeNull()
    const sortOptions = Array.from(sortSelect?.options ?? []).map((option) => option.value)
    expect(sortOptions).toEqual(['NAME', 'POPULARITY'])

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(sortSelect, 'POPULARITY')
      sortSelect?.dispatchEvent(new Event('change', { bubbles: true }))
      setter?.call(orderSelect, 'DESC')
      orderSelect?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    await waitFor(
      () =>
        calls.some(
          (call) => call.includes('sortBy=POPULARITY') && call.includes('orderBy=DESC')
        ) === true,
      4000
    )
  }, 15000)

  it('shows the empty state with suggestions when search matches nothing', async () => {
    stubApi(catalogRoutes({ list: () => ({ status: 200, body: seekPage([]) }) }))
    const container = renderCatalog()

    await typeSearch(container, 'zzz-not-found')

    await waitFor(() => container.textContent?.includes('No integrations found') === true, 4000)

    const text = container.textContent || ''
    expect(text).toContain('Try:')
    ;['GitHub', 'Gmail', 'Slack'].forEach((term) => expect(text).toContain(term))

    const clearButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Clear Filters')
    )
    expect(clearButton).not.toBeUndefined()
  }, 15000)

  it('renders the error state with retry when the listing fails', async () => {
    let failing = true
    const { calls } = stubApi(
      catalogRoutes({
        list: () =>
          failing ? { status: 500, body: { message: 'boom' } } : { status: 200, body: seekPage(ALL_SUMMARIES) },
      })
    )
    const container = renderCatalog()

    await waitFor(() => container.textContent?.includes('Unable to load integrations.') === true, 4000)

    const retryButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.toLowerCase().includes('try again')
    )
    expect(retryButton).toBeDefined()

    failing = false

    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await waitFor(() => container.textContent?.includes('GitHub') === true, 4000)
    expect(calls.filter((call) => call.includes('/integrations?')).length).toBeGreaterThanOrEqual(2)
  }, 15000)
})
