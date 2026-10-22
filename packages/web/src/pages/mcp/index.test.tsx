import { act } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import McpPage from './index'
import { stubApi, StubRoute } from '@/test/api-stub'
import {
  MCP_PROJECT_ID,
  mcpRoutes,
  mcpServer,
} from '@/test/fixtures/mcp'
import { ALL_SUMMARIES, seekPage } from '@/test/fixtures/integrations'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { Toaster } from '@/components/ui/sonner'
import { apiClient } from '@/lib/api/client'

const GENERATED_TOKEN = 'mcp_generated_token_abc123'

function catalogRoute(): StubRoute {
  return {
    match: (url) => url.pathname === '/api/v1/integrations',
    respond: () => ({ status: 200, body: seekPage(ALL_SUMMARIES) }),
  }
}

function renderMcp(): HTMLElement {
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/mcp']}>
        <Toaster position="bottom-right" richColors />
        <Routes>
          <Route path="/mcp" element={<McpPage />} />
          <Route path="/actions" element={<div>actions page</div>} />
          <Route path="/integrations/:name" element={<div>integration detail</div>} />
          <Route path="/activity" element={<div>activity page</div>} />
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

async function clickButton(testId: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
  expect(button).not.toBeNull()
  await act(async () => {
    button?.click()
  })
}

async function clickButtonWithText(text: string): Promise<void> {
  const scope = document.querySelector('[role="dialog"]') ?? document
  const button = Array.from(scope.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  )
  expect(button).not.toBeNull()
  await act(async () => {
    button?.click()
  })
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

async function selectOption(selector: string, value: string): Promise<void> {
  const select = document.querySelector<HTMLSelectElement>(selector)
  expect(select).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select?.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

describe('MCP Hub', () => {
  beforeEach(() => {
    localStorage.clear()
    apiClient.setProjectId(MCP_PROJECT_ID)
    document.body.innerHTML = ''
    stubClipboard()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('MCP server information', () => {
    it('loads and displays the project MCP server from the real endpoint', async () => {
      const { calls } = stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-server-url"]') !== null)

      expect(
        calls.some((call) => call.includes(`/api/v1/projects/${MCP_PROJECT_ID}/mcp-server`) && !call.includes('token'))
      ).toBe(true)

      const urlInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-server-url"]')
      expect(urlInput?.value).toBe(`${window.location.origin}/mcp`)
      expect(container.textContent).toContain('PROJECT')
      expect(container.textContent).toContain('16 of 17 exposed')
    }, 15000)

    it('shows a retryable error state when the server info request fails', async () => {
      let failing = true
      stubApi([
        {
          match: (url) => url.pathname.endsWith('/mcp-server'),
          respond: () =>
            failing
              ? { status: 500, body: { message: 'boom' } }
              : { status: 200, body: mcpServer() },
        },
        ...mcpRoutes(),
        catalogRoute(),
      ])
      const container = renderMcp()

      await waitFor(() => container.textContent?.includes('Could not load the MCP server') === true, 5000)

      failing = false
      await clickButtonWithText('Try again')

      await waitFor(() => container.querySelector('[data-testid="mcp-server-url"]') !== null)
    }, 15000)

    it('uses the backend-provided server URL after a token generation response', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-generate-token"]') !== null)
      await clickButton('mcp-generate-token')

      await waitFor(
        () =>
          container.querySelector<HTMLInputElement>('[data-testid="mcp-server-url"]')?.value ===
          'https://cloud.inboxfm.example/mcp'
      )
    }, 15000)
  })

  describe('tool registry', () => {
    it('renders the tool registry with exposure state and counts', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-tool-table"]') !== null)

      expect(container.textContent).toContain('16 of 17 exposed')
      const enabledRow = container.querySelector('[data-testid="mcp-tool-row-ap_run_action"]')
      expect(enabledRow?.getAttribute('data-enabled')).toBe('true')
      const disabledRow = container.querySelector('[data-testid="mcp-tool-row-ap_delete_table"]')
      expect(disabledRow?.getAttribute('data-enabled')).toBe('false')
      const lockedToggle = container.querySelector('[data-testid="mcp-tool-toggle-ap_research_pieces"]')
      expect(lockedToggle).toBeNull()
    }, 15000)

    it('searches tools by name and description without extra API calls', async () => {
      const { calls } = stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-tool-table"]') !== null)
      const callsBeforeSearch = calls.length

      await typeSearch(container, 'run action')

      await waitFor(
        () =>
          container.querySelector('[data-testid="mcp-tool-row-ap_run_action"]') !== null &&
          container.querySelector('[data-testid="mcp-tool-row-ap_create_table"]') === null
      )
      expect(calls.length).toBe(callsBeforeSearch)
    }, 15000)

    it('filters by exposure status', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-tool-table"]') !== null)

      await selectOption('[data-testid="mcp-status-filter"]', 'disabled')

      await waitFor(() => container.querySelector('[data-testid="mcp-tool-row-ap_run_action"]') === null)
      expect(container.querySelector('[data-testid="mcp-tool-row-ap_delete_table"]')).not.toBeNull()
    }, 15000)

    it('sends the exact full disabledTools array when toggling a tool on', async () => {
      const { requests } = stubApi([
        ...mcpRoutes(),
        {
          match: (url, method) => method === 'POST' && url.pathname.endsWith('/mcp-server'),
          respond: (_url, _method, body) => ({
            status: 200,
            body: mcpServer({
              disabledTools: ((body as { disabledTools?: string[] })?.disabledTools ?? []),
            }),
          }),
        },
        catalogRoute(),
      ])
      const container = renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-tool-toggle-ap_delete_table"]') !== null)

      await clickButton('mcp-tool-toggle-ap_delete_table')

      await waitFor(() => {
        const updateRequest = requests.find(
          (request) => request.method === 'POST' && request.url.endsWith('/mcp-server')
        )
        return !!updateRequest
      }, 5000)

      const updateRequest = requests.find(
        (request) => request.method === 'POST' && request.url.endsWith('/mcp-server')
      )
      expect(updateRequest?.body).toEqual({ disabledTools: [] })
      await waitFor(
        () =>
          container.querySelector('[data-testid="mcp-tool-row-ap_delete_table"]')?.getAttribute('data-enabled') ===
          'true'
      )
    }, 15000)

    it('adds a newly hidden tool to the disabledTools array and invalidates the cache', async () => {
      const { calls, requests } = stubApi([...mcpRoutes(), catalogRoute()])
      renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-tool-toggle-ap_run_action"]') !== null)
      const getCallsBefore = calls.filter((call) => call.includes('/mcp-server')).length

      await clickButton('mcp-tool-toggle-ap_run_action')

      await waitFor(() => {
        const updateRequest = requests.find(
          (request) => request.method === 'POST' && request.url.endsWith('/mcp-server')
        )
        return !!updateRequest
      }, 5000)
      const updateRequest = requests.find(
        (request) => request.method === 'POST' && request.url.endsWith('/mcp-server')
      )
      expect(updateRequest?.body).toEqual({ disabledTools: ['ap_delete_table', 'ap_run_action'] })

      await waitFor(
        () => calls.filter((call) => call.includes('/mcp-server')).length > getCallsBefore,
        5000
      )
    }, 15000)

    it('reverts optimistic toggle state and surfaces an error when the mutation fails', async () => {
      stubApi([...mcpRoutes({ onUpdateStatus: 500 }), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-tool-toggle-ap_delete_table"]') !== null)
      const rowBefore =
        container.querySelector('[data-testid="mcp-tool-row-ap_delete_table"]')?.getAttribute('data-enabled')

      await clickButton('mcp-tool-toggle-ap_delete_table')

      await waitFor(() => bodyText().includes('Failed to update tool exposure'), 5000)

      await waitFor(
        () =>
          container.querySelector('[data-testid="mcp-tool-row-ap_delete_table"]')?.getAttribute('data-enabled') ===
          rowBefore
      )
    }, 15000)
  })

  describe('credentials', () => {
    it('displays only a masked server token', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-server-token-section"]') !== null)

      const section = container.querySelector('[data-testid="mcp-server-token-section"]')
      expect(section?.textContent).not.toContain(mcpServer().token)
      expect(section?.textContent).toContain('\u2022')
    }, 15000)

    it('generates a short-lived token with one-time display and never persists or leaks it', async () => {
      const { calls, requests } = stubApi([...mcpRoutes(), catalogRoute()])
      renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-generate-token"]') !== null)
      await clickButton('mcp-generate-token')

      await waitFor(() => document.querySelector('[data-testid="mcp-generated-token"]') !== null)

      const tokenEl = document.querySelector('[data-testid="mcp-generated-token"]')
      expect(tokenEl?.textContent).toBe(GENERATED_TOKEN)
      expect(bodyText()).toContain('will not be shown again')
      expect(requests.some((request) => request.url.includes(GENERATED_TOKEN))).toBe(false)
      expect(calls.every((call) => !call.includes(GENERATED_TOKEN))).toBe(true)
      expect(localStorage.getItem('ap-token')).toBeNull()
      expect(sessionStorage.getItem('ap-token')).toBeNull()

      await clickButtonWithText('Close')
      await waitFor(() => document.querySelector('[data-testid="mcp-generated-token"]') === null)
      expect(bodyText().includes(GENERATED_TOKEN)).toBe(false)
    }, 15000)

    it('shows an error toast when token generation fails', async () => {
      stubApi([...mcpRoutes({ onTokenStatus: 500 }), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-generate-token"]') !== null)
      await clickButton('mcp-generate-token')

      await waitFor(() => bodyText().includes('Could not generate an MCP token'), 5000)
      expect(bodyText().includes(GENERATED_TOKEN)).toBe(false)
      expect(container.querySelector('[data-testid="mcp-generated-token"]')).toBeNull()
    }, 15000)

    it('rotates the server token after explicit confirmation', async () => {
      const { requests } = stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-rotate-token"]') !== null)
      await clickButton('mcp-rotate-token')

      await waitFor(() => bodyText().includes('Rotate MCP token?'))

      await clickButtonWithText('Rotate Token')

      await waitFor(
        () => requests.some((request) => request.url.endsWith('/mcp-server/rotate')) === true,
        5000
      )
      await waitFor(() => bodyText().includes('rotated'))
      expect(container.textContent).toContain('Rotate Token')
    }, 15000)

    it('does not rotate without confirmation', async () => {
      const { requests } = stubApi([...mcpRoutes(), catalogRoute()])
      renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-rotate-token"]') !== null)
      await clickButton('mcp-rotate-token')

      await waitFor(() => bodyText().includes('Rotate MCP token?'))
      expect(requests.some((request) => request.url.endsWith('/mcp-server/rotate'))).toBe(false)
    }, 15000)
  })

  describe('client configuration', () => {
    it('defaults to an OAuth config without any secret for Claude Desktop', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-config-claude-desktop"]') !== null)

      const pre = container.querySelector('[data-testid="mcp-config-claude-desktop"]')
      expect(pre?.textContent).toContain('"url"')
      expect(pre?.textContent).toContain(`${window.location.origin}/mcp`)
      expect(pre?.textContent?.includes('Bearer')).toBe(false)
      expect(document.querySelector('[data-testid="mcp-config-secret-warning"]')).toBeNull()
    }, 15000)

    it('embeds the generated token in bearer mode across all clients with a visible warning', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-generate-token"]') !== null)
      await clickButton('mcp-generate-token')

      await waitFor(() => document.querySelector('[data-testid="mcp-generated-token"]') !== null)

      await selectOption('[data-testid="mcp-auth-mode-select"]', 'bearer')

      await waitFor(() => document.querySelector('[data-testid="mcp-config-secret-warning"]') !== null)

      const claudeConfig =
        container.querySelector('[data-testid="mcp-config-claude-desktop"]')?.textContent ?? ''
      expect(claudeConfig).toContain(`Bearer ${GENERATED_TOKEN}`)

      for (const client of ['cursor', 'windsurf'] as const) {
        await act(async () => {
          const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((candidate) =>
            candidate.textContent?.toLowerCase().includes(client)
          )
          tab?.click()
        })
        const clientConfig =
          container.querySelector(`[data-testid="mcp-config-${client}"]`)?.textContent ?? ''
        expect(clientConfig).toContain(`Bearer ${GENERATED_TOKEN}`)
      }

      const windsurfConfig =
        container.querySelector('[data-testid="mcp-config-windsurf"]')?.textContent ?? ''
      expect(windsurfConfig).toContain('"serverUrl"')
    }, 15000)

    it('warns that bearer mode needs a token before one is generated', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-auth-mode-select"]') !== null)
      await selectOption('[data-testid="mcp-auth-mode-select"]', 'bearer')

      await waitFor(() => bodyText().includes('Generate a token first'))
    }, 15000)

    it('copies the configuration to the clipboard', async () => {
      stubApi([...mcpRoutes(), catalogRoute()])
      renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-copy-config"]') !== null)
      await clickButton('mcp-copy-config')

      await waitFor(() => bodyText().includes('Copied Claude Desktop configuration'))
      const written = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? ''
      expect(written).toContain('"mcpServers"')
      expect(written.includes(GENERATED_TOKEN)).toBe(false)
    }, 15000)
  })

  describe('tool inspector and linkage', () => {
    it('opens the inspector with metadata, schema and exposure status', async () => {
      const container = renderMcp()
      stubApi([...mcpRoutes(), catalogRoute()])

      await waitFor(() => container.querySelector('[data-testid="mcp-tool-name-ap_run_action"]') !== null)

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="mcp-tool-name-ap_run_action"]')?.click()
      })

      await waitFor(() => document.querySelector('[data-testid="mcp-inspector-params"]') !== null)

      const inspector = document.querySelector('[data-testid="mcp-inspector-params"]')
      expect(inspector?.textContent).toContain('pieceName')
      expect(inspector?.textContent).toContain('connectionExternalId')
      expect(bodyText()).toContain('Exposed to AI agents')
    }, 15000)

    it('links ap_run_action to the Actions console and tools to Activity', async () => {
      const container = renderMcp()
      stubApi([...mcpRoutes(), catalogRoute()])

      await waitFor(() => container.querySelector('[data-testid="mcp-tool-name-ap_run_action"]') !== null)
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="mcp-tool-name-ap_run_action"]')?.click()
      })

      await waitFor(() => document.querySelector('[data-testid="mcp-open-in-actions"]') !== null)
      const actionsLink = document.querySelector<HTMLAnchorElement>('[data-testid="mcp-open-in-actions"]')
      expect(actionsLink?.getAttribute('href')).toBe('/actions')
      expect(
        Array.from(document.querySelectorAll('a')).some((link) => link.getAttribute('href') === '/activity')
      ).toBe(true)
    }, 15000)

    it('lists integrations callable through ap_run_action reusing existing integration models', async () => {
      const { calls } = stubApi([...mcpRoutes(), catalogRoute()])
      const container = renderMcp()

      await waitFor(() => container.querySelector('[data-testid="mcp-callable-integrations"]') !== null)

      const list = container.querySelector('[data-testid="mcp-callable-integrations"]')
      expect(list?.textContent).toContain('GitHub')
      const integrationCalls = calls.filter((call) => call.includes('/api/v1/integrations?'))
      expect(integrationCalls.length).toBe(1)
    }, 15000)
  })

  describe('security', () => {
    it('never places tokens in request URLs', async () => {
      const { calls } = stubApi([...mcpRoutes(), catalogRoute()])
      renderMcp()

      await waitFor(() => document.querySelector('[data-testid="mcp-generate-token"]') !== null)
      await clickButton('mcp-generate-token')
      await waitFor(() => document.querySelector('[data-testid="mcp-generated-token"]') !== null)

      await clickButtonWithText('Close')
      await clickButton('mcp-rotate-token')
      await waitFor(() => bodyText().includes('Rotate MCP token?'))
      await clickButtonWithText('Rotate Token')

      await waitFor(() => calls.some((call) => call.includes('/rotate')), 5000)

      expect(calls.some((call) => call.includes(GENERATED_TOKEN))).toBe(false)
      expect(calls.every((call) => !call.includes('rotated_token_value_9999'))).toBe(true)
    }, 15000)
  })
})
