import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NewTriggerBindingPage from './triggers-new'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { ALL_SUMMARIES, githubMetadata, seekPage } from '@/test/fixtures/integrations'
import { automationConnection } from '@/test/fixtures/automations'

interface RecordedRequest {
  url: string
  method: string
  body?: unknown
}

const createdBinding = () => ({
  id: 'tb_new',
  created: '2026-05-01T00:00:00.000Z',
  updated: '2026-05-01T00:00:00.000Z',
  projectId: 'proj_default',
  platformId: 'plat_default',
  pieceName: 'github',
  pieceVersion: '0.3.4',
  triggerName: 'onPush',
  connectionId: 'conn_github_1',
  promptTemplate: 'Post the push summary.',
  settings: {},
  status: 'ENABLED',
})

function installApi(options: { createStatus?: number } = {}): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  const originalFetch = global.fetch

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
    let body: unknown
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = undefined
      }
    }
    requests.push({ url: raw, method, body })

    if (url.pathname === '/api/v1/integrations') {
      return json(seekPage(ALL_SUMMARIES))
    }
    if (url.pathname === '/api/v1/integrations/github') {
      return json(githubMetadata())
    }
    if (url.pathname === '/api/v1/connections') {
      return json({ data: [automationConnection()], next: null, previous: null })
    }
    if (url.pathname === '/api/v1/trigger-bindings' && method === 'POST') {
      if ((options.createStatus ?? 201) >= 400) {
        return json({ message: 'piece version is not available' }, options.createStatus)
      }
      return json({ ...createdBinding(), ...(body as Record<string, unknown>) }, 201)
    }
    return json({ message: `unhandled ${method} ${raw}` }, 404)
  }

  global.fetch = vi.fn(handler) as unknown as typeof fetch
  pendingRestores.push(() => {
    global.fetch = originalFetch
  })
  return requests
}

const pendingRestores: Array<() => void> = []

async function selectOption(container: HTMLElement, selector: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLSelectElement>(selector)
  expect(element).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(element, value)
    element?.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function setInputValue(container: HTMLElement, selector: string, value: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  expect(element).not.toBeNull()
  await act(async () => {
    const proto =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
    setter?.call(element, value)
    element?.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function clickSubmit(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>('[data-testid="submit-binding"]')
  expect(button).not.toBeNull()
  await act(async () => {
    button?.click()
  })
}

describe('Trigger binding creation', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    while (pendingRestores.length > 0) {
      pendingRestores.pop()?.()
    }
  })

  it('submits an exact create payload built from schema-driven inputs', async () => {
    const requests = installApi()
    const container = renderForm()

    await waitFor(
      () => container.querySelector('[data-testid="source-integration-select"] option[value="github"]') !== null
    )

    await selectOption(container, '[data-testid="source-integration-select"]', 'github')
    await waitFor(
      () => container.querySelector('[data-testid="trigger-select"] option[value="onPush"]') !== null
    )
    await selectOption(container, '[data-testid="trigger-select"]', 'onPush')

    await waitFor(() => container.querySelector('#prop-branch') !== null)
    await setInputValue(container, '#prop-branch', 'main')
    await setInputValue(container, '#binding-prompt', 'Announce every push in the dev channel.')

    await waitFor(
      () => container.querySelector<HTMLSelectElement>('#action-connection-select')?.options.length === 2
    )
    await selectOption(container, '#action-connection-select', 'conn_github_1')

    await clickSubmit(container)

    const createRequest = requests.find(
      (request) =>
        request.method === 'POST' && request.url.includes('/api/v1/trigger-bindings')
    )
    expect(createRequest).toBeTruthy()
    expect(createRequest?.body).toEqual({
      pieceName: 'github',
      pieceVersion: '0.3.4',
      triggerName: 'onPush',
      connectionId: 'conn_github_1',
      promptTemplate: 'Announce every push in the dev channel.',
      settings: { branch: 'main' },
      status: 'ENABLED',
    })

    await waitFor(() => container.textContent?.includes('binding detail') === true)
  }, 20000)

  it('blocks submission when required fields are missing', async () => {
    const requests = installApi()
    const container = renderForm()

    await waitFor(
      () => container.querySelector('[data-testid="source-integration-select"] option[value="github"]') !== null
    )

    await selectOption(container, '[data-testid="source-integration-select"]', 'github')
    await waitFor(
      () => container.querySelector('[data-testid="trigger-select"] option[value="onPush"]') !== null
    )
    await selectOption(container, '[data-testid="trigger-select"]', 'onPush')
    await waitFor(() => container.querySelector('#binding-prompt') !== null)

    await clickSubmit(container)

    expect(
      requests.some((request) => request.url.includes('/api/v1/trigger-bindings') && request.method === 'POST')
    ).toBe(false)
    expect(container.textContent).toContain('This trigger requires a connection.')
  }, 15000)

  it('rejects invalid advanced cron expressions without calling the API', async () => {
    const requests = installApi()
    const container = renderForm()

    await waitFor(
      () => container.querySelector('[data-testid="source-integration-select"] option[value="github"]') !== null
    )
    await selectOption(container, '[data-testid="source-integration-select"]', 'github')
    await waitFor(
      () => container.querySelector('[data-testid="trigger-select"] option[value="newIssue"]') !== null
    )
    await selectOption(container, '[data-testid="trigger-select"]', 'newIssue')

    await setInputValue(container, '#binding-cron', 'definitely-not-cron')
    await setInputValue(container, '#binding-prompt', 'Poll and summarize.')
    await selectOption(container, '#action-connection-select', 'conn_github_1')

    await clickSubmit(container)

    expect(
      requests.some((request) => request.url.includes('/api/v1/trigger-bindings') && request.method === 'POST')
    ).toBe(false)
  }, 15000)

  it('surfaces API failures without leaking internals or navigating', async () => {
    const requests = installApi({ createStatus: 500 })
    const container = renderForm()

    await waitFor(
      () => container.querySelector('[data-testid="source-integration-select"] option[value="github"]') !== null
    )
    await selectOption(container, '[data-testid="source-integration-select"]', 'github')
    await waitFor(
      () => container.querySelector('[data-testid="trigger-select"] option[value="newIssue"]') !== null
    )
    await selectOption(container, '[data-testid="trigger-select"]', 'newIssue')
    await setInputValue(container, '#binding-prompt', 'Summarize new issues.')
    await selectOption(container, '#action-connection-select', 'conn_github_1')

    await clickSubmit(container)

    await waitFor(
      () => container.querySelector('[data-testid="form-general-error"]') !== null
    )
    expect(container.textContent).toContain('piece version is not available')
    expect(container.textContent).toContain('Create Trigger Binding')
    expect(
      requests.some((request) => request.url.includes('/api/v1/trigger-bindings') && request.method === 'POST')
    ).toBe(true)
  }, 15000)
})

function renderForm(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/automations/triggers/new']}>
        <Routes>
          <Route path="/automations/triggers/new" element={<NewTriggerBindingPage />} />
          <Route path="/automations/triggers/:id" element={<div>binding detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
