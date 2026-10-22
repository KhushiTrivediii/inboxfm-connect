import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import ActionDetailPage from './detail'
import { apiClient } from '@/lib/api/client'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { stubApi, StubRequestRecord, StubResponse, StubRoute } from '@/test/api-stub'
import {
  githubConnection,
  runnerMetadata,
  seekPage,
} from '@/test/fixtures/integrations'

const CONNECTION_ID = 'conn_runner_1'

function routes(options: {
  execute?: () => StubResponse
  integrationNotFound?: boolean
} = {}): StubRoute[] {
  return [
    {
      match: (url) => url.pathname === '/api/v1/integrations/runner',
      respond: () =>
        options.integrationNotFound
          ? { status: 404, body: { message: 'not found' } }
          : { status: 200, body: runnerMetadata() },
    },
    {
      match: (url) => url.pathname === '/api/v1/connections',
      respond: () => ({
        status: 200,
        body: seekPage([
          githubConnection(CONNECTION_ID, 'Mihir Runner'),
          githubConnection('conn_err_1', 'Broken Runner', { status: 'ERROR' }),
        ]),
      }),
    },
    {
      match: (url) => url.pathname === '/api/v1/integrations/options',
      respond: () => ({ status: 200, body: { options: [] } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/execute',
      respond: () =>
        options.execute
          ? options.execute()
          : {
              // POST /v1/execute returns the RAW action output, not an envelope.
              status: 200,
              body: { id: 42, url: 'https://example.com/items/42' },
            },
    },
  ]
}

function renderRunner(
  _stubRoutes: StubRoute[] = routes(),
  initialRoute = '/actions/runner/createItem'
): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route path="/actions/:pieceName/:actionName" element={<ActionDetailPage />} />
          <Route path="/integrations/:name" element={<div>integration detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function setInputValue(
  container: HTMLElement,
  selector: string,
  value: string,
  event = 'input'
): Promise<void> {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(selector)
  expect(element).not.toBeNull()
  await act(async () => {
    const proto = element instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
    setter?.call(element, value)
    element?.dispatchEvent(new Event(event, { bubbles: true }))
  })
}

async function toggleCheckbox(container: HTMLElement, selector: string): Promise<void> {
  const element = container.querySelector<HTMLInputElement>(selector)
  expect(element).not.toBeNull()
  await act(async () => {
    element?.click()
  })
}

async function clickButton(container: HTMLElement, label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(label)
  )
  expect(button).toBeTruthy()
  await act(async () => {
    button?.click()
  })
}

function executeCalls(requests: StubRequestRecord[]): StubRequestRecord[] {
  return requests.filter((request) => request.url.includes('/api/v1/execute'))
}

describe('Action runner', () => {
  beforeEach(() => {
    localStorage.clear()
    apiClient.setProjectId(null)
    document.body.innerHTML = ''
  })

  it('loads metadata, shows auth requirement, connection picker and schema form', async () => {
    stubApi(routes())
    const container = renderRunner()

    await waitFor(() => container.textContent?.includes('Create Item') === true)

    const text = container.textContent || ''
    expect(text).toContain('Runner')
    expect(text).toContain('OAuth 2.0')
    expect(text).toContain('Connection')
    expect(container.querySelector('#action-connection-select')).not.toBeNull()
    expect(container.querySelector('#prop-title')).not.toBeNull()
    await waitFor(() => container.querySelector('#prop-project') !== null)
    expect(container.querySelector('#prop-count')).not.toBeNull()
    expect(container.querySelector('#prop-publish')).not.toBeNull()
    expect(container.querySelector('#prop-priority')).not.toBeNull()
  }, 15000)

  it('shows a distinct state for an unknown action', async () => {
    stubApi(routes())
    const container = renderRunner(routes(), '/actions/runner/doesNotExist')

    await waitFor(
      () => container.textContent?.includes('Action not found') === true,
      5000
    )
    expect(container.textContent).toContain('"doesNotExist" is not an action of Runner.')
  }, 15000)

  it('does not auto-select an errored connection when no healthy one exists', async () => {
    stubApi([
      {
        match: (url) => url.pathname === '/api/v1/integrations/runner',
        respond: () => ({ status: 200, body: runnerMetadata() }),
      },
      {
        match: (url) => url.pathname === '/api/v1/connections',
        respond: () => ({
          status: 200,
          body: seekPage([githubConnection('conn_err_only', 'Broken Runner', { status: 'ERROR' })]),
        }),
      },
      {
        match: (url) => url.pathname === '/api/v1/integrations/options',
        respond: () => ({ status: 200, body: { options: [] } }),
      },
    ])
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)
    // The picker renders the errored connection as a DISABLED option and shows
    // the empty placeholder. Auto-select must not arm a credential the UI itself
    // refuses to let the user pick.
    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return !!select && select.options.length > 1
    })
    const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
    expect(select?.value).toBe('')
    const erroredOption = Array.from(select?.options ?? []).find(
      (option) => option.value === 'conn_err_only'
    )
    expect(erroredOption?.disabled).toBe(true)
  }, 15000)

  it('executes with correctly serialized values and renders the result', async () => {
    // The backend resolves the tenant from the request BODY for /v1/execute.
    apiClient.setProjectId('proj_runner_1')
    const { requests } = stubApi(routes())
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)

    await setInputValue(container, '#prop-title', 'OAuth refresh bug')
    await setInputValue(container, '#prop-count', '3')
    await toggleCheckbox(container, '#prop-publish')
    await setInputValue(container, '#prop-priority', 'high', 'change')

    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return select?.value === CONNECTION_ID
    })

    await clickButton(container, 'Execute Tool')

    await waitFor(() => executeCalls(requests).length === 1, 6000)

    const executed = executeCalls(requests)[0]
    expect(executed.body).toEqual({
      projectId: 'proj_runner_1',
      integration: 'runner',
      tool: 'createItem',
      connectionId: CONNECTION_ID,
      input: {
        title: 'OAuth refresh bug',
        count: 3,
        publish: true,
        priority: 'high',
      },
    })

    await waitFor(
      () => container.querySelector('[data-testid="execution-success"]') !== null,
      6000
    )
    expect(container.textContent).toContain('Success')
    expect(container.textContent).toContain('"id": 42')
    expect(container.textContent).toContain('Duration:')
    expect(container.textContent).toContain('Run Again')
  }, 20000)

  it('blocks execution and shows field errors when required input is missing', async () => {
    const { requests } = stubApi(routes())
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)
    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return select?.value === CONNECTION_ID
    })

    await clickButton(container, 'Execute Tool')

    await waitFor(() => container.textContent?.includes('Title is required') === true)
    expect(executeCalls(requests).length).toBe(0)
    expect(container.textContent).toContain('Fix the highlighted fields before executing.')
  }, 15000)

  it('treats an arbitrary raw action payload as a successful execution', async () => {
    stubApi(routes({ execute: () => ({ status: 200, body: { foo: 'bar' } }) }))
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)
    await setInputValue(container, '#prop-title', 'raw payload')
    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return select?.value === CONNECTION_ID
    })
    await clickButton(container, 'Execute Tool')

    await waitFor(
      () => container.querySelector('[data-testid="execution-success"]') !== null,
      6000
    )
    expect(container.textContent).toContain('Success')
    expect(container.textContent).toContain('"foo": "bar"')
  }, 20000)

  it('does not treat a payload property named success as a framework failure flag', async () => {
    stubApi(
      routes({
        execute: () => ({
          status: 200,
          body: { success: false, message: 'the action itself reports a soft failure' },
        }),
      })
    )
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)
    await setInputValue(container, '#prop-title', 'soft failure')
    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return select?.value === CONNECTION_ID
    })
    await clickButton(container, 'Execute Tool')

    await waitFor(
      () => container.querySelector('[data-testid="execution-success"]') !== null,
      6000
    )
    expect(container.querySelector('[data-testid="execution-failed"]')).toBeNull()
    expect(container.textContent).toContain('"success": false')
    expect(container.textContent).toContain('the action itself reports a soft failure')
    // No `standardOutput` surface exists in the real contract.
    expect(container.querySelector('[data-testid="execution-stdout"]')).toBeNull()
  }, 20000)

  it('renders an honest empty-output state when the action returns nothing', async () => {
    stubApi(routes({ execute: () => ({ status: 200, body: null }) }))
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)
    await setInputValue(container, '#prop-title', 'no output')
    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return select?.value === CONNECTION_ID
    })
    await clickButton(container, 'Execute Tool')

    await waitFor(
      () => container.querySelector('[data-testid="execution-success"]') !== null,
      6000
    )
    expect(container.textContent).toContain('Success')
  }, 20000)

  it('normalizes transport failures without leaking internals and supports Run Again', async () => {
    let fail = true
    const { requests } = stubApi(
      routes({
        execute: () =>
          fail
            ? { status: 500, body: { message: 'worker crashed' } }
            : { status: 200, body: { ok: true } },
      })
    )
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)
    await setInputValue(container, '#prop-title', 'retry me')
    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return select?.value === CONNECTION_ID
    })
    await clickButton(container, 'Execute Tool')

    await waitFor(
      () => container.querySelector('[data-testid="execution-transport-error"]') !== null,
      6000
    )

    fail = false
    await clickButton(container, 'Run Again')

    await waitFor(
      () => container.querySelector('[data-testid="execution-success"]') !== null,
      6000
    )
    expect(executeCalls(requests).length).toBe(2)
  }, 20000)

  it('never exposes secrets in the request preview, code snippets or URLs', async () => {
    const { calls, requests } = stubApi(routes())
    const container = renderRunner()

    await waitFor(() => container.querySelector('#prop-title') !== null)
    await setInputValue(container, '#prop-title', 'secret leak probe')
    await setInputValue(container, '#prop-token', 'sk-super-secret-value')
    await waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>('#action-connection-select')
      return select?.value === CONNECTION_ID
    })
    await clickButton(container, 'Execute Tool')

    await waitFor(() => executeCalls(requests).length === 1, 6000)

    // No credential material ever travels in a URL.
    for (const call of calls) {
      expect(call).not.toContain('sk-super-secret-value')
      expect(call).not.toContain(CONNECTION_ID)
    }

    // Request preview redacts the secret property and the connection id.
    await clickButton(container, 'Request')
    await waitFor(() => container.querySelector('[data-testid="request-preview"] pre') !== null)
    const previewText = container.querySelector('[data-testid="request-preview"]')?.textContent ?? ''
    expect(previewText).toContain('$SECRET')
    expect(previewText).toContain('$CONNECTION_ID')
    expect(previewText).not.toContain('sk-super-secret-value')
    expect(previewText).not.toContain(CONNECTION_ID)

    // Code snippets use placeholders only.
    const snippets = container.querySelector('[data-testid="code-snippets"]')?.textContent ?? ''
    expect(snippets).toContain('$API_KEY')
    expect(snippets).toContain('$CONNECTION_ID')
    expect(snippets).not.toContain('sk-super-secret-value')
    expect(snippets).not.toContain(CONNECTION_ID)

    expect(window.location.search).not.toContain('secret')
  }, 20000)
})
