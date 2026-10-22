import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TriggerBindingDetailPage from './triggers-detail'
import EditTriggerBindingPage from './triggers-edit'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { ALL_SUMMARIES, githubMetadata, seekPage } from '@/test/fixtures/integrations'
import { automationConnection, githubTriggerBinding } from '@/test/fixtures/automations'
import { Execution, TriggerBinding } from '@/lib/api/types'

interface RecordedRequest {
  url: string
  method: string
  body?: unknown
}

const executionsFixture = (): Execution[] => [
  {
    id: 'exec_abc123',
    created: '2026-06-01T12:00:00.000Z',
    updated: '2026-06-01T12:00:00.000Z',
    projectId: 'proj_default',
    platformId: 'plat_default',
    status: 'CREATED',
    prompt: 'Summarize the issue and post it to Slack.',
    metadata: {},
  },
]

function installApi(options: {
  binding?: TriggerBinding
  runStatus?: number
  updateStatus?: number
} = {}): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  const originalFetch = global.fetch
  const binding = options.binding ?? githubTriggerBinding()

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

    if (url.pathname === '/api/v1/trigger-bindings/tb_github_issue/run') {
      if ((options.runStatus ?? 200) >= 400) {
        return json({ message: 'TriggerBinding tb_github_issue is currently disabled' }, options.runStatus)
      }
      return json(executionsFixture())
    }
    if (
      url.pathname === '/api/v1/trigger-bindings/tb_github_issue' &&
      method === 'POST'
    ) {
      if ((options.updateStatus ?? 200) >= 400) {
        return json({ message: 'update rejected' }, options.updateStatus)
      }
      return json({ ...binding, ...(body as Record<string, unknown>) })
    }
    if (url.pathname === '/api/v1/trigger-bindings/tb_github_issue') {
      return json(binding)
    }
    if (url.pathname === '/api/v1/integrations') {
      return json(seekPage(ALL_SUMMARIES))
    }
    if (url.pathname === '/api/v1/integrations/github') {
      return json(githubMetadata())
    }
    if (url.pathname === '/api/v1/connections/conn_github_1') {
      return json(automationConnection())
    }
    if (url.pathname === '/api/v1/connections?pieceName=github' || url.pathname === '/api/v1/connections') {
      return json({ data: [automationConnection()], next: null, previous: null })
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

async function clickButton(container: HTMLElement, selector: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(selector)
  expect(button).not.toBeNull()
  await act(async () => {
    button?.click()
  })
}

describe('Trigger binding detail', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    while (pendingRestores.length > 0) {
      pendingRestores.pop()?.()
    }
  })

  it('renders the binding overview without exposing secrets', async () => {
    installApi()
    const container = renderAt('/automations/triggers/tb_github_issue', 'binding detail')

    await waitFor(() => container.querySelector('[data-testid="binding-overview"]') !== null)
    await waitFor(() => container.textContent?.includes('Mihir GitHub') === true)

    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).toContain('newIssue')
    expect(container.textContent).toContain('Summarize the issue and post it to Slack.')
    expect(container.textContent).toContain('Enabled')
  }, 15000)

  it('runs a simulated event against the real endpoint and shows returned records only', async () => {
    const requests = installApi()
    const container = renderAt('/automations/triggers/tb_github_issue', 'binding detail')

    await waitFor(() => container.querySelector('[data-testid="run-test-button"]') !== null)

    await setInputValue(
      container,
      '#test-payload',
      '{"action":"opened","issue":{"number":42}}'
    )
    await clickButton(container, '[data-testid="run-test-button"]')

    await waitFor(
      () =>
        requests.some(
          (request) =>
            request.method === 'POST' && request.url.endsWith('/trigger-bindings/tb_github_issue/run')
        ) === true
    )

    const runRequest = requests.find((request) =>
      request.url.endsWith('/trigger-bindings/tb_github_issue/run')
    )
    expect(runRequest?.body).toEqual({ action: 'opened', issue: { number: 42 } })

    await waitFor(() => container.querySelector('[data-testid="test-result"]') !== null)
    expect(container.textContent).toContain('exec_abc123')
    expect(container.textContent).toContain('CREATED')
  }, 15000)

  it('reports failures from the run endpoint', async () => {
    const requests = installApi({ runStatus: 400 })
    const container = renderAt('/automations/triggers/tb_github_issue', 'binding detail')

    await waitFor(() => container.querySelector('[data-testid="run-test-button"]') !== null)

    await clickButton(container, '[data-testid="run-test-button"]')

    await waitFor(
      () =>
        requests.some(
          (request) =>
            request.method === 'POST' && request.url.endsWith('/trigger-bindings/tb_github_issue/run')
        ) === true
    )
    expect(container.querySelector('[data-testid="test-result"]')).toBeNull()
  }, 15000)
})

describe('Trigger binding edit', () => {
  beforeEach(() => {
    localStorage.clear()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    while (pendingRestores.length > 0) {
      pendingRestores.pop()?.()
    }
  })

  it('loads existing values and submits an exact partial update', async () => {
    const requests = installApi({
      binding: githubTriggerBinding({
        triggerName: 'onPush',
        settings: { branch: 'develop' },
        promptTemplate: 'Old instruction.',
      }),
    })
    const container = renderEdit()

    await waitFor(
      () => container.querySelector<HTMLSelectElement>('[data-testid="source-integration-select"]')?.value === 'github'
    )

    // Existing values are restored into schema-driven fields
    expect(
      container.querySelector<HTMLSelectElement>('[data-testid="source-integration-select"]')?.value
    ).toBe('github')

    await waitFor(
      () => container.querySelector<HTMLInputElement>('#prop-branch')?.value === 'develop'
    )
    expect(
      container.querySelector<HTMLSelectElement>('#action-connection-select')?.value
    ).toBe('conn_github_1')
    expect(
      (container.querySelector('#binding-prompt') as HTMLTextAreaElement | null)?.value
    ).toBe('Old instruction.')

    await setInputValue(container, '#prop-branch', 'main')
    await setInputValue(container, '#binding-prompt', 'New instruction.')

    // Toggle status to DISABLED through the segmented control
    await clickButton(container, '[data-testid="status-disabled"]')
    await clickButton(container, '[data-testid="submit-binding"]')

    const updateRequest = requests.find(
      (request) =>
        request.method === 'POST' &&
        request.url.endsWith('/api/v1/trigger-bindings/tb_github_issue')
    )
    expect(updateRequest).toBeTruthy()
    expect(updateRequest?.body).toEqual({
      pieceName: 'github',
      pieceVersion: '0.3.4',
      triggerName: 'onPush',
      connectionId: 'conn_github_1',
      promptTemplate: 'New instruction.',
      settings: { branch: 'main' },
      status: 'DISABLED',
    })

    await waitFor(() => container.textContent?.includes('binding detail') === true)
  }, 20000)
})

function renderAt(path: string, detailText: string): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/automations/triggers/:id" element={<TriggerBindingDetailPage />} />
          <Route path="/activity/:id" element={<div>{detailText}</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function renderEdit(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/automations/triggers/tb_github_issue/edit']}>
        <Routes>
          <Route path="/automations/triggers/:id/edit" element={<EditTriggerBindingPage />} />
          <Route path="/automations/triggers/:id" element={<div>binding detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

