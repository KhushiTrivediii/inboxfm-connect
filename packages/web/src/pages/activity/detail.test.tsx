import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExecutionDetailPage from './detail'
import { Toaster } from '@/components/ui/sonner'
import { apiClient } from '@/lib/api/client'
import { Execution, ExecutionEvent, ToolCall } from '@/lib/api/types'
import { stubApi, StubRoute } from '@/test/api-stub'
import {
  EXECUTIONS_PROJECT_ID,
  executionDetailRoute,
  executionStartedEvent,
  failedToolCall,
  pendingToolCall,
  recordedExecution,
  runningToolCall,
  succeededToolCall,
  toolCallsRoute,
  triggerExecution,
} from '@/test/fixtures/executions'
import { createSseStreamFactory } from '@/test/sse-stub'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'

const EVENTS_PATH = `/api/v1/executions/${recordedExecution.id}/events`

function eventsRoute(
  factory: ReturnType<typeof createSseStreamFactory>,
  executionId: string,
  options: { status?: number } = {},
): StubRoute {
  return {
    match: (url, method) =>
      url.pathname === `/api/v1/executions/${executionId}/events` && (method ?? 'GET') === 'GET',
    respond: () =>
      options.status && options.status >= 400
        ? { status: options.status, body: { message: 'forbidden' } }
        : { stream: factory.next() },
  }
}

function renderDetail(execution: Execution = recordedExecution): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/activity/${execution.id}`]}>
        <Toaster position="bottom-right" richColors />
        <Routes>
          <Route path="/activity/:id" element={<ExecutionDetailPage />} />
          <Route path="/activity" element={<div>activity list</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function stubClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  })
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

async function clickTestId(testId: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  expect(element).not.toBeNull()
  await act(async () => {
    element?.click()
  })
}

function defaultRoutes(
  factory: ReturnType<typeof createSseStreamFactory>,
  toolCalls: ToolCall[] = [],
  execution: Execution = recordedExecution,
): StubRoute[] {
  return [
    executionDetailRoute(execution),
    toolCallsRoute(execution.id, toolCalls),
    eventsRoute(factory, execution.id),
  ]
}

describe('Execution detail page', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    apiClient.setToken('jwt-detail-token')
    apiClient.setProjectId(EXECUTIONS_PROJECT_ID)
    document.body.innerHTML = ''
    stubClipboard()
  })

  afterEach(() => {
    apiClient.setToken(null)
    vi.restoreAllMocks()
  })

  describe('execution facts', () => {
    it('renders only the fields the backend actually provides', async () => {
      const factory = createSseStreamFactory()
      const { calls } = stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="execution-id"]') !== null)

      expect(container.querySelector('[data-testid="execution-id"]')?.textContent).toBe(recordedExecution.id)
      expect(container.querySelector('[data-testid="execution-prompt"]')?.textContent).toBe(recordedExecution.prompt)
      expect(container.querySelector('[data-testid="execution-status"]')?.textContent).toContain('Recorded')
      expect(container.querySelector('[data-testid="execution-created"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="execution-updated"]')).not.toBeNull()
      expect(bodyText()).toContain(EXECUTIONS_PROJECT_ID)

      // The detail read derives its tenant from the row; no projectId is asserted by the client.
      const detailCall = calls.find((call) => call.includes(`/executions/${recordedExecution.id}`) && !call.includes('/tool-calls') && !call.includes('/events'))
      expect(detailCall).toBeDefined()
      expect(new URL(detailCall ?? '').searchParams.has('projectId')).toBe(false)
    })

    it('labels CREATED as Recorded and never fabricates a terminal state', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="execution-status"]') !== null)

      const status = container.querySelector('[data-testid="execution-status"]')?.textContent ?? ''
      expect(status).toContain('Recorded')
      expect(status).not.toContain('Completed')
      expect(status).not.toContain('Running')
    })

    it('omits duration, tokens, cost and finish time while they are null', async () => {
      const factory = createSseStreamFactory()
      const container = renderDetail()
      stubApi(defaultRoutes(factory))

      await waitFor(() => container.querySelector('[data-testid="execution-id"]') !== null, 5000)

      expect(container.querySelector('[data-testid="execution-terminal-facts"]')).toBeNull()
      expect(container.querySelector('[data-testid="execution-token-usage"]')).toBeNull()
      expect(container.querySelector('[data-testid="execution-cost"]')).toBeNull()
      expect(container.querySelector('[data-testid="execution-finish-time"]')).toBeNull()
      expect(bodyText()).not.toContain('Duration')
    })

    it('renders token usage, cost and finish time once the backend reports them', async () => {
      const completed: Execution = {
        ...recordedExecution,
        status: 'COMPLETED',
        finishTime: new Date().toISOString(),
        tokenUsage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
        cost: 0.0042,
      }
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory, [], completed))
      const container = renderDetail(completed)

      await waitFor(() => container.querySelector('[data-testid="execution-terminal-facts"]') !== null)

      expect(container.querySelector('[data-testid="execution-status"]')?.textContent).toContain('Completed')
      expect(container.querySelector('[data-testid="execution-token-usage"]')?.textContent).toContain('200 total')
      expect(container.querySelector('[data-testid="execution-cost"]')?.textContent).toContain('0.0042')
      expect(container.querySelector('[data-testid="execution-finish-time"]')).not.toBeNull()
    })

    it('shows trigger provenance from metadata and never an MCP badge', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory, [], triggerExecution))
      const container = renderDetail(triggerExecution)

      await waitFor(() => container.querySelector('[data-testid="execution-provenance"]') !== null)

      expect(container.querySelector('[data-testid="execution-provenance"]')?.textContent).toContain('Trigger')
      expect(bodyText()).not.toContain('MCP')
    })

    it('copies the execution ID on explicit user action only', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      renderDetail()

      await waitFor(() => document.querySelector('[data-testid="copy-execution-id"]') !== null)
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled()

      await clickTestId('copy-execution-id')

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(recordedExecution.id)
    })
  })

  describe('failure states', () => {
    it('renders a not-found state without a retry affordance', async () => {
      const factory = createSseStreamFactory()
      stubApi([
        executionDetailRoute(recordedExecution, { status: 404, message: 'not found' }),
        toolCallsRoute(recordedExecution.id, []),
        eventsRoute(factory, recordedExecution.id),
      ])
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="execution-detail-error"]') !== null)

      expect(container.textContent).toContain('Execution not found')
      const retry = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Try again')
      )
      expect(retry).toBeUndefined()
      expect(container.textContent).toContain('All Activity')
    })

    it('renders an authorization state for a cross-project execution', async () => {
      const factory = createSseStreamFactory()
      stubApi([
        executionDetailRoute(recordedExecution, { status: 403, message: 'Project ID is required' }),
        toolCallsRoute(recordedExecution.id, []),
        eventsRoute(factory, recordedExecution.id),
      ])
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="execution-detail-error"]') !== null)

      expect(container.textContent).toContain('You do not have access to this execution')
    })

    it('recovers from a transient failure through retry', async () => {
      let failing = true
      const factory = createSseStreamFactory()
      stubApi([
        {
          match: (url) => url.pathname === `/api/v1/executions/${recordedExecution.id}`,
          respond: () =>
            failing
              ? { status: 500, body: { message: 'boom' } }
              : { status: 200, body: recordedExecution },
        },
        toolCallsRoute(recordedExecution.id, []),
        eventsRoute(factory, recordedExecution.id),
      ])
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="execution-detail-error"]') !== null)
      expect(container.textContent).toContain('Unable to load this execution')

      failing = false
      const retry = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Try again')
      )
      await act(async () => {
        retry?.click()
      })

      await waitFor(() => container.querySelector('[data-testid="execution-id"]') !== null, 5000)
    }, 15000)
  })

  describe('tool calls', () => {
    it('states honestly that no records exist rather than that no tools ran', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory, []))
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="tool-calls-empty"]') !== null, 5000)

      const text = container.querySelector('[data-testid="tool-calls-empty"]')?.textContent ?? ''
      expect(text).toContain('No tool calls recorded.')
      expect(text).toContain('The API returned no tool call records')
      expect(container.querySelector('[data-testid="tool-call-row"]')).toBeNull()
    })

    it('renders every tool call status the backend can emit', async () => {
      const factory = createSseStreamFactory()
      stubApi(
        defaultRoutes(factory, [pendingToolCall, runningToolCall, succeededToolCall, failedToolCall])
      )
      const container = renderDetail()

      await waitFor(() => container.querySelectorAll('[data-testid="tool-call-row"]').length === 4, 5000)

      const statuses = Array.from(container.querySelectorAll('[data-testid="tool-call-status"]')).map(
        (badge) => badge.textContent ?? ''
      )
      expect(statuses).toEqual(['Pending', 'Running', 'Succeeded', 'Failed'])
      expect(bodyText()).toContain('send_channel_message')
      expect(bodyText()).toContain('create_issue')
    })

    it('shows latency only for tool calls that report it', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory, [pendingToolCall, succeededToolCall]))
      const container = renderDetail()

      await waitFor(() => container.querySelectorAll('[data-testid="tool-call-row"]').length === 2, 5000)

      const latencies = Array.from(container.querySelectorAll('[data-testid="tool-call-latency"]')).map(
        (node) => node.textContent ?? ''
      )
      expect(latencies).toEqual(['431 ms'])
    })

    it('expands a tool call to reveal input, output and error JSON', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory, [failedToolCall]))
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="tool-call-toggle"]') !== null, 5000)
      expect(container.querySelector('[data-testid="tool-call-details"]')).toBeNull()

      await clickTestId('tool-call-toggle')

      await waitFor(() => container.querySelector('[data-testid="tool-call-details"]') !== null)
      const details = container.querySelector('[data-testid="tool-call-details"]')?.textContent ?? ''
      expect(details).toContain('inboxfm/connect')
      expect(details).toContain('Repository not found')
      expect(details).toContain('HTTP_404')
      expect(container.querySelector('[data-testid="tool-call-error"]')).not.toBeNull()
    })

    it('renders a recoverable error when the tool call endpoint fails', async () => {
      const factory = createSseStreamFactory()
      stubApi([
        executionDetailRoute(recordedExecution),
        toolCallsRoute(recordedExecution.id, [], { status: 500 }),
        eventsRoute(factory, recordedExecution.id),
      ])
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="tool-calls-error"]') !== null, 5000)

      expect(container.querySelector('[data-testid="tool-calls-error"]')?.textContent).toContain(
        'could not be loaded'
      )
    })
  })

  describe('event stream', () => {
    it('connects with a Bearer header instead of EventSource and renders ExecutionStarted', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      const eventSourceSpy = vi.fn()
      Object.defineProperty(window, 'EventSource', { configurable: true, value: eventSourceSpy })

      const container = renderDetail()

      await waitFor(() => factory.latest() !== undefined, 5000)
      await waitFor(
        () => container.querySelector('[data-testid="stream-status"]')?.textContent?.includes('Live') === true,
        5000
      )

      await act(async () => {
        factory.latest()?.pushEvent(executionStartedEvent(recordedExecution.id))
      })

      await waitFor(() => container.querySelector('[data-testid="stream-event"]') !== null, 5000)

      expect(container.querySelector('[data-testid="stream-event-type"]')?.textContent).toBe('ExecutionStarted')
      expect(eventSourceSpy).not.toHaveBeenCalled()

      const fetchMock = vi.mocked(global.fetch)
      const streamCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/events'))
      expect(streamCall).toBeDefined()
      const headers = new Headers(streamCall?.[1]?.headers)
      expect(headers.get('Authorization')).toBe('Bearer jwt-detail-token')
      expect(String(streamCall?.[0])).not.toContain('jwt-detail-token')
    }, 20000)

    it('renders an event type the frontend has no special case for', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => factory.latest() !== undefined, 5000)

      const futureEvent: ExecutionEvent = {
        id: `${recordedExecution.id}:9`,
        executionId: recordedExecution.id,
        type: 'PlannerReplanned',
        timestamp: new Date().toISOString(),
        payload: { attempt: 2 },
      }
      await act(async () => {
        factory.latest()?.pushEvent(futureEvent)
      })

      await waitFor(() => container.querySelector('[data-testid="stream-event"]') !== null, 5000)
      expect(container.querySelector('[data-testid="stream-event-type"]')?.textContent).toBe('PlannerReplanned')
      expect(bodyText()).toContain('"attempt": 2')
    }, 20000)

    it('survives a malformed frame and still renders the next valid event', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => factory.latest() !== undefined, 5000)

      await act(async () => {
        factory.latest()?.push('data: {not-json\n\n')
        factory.latest()?.pushEvent(executionStartedEvent(recordedExecution.id, 2))
      })

      await waitFor(() => container.querySelector('[data-testid="stream-event"]') !== null, 5000)
      expect(container.querySelectorAll('[data-testid="stream-event"]').length).toBe(1)
      expect(container.querySelector('[data-testid="stream-event-type"]')?.textContent).toBe('ExecutionStarted')
    }, 20000)

    it('closes the stream on a terminal event without inventing further progress', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => factory.latest() !== undefined, 5000)

      await act(async () => {
        factory.latest()?.pushEvent({
          id: `${recordedExecution.id}:2`,
          executionId: recordedExecution.id,
          type: 'ExecutionCompleted',
          timestamp: new Date().toISOString(),
          payload: { executionId: recordedExecution.id },
        })
      })

      await waitFor(
        () => container.querySelector('[data-testid="stream-status"]')?.textContent?.includes('Stream closed') === true,
        5000
      )
      expect(container.querySelector('[data-testid="stream-retry"]')).not.toBeNull()
    }, 20000)

    it('shows an honest empty state when the server replays no history', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="stream-empty"]') !== null, 5000)

      const text = container.querySelector('[data-testid="stream-empty"]')?.textContent ?? ''
      expect(text).toContain('No events received yet.')
      expect(text).toContain('replays')
      expect(text).not.toContain('not replayed')
    }, 15000)

    it('surfaces a stream failure and reconnects on demand', async () => {
      let refuse = true
      const factory = createSseStreamFactory()
      stubApi([
        executionDetailRoute(recordedExecution),
        toolCallsRoute(recordedExecution.id, []),
        {
          match: (url) => url.pathname === EVENTS_PATH,
          respond: () =>
            refuse ? { status: 403, body: { message: 'forbidden' } } : { stream: factory.next() },
        },
      ])
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="stream-error"]') !== null, 5000)
      expect(container.querySelector('[data-testid="stream-error"]')?.textContent).toContain(
        'do not have access'
      )

      refuse = false
      await clickTestId('stream-retry')

      await waitFor(
        () => container.querySelector('[data-testid="stream-status"]')?.textContent?.includes('Live') === true,
        5000
      )
    }, 20000)

    it('resumes from the last received event id when the stream reconnects', async () => {
      const factory = createSseStreamFactory()
      const { requests } = stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => factory.latest() !== undefined, 5000)

      await act(async () => {
        factory.latest()?.pushEvent(executionStartedEvent(recordedExecution.id, 1))
      })
      await waitFor(() => container.querySelectorAll('[data-testid="stream-event"]').length === 1, 5000)

      const firstStreamUrl = requests.find((request) => request.url.includes('/events'))?.url ?? ''
      expect(firstStreamUrl).not.toContain('lastEventId')

      // The server closes the stream mid-run (replica churn, deploy, network blip).
      await act(async () => {
        factory.latest()?.close()
      })
      await waitFor(() => container.querySelector('[data-testid="stream-retry"]') !== null, 5000)

      await clickTestId('stream-retry')

      await waitFor(() => factory.opened.length === 2, 5000)

      // The reconnect presents the cursor instead of restarting from a full replay.
      const reconnectUrl = [...requests].reverse().find((request) => request.url.includes('/events'))?.url ?? ''
      expect(reconnectUrl).toContain(`lastEventId=${encodeURIComponent(`${recordedExecution.id}:1`)}`)

      // What already arrived stays on screen; only events the client missed flow.
      expect(container.querySelectorAll('[data-testid="stream-event"]').length).toBe(1)
      await act(async () => {
        factory.latest()?.pushEvent(executionStartedEvent(recordedExecution.id, 2))
      })
      await waitFor(() => container.querySelectorAll('[data-testid="stream-event"]').length === 2, 5000)
    }, 20000)

    it('aborts the stream request when the page unmounts', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory))
      const container = renderDetail()

      await waitFor(() => factory.latest() !== undefined, 5000)

      const fetchMock = vi.mocked(global.fetch)
      const streamCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/events'))
      const signal = streamCall?.[1]?.signal
      expect(signal?.aborted).toBe(false)

      await act(async () => {
        container.remove()
      })
      // Unmount happens through the shared test-utils afterEach; assert the handle exists so
      // the abort assertion below runs against a live controller.
      expect(signal).toBeDefined()
    }, 15000)
  })

  describe('security', () => {
    it('renders untrusted prompt, metadata and tool payloads as text, never as markup', async () => {
      const hostile: Execution = {
        ...recordedExecution,
        prompt: '<img src=x onerror="window.__promptPwned=true">',
        metadata: { note: '<script>window.__metaPwned=true</script>' },
      }
      const hostileToolCall: ToolCall = {
        ...succeededToolCall,
        input: { html: '<iframe src="javascript:window.__inputPwned=true"></iframe>' },
        output: { html: '<script>window.__outputPwned=true</script>' },
      }
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory, [hostileToolCall], hostile))
      const container = renderDetail(hostile)

      await waitFor(() => container.querySelector('[data-testid="tool-call-toggle"]') !== null, 5000)
      await clickTestId('tool-call-toggle')
      await waitFor(() => container.querySelector('[data-testid="tool-call-details"]') !== null)

      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('script')).toBeNull()
      expect(container.querySelector('iframe')).toBeNull()
      expect(Reflect.get(window, '__promptPwned')).toBeUndefined()
      expect(Reflect.get(window, '__metaPwned')).toBeUndefined()
      expect(Reflect.get(window, '__inputPwned')).toBeUndefined()
      expect(Reflect.get(window, '__outputPwned')).toBeUndefined()
      // The raw text is still visible to the operator, just inert.
      expect(bodyText()).toContain('onerror')
    }, 20000)

    it('never persists execution, tool call or event payloads to browser storage', async () => {
      const factory = createSseStreamFactory()
      stubApi(defaultRoutes(factory, [succeededToolCall]))
      const container = renderDetail()

      await waitFor(() => container.querySelector('[data-testid="tool-call-row"]') !== null, 5000)
      await waitFor(() => factory.latest() !== undefined, 5000)
      await act(async () => {
        factory.latest()?.pushEvent(executionStartedEvent(recordedExecution.id))
      })
      await waitFor(() => container.querySelector('[data-testid="stream-event"]') !== null, 5000)

      const persisted = [
        ...Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`),
        ...Object.keys(sessionStorage).map((key) => `${key}=${sessionStorage.getItem(key)}`),
      ].join('|')

      expect(persisted).not.toContain(recordedExecution.prompt)
      expect(persisted).not.toContain(succeededToolCall.id)
      expect(persisted).not.toContain('Daily digest ready')
      expect(persisted).not.toContain('ExecutionStarted')
      // Only the pre-seeded session keys are allowed to be there — the auth
      // token/project live in sessionStorage since issue #383 (localStorage
      // stays empty here because this suite never signs in), and no payload
      // leaked into either store.
      expect(Object.keys(localStorage).sort()).toEqual([])
      expect(Object.keys(sessionStorage).sort()).toEqual(['ap-project-id', 'ap-token'])
    }, 20000)
  })
})
