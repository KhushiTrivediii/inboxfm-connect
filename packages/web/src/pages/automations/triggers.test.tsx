import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TriggerBindingsPage from './triggers'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { ALL_SUMMARIES, seekPage } from '@/test/fixtures/integrations'
import { automationConnection, githubTriggerBinding } from '@/test/fixtures/automations'
import { TriggerBinding } from '@/lib/api/types'

interface RecordedRequest {
  url: string
  method: string
  body?: unknown
}

interface MockBackend {
  requests: RecordedRequest[]
  bindings: TriggerBinding[]
  deletedIds: string[]
  listStatus: number
  install(): void
  restore(): void
}

function createMockBackend(options: { bindings?: TriggerBinding[]; listStatus?: number } = {}): MockBackend {
  const requests: RecordedRequest[] = []
  const bindings: TriggerBinding[] =
    options.bindings !== undefined ? [...options.bindings] : [githubTriggerBinding()]
  const deletedIds: string[] = []
  const originalFetch = global.fetch
  let listStatus = options.listStatus ?? 200

  function parseBody(init?: RequestInit): unknown {
    if (typeof init?.body !== 'string') return undefined
    try {
      return JSON.parse(init.body)
    } catch {
      return undefined
    }
  }

  function idFrom(pathname: string): string {
    return pathname.replace('/api/v1/trigger-bindings/', '').split('/')[0]
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  async function handler(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw = String(input)
    const url = new URL(raw, 'http://localhost')
    const method = init?.method ?? 'GET'
    requests.push({ url: raw, method, body: parseBody(init) })

    if (url.pathname === '/api/v1/trigger-bindings' && method === 'GET') {
      if (listStatus >= 400) {
        return json({ message: 'database unreachable' }, listStatus)
      }
      return json({ data: [...bindings], next: null, previous: null })
    }

    if (/^\/api\/v1\/trigger-bindings\/[^/]+\/enable$/.test(url.pathname)) {
      return json(setStatus(idFrom(url.pathname), 'ENABLED'))
    }
    if (/^\/api\/v1\/trigger-bindings\/[^/]+\/disable$/.test(url.pathname)) {
      return json(setStatus(idFrom(url.pathname), 'DISABLED'))
    }
    if (/^\/api\/v1\/trigger-bindings\/[^/]+$/.test(url.pathname) && method === 'DELETE') {
      const id = idFrom(url.pathname)
      const index = bindings.findIndex((binding) => binding.id === id)
      if (index >= 0) {
        bindings.splice(index, 1)
        deletedIds.push(id)
      }
      return new Response(null, { status: 204 })
    }
    if (/^\/api\/v1\/trigger-bindings\/[^/]+$/.test(url.pathname)) {
      const binding = bindings.find((candidate) => candidate.id === idFrom(url.pathname))
      return binding ? json(binding) : json({ message: 'not found' }, 404)
    }
    if (url.pathname === '/api/v1/integrations') {
      return json(seekPage(ALL_SUMMARIES))
    }
    if (url.pathname === '/api/v1/connections') {
      return json({ data: [automationConnection()], next: null, previous: null })
    }
    return json({ message: `unhandled ${method} ${raw}` }, 404)
  }

  function setStatus(id: string, status: TriggerBinding['status']): TriggerBinding {
    const index = bindings.findIndex((binding) => binding.id === id)
    bindings[index] = { ...bindings[index], status, updated: new Date().toISOString() }
    return bindings[index]
  }

  return {
    requests,
    bindings,
    deletedIds,
    get listStatus() {
      return listStatus
    },
    set listStatus(value: number) {
      listStatus = value
    },
    install() {
      global.fetch = vi.fn(handler) as unknown as typeof fetch
    },
    restore() {
      global.fetch = originalFetch
    },
  }
}

async function clickButtonWithText(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label)
  )
  expect(button).toBeTruthy()
  await act(async () => {
    button?.click()
  })
}

describe('Trigger bindings hub', () => {
  let backend: MockBackend
  const cleanups: Array<() => void> = []

  function setupBackend(options?: { bindings?: TriggerBinding[]; listStatus?: number }): MockBackend {
    const instance = createMockBackend(options)
    instance.install()
    cleanups.push(() => instance.restore())
    return instance
  }

  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
    backend = setupBackend()
  })

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.()
    }
  })

  it('lists bindings from the backend SeekPage response', async () => {
    const container = renderHub()

    await waitFor(() => container.textContent?.includes('GitHub') === true)

    const listCall = backend.requests.find(
      (request) => request.url.includes('/api/v1/trigger-bindings') && request.method === 'GET'
    )
    expect(listCall).toBeTruthy()

    expect(container.querySelectorAll('[data-testid="trigger-binding-row"]').length).toBe(1)
    expect(container.textContent).toContain('newIssue')
    expect(container.textContent).toContain('Summarize the issue and post it to Slack.')
    expect(container.textContent).toContain('Mihir GitHub')
    expect(container.querySelector('[data-testid="automation-status-enabled"]')).not.toBeNull()
  }, 15000)

  it('renders an empty state when no bindings exist', async () => {
    backend.restore()
    backend = setupBackend({ bindings: [] })
    const container = renderHub()

    await waitFor(
      () => container.textContent?.includes('No trigger bindings configured') === true
    )
  }, 15000)

  it('shows an error state when the list fails to load', async () => {
    backend.restore()
    backend = setupBackend({ listStatus: 500 })
    const container = renderHub()

    await waitFor(() => container.textContent?.includes('Unable to load trigger bindings') === true)
  }, 15000)

  it('disables and re-enables through the dedicated POST endpoints', async () => {
    const container = renderHub()

    await waitFor(() => container.querySelector('[data-testid="trigger-binding-row"]') !== null)

    await clickButtonWithText(container, 'Disable')

    await waitFor(
      () =>
        backend.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.url.endsWith('/trigger-bindings/tb_github_issue/disable')
        ) === true
    )
    await waitFor(() => container.querySelector('[data-testid="automation-status-disabled"]') !== null)
    expect(container.querySelector('[data-testid="automation-status-disabled"]')).not.toBeNull()

    await clickButtonWithText(container, 'Enable')

    await waitFor(
      () =>
        backend.requests.some(
          (request) =>
            request.method === 'POST' &&
            request.url.endsWith('/trigger-bindings/tb_github_issue/enable')
        ) === true
    )
    await waitFor(() => container.querySelector('[data-testid="automation-status-enabled"]') !== null)
    expect(container.querySelector('[data-testid="automation-status-enabled"]')).not.toBeNull()
  }, 20000)

  it('deletes only after confirmation using DELETE', async () => {
    const container = renderHub()

    await waitFor(() => container.querySelector('[data-testid="trigger-binding-row"]') !== null)

    const deleteButton = Array.from(container.querySelectorAll('button')).find((candidate) =>
      candidate.getAttribute('aria-label')?.includes('Delete')
    )
    expect(deleteButton).toBeTruthy()
    await act(async () => {
      deleteButton?.click()
    })

    await waitFor(() => document.querySelector('[role="dialog"]') !== null)
    expect(document.body.textContent).toContain('Delete trigger binding?')
    expect(backend.deletedIds.length).toBe(0)

    await clickButtonWithText(document.body as HTMLElement, 'Delete')

    await waitFor(() => backend.deletedIds.length === 1)
    const deleteRequest = backend.requests.find((request) => request.method === 'DELETE')
    expect(deleteRequest?.url).toContain('/api/v1/trigger-bindings/tb_github_issue')

    await waitFor(
      () => container.textContent?.includes('No trigger bindings configured') === true
    )
  }, 20000)
})

function renderHub(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/automations/triggers']}>
        <Routes>
          <Route path="/automations/triggers" element={<TriggerBindingsPage />} />
          <Route path="/automations/triggers/new" element={<div>new binding</div>} />
          <Route path="/automations/triggers/:id" element={<div>binding detail</div>} />
          <Route path="/triggers" element={<div>discovery</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
