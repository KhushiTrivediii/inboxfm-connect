import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { CommandPalette } from './command-palette'
import { createTestQueryClient, mount, waitFor } from '@/test/test-utils'
import { stubApi, StubRoute } from '@/test/api-stub'
import { automationConnection, githubTriggerBinding, slackScheduledTask } from '@/test/fixtures/automations'
import { recordedExecution, executionsPage } from '@/test/fixtures/executions'
import { apiClient } from '@/lib/api/client'

const TEST_PROJECT_ID = 'proj_palette_scoped'

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="pathname">{location.pathname}</span>
}

function defaultRoutes(): StubRoute[] {
  return [
    {
      match: (url) => url.pathname === '/api/v1/connections',
      respond: () => ({ status: 200, body: { data: [automationConnection()] } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/trigger-bindings',
      respond: () => ({ status: 200, body: { data: [githubTriggerBinding()] } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/scheduled-tasks',
      respond: () => ({ status: 200, body: { data: [slackScheduledTask()] } }),
    },
    {
      match: (url) => url.pathname === '/api/v1/executions',
      respond: () => ({ status: 200, body: executionsPage([recordedExecution]) }),
    },
    {
      match: (url) => url.pathname === '/api/v1/integrations',
      respond: () => ({
        status: 200,
        body: {
          data: [
            {
              name: '@inboxfm-connect/piece-slack',
              displayName: 'Slack',
              logoUrl: '',
              description: 'Slack integration',
              version: '0.4.1',
              actions: 5,
              triggers: 2,
              categories: ['Communication'],
            },
          ],
        },
      }),
    },
  ]
}

function renderPalette(
  open: boolean,
  onOpenChange: (open: boolean) => void,
  routes: StubRoute[] = defaultRoutes()
): HTMLElement {
  stubApi(routes)
  const queryClient = createTestQueryClient()
  return mount(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <CommandPalette open={open} onOpenChange={onOpenChange} />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function typeIntoPalette(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[cmdk-input]')
  expect(input).not.toBeNull()
  await act(async () => {
    input!.focus()
    const tracker = (
      input as HTMLInputElement & { _valueTracker?: { setValue: (val: string) => void } }
    )._valueTracker
    if (tracker) {
      tracker.setValue('')
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input?.dispatchEvent(new Event('input', { bubbles: true }))
    input?.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('CommandPalette', () => {
  beforeEach(() => {
    apiClient.setProjectId(TEST_PROJECT_ID)
    document.body.innerHTML = ''
  })

  it('toggles open state on Ctrl+K / Cmd+K keydown', () => {
    const onOpenChange = vi.fn()
    renderPalette(false, onOpenChange)

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })
      )
    })
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
      )
    })

    expect(onOpenChange).toHaveBeenCalledWith(true)
    expect(onOpenChange).toHaveBeenCalledTimes(2)
  })

  it('renders navigation destinations when open', async () => {
    renderPalette(true, vi.fn())

    await waitFor(() => document.querySelector('[cmdk-root]') !== null)

    const labels = ['Overview Dashboard', 'Integrations Catalog', 'Connections & Credentials']
    labels.forEach((label) => {
      expect(document.body.textContent).toContain(label)
    })
  })

  it('renders project resources when data loads', async () => {
    renderPalette(true, vi.fn())

    await waitFor(() => document.body.textContent?.includes('Mihir GitHub') === true)

    expect(document.body.textContent).toContain('Mihir GitHub')
    expect(document.body.textContent).toContain('newIssue')
    expect(document.body.textContent).toContain('Summarize unread inbox and post the digest.')
    expect(document.body.textContent).toContain('Summarize new GitHub issues and post the digest to Slack.')
    expect(document.body.textContent).toContain('Slack')
  })

  it('deep-links to connection detail on click', async () => {
    const onOpenChange = vi.fn()
    renderPalette(true, onOpenChange)

    await waitFor(() => document.querySelector('[cmdk-item]') !== null)
    await waitFor(() => document.body.textContent?.includes('Mihir GitHub') === true)

    const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
    const connItem = items.find((item) => item.textContent?.includes('Mihir GitHub'))
    expect(connItem).toBeDefined()

    await act(async () => {
      connItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBe('/connections/conn_github_1')
  })

  it('deep-links to trigger binding detail on click', async () => {
    const onOpenChange = vi.fn()
    renderPalette(true, onOpenChange)

    await waitFor(() => document.body.textContent?.includes('newIssue') === true)

    const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
    const triggerItem = items.find((item) => item.textContent?.includes('newIssue'))
    expect(triggerItem).toBeDefined()

    await act(async () => {
      triggerItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBe('/automations/triggers/tb_github_issue')
  })

  it('deep-links to scheduled task detail on click', async () => {
    const onOpenChange = vi.fn()
    renderPalette(true, onOpenChange)

    await waitFor(() => document.body.textContent?.includes('Summarize unread inbox and post the digest.') === true)

    const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
    const schedItem = items.find((item) => item.textContent?.includes('Summarize unread inbox and post the digest.'))
    expect(schedItem).toBeDefined()

    await act(async () => {
      schedItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBe('/automations/schedules/st_daily_digest')
  })

  it('deep-links to execution detail on click', async () => {
    const onOpenChange = vi.fn()
    renderPalette(true, onOpenChange)

    await waitFor(() => document.body.textContent?.includes('Summarize new GitHub issues') === true)

    const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
    const execItem = items.find((item) => item.textContent?.includes('Summarize new GitHub issues'))
    expect(execItem).toBeDefined()

    await act(async () => {
      execItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBe('/activity/exec_recorded_1')
  })

  it('deep-links to integration detail on click', async () => {
    const onOpenChange = vi.fn()
    renderPalette(true, onOpenChange)

    await waitFor(() => document.body.textContent?.includes('v0.4.1') === true)

    const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
    const integItem = items.find((item) => item.textContent?.includes('v0.4.1'))
    expect(integItem).toBeDefined()

    await act(async () => {
      integItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBe(
      `/integrations/${encodeURIComponent('@inboxfm-connect/piece-slack')}`
    )
  })

  it('filters results based on query input and displays empty state when nothing matches', async () => {
    renderPalette(true, vi.fn())

    await waitFor(() => document.body.textContent?.includes('Mihir GitHub') === true)

    await typeIntoPalette('nonexistent-random-query-xyz')

    await waitFor(() => document.body.textContent?.includes('No results found.') === true)
    expect(document.querySelectorAll('[cmdk-item]').length).toBe(0)
  })

  it('filters down to matching resources when typing', async () => {
    renderPalette(true, vi.fn())

    await waitFor(() => document.body.textContent?.includes('Mihir GitHub') === true)

    await typeIntoPalette('Mihir GitHub')

    await waitFor(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
      const hasMihir = items.some((item) => item.textContent?.includes('Mihir GitHub') === true)
      const hasOverview = items.some((item) => item.textContent?.includes('Overview Dashboard') === true)
      return hasMihir && !hasOverview
    })
  })

  it('navigates via keyboard selection using Enter key', async () => {
    const onOpenChange = vi.fn()
    renderPalette(true, onOpenChange)

    await waitFor(() => document.body.textContent?.includes('Mihir GitHub') === true)

    await typeIntoPalette('Overview Dashboard')

    await waitFor(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
      return items.length === 1 && items[0].textContent?.includes('Overview Dashboard') === true
    })

    const input = document.querySelector<HTMLInputElement>('input[cmdk-input]')
    expect(input).not.toBeNull()

    // Press Enter to select the active filtered item
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBe('/')
  })

  it('follows SeekPage.next pagination to load subsequent pages of connections', async () => {
    const multiPageRoutes: StubRoute[] = [
      {
        match: (url) =>
          url.pathname === '/api/v1/connections' && !url.searchParams.has('cursor'),
        respond: () => ({
          status: 200,
          body: {
            data: [automationConnection({ id: 'conn_1', displayName: 'Connection Page 1' })],
            next: 'cursor_page_2',
            previous: null,
          },
        }),
      },
      {
        match: (url) =>
          url.pathname === '/api/v1/connections' &&
          url.searchParams.get('cursor') === 'cursor_page_2',
        respond: () => ({
          status: 200,
          body: {
            data: [automationConnection({ id: 'conn_2', displayName: 'Connection Page 2' })],
            next: null,
            previous: null,
          },
        }),
      },
      {
        match: (url) => url.pathname === '/api/v1/trigger-bindings',
        respond: () => ({ status: 200, body: { data: [] } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/scheduled-tasks',
        respond: () => ({ status: 200, body: { data: [] } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/executions',
        respond: () => ({ status: 200, body: executionsPage([]) }),
      },
      {
        match: (url) => url.pathname === '/api/v1/integrations',
        respond: () => ({ status: 200, body: { data: [] } }),
      },
    ]

    renderPalette(true, vi.fn(), multiPageRoutes)

    await waitFor(() => document.body.textContent?.includes('Connection Page 1') === true)
    await waitFor(() => document.body.textContent?.includes('Connection Page 2') === true)

    expect(document.body.textContent).toContain('Connection Page 1')
    expect(document.body.textContent).toContain('Connection Page 2')
  })

  it('degrades gracefully when resource queries fail (500)', async () => {
    const onOpenChange = vi.fn()
    const errorRoutes: StubRoute[] = [
      {
        match: (url) => url.pathname === '/api/v1/connections',
        respond: () => ({ status: 500, body: { message: 'Internal Server Error' } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/trigger-bindings',
        respond: () => ({ status: 500, body: { message: 'Internal Server Error' } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/scheduled-tasks',
        respond: () => ({ status: 500, body: { message: 'Internal Server Error' } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/executions',
        respond: () => ({ status: 500, body: { message: 'Internal Server Error' } }),
      },
      {
        match: (url) => url.pathname === '/api/v1/integrations',
        respond: () => ({ status: 500, body: { message: 'Internal Server Error' } }),
      },
    ]

    renderPalette(true, onOpenChange, errorRoutes)

    await waitFor(() => document.querySelector('[cmdk-root]') !== null)

    // Palette stays open, no crash
    expect(document.querySelector('[cmdk-root]')).not.toBeNull()

    // Resource groups are hidden
    expect(document.body.textContent).not.toContain('Mihir GitHub')
    expect(document.body.textContent).not.toContain('newIssue')

    // Navigation group items remain visible and selectable
    const labels = ['Overview Dashboard', 'Integrations Catalog', 'Connections & Credentials']
    labels.forEach((label) => {
      expect(document.body.textContent).toContain(label)
    })

    // Navigation works even when resource endpoints fail
    const items = Array.from(document.querySelectorAll<HTMLElement>('[cmdk-item]'))
    const overviewItem = items.find((item) => item.textContent?.includes('Overview Dashboard'))
    expect(overviewItem).toBeDefined()

    await act(async () => {
      overviewItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBe('/')
  })

  it('asserts resource queries include projectId parameter for multi-tenant isolation', async () => {
    const api = stubApi(defaultRoutes())
    const queryClient = createTestQueryClient()
    mount(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <CommandPalette open={true} onOpenChange={vi.fn()} />
        </MemoryRouter>
      </QueryClientProvider>
    )

    await waitFor(() => document.body.textContent?.includes('Mihir GitHub') === true)

    const resourceEndpoints = [
      '/api/v1/connections',
      '/api/v1/trigger-bindings',
      '/api/v1/scheduled-tasks',
      '/api/v1/executions',
    ]

    for (const endpoint of resourceEndpoints) {
      const recorded = api.requests.find((r) => r.url.includes(endpoint))
      expect(recorded).toBeDefined()
      const url = new URL(recorded!.url, 'http://localhost')
      expect(url.searchParams.get('projectId')).toBe(TEST_PROJECT_ID)
    }
  })

  it('supports keyboard navigation traversal via ArrowDown and Enter key', async () => {
    const onOpenChange = vi.fn()
    renderPalette(true, onOpenChange)

    await waitFor(() => document.body.textContent?.includes('Overview Dashboard') === true)

    const input = document.querySelector<HTMLInputElement>('input[cmdk-input]')
    expect(input).not.toBeNull()

    // Press ArrowDown to change focus
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })

    // Press Enter to select
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
      )
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[data-testid="pathname"]')?.textContent).toBeTruthy()
  })
})
